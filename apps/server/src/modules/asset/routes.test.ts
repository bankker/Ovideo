import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { STORAGE_ROOT, uriToAbsPath } from '../../lib/storage.js';
import { assetRoutes } from './routes.js';
import { createAsset } from './service.js';

let t: TestDb;
let app: FastifyInstance;
let projectId: string;

beforeAll(async () => {
  t = await createTestDb();
  const p = await t.db.project.create({ data: { name: '上传测试项目' } });
  projectId = p.id;
  app = Fastify();
  // 错误处理器必须先于路由插件注册：encapsulated context 在注册时快照父级 handler
  registerErrorHandler(app);
  await app.register(multipart);
  await app.register(assetRoutes, { db: t.db });
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
  // 清理本测试落盘的上传文件
  fs.rmSync(path.join(STORAGE_ROOT, projectId), { recursive: true, force: true });
});

/** 手拼 multipart 请求体（fastify inject 支持 payload + headers） */
function multipartPayload(filename: string, contentType: string, data: Buffer) {
  const boundary = '----ovideo-test-boundary';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, data, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('POST /api/projects/:projectId/assets/upload', () => {
  it('image/* 上传落盘并建 IMAGE + UPLOADED 资产', async () => {
    const data = Buffer.from('fake-png-bytes-测试');
    const { payload, headers } = multipartPayload('cover.png', 'image/png', data);
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assets/upload`,
      payload,
      headers,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.type).toBe('IMAGE');
    expect(body.source).toBe('UPLOADED');
    expect(body.mime).toBe('image/png');
    expect(body.sizeBytes).toBe(data.length);
    expect(body.uri).toMatch(new RegExp(`^/storage/${projectId}/.+\\.png$`));
    // 落盘校验：文件内容与上传字节一致
    expect(fs.readFileSync(uriToAbsPath(body.uri))).toEqual(data);
  });

  it('video/* → VIDEO，audio/* → AUDIO', async () => {
    const v = multipartPayload('clip.mp4', 'video/mp4', Buffer.from('v'));
    const resV = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assets/upload`,
      payload: v.payload,
      headers: v.headers,
    });
    expect(resV.statusCode).toBe(201);
    expect(resV.json().type).toBe('VIDEO');

    const a = multipartPayload('voice.wav', 'audio/wav', Buffer.from('a'));
    const resA = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assets/upload`,
      payload: a.payload,
      headers: a.headers,
    });
    expect(resA.statusCode).toBe(201);
    expect(resA.json().type).toBe('AUDIO');
  });

  it('不支持的 mime 前缀 → 400', async () => {
    const { payload, headers } = multipartPayload('doc.pdf', 'application/pdf', Buffer.from('p'));
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assets/upload`,
      payload,
      headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it('项目不存在 → 404', async () => {
    const { payload, headers } = multipartPayload('x.png', 'image/png', Buffer.from('x'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/nope/assets/upload',
      payload,
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/projects/:projectId/assets', () => {
  it('默认列 ACTIVE，支持 type/status 过滤', async () => {
    const p = await t.db.project.create({ data: { name: '列表项目' } });
    const img = await createAsset(t.db, {
      projectId: p.id,
      type: 'IMAGE',
      source: 'GENERATED',
      uri: `/storage/${p.id}/a.png`,
    });
    const vid = await createAsset(t.db, {
      projectId: p.id,
      type: 'VIDEO',
      source: 'GENERATED',
      uri: `/storage/${p.id}/b.mp4`,
    });

    const resAll = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/assets` });
    expect(resAll.statusCode).toBe(200);
    expect(new Set(resAll.json().map((x: { id: string }) => x.id))).toEqual(
      new Set([img.id, vid.id]),
    );

    const resImg = await app.inject({
      method: 'GET',
      url: `/api/projects/${p.id}/assets?type=IMAGE`,
    });
    expect(resImg.json().map((x: { id: string }) => x.id)).toEqual([img.id]);

    const resBad = await app.inject({
      method: 'GET',
      url: `/api/projects/${p.id}/assets?type=DOC`,
    });
    expect(resBad.statusCode).toBe(400);
  });
});

describe('recycle / restore / lineage 路由', () => {
  it('回收后默认列表不可见，恢复后可见', async () => {
    const p = await t.db.project.create({ data: { name: '回收项目' } });
    const a = await createAsset(t.db, {
      projectId: p.id,
      type: 'IMAGE',
      source: 'GENERATED',
      uri: `/storage/${p.id}/r.png`,
    });

    const rec = await app.inject({ method: 'POST', url: `/api/assets/${a.id}/recycle` });
    expect(rec.statusCode).toBe(200);
    expect(rec.json().status).toBe('RECYCLED');

    const listAfterRecycle = await app.inject({
      method: 'GET',
      url: `/api/projects/${p.id}/assets`,
    });
    expect(listAfterRecycle.json()).toEqual([]);

    const resRestore = await app.inject({ method: 'POST', url: `/api/assets/${a.id}/restore` });
    expect(resRestore.json().status).toBe('ACTIVE');

    const res404 = await app.inject({ method: 'POST', url: '/api/assets/nope/recycle' });
    expect(res404.statusCode).toBe(404);
  });

  it('GET /api/assets/:id/lineage 返回祖先与后代', async () => {
    const p = await t.db.project.create({ data: { name: '血缘项目' } });
    const a = await createAsset(t.db, {
      projectId: p.id,
      type: 'IMAGE',
      source: 'UPLOADED',
      uri: `/storage/${p.id}/a.png`,
    });
    const b = await createAsset(t.db, {
      projectId: p.id,
      type: 'VIDEO',
      source: 'GENERATED',
      uri: `/storage/${p.id}/b.mp4`,
      parentIds: [a.id],
    });

    const res = await app.inject({ method: 'GET', url: `/api/assets/${b.id}/lineage` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.asset.id).toBe(b.id);
    expect(body.ancestors.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect(body.descendants).toEqual([]);
  });
});
