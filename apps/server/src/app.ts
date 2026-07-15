import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { registerErrorHandler } from './lib/errors.js';
import { STORAGE_ROOT } from './lib/storage.js';

/** 模块路由在 M1-C 集成阶段统一注册（各模块导出 FastifyPluginAsync） */
export async function buildApp() {
  const app = Fastify({ logger: { level: 'warn' } });

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });
  await app.register(fastifyStatic, { root: STORAGE_ROOT, prefix: '/storage/' });
  registerErrorHandler(app);

  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

  return app;
}
