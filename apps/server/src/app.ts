import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { PrismaClient } from '@prisma/client';
import { registerErrorHandler, badRequest } from './lib/errors.js';
import { STORAGE_ROOT } from './lib/storage.js';
import { db as defaultDb } from './lib/db.js';
import { parseJson, toJson } from './lib/json.js';

import { projectRoutes } from './modules/project/routes.js';
import { episodeRoutes } from './modules/episode/routes.js';
import { tagRoutes } from './modules/tag/routes.js';
import { assetRoutes } from './modules/asset/routes.js';
import { bindingRoutes } from './modules/binding/routes.js';
import { jobRoutes } from './modules/job/routes.js';
import { providerRoutes } from './modules/provider/routes.js';
import { scriptRoutes } from './modules/script/routes.js';
import { storyboardRoutes } from './modules/storyboard/routes.js';

import { designRoutes } from './modules/design/routes.js';
import { dubbingRoutes } from './modules/dubbing/routes.js';
import { generationRoutes } from './modules/generation/routes.js';
import { agentRoutes } from './modules/agent/routes.js';
import { cutRoutes } from './modules/cut/routes.js';
import { libraryRoutes } from './modules/cut/library-routes.js';

import { enqueueJob, completeJob, failJob, updateJobProgress } from './modules/job/service.js';
import { startWorker, type JobWorker } from './modules/job/worker.js';
import { registerExecutor, getExecutor } from './modules/job/registry.js';
import { createStoryboardGenerator } from './modules/script/generate.js';
import { makeGenerateScript } from './modules/script/write.js';
import { createScriptChat } from './modules/script/chat.js';
import { shotGroupRoutes } from './modules/shotgroup/routes.js';
import { enhanceRoutes } from './modules/enhance/routes.js';
import { registerEnhanceExecutors } from './modules/enhance/executors.js';
import { chatComplete } from './modules/provider/adapters/openai-compatible.js';
import { visionJudge } from './modules/provider/adapters/vision-judge.js';
import { registerAgentExecutors } from './modules/agent/executor.js';
import { recoverStaleAgentRuns } from './modules/agent/service.js';
import type {
  AgentKeyframeGen,
  AgentTextGen,
  AgentVisionJudge,
} from './modules/agent/service.js';
import { openaiImageGenerate } from './modules/provider/adapters/openai-image.js';
import { arkVideoGenerate } from './modules/provider/adapters/ark-video.js';
import { uriToAbsPath } from './lib/storage.js';
import { registerGenerationExecutors } from './modules/generation/executors.js';
import type { ImageGen, VideoGen, TtsGen } from './modules/generation/gens.js';
import { dashscopeTtsGenerate } from './modules/provider/adapters/dashscope-tts.js';
import { registerCutExecutor } from './modules/cut/executor.js';
import { findOrCreateTags } from './modules/tag/service.js';
import * as stale from './modules/stale/service.js';
import { createFailoverTextGen, pickModelForModality, AUTO_ROUTE_MODALITIES } from './modules/provider/scheduler.js';
import type { Modality } from '@ovideo/shared';

/* ---------------- 关键图自动收敛 agent 的真实能力接线 ---------------- */

/**
 * agent 的取图能力 = 人点「生成关键图」时的同一个执行器。
 * 【旁路原则】不为 agent 新增生成路径：同样落一条 GENERATE_IMAGE 的 Job 行、同样产出普通 Take，
 * 因此 agent 抽出来的每张图在任务面板与抽卡列表里与人工产出完全同形，人随时可改选。
 */
const agentKeyframeGen: AgentKeyframeGen = async ({
  db,
  projectId,
  shotId,
  modelConfigId,
  promptOverride,
}) => {
  const executor = getExecutor('GENERATE_IMAGE');
  if (!executor) throw new Error('图像生成执行器未注册，无法运行自动收敛');
  // 人工入队时由 enqueue 自动调度队首图像模型；agent 直接驱动执行器，这里补上同样的调度
  let imageModelId = modelConfigId;
  if (!imageModelId) {
    const picked = await pickModelForModality(db, 'image');
    imageModelId = picked?.id;
  }
  const job = await db.job.create({
    data: {
      projectId,
      type: 'GENERATE_IMAGE',
      executor: 'API',
      status: 'RUNNING',
      attempts: 1,
      startedAt: new Date(),
      inputJson: toJson({ kind: 'keyframe', shotId, modelConfigId: imageModelId, promptOverride }),
    },
  });
  try {
    const result = await executor({
      db,
      job,
      updateProgress: (p) => updateJobProgress(db, job.id, p),
    });
    await completeJob(db, job.id, result ?? {});
    const takeId = (result.output as { takeId?: string } | undefined)?.takeId;
    if (!takeId) throw new Error('关键图生成未返回 take');
    const take = await db.take.findUnique({ where: { id: takeId }, include: { asset: true } });
    if (!take) throw new Error('关键图 take 落库后读取失败');
    return { takeId: take.id, assetUri: take.asset.uri };
  } catch (err) {
    // fatal：这条 Job 由 agent 同步驱动，留给 worker 重试会凭空多抽一张图（多花一次钱）
    await failJob(db, job.id, err instanceof Error ? err.message : String(err), { fatal: true });
    throw err;
  }
};

/** 视觉评审：显式指定优先，否则按 modality='vision' 调度队首；一个都没有时给出可行动的中文指引 */
const agentVisionJudge: AgentVisionJudge = async ({
  db,
  imagePath,
  refImagePaths,
  prompt,
  visionModelConfigId,
}) => {
  const model = visionModelConfigId
    ? await db.modelConfig.findUnique({
        where: { id: visionModelConfigId },
        include: { provider: true },
      })
    : await pickModelForModality(db, 'vision');
  if (!model || !model.enabled || !model.provider.enabled || !model.provider.baseUrl) {
    throw new Error(
      '未配置视觉理解模型：请到管理后台把一个视觉模型（如豆包视觉理解 Pro / Qwen-VL）的模态设为「视觉理解」并启用后重试',
    );
  }
  const cfg = { baseUrl: model.provider.baseUrl, apiKey: model.provider.apiKey, modelKey: model.key };
  return visionJudge(cfg, { imagePath, refImagePaths, prompt, modelCfg: cfg });
};

/** 提示词改写走既有文本通道（按需调度 + 失效转移 + jsonMode），与对话式剧本同一套策略 */
const agentTextGen: AgentTextGen = async ({ db, prompt }) =>
  createFailoverTextGen(db, async () => {
    throw new Error('未配置文本模型：请在管理后台「一键接入」任一文本厂商后再使用提示词改写');
  })(prompt);

/**
 * 集成装配：模块间协作全部在这里接线（模块彼此不 import，见各模块 options 注释）。
 * - 失效传播（stale）注入 script/storyboard/binding 的 hooks
 * - 任务入队（job.enqueueJob）注入 script 路由
 * 【无 Mock 原则】所有生成路径只走真实模型；未配置/未选择模型时明确报错引导配置，
 * 绝不静默产出占位内容（本地 FFmpeg 的拼接/放大/抽帧属真实本地处理，不在此列）。
 */
export function registerExecutors(): void {
  const smartImageGen: ImageGen = async (args) => {
    if (!args.modelCfg?.baseUrl) {
      throw new Error('未配置图像模型：请在管理后台「一键接入」或启用图像厂商（如火山方舟 Seedream）后重试');
    }
    await openaiImageGenerate(
      { baseUrl: args.modelCfg.baseUrl, apiKey: args.modelCfg.apiKey, model: args.modelCfg.modelKey },
      {
        prompt: args.prompt,
        outPath: args.outPath,
        size: args.size,
        // 绑定/默认设计图作为参考图上送（Seedream i2i），保证角色与场景形象一致
        refImagePaths: args.refUris.map((u) => uriToAbsPath(u)),
      },
    );
  };
  const smartVideoGen: VideoGen = async (args) => {
    if (!args.modelCfg?.baseUrl) {
      throw new Error('未选择视频模型：请在视频页选择模型（当前支持火山方舟 Seedance），或在管理后台接入');
    }
    // 火山方舟（Seedance/wan2）走异步任务适配器；其余厂商待接入
    const isArk =
      args.modelCfg.baseUrl.includes('volces.com') || /seedance|wan2/i.test(args.modelCfg.modelKey);
    if (!isArk) {
      throw new Error('该厂商的视频生成适配器尚未接入（当前支持：火山方舟 Seedance），请选择 Seedance 模型');
    }
    await arkVideoGenerate(
      { baseUrl: args.modelCfg.baseUrl, apiKey: args.modelCfg.apiKey, model: args.modelCfg.modelKey },
      {
        prompt: args.prompt,
        firstFramePath: args.firstFrameUri ? uriToAbsPath(args.firstFrameUri) : null,
        durationMs: args.durationMs,
        outPath: args.outPath,
        resolution: args.resolution,
        onProgress: args.onProgress,
      },
    );
  };
  const smartTtsGen: TtsGen = async (args) => {
    if (!args.modelCfg?.baseUrl) {
      throw new Error('未配置语音模型：请在管理后台给阿里云百炼添加 qwen-tts 模型（同一把 Key 即用）后重试');
    }
    // 阿里云百炼 Qwen-TTS（DashScope 原生 API）；其余厂商待接入
    const isDashScope =
      args.modelCfg.baseUrl.includes('dashscope') || /qwen-tts|sambert|cosyvoice/i.test(args.modelCfg.modelKey);
    if (!isDashScope) {
      throw new Error('该厂商的语音合成适配器尚未接入（当前支持：阿里云百炼 Qwen-TTS），请选择 qwen-tts 模型');
    }
    await dashscopeTtsGenerate(
      { baseUrl: args.modelCfg.baseUrl, apiKey: args.modelCfg.apiKey, model: args.modelCfg.modelKey },
      { text: args.text, speed: args.speed, voiceSeed: args.voiceSeed, outPath: args.outPath },
    );
  };
  registerGenerationExecutors({ imageGen: smartImageGen, videoGen: smartVideoGen, ttsGen: smartTtsGen });
  registerCutExecutor();
  registerEnhanceExecutors();
  registerAgentExecutors({
    generateKeyframe: agentKeyframeGen,
    judgeImage: agentVisionJudge,
    textGen: agentTextGen,
  });

  registerExecutor('GENERATE_STORYBOARD', async (ctx) => {
    const input = parseJson<{ scriptDraftId?: string; modelConfigId?: string }>(
      ctx.job.inputJson,
      {},
    );
    // 用户显式指定模型 → 只用该模型（失败即失败，不偷换）；
    // 未指定 → 按需调度 + 失效转移；一个真实文本模型都没有 → 明确报错（无 Mock）
    let textGen = createFailoverTextGen(ctx.db, async () => {
      throw new Error('未配置文本模型：请在管理后台「一键接入」任一文本厂商（豆包/千问/DeepSeek…）后重试');
    });
    if (input.modelConfigId) {
      const model = await ctx.db.modelConfig.findUnique({
        where: { id: input.modelConfigId },
        include: { provider: true },
      });
      if (!model || !model.enabled || !model.provider.enabled) {
        throw badRequest('指定的文本模型不可用（已停用或不存在）');
      }
      if (model.provider.baseUrl) {
        const cfg = {
          baseUrl: model.provider.baseUrl,
          apiKey: model.provider.apiKey,
          model: model.key,
        };
        textGen = async (prompt: string) =>
          chatComplete(cfg, [{ role: 'user', content: prompt }], { jsonMode: true });
      } else {
        throw badRequest('该模型所属厂商未配置 Base URL，无法调用');
      }
    }
    return createStoryboardGenerator({ textGen })(ctx);
  });

  // 一句话创意 → 剧本正文。模型路由策略与三步生成同一套，唯一区别是关掉 jsonMode：
  // 这里要的是散文剧本，不是 JSON。
  registerExecutor('GENERATE_SCRIPT', async (ctx) => {
    const input = parseJson<{ modelConfigId?: string }>(ctx.job.inputJson, {});
    let textGen = createFailoverTextGen(
      ctx.db,
      async () => {
        throw new Error('未配置文本模型：请在管理后台「一键接入」任一文本厂商（豆包/千问/DeepSeek…）后重试');
      },
      { jsonMode: false },
    );
    if (input.modelConfigId) {
      const model = await ctx.db.modelConfig.findUnique({
        where: { id: input.modelConfigId },
        include: { provider: true },
      });
      if (!model || !model.enabled || !model.provider.enabled) {
        throw badRequest('指定的文本模型不可用（已停用或不存在）');
      }
      if (!model.provider.baseUrl) throw badRequest('该模型所属厂商未配置 Base URL，无法调用');
      const cfg = { baseUrl: model.provider.baseUrl, apiKey: model.provider.apiKey, model: model.key };
      textGen = async (prompt: string) => chatComplete(cfg, [{ role: 'user', content: prompt }]);
    }
    return makeGenerateScript({ textGen })(ctx);
  });
}

export interface BuildAppOptions {
  db?: PrismaClient;
}

export async function buildApp(opts: BuildAppOptions = {}) {
  const db = opts.db ?? defaultDb;
  const app = Fastify({ logger: { level: 'warn' } });

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });
  await app.register(fastifyStatic, { root: STORAGE_ROOT, prefix: '/storage/' });
  registerErrorHandler(app);

  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

  // 浏览器直接访问 API 端口时给出中文引导，避免看到裸 404 JSON
  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return `<!doctype html><meta charset="utf-8"><title>Ovideo API</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f5f5f5">
<div style="text-align:center;color:#333">
<h2>这里是 Ovideo API 服务（端口 8787）</h2>
<p>平台操作界面请访问 <a href="http://localhost:5173">http://localhost:5173</a></p>
<p style="color:#999;font-size:13px">健康检查：<code>/api/health</code></p>
</div></body>`;
  });

  await app.register(projectRoutes, { db });
  await app.register(episodeRoutes, { db });
  // dedupTextGen 前置声明依赖 chatTextGen（定义在下方）——用惰性包装避免声明顺序问题
  await app.register(tagRoutes, { db, dedupTextGen: (prompt) => chatTextGen(prompt) });
  await app.register(assetRoutes, { db });
  await app.register(bindingRoutes, {
    db,
    hooks: {
      onBindingChanged: async (d, episodeId, tagId, shotId) => {
        await stale.onBindingChanged(d, episodeId, tagId, shotId);
      },
    },
  });
  await app.register(jobRoutes, { db });
  await app.register(providerRoutes, { db });
  // 按需调度（v3.6）：任务未显式指定模型时，按 JobType 对应模态自动选用队首的已启用真实模型；
  // 无真实模型则回落 Mock。只覆盖已有真实适配器的模态（text/image），video/tts 待 M3 适配器。
  const MODALITY_BY_JOB_TYPE: Record<string, Modality> = {
    GENERATE_SCRIPT: 'text',
    GENERATE_STORYBOARD: 'text',
    GENERATE_IMAGE: 'image',
    GENERATE_VIDEO: 'video',
    GENERATE_TTS: 'tts',
  };
  const enqueue = async (input: Parameters<typeof enqueueJob>[1]) => {
    const payload = (input.inputPayload ?? {}) as Record<string, unknown>;
    const modality = MODALITY_BY_JOB_TYPE[input.type];
    if (!payload.modelConfigId && modality && AUTO_ROUTE_MODALITIES.includes(modality)) {
      const picked = await pickModelForModality(db, modality);
      if (picked) {
        // 文本任务不钉死单一模型：执行时走失效转移（见 GENERATE_STORYBOARD / GENERATE_SCRIPT 执行器），
        // modelKey 仅作展示；图像任务钉队首模型（图像适配器暂无转移链）
        if (input.type === 'GENERATE_STORYBOARD' || input.type === 'GENERATE_SCRIPT') {
          return enqueueJob(db, {
            ...input,
            executor: 'API',
            providerConfigId: picked.providerConfigId,
            modelKey: `自动调度（首选 ${picked.key}）`,
          });
        }
        return enqueueJob(db, {
          ...input,
          executor: 'API',
          inputPayload: { ...payload, modelConfigId: picked.id },
          providerConfigId: picked.providerConfigId,
          modelKey: picked.key,
        });
      }
    }
    return enqueueJob(db, input);
  };

  // 对话式剧本：按需调度 + 失效转移（与三步生成任务共用 scheduler 的同一策略）
  const chatTextGen = createFailoverTextGen(db, async () => {
    throw new Error('未配置文本模型：请在管理后台「一键接入」任一文本厂商后再使用对话/生成功能');
  });

  await app.register(scriptRoutes, {
    db,
    enqueue, // 统一走按需调度入队（未指定模型时自动选队首真实模型）
    hooks: { onScriptDraftChanged: stale.onScriptDraftChanged },
    // 对话式修改按请求路由模型：显式指定 → 只用该模型；缺省 → 按需调度 + 失效转移
    chat: async (chatDb, params) => {
      let textGen = chatTextGen;
      if (params.modelConfigId) {
        const model = await chatDb.modelConfig.findUnique({
          where: { id: params.modelConfigId },
          include: { provider: true },
        });
        if (!model || !model.enabled || !model.provider.enabled || !model.provider.baseUrl) {
          throw badRequest('指定的文本模型不可用（已停用/不存在/未配置端点）');
        }
        const cfg = { baseUrl: model.provider.baseUrl, apiKey: model.provider.apiKey, model: model.key };
        textGen = async (prompt: string) =>
          chatComplete(cfg, [{ role: 'user', content: prompt }], { jsonMode: true });
      }
      return createScriptChat({ textGen })(chatDb, params);
    },
  });
  await app.register(storyboardRoutes, {
    db,
    hooks: { onStoryboardPatched: stale.onStoryboardPatched },
    resolveTags: (projectId, tags) => findOrCreateTags(db, projectId, tags),
  });

  // ---- M2 生成管线路由 ----
  await app.register(designRoutes, { db, enqueue });
  await app.register(dubbingRoutes, { db, enqueue });
  await app.register(generationRoutes, { db, enqueue });
  // 自动收敛 agent：与「生成关键图」并列的新入口，原有按钮行为完全不变
  await app.register(agentRoutes, { db, enqueue });
  await app.register(cutRoutes, { db, enqueue });
  await app.register(libraryRoutes, { db });
  await app.register(shotGroupRoutes, { db });
  await app.register(enhanceRoutes, { db, enqueue });

  return app;
}

/** 供 index.ts 启动完整服务（HTTP + 执行器 + Worker） */
export function startRuntime(db: PrismaClient): JobWorker {
  registerExecutors();
  // agent 运行记录与 Job 一样会留下重启孤儿；不清扫会永久堵死该镜头的后续发起
  void recoverStaleAgentRuns(db)
    .then((n) => {
      if (n > 0) console.warn(`[agent] 启动恢复：${n} 个中断的自动收敛已标记失败`);
    })
    .catch((err) => console.error('[agent] 启动恢复失败：', err));
  return startWorker(db, { intervalMs: 400, concurrency: 2 });
}
