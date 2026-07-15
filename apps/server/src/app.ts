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

import { enqueueJob } from './modules/job/service.js';
import { startWorker, type JobWorker } from './modules/job/worker.js';
import { registerExecutor } from './modules/job/registry.js';
import { registerMockMediaExecutors } from './modules/job/executors/mock-media.js';
import { createStoryboardGenerator, mockTextGen } from './modules/script/generate.js';
import { chatComplete } from './modules/provider/adapters/openai-compatible.js';
import { findOrCreateTags } from './modules/tag/service.js';
import * as stale from './modules/stale/service.js';

/**
 * 集成装配：模块间协作全部在这里接线（模块彼此不 import，见各模块 options 注释）。
 * - 失效传播（stale）注入 script/storyboard/binding 的 hooks
 * - 任务入队（job.enqueueJob）注入 script 路由
 * - 三步生成执行器按 job.input.modelConfigId 路由：有 → OpenAI 兼容适配器（真实厂商），无 → mockTextGen
 */
export function registerExecutors(): void {
  registerMockMediaExecutors();

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
  });
  await app.register(storyboardRoutes, {
    db,
    hooks: { onStoryboardPatched: stale.onStoryboardPatched },
    resolveTags: (projectId, tags) => findOrCreateTags(db, projectId, tags),
  });

  return app;
}

/** 供 index.ts 启动完整服务（HTTP + 执行器 + Worker） */
export function startRuntime(db: PrismaClient): JobWorker {
  registerExecutors();
  return startWorker(db, { intervalMs: 400, concurrency: 2 });
}
