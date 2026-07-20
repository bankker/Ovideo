import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { JobExecutorKind, JobType, StoryboardPatch } from '@ovideo/shared';
import {
  CreateScriptDraftBodySchema,
  GenerateStoryboardBodySchema,
  UpdateScriptDraftBodySchema,
} from '@ovideo/shared';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { createDraft, listDrafts, updateDraft, type ScriptHooks } from './service.js';

/** 任务入队函数：由集成阶段注入 job 模块的 enqueueJob，保持模块解耦 */
export type EnqueueFn = (input: {
  projectId: string;
  type: JobType;
  executor: JobExecutorKind;
  inputPayload: Record<string, unknown>;
  /** 花钱的任务据此关掉自动重试（缺省沿用 Job 表默认值，既有调用方不受影响） */
  maxAttempts?: number;
}) => Promise<unknown>;

/**
 * 对话式修改函数：与 chat.ts 的 createScriptChat 返回值结构兼容。
 * 放宽为函数签名而非 ReturnType 引用，避免 routes ↔ chat 循环依赖。
 */
export type ScriptChatFn = (
  db: PrismaClient,
  input: { scriptDraftId: string; baseStoryboardId: string; message: string; modelConfigId?: string },
) => Promise<{ patch: StoryboardPatch; summary: string }>;

/**
 * 对话改剧本正文函数：与 rewrite.ts 的 makeRewriteScript 返回值结构兼容。
 * 同 ScriptChatFn，放宽为函数签名而非 ReturnType 引用，避免 routes ↔ rewrite 循环依赖。
 */
export type ScriptRewriteFn = (input: {
  script: string;
  message: string;
  stylePrompt?: string;
  modelConfigId?: string;
  /** 传了就是选区改写：只改这一段，产出 replacement；不传是整篇改写，产出 script */
  selection?: { from: number; to: number };
}) => Promise<{ summary: string; script?: string; replacement?: string }>;

/** 一句话创意生成剧本的请求体 */
const GenerateScriptBodySchema = z.object({
  brief: z.string().min(1).max(2000),
  /** 目标成片时长秒数：决定正文字数与场景数 */
  durationSec: z.number().int().min(15).max(600).default(60),
  style: z.string().max(200).optional(),
  /** 指定文本模型；缺省走按需调度 + 失效转移 */
  modelConfigId: z.string().optional(),
});

/** 导入剧本的体积上限：纯文本剧本再长也到不了 512KB，超了基本是传错文件 */
const MAX_IMPORT_BYTES = 512 * 1024;
/** 扩展名兜底：浏览器给 .md 常报 application/octet-stream，只认 mime 会误杀 */
const TEXT_EXT = /\.(txt|md|markdown)$/i;
const TEXT_MIME = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);

/** 标题取 brief 前 20 字，超长加省略号——列表里一眼能认出是哪条创意 */
function titleFromBrief(brief: string): string {
  const single = brief.replace(/\s+/g, ' ').trim();
  return single.length > 20 ? `${single.slice(0, 20)}…` : single;
}

/** 对话式剧本修改请求体（v2 §4：产出 patch 预览，前端 diff 确认后另行应用） */
const ChatBodySchema = z.object({
  message: z.string().min(1).max(2000),
  baseStoryboardId: z.string().min(1),
  /** 指定文本模型；缺省走按需调度 + 失效转移 */
  modelConfigId: z.string().optional(),
});

/** 对话改剧本正文的请求体（产出改写预览，用户采纳后才走 PATCH 落库） */
const RewriteBodySchema = z.object({
  message: z.string().min(1).max(1000),
  /** 指定文本模型；缺省走按需调度 + 失效转移 */
  modelConfigId: z.string().optional(),
  /**
   * 选区改写：正文中的字符区间（UTF-16 code unit 下标，含 from 不含 to）。
   * 这里只校验"是整数"，越界与空选区留给处理函数报中文错——
   * zod 的边界报错是英文结构化信息，用户看不懂该怎么办。
   */
  selection: z.object({ from: z.number().int(), to: z.number().int() }).optional(),
});

export interface ScriptRoutesOptions {
  db: PrismaClient;
  enqueue: EnqueueFn;
  hooks?: ScriptHooks;
  chat?: ScriptChatFn;
  rewrite?: ScriptRewriteFn;
}

export const scriptRoutes: FastifyPluginAsync<ScriptRoutesOptions> = async (app, opts) => {
  const { db, enqueue, hooks, chat, rewrite } = opts;

  app.get('/api/episodes/:id/script-drafts', async (req) => {
    const { id } = req.params as { id: string };
    return listDrafts(db, id);
  });

  app.post('/api/episodes/:id/script-drafts', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CreateScriptDraftBodySchema.parse(req.body ?? {});
    reply.code(201);
    return createDraft(db, id, body);
  });

  /**
   * 一句话创意 → 剧本稿（新增入口，不改动粘贴/手写那条路径）。
   * 先落一条空内容草稿再入队：用户立刻能在左栏看到它并知道正在生成，
   * 且任务失败时这条草稿仍在，可以手工接着写——不做"成功才落库"的全有全无。
   */
  app.post('/api/episodes/:id/script-drafts/generate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = GenerateScriptBodySchema.parse(req.body ?? {});
    const episode = await db.episode.findUnique({ where: { id } });
    if (!episode) throw notFound('分集');

    const draft = await createDraft(db, id, { title: titleFromBrief(body.brief), content: '' });
    const job = await enqueue({
      projectId: episode.projectId,
      type: 'GENERATE_SCRIPT',
      executor: 'API',
      inputPayload: {
        draftId: draft.id,
        brief: body.brief,
        durationSec: body.durationSec,
        ...(body.style ? { style: body.style } : {}),
        ...(body.modelConfigId ? { modelConfigId: body.modelConfigId } : {}),
      },
      // 一次调用就是一次真金白银，失败让用户自己决定要不要重试，绝不自动重刷
      maxAttempts: 1,
    });
    reply.code(202);
    return { draft, job };
  });

  /** 上传纯文本文件导入为剧本稿（第三条入口：已经写好的剧本直接进系统） */
  app.post('/api/episodes/:id/script-drafts/import', async (req, reply) => {
    const { id } = req.params as { id: string };
    const episode = await db.episode.findUnique({ where: { id } });
    if (!episode) throw notFound('分集');

    const file = await req.file();
    if (!file) throw badRequest('缺少上传文件');
    const isText = TEXT_MIME.has(file.mimetype) || TEXT_EXT.test(file.filename ?? '');
    if (!isText) {
      throw badRequest('只支持 .txt / .md 纯文本文件（其他格式请先另存为纯文本）');
    }
    const buf = await file.toBuffer();
    if (buf.byteLength > MAX_IMPORT_BYTES) throw badRequest('剧本文件不能超过 512KB');

    const title = (file.filename ?? '导入剧本').replace(/\.[^.]+$/, '') || '导入剧本';
    const draft = await createDraft(db, id, { title, content: buf.toString('utf-8') });
    reply.code(201);
    return draft;
  });

  app.patch('/api/script-drafts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = UpdateScriptDraftBodySchema.parse(req.body ?? {});
    return updateDraft(db, id, body, hooks);
  });

  app.post('/api/script-drafts/:id/generate-storyboard', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = GenerateStoryboardBodySchema.parse(req.body ?? {});
    const draft = await db.scriptDraft.findUnique({
      where: { id },
      include: { episode: true },
    });
    if (!draft) throw notFound('剧本稿');
    const job = await enqueue({
      projectId: draft.episode.projectId,
      type: 'GENERATE_STORYBOARD',
      // 指定了模型 → 走真实 API；未指定 → Mock 执行器（无 key 也能全流程跑通）
      executor: 'API',
      inputPayload: {
        scriptDraftId: draft.id,
        ...(body.modelConfigId ? { modelConfigId: body.modelConfigId } : {}),
        // 空串等同于没提要求，不必落进 Job 输入里污染重放
        ...(body.directive ? { directive: body.directive } : {}),
      },
    });
    reply.code(202);
    return job;
  });

  // 对话式剧本修改（v2 §4）：一句话指令 → patch 预览（不应用，前端 diff 确认后另行落库）
  app.post('/api/script-drafts/:id/chat', async (req) => {
    const { id } = req.params as { id: string };
    const body = ChatBodySchema.parse(req.body ?? {});
    const draft = await db.scriptDraft.findUnique({ where: { id } });
    if (!draft) throw notFound('剧本稿');
    const storyboard = await db.storyboard.findUnique({ where: { id: body.baseStoryboardId } });
    if (!storyboard) throw notFound('基底分镜');
    if (storyboard.episodeId !== draft.episodeId) throw badRequest('基底分镜不属于该剧本稿的分集');
    if (!chat) throw new AppError(501, '对话功能未配置');
    return chat(db, {
      scriptDraftId: id,
      baseStoryboardId: body.baseStoryboardId,
      message: body.message,
      modelConfigId: body.modelConfigId,
    });
  });

  /**
   * 对话改剧本正文：一句话指令 → 改写结果（只返回，不落库）。
   * 【为什么不写库】改写结果要先在对话气泡里给用户看、由用户点「采纳」才生效，
   * 服务端擅自覆盖正文会让用户丢掉手写内容且无处可退（撤销由前端保存上一版文本承担）。
   *
   * 两种模式：
   * - 不传 selection → 整篇改写，返回 { summary, script }（原有行为，一字未改）；
   * - 传 selection   → 只改这一段，返回 { summary, replacement, from, to }。
   * 【为什么要回显 from/to】前端拿到结果时用户可能已经在编辑器里挪过光标，
   * 回显的区间才是这次改写真正对应的位置，拼接时以它为准就不会拼错地方。
   */
  app.post('/api/script-drafts/:id/rewrite', async (req) => {
    const { id } = req.params as { id: string };
    const body = RewriteBodySchema.parse(req.body ?? {});
    const draft = await db.scriptDraft.findUnique({
      where: { id },
      include: { episode: { include: { project: true } } },
    });
    if (!draft) throw notFound('剧本稿');
    if (!draft.content.trim()) {
      throw badRequest('该剧本稿还没有内容，请先生成或粘贴剧本再用对话修改');
    }

    const { selection } = body;
    if (selection) {
      // 越界通常意味着前端拿的是旧正文（别处刚改过），让用户重选比拼一段错位文本安全
      if (selection.from < 0 || selection.to > draft.content.length || selection.from >= selection.to) {
        throw badRequest('选区超出剧本范围，请重新选择');
      }
      if (!draft.content.slice(selection.from, selection.to).trim()) {
        throw badRequest('选中的内容为空，请选择要修改的段落');
      }
    }

    if (!rewrite) throw new AppError(501, '对话改剧本功能未配置');
    const result = await rewrite({
      script: draft.content,
      message: body.message,
      stylePrompt: draft.episode.project.stylePrompt,
      modelConfigId: body.modelConfigId,
      selection,
    });

    if (!selection) return { summary: result.summary, script: result.script };
    // 走到这里 replacement 必定有值（makeRewriteScript 缺字段时已抛 400），
    // 这层判断只是兜住"注入了别的实现"的情况，不做静默降级
    if (!result.replacement) throw badRequest('AI 返回的改写结果无法解析，请换个说法重试');
    return {
      summary: result.summary,
      replacement: result.replacement,
      from: selection.from,
      to: selection.to,
    };
  });
};
