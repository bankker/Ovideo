import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { PrismaClient } from '@prisma/client';
import { registerErrorHandler, badRequest } from './lib/errors.js';
import { STORAGE_ROOT } from './lib/storage.js';
import { db as defaultDb } from './lib/db.js';
import { parseJson } from './lib/json.js';

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
import { cutRoutes } from './modules/cut/routes.js';
import { libraryRoutes } from './modules/cut/library-routes.js';

import { enqueueJob } from './modules/job/service.js';
import { startWorker, type JobWorker } from './modules/job/worker.js';
import { registerExecutor } from './modules/job/registry.js';
import { createStoryboardGenerator, mockTextGen } from './modules/script/generate.js';
import { createScriptChat, mockChatGen } from './modules/script/chat.js';
import { shotGroupRoutes } from './modules/shotgroup/routes.js';
import { enhanceRoutes } from './modules/enhance/routes.js';
import { registerEnhanceExecutors } from './modules/enhance/executors.js';
import { chatComplete } from './modules/provider/adapters/openai-compatible.js';
import { openaiImageGenerate } from './modules/provider/adapters/openai-image.js';
import { arkVideoGenerate } from './modules/provider/adapters/ark-video.js';
import { uriToAbsPath } from './lib/storage.js';
import { registerGenerationExecutors } from './modules/generation/executors.js';
import { mockImageGen, mockVideoGen, mockTtsGen, type ImageGen, type VideoGen, type TtsGen } from './modules/generation/gens.js';
import { registerCutExecutor } from './modules/cut/executor.js';
import { findOrCreateTags } from './modules/tag/service.js';
import * as stale from './modules/stale/service.js';
import { createFailoverTextGen, pickModelForModality, AUTO_ROUTE_MODALITIES } from './modules/provider/scheduler.js';
import type { Modality } from '@ovideo/shared';

/**
 * 集成装配：模块间协作全部在这里接线（模块彼此不 import，见各模块 options 注释）。
 * - 失效传播（stale）注入 script/storyboard/binding 的 hooks
 * - 任务入队（job.enqueueJob）注入 script 路由
 * - 三步生成执行器按 job.input.modelConfigId 路由：有 → OpenAI 兼容适配器（真实厂商），无 → mockTextGen
 */
export function registerExecutors(): void {
  // 生成执行器：modelConfigId 配了真实厂商（有 baseUrl）走对应适配器，否则 FFmpeg Mock。
  // 明确不静默降级：选了真实厂商但该模态暂无适配器时报错，避免"以为在用付费模型其实是 Mock"。
  const smartImageGen: ImageGen = async (args) => {
    if (args.modelCfg?.baseUrl) {
      await openaiImageGenerate(
        { baseUrl: args.modelCfg.baseUrl, apiKey: args.modelCfg.apiKey, model: args.modelCfg.modelKey },
        {
          prompt: args.prompt,
          outPath: args.outPath,
          // 绑定/默认设计图作为参考图上送（Seedream i2i），保证角色与场景形象一致
          refImagePaths: args.refUris.map((u) => uriToAbsPath(u)),
        },
      );
      return;
    }
    return mockImageGen(args);
  };
  const smartVideoGen: VideoGen = async (args) => {
    if (args.modelCfg?.baseUrl) {
      // 火山方舟（Seedance/wan2）走异步任务适配器；其余厂商待接入
      const isArk =
        args.modelCfg.baseUrl.includes('volces.com') || /seedance|wan2/i.test(args.modelCfg.modelKey);
      if (!isArk) {
        throw new Error('该厂商的视频真实生成适配器尚未接入（当前支持：火山方舟 Seedance），请选择 Seedance 或 Mock 模型');
      }
      await arkVideoGenerate(
        { baseUrl: args.modelCfg.baseUrl, apiKey: args.modelCfg.apiKey, model: args.modelCfg.modelKey },
        {
          prompt: args.prompt,
          firstFramePath: args.firstFrameUri ? uriToAbsPath(args.firstFrameUri) : null,
          durationMs: args.durationMs,
          outPath: args.outPath,
          onProgress: args.onProgress,
        },
      );
      return;
    }
    return mockVideoGen(args);
  };
  const smartTtsGen: TtsGen = async (args) => {
    if (args.modelCfg?.baseUrl) {
      throw new Error('该厂商的语音真实生成适配器将在 M3 接入，当前请使用 Mock 模型');
    }
    return mockTtsGen(args);
  };
  registerGenerationExecutors({ imageGen: smartImageGen, videoGen: smartVideoGen, ttsGen: smartTtsGen });
  registerCutExecutor();
  registerEnhanceExecutors();

  registerExecutor('GENERATE_STORYBOARD', async (ctx) => {
    const input = parseJson<{ scriptDraftId?: string; modelConfigId?: string }>(
      ctx.job.inputJson,
      {},
    );
    // 用户显式指定模型 → 只用该模型（失败即失败，不偷换）；
    // 未指定 → 按需调度 + 失效转移（候选依次尝试，全无候选回落确定性 Mock）
    let textGen = createFailoverTextGen(ctx.db, mockTextGen);
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
        textGen = mockTextGen; // 显式选择 Mock 厂商
      }
    }
    return createStoryboardGenerator({ textGen })(ctx);
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
  await app.register(tagRoutes, { db });
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
        // 文本任务不钉死单一模型：执行时走失效转移（见 GENERATE_STORYBOARD 执行器），
        // modelKey 仅作展示；图像任务钉队首模型（图像适配器暂无转移链）
        if (input.type === 'GENERATE_STORYBOARD') {
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
  const chatTextGen = createFailoverTextGen(db, mockChatGen);

  await app.register(scriptRoutes, {
    db,
    enqueue, // 统一走按需调度入队（未指定模型时自动选队首真实模型）
    hooks: { onScriptDraftChanged: stale.onScriptDraftChanged },
    chat: createScriptChat({ textGen: chatTextGen }),
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
  await app.register(cutRoutes, { db, enqueue });
  await app.register(libraryRoutes, { db });
  await app.register(shotGroupRoutes, { db });
  await app.register(enhanceRoutes, { db, enqueue });

  return app;
}

/** 供 index.ts 启动完整服务（HTTP + 执行器 + Worker） */
export function startRuntime(db: PrismaClient): JobWorker {
  registerExecutors();
  return startWorker(db, { intervalMs: 400, concurrency: 2 });
}
