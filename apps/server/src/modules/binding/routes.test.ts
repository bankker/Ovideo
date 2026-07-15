import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { bindingRoutes } from './routes.js';

let t: TestDb;
let app: FastifyInstance;
let episodeId: string;
let tagId: string;
let assetId: string;
const onBindingChanged = vi.fn().mockResolvedValue(undefined);

beforeAll(async () => {
  t = await createTestDb();
  const project = await t.db.project.create({ data: { name: '绑定路由测试' } });
  const episode = await t.db.episode.create({ data: { projectId: project.id, title: '第1集' } });
  episodeId = episode.id;
  tagId = (
    await t.db.tag.create({ data: { projectId: project.id, type: 'CHARACTER', name: '沈娘' } })
  ).id;
  assetId = (
    await t.db.asset.create({
      data: {
        projectId: project.id,
        type: 'IMAGE',
        source: 'GENERATED',
        uri: `/storage/${project.id}/x.png`,
      },
    })
  ).id;

  app = Fastify();
  // 错误处理器必须先于路由插件注册：encapsulated context 在注册时快照父级 handler
  registerErrorHandler(app);
  await app.register(bindingRoutes, { db: t.db, hooks: { onBindingChanged } });
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe('PUT /api/episodes/:id/bindings', () => {
  it('写入标签级绑定并触发注入的钩子', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/episodes/${episodeId}/bindings`,
      payload: { tagId, assetId }, // shotId 省略 → 默认 null（标签级）
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.binding.tagId).toBe(tagId);
    expect(body.binding.assetId).toBe(assetId);
    expect(body.binding.shotId).toBeNull();
    // 不能用 toHaveBeenCalledWith 深比较 PrismaClient（代理对象会撑爆相等性遍历的调用栈）
    expect(onBindingChanged).toHaveBeenCalledTimes(1);
    const call = onBindingChanged.mock.calls[0] as unknown[];
    expect(call[0]).toBe(t.db);
    expect(call.slice(1)).toEqual([episodeId, tagId, undefined]);
  });

  it('assetId = null 删除绑定，返回 binding: null', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/episodes/${episodeId}/bindings`,
      payload: { tagId, shotId: null, assetId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().binding).toBeNull();
  });

  it('body 不合法 → 400；分集不存在 → 404', async () => {
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/episodes/${episodeId}/bindings`,
      payload: { assetId }, // 缺 tagId
    });
    expect(bad.statusCode).toBe(400);

    const gone = await app.inject({
      method: 'PUT',
      url: '/api/episodes/nope/bindings',
      payload: { tagId, assetId },
    });
    expect(gone.statusCode).toBe(404);
  });
});

describe('GET /api/episodes/:id/bindings', () => {
  it('返回本集全部绑定行', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/episodes/${episodeId}/bindings`,
      payload: { tagId, assetId },
    });
    const res = await app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/bindings` });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].assetId).toBe(assetId);
  });

  it('分集不存在 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/episodes/nope/bindings' });
    expect(res.statusCode).toBe(404);
  });
});
