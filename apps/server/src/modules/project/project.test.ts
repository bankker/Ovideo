import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { projectRoutes } from './routes.js';

let tdb: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  tdb = await createTestDb();
  app = Fastify();
  // 先注册错误处理器再挂路由：Fastify 子上下文只继承注册时已存在的 errorHandler
  registerErrorHandler(app);
  await app.register(projectRoutes, { db: tdb.db });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await tdb.cleanup();
});

describe('project 路由', () => {
  it('POST 创建项目并返回 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '测试项目', description: '描述' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('测试项目');
    expect(body.archived).toBe(false);
  });

  it('POST 空名字返回 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '' } });
    expect(res.statusCode).toBe(400);
  });

  it('GET 列表支持 archived 过滤', async () => {
    const a = await tdb.db.project.create({ data: { name: '活跃项目' } });
    const b = await tdb.db.project.create({ data: { name: '归档项目', archived: true } });

    const all = await app.inject({ method: 'GET', url: '/api/projects' });
    const allIds = all.json().map((p: { id: string }) => p.id);
    expect(allIds).toContain(a.id);
    expect(allIds).toContain(b.id);

    const active = await app.inject({ method: 'GET', url: '/api/projects?archived=false' });
    const activeIds = active.json().map((p: { id: string }) => p.id);
    expect(activeIds).toContain(a.id);
    expect(activeIds).not.toContain(b.id);

    const archived = await app.inject({ method: 'GET', url: '/api/projects?archived=true' });
    const archivedIds = archived.json().map((p: { id: string }) => p.id);
    expect(archivedIds).toContain(b.id);
    expect(archivedIds).not.toContain(a.id);
  });

  it('GET/:id 返回项目，未知 id 返回 404', async () => {
    const p = await tdb.db.project.create({ data: { name: '详情项目' } });
    const ok = await app.inject({ method: 'GET', url: `/api/projects/${p.id}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().name).toBe('详情项目');

    const miss = await app.inject({ method: 'GET', url: '/api/projects/nope' });
    expect(miss.statusCode).toBe(404);
  });

  it('PATCH 可改名与归档', async () => {
    const p = await tdb.db.project.create({ data: { name: '待改名' } });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${p.id}`,
      payload: { name: '新名字', archived: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('新名字');
    expect(res.json().archived).toBe(true);
  });

  it('DELETE 直接删除并级联清理分集', async () => {
    const p = await tdb.db.project.create({ data: { name: '待删除' } });
    const e = await tdb.db.episode.create({ data: { projectId: p.id, title: '第一集' } });

    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
    expect(res.statusCode).toBe(200);
    expect(await tdb.db.project.findUnique({ where: { id: p.id } })).toBeNull();
    expect(await tdb.db.episode.findUnique({ where: { id: e.id } })).toBeNull();

    const again = await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` });
    expect(again.statusCode).toBe(404);
  });
});
