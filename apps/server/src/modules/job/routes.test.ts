import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { toJson } from '../../lib/json.js';
import { jobRoutes } from './routes.js';

let t: TestDb;
let db: PrismaClient;
let app: FastifyInstance;
let projectId: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const project = await db.project.create({ data: { name: '路由测试项目' } });
  projectId = project.id;

  app = Fastify();
  // 与 app.ts 集成顺序一致：错误处理器先于路由注册（Fastify 封装上下文在注册时快照父级配置）
  registerErrorHandler(app);
  await app.register(jobRoutes, { db });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe('GET /api/projects/:projectId/jobs', () => {
  it('按 createdAt 倒序返回，支持 status 过滤与 limit', async () => {
    const base = Date.now();
    const mk = (status: string, offsetMs: number) =>
      db.job.create({
        data: {
          projectId,
          type: 'GENERATE_IMAGE',
          status,
          inputJson: toJson({ offsetMs }),
          createdAt: new Date(base + offsetMs),
        },
      });
    const j1 = await mk('SUCCEEDED', 0);
    const j2 = await mk('QUEUED', 1000);
    const j3 = await mk('FAILED', 2000);

    const all = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/jobs` });
    expect(all.statusCode).toBe(200);
    const list = all.json() as Array<{ id: string; input: unknown; inputJson?: string }>;
    expect(list.map((j) => j.id)).toEqual([j3.id, j2.id, j1.id]);
    // inputJson 已解析为 input 对象，原始列不外露
    expect(list[2]?.input).toEqual({ offsetMs: 0 });
    expect(list[0]?.inputJson).toBeUndefined();

    const failedOnly = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/jobs?status=FAILED`,
    });
    expect((failedOnly.json() as Array<{ id: string }>).map((j) => j.id)).toEqual([j3.id]);

    const limited = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/jobs?limit=2` });
    expect((limited.json() as unknown[]).length).toBe(2);
  });

  it('非法 status 报 400', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/jobs?status=WHAT` });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/jobs/:id', () => {
  it('返回单个任务，output 解析为对象', async () => {
    const job = await db.job.create({
      data: {
        projectId,
        type: 'GENERATE_TTS',
        status: 'SUCCEEDED',
        inputJson: toJson({ text: '你好' }),
        outputJson: toJson({ outputAssetIds: ['a9'], output: null }),
      },
    });
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { input: unknown; output: unknown };
    expect(body.input).toEqual({ text: '你好' });
    expect(body.output).toEqual({ outputAssetIds: ['a9'], output: null });
  });

  it('不存在报 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/jobs/:id/cancel', () => {
  it('QUEUED 任务取消成功', async () => {
    const job = await db.job.create({ data: { projectId, type: 'GENERATE_IMAGE' } });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('CANCELED');
  });

  it('RUNNING 任务取消报 400', async () => {
    const job = await db.job.create({ data: { projectId, type: 'GENERATE_IMAGE', status: 'RUNNING' } });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/jobs/:id/retry', () => {
  it('FAILED 任务重回 QUEUED', async () => {
    const job = await db.job.create({
      data: { projectId, type: 'GENERATE_IMAGE', status: 'FAILED', attempts: 2, error: '挂了' },
    });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; attempts: number; error: string | null };
    expect(body.status).toBe('QUEUED');
    expect(body.attempts).toBe(0);
    expect(body.error).toBeNull();
  });

  it('非 FAILED 任务重试报 400', async () => {
    const job = await db.job.create({ data: { projectId, type: 'GENERATE_IMAGE', status: 'SUCCEEDED' } });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry` });
    expect(res.statusCode).toBe(400);
  });
});
