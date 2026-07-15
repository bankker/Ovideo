import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Project } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { episodeRoutes } from './routes.js';

let tdb: TestDb;
let app: FastifyInstance;
let project: Project;

beforeAll(async () => {
  tdb = await createTestDb();
  app = Fastify();
  // 先注册错误处理器再挂路由：Fastify 子上下文只继承注册时已存在的 errorHandler
  registerErrorHandler(app);
  await app.register(episodeRoutes, { db: tdb.db });
  await app.ready();
  project = await tdb.db.project.create({ data: { name: '项目' } });
});

afterAll(async () => {
  await app.close();
  await tdb.cleanup();
});

describe('episode 路由', () => {
  it('POST 创建分集，sortOrder 自动递增', async () => {
    const r1 = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/episodes`,
      payload: { title: '第一集' },
    });
    expect(r1.statusCode).toBe(201);
    const r2 = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/episodes`,
      payload: { title: '第二集' },
    });
    expect(r2.json().sortOrder).toBeGreaterThan(r1.json().sortOrder);
  });

  it('GET 按 sortOrder 排序返回本项目分集', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/episodes` });
    expect(res.statusCode).toBe(200);
    const titles = res.json().map((e: { title: string }) => e.title);
    expect(titles).toEqual(['第一集', '第二集']);
  });

  it('GET 未知项目返回 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/nope/episodes' });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH 可改标题与 sortOrder', async () => {
    const e = await tdb.db.episode.create({
      data: { projectId: project.id, title: '待改', sortOrder: 9 },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/episodes/${e.id}`,
      payload: { title: '已改', sortOrder: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('已改');
    expect(res.json().sortOrder).toBe(1);
  });

  it('PATCH 未知分集返回 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/episodes/nope',
      payload: { title: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE 删除分集并级联清理剧本稿', async () => {
    const e = await tdb.db.episode.create({ data: { projectId: project.id, title: '待删' } });
    const d = await tdb.db.scriptDraft.create({ data: { episodeId: e.id, isMain: true } });
    const res = await app.inject({ method: 'DELETE', url: `/api/episodes/${e.id}` });
    expect(res.statusCode).toBe(200);
    expect(await tdb.db.episode.findUnique({ where: { id: e.id } })).toBeNull();
    expect(await tdb.db.scriptDraft.findUnique({ where: { id: d.id } })).toBeNull();
  });
});
