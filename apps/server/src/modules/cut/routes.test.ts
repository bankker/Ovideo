import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { cutRoutes } from './routes.js';

let t: TestDb;
let app: FastifyInstance;
let projectId: string;

const enqueue = vi.fn(async (input: unknown) => ({ id: 'job-1', status: 'QUEUED', input }));

beforeAll(async () => {
  t = await createTestDb();
  const p = await t.db.project.create({ data: { name: 'cut 路由测试项目' } });
  projectId = p.id;
  app = Fastify();
  // 错误处理器必须先于路由插件注册（否则 zod 400 变 500）
  registerErrorHandler(app);
  await app.register(cutRoutes, { db: t.db, enqueue });
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

beforeEach(() => {
  enqueue.mockClear();
});

/** 分集 + 分镜 + N 个已选定视频 take 的镜头 */
async function makeFixture(db: PrismaClient, shotCount: number, selectAll = true) {
  const episode = await db.episode.create({ data: { projectId, title: '第1集' } });
  const draft = await db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
  const storyboard = await db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  for (let i = 0; i < shotCount; i++) {
    const shot = await db.shot.create({ data: { storyboardId: storyboard.id, sortOrder: i } });
    if (!selectAll) continue;
    const asset = await db.asset.create({
      data: {
        projectId,
        type: 'VIDEO',
        source: 'GENERATED',
        uri: `/storage/${projectId}/${shot.id}.mp4`,
        durationMs: 1000,
      },
    });
    const take = await db.take.create({ data: { shotId: shot.id, slot: 'VIDEO', assetId: asset.id } });
    await db.shot.update({ where: { id: shot.id }, data: { videoSelectedTakeId: take.id } });
  }
  return { episode, storyboard };
}

describe('POST /api/episodes/:id/cuts', () => {
  it('创建 Cut 并入队 COMPOSE_CUT → 202 { cut, job }', async () => {
    const { episode, storyboard } = await makeFixture(t.db, 2);
    const res = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/cuts`,
      payload: { storyboardId: storyboard.id },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.cut.status).toBe('COMPOSING');
    expect(body.cut.items).toHaveLength(2);
    expect(body.job.id).toBe('job-1');

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [input] = enqueue.mock.calls[0] as [Record<string, unknown>];
    expect(input.projectId).toBe(projectId);
    expect(input.type).toBe('COMPOSE_CUT');
    expect(input.executor).toBe('MOCK');
    expect(input.inputPayload).toEqual({ cutId: body.cut.id });
  });

  it('有镜头未选定视频 → 400 且不入队', async () => {
    const { episode, storyboard } = await makeFixture(t.db, 2, false);
    const res = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/cuts`,
      payload: { storyboardId: storyboard.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('以下镜头还没有选定视频片段');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('分集不存在 → 404；body 缺 storyboardId → 400', async () => {
    const res404 = await app.inject({
      method: 'POST',
      url: '/api/episodes/nope/cuts',
      payload: { storyboardId: 'x' },
    });
    expect(res404.statusCode).toBe(404);

    const { episode } = await makeFixture(t.db, 1);
    const res400 = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/cuts`,
      payload: {},
    });
    expect(res400.statusCode).toBe(400);
  });
});

describe('GET cuts', () => {
  it('GET /api/episodes/:id/cuts 新版本在前；GET /api/cuts/:id 返回详情', async () => {
    const { episode, storyboard } = await makeFixture(t.db, 1);
    const r1 = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/cuts`,
      payload: { storyboardId: storyboard.id },
    });
    const r2 = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/cuts`,
      payload: { storyboardId: storyboard.id },
    });
    const id1 = r1.json().cut.id as string;
    const id2 = r2.json().cut.id as string;

    const list = await app.inject({ method: 'GET', url: `/api/episodes/${episode.id}/cuts` });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((c: { id: string }) => c.id)).toEqual([id2, id1]);

    const one = await app.inject({ method: 'GET', url: `/api/cuts/${id1}` });
    expect(one.statusCode).toBe(200);
    expect(one.json().id).toBe(id1);
    expect(one.json().items).toHaveLength(1);
    expect(one.json().outputAsset).toBeNull();

    const missing = await app.inject({ method: 'GET', url: '/api/cuts/nope' });
    expect(missing.statusCode).toBe(404);
  });
});
