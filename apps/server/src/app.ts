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
import { registerGenerationExecutors } from './modules/generation/executors.js';
import { mockImageGen, mockVideoGen, mockTtsGen, type ImageGen, type VideoGen, type TtsGen } from './modules/generation/gens.js';
import { registerCutExecutor } from './modules/cut/executor.js';
import { findOrCreateTags } from './modules/tag/service.js';
import * as stale from './modules/stale/service.js';

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
        { prompt: args.prompt, outPath: args.outPath },
      );
      return;
    }
    return mockImageGen(args);
  };
  const smartVideoGen: VideoGen = async (args) => {
    if (args.modelCfg?.baseUrl) {
      throw new Error('该厂商的视频真实生成适配器将在 M3 接入（Seedance/海螺等），当前请使用 Mock 模型');
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
    let textGen = mockTextGen;
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
      }
      // baseUrl 为空的"Mock 厂商"走 mockTextGen
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
  // 对话式剧本：请求时动态选第一个 enabled 的真实 TEXT 模型（有 baseUrl），无则走确定性 Mock
  const chatTextGen = async (prompt: string): Promise<string> => {
    const model = await db.modelConfig.findFirst({
      where: { enabled: true, modality: 'text', provider: { enabled: true, category: 'TEXT', NOT: { baseUrl: '' } } },
      include: { provider: true },
      orderBy: { sortOrder: 'asc' },
    });
    if (model) {
      return chatComplete(
        { baseUrl: model.provider.baseUrl, apiKey: model.provider.apiKey, model: model.key },
        [{ role: 'user', content: prompt }],
        { jsonMode: true },
      );
    }
    return mockChatGen(prompt);
  };

  await app.register(scriptRoutes, {
    db,
    enqueue: (input) =>
      enqueueJob(db, {
        projectId: input.projectId,
        type: input.type,
        executor: input.executor,
        inputPayload: input.inputPayload,
      }),
    hooks: { onScriptDraftChanged: stale.onScriptDraftChanged },
    chat: createScriptChat({ textGen: chatTextGen }),
  });
  await app.register(storyboardRoutes, {
    db,
    hooks: { onStoryboardPatched: stale.onStoryboardPatched },
    resolveTags: (projectId, tags) => findOrCreateTags(db, projectId, tags),
  });

  // ---- M2 生成管线路由 ----
  const enqueue = (input: Parameters<typeof enqueueJob>[1]) => enqueueJob(db, input);
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
