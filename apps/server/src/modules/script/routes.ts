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
}) => Promise<unknown>;

/**
 * 对话式修改函数：与 chat.ts 的 createScriptChat 返回值结构兼容。
 * 放宽为函数签名而非 ReturnType 引用，避免 routes ↔ chat 循环依赖。
 */
export type ScriptChatFn = (
  db: PrismaClient,
  input: { scriptDraftId: string; baseStoryboardId: string; message: string },
) => Promise<{ patch: StoryboardPatch; summary: string }>;

/** 对话式剧本修改请求体（v2 §4：产出 patch 预览，前端 diff 确认后另行应用） */
const ChatBodySchema = z.object({
  message: z.string().min(1).max(2000),
  baseStoryboardId: z.string().min(1),
});

export interface ScriptRoutesOptions {
  db: PrismaClient;
  enqueue: EnqueueFn;
  hooks?: ScriptHooks;
  chat?: ScriptChatFn;
}

export const scriptRoutes: FastifyPluginAsync<ScriptRoutesOptions> = async (app, opts) => {
  const { db, enqueue, hooks, chat } = opts;

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
    });
  });
};
