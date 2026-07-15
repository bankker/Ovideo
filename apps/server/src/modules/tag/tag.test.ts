import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Project } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { tagRoutes } from './routes.js';
import { findOrCreateTags } from './service.js';

let tdb: TestDb;
let app: FastifyInstance;
let project: Project;

beforeAll(async () => {
  tdb = await createTestDb();
  app = Fastify();
  // 先注册错误处理器再挂路由：Fastify 子上下文只继承注册时已存在的 errorHandler
  registerErrorHandler(app);
  await app.register(tagRoutes, { db: tdb.db });
  await app.ready();
  project = await tdb.db.project.create({ data: { name: '项目' } });
});

afterAll(async () => {
  await app.close();
  await tdb.cleanup();
});

describe('tag 路由', () => {
  it('POST 创建标签，重名返回 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/tags`,
      payload: { type: 'CHARACTER', name: '林凡', description: '男主' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('林凡');

    const dup = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/tags`,
      payload: { type: 'SCENE', name: '林凡' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('POST 未知项目返回 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/nope/tags',
      payload: { type: 'PROP', name: '长剑' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET 列出项目标签', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/tags` });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((t: { name: string }) => t.name)).toContain('林凡');
  });

  it('PATCH 可改名/描述，重名 409，未知 404', async () => {
    const t = await tdb.db.tag.create({
      data: { projectId: project.id, type: 'SCENE', name: '天台' },
    });
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/tags/${t.id}`,
      payload: { name: '夜晚天台', description: '决战地' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().name).toBe('夜晚天台');

    const dup = await app.inject({
      method: 'PATCH',
      url: `/api/tags/${t.id}`,
      payload: { name: '林凡' },
    });
    expect(dup.statusCode).toBe(409);

    const miss = await app.inject({ method: 'PATCH', url: '/api/tags/nope', payload: {} });
    expect(miss.statusCode).toBe(404);
  });

  it('PATCH canonicalAssetId 可设可清（null），跨项目资产拒绝', async () => {
    const t = await tdb.db.tag.create({
      data: { projectId: project.id, type: 'CHARACTER', name: '苏瑶' },
    });
    const asset = await tdb.db.asset.create({
      data: { projectId: project.id, type: 'IMAGE', source: 'UPLOADED', uri: '/a.png' },
    });

    const set = await app.inject({
      method: 'PATCH',
      url: `/api/tags/${t.id}`,
      payload: { canonicalAssetId: asset.id },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().canonicalAssetId).toBe(asset.id);

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/tags/${t.id}`,
      payload: { canonicalAssetId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().canonicalAssetId).toBeNull();

    const other = await tdb.db.project.create({ data: { name: '别的项目' } });
    const foreign = await tdb.db.asset.create({
      data: { projectId: other.id, type: 'IMAGE', source: 'UPLOADED', uri: '/b.png' },
    });
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/tags/${t.id}`,
      payload: { canonicalAssetId: foreign.id },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('findOrCreateTags', () => {
  it('同名复用、缺失新建、入参去重', async () => {
    const p = await tdb.db.project.create({ data: { name: '解析项目' } });
    const existing = await tdb.db.tag.create({
      data: { projectId: p.id, type: 'CHARACTER', name: '林凡' },
    });

    const result = await findOrCreateTags(tdb.db, p.id, [
      { name: '林凡', type: 'CHARACTER' },
      { name: '苏瑶', type: 'CHARACTER' },
      { name: '苏瑶', type: 'CHARACTER' },
      { name: '天台', type: 'SCENE' },
    ]);
    expect(result.map((t) => t.name)).toEqual(['林凡', '苏瑶', '天台']);
    expect(result[0].id).toBe(existing.id);

    const count = await tdb.db.tag.count({ where: { projectId: p.id } });
    expect(count).toBe(3);

    // 同名不同 type：仍复用库内已有标签（名字是项目内唯一键）
    const again = await findOrCreateTags(tdb.db, p.id, [{ name: '林凡', type: 'SCENE' }]);
    expect(again[0].id).toBe(existing.id);
    expect(again[0].type).toBe('CHARACTER');
    expect(await tdb.db.tag.count({ where: { projectId: p.id } })).toBe(3);
  });

  it('空入参返回空数组', async () => {
    expect(await findOrCreateTags(tdb.db, project.id, [])).toEqual([]);
  });
});
