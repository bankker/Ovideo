import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Job, PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import type { EnqueueJobInput } from '../job/service.js';
import { enhanceRoutes } from './routes.js';

let t: TestDb;
let db: PrismaClient;
let app: FastifyInstance;
let projectId: string;

const enqueue = vi.fn(
  async (input: EnqueueJobInput) => ({ id: `job-${crypto.randomUUID()}`, ...input }) as unknown as Job,
);

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const project = await db.project.create({ data: { name: '增强路由测试项目' } });
  projectId = project.id;

  app = Fastify();
  // 与 app.ts 集成顺序一致：错误处理器先于路由注册（否则 zod 错误变 500）
  registerErrorHandler(app);
  await app.register(enhanceRoutes, { db, enqueue });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

beforeEach(() => {
  enqueue.mockClear();
});

async function seedShot(shotData: Record<string, unknown> = {}) {
  const episode = await db.episode.create({ data: { projectId, title: '测试集' } });
  const draft = await db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
  const storyboard = await db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  const shot = await db.shot.create({
    data: { storyboardId: storyboard.id, sortOrder: 0, sourceText: '镜头文本', ...shotData },
  });
  return { episode, storyboard, shot };
}

/** 给镜头挂一个 selected 的 VIDEO take（路由只查指针，资产文件无需真实存在） */
async function seedShotWithSelectedVideo() {
  const { shot } = await seedShot();
  const asset = await db.asset.create({
    data: { projectId, type: 'VIDEO', source: 'GENERATED', uri: `/storage/${projectId}/${crypto.randomUUID()}.mp4` },
  });
  const take = await db.take.create({ data: { shotId: shot.id, slot: 'VIDEO', assetId: asset.id } });
  await db.shot.update({ where: { id: shot.id }, data: { videoSelectedTakeId: take.id } });
  return { shot, asset, take };
}

describe('POST /api/shots/:id/enhance', () => {
  it('无 selected video 400 提前拦截，不入队', async () => {
    const { shot } = await seedShot();
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/enhance`,
      payload: { kind: 'upscale' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('请先生成并选定视频片段');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('kind=upscale → 202 入队 UPSCALE / LOCAL / { shotId }', async () => {
    const { shot } = await seedShotWithSelectedVideo();
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/enhance`,
      payload: { kind: 'upscale' },
    });
    expect(res.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const arg = enqueue.mock.calls[0]![0];
    expect(arg.projectId).toBe(projectId);
    expect(arg.type).toBe('UPSCALE');
    expect(arg.executor).toBe('LOCAL');
    expect(arg.inputPayload).toEqual({ shotId: shot.id });
  });

  it('kind=interpolate → 202 入队 INTERPOLATE', async () => {
    const { shot } = await seedShotWithSelectedVideo();
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/enhance`,
      payload: { kind: 'interpolate' },
    });
    expect(res.statusCode).toBe(202);
    const arg = enqueue.mock.calls[0]![0];
    expect(arg.type).toBe('INTERPOLATE');
    expect(arg.inputPayload).toEqual({ shotId: shot.id });
  });

  it('镜头不存在 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/shots/no-such/enhance',
      payload: { kind: 'upscale' },
    });
    expect(res.statusCode).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('kind 非法 400（zod 校验）', async () => {
    const { shot } = await seedShotWithSelectedVideo();
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/enhance`,
      payload: { kind: 'sharpen' },
    });
    expect(res.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
