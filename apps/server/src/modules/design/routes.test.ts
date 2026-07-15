import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type { Project, Tag } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { STORAGE_ROOT, uriToAbsPath } from '../../lib/storage.js';
import { createAsset } from '../asset/service.js';
import { attachDesign } from './service.js';
import { designRoutes } from './routes.js';

let t: TestDb;
let app: FastifyInstance;
let project: Project;
let seq = 0;

const enqueue = vi.fn(async (input: unknown) => ({ id: 'job-1', status: 'QUEUED', input }));

beforeAll(async () => {
  t = await createTestDb();
  app = Fastify();
  // 错误处理器必须先于路由插件注册：encapsulated context 在注册时快照父级 handler
  registerErrorHandler(app);
  await app.register(multipart);
  await app.register(designRoutes, { db: t.db, enqueue });
  await app.ready();
  project = await t.db.project.create({ data: { name: '设计路由项目' } });
});

beforeEach(() => {
  enqueue.mockClear();
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
  // 清理本测试落盘的上传文件
  fs.rmSync(path.join(STORAGE_ROOT, project.id), { recursive: true, force: true });
});

async function makeTag(name: string, description = ''): Promise<Tag> {
  return t.db.tag.create({ data: { projectId: project.id, type: 'CHARACTER', name, description } });
}

async function makeImage() {
  seq += 1;
  return createAsset(t.db, {
    projectId: project.id,
    type: 'IMAGE',
    source: 'UPLOADED',
    uri: `/storage/${project.id}/routes-${seq}.png`,
  });
}

/** 手拼 multipart 请求体（fastify inject 支持 payload + headers） */
function multipartPayload(filename: string, contentType: string, data: Buffer) {
  const boundary = '----ovideo-design-boundary';
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

describe('GET /api/tags/:id/designs', () => {
  it('标签不存在 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tags/nope/designs' });
    expect(res.statusCode).toBe(404);
  });

  it('返回 { tag, designs }，designs 按 createdAt desc 且带 asset', async () => {
    const tag = await makeTag('列表路由标签');
    const a1 = await makeImage();
    const a2 = await makeImage();
    await t.db.tagDesign.create({
      data: { tagId: tag.id, assetId: a1.id, createdAt: new Date('2026-01-01T00:00:00Z') },
    });
    await t.db.tagDesign.create({
      data: { tagId: tag.id, assetId: a2.id, createdAt: new Date('2026-01-02T00:00:00Z') },
    });

    const res = await app.inject({ method: 'GET', url: `/api/tags/${tag.id}/designs` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tag.id).toBe(tag.id);
    expect(body.designs.map((d: { assetId: string }) => d.assetId)).toEqual([a2.id, a1.id]);
    expect(body.designs[0].asset.uri).toBe(a2.uri);
  });
});

describe('POST /api/tags/:id/designs/generate', () => {
  it('缺省 prompt 组装自「名，描述」，MOCK 执行器，入队参数一字不差', async () => {
    const tag = await makeTag('生成标签', '短发少女');
    const res = await app.inject({
      method: 'POST',
      url: `/api/tags/${tag.id}/designs/generate`,
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().id).toBe('job-1');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      projectId: project.id,
      type: 'GENERATE_IMAGE',
      executor: 'MOCK',
      // kind:'design' 是与 generation 执行器的跨模块契约
      inputPayload: { kind: 'design', tagId: tag.id, prompt: '生成标签，短发少女' },
    });
  });

  it('指定 modelConfigId → API 执行器；自定义 prompt 透传', async () => {
    const tag = await makeTag('生成标签2', '描述');
    const res = await app.inject({
      method: 'POST',
      url: `/api/tags/${tag.id}/designs/generate`,
      payload: { modelConfigId: 'model-9', prompt: '水彩风格立绘' },
    });
    expect(res.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledWith({
      projectId: project.id,
      type: 'GENERATE_IMAGE',
      executor: 'API',
      inputPayload: {
        kind: 'design',
        tagId: tag.id,
        prompt: '水彩风格立绘',
        modelConfigId: 'model-9',
      },
    });
  });

  it('标签不存在 → 404 且不入队', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tags/nope/designs/generate',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('POST /api/tags/:id/designs/upload', () => {
  it('上传落盘建 IMAGE+UPLOADED 资产并关联；首张自动 canonical', async () => {
    const tag = await makeTag('上传标签');
    const data = Buffer.from('fake-design-png-字节');
    const { payload, headers } = multipartPayload('design.png', 'image/png', data);
    const res = await app.inject({
      method: 'POST',
      url: `/api/tags/${tag.id}/designs/upload`,
      payload,
      headers,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.asset.type).toBe('IMAGE');
    expect(body.asset.source).toBe('UPLOADED');
    expect(body.asset.sizeBytes).toBe(data.length);
    expect(body.design.tagId).toBe(tag.id);
    expect(body.design.assetId).toBe(body.asset.id);
    expect(fs.readFileSync(uriToAbsPath(body.asset.uri))).toEqual(data);

    // 首张自动设为 canonical
    const tagAfter = await t.db.tag.findUnique({ where: { id: tag.id } });
    expect(tagAfter?.canonicalAssetId).toBe(body.asset.id);

    // 第二张不覆盖已有 canonical
    const second = multipartPayload('design2.png', 'image/png', Buffer.from('2'));
    const res2 = await app.inject({
      method: 'POST',
      url: `/api/tags/${tag.id}/designs/upload`,
      payload: second.payload,
      headers: second.headers,
    });
    expect(res2.statusCode).toBe(201);
    const tagAfter2 = await t.db.tag.findUnique({ where: { id: tag.id } });
    expect(tagAfter2?.canonicalAssetId).toBe(body.asset.id);
  });

  it('非图片 mime → 400；标签不存在 → 404', async () => {
    const tag = await makeTag('上传校验标签');
    const bad = multipartPayload('clip.mp4', 'video/mp4', Buffer.from('v'));
    const res = await app.inject({
      method: 'POST',
      url: `/api/tags/${tag.id}/designs/upload`,
      payload: bad.payload,
      headers: bad.headers,
    });
    expect(res.statusCode).toBe(400);

    const ok = multipartPayload('x.png', 'image/png', Buffer.from('x'));
    const res404 = await app.inject({
      method: 'POST',
      url: '/api/tags/nope/designs/upload',
      payload: ok.payload,
      headers: ok.headers,
    });
    expect(res404.statusCode).toBe(404);
  });
});

describe('POST /api/tags/:id/canonical', () => {
  it('asset 必须属于该 tag 的 designs，否则 400；合法则更新并返回 tag', async () => {
    const tag = await makeTag('canonical标签');
    const inDesigns = await makeImage();
    const outside = await makeImage();
    await attachDesign(t.db, tag.id, inDesigns.id);

    const resBad = await app.inject({
      method: 'POST',
      url: `/api/tags/${tag.id}/canonical`,
      payload: { assetId: outside.id },
    });
    expect(resBad.statusCode).toBe(400);

    const resOk = await app.inject({
      method: 'POST',
      url: `/api/tags/${tag.id}/canonical`,
      payload: { assetId: inDesigns.id },
    });
    expect(resOk.statusCode).toBe(200);
    expect(resOk.json().canonicalAssetId).toBe(inDesigns.id);
  });

  it('缺 assetId → 400（zod）；标签不存在 → 404', async () => {
    const tag = await makeTag('canonical校验标签');
    const resZod = await app.inject({
      method: 'POST',
      url: `/api/tags/${tag.id}/canonical`,
      payload: {},
    });
    expect(resZod.statusCode).toBe(400);

    const res404 = await app.inject({
      method: 'POST',
      url: '/api/tags/nope/canonical',
      payload: { assetId: 'whatever' },
    });
    expect(res404.statusCode).toBe(404);
  });
});

describe('DELETE /api/designs/:id', () => {
  it('删行不删资产；恰是 canonical 则清空指针', async () => {
    const tag = await makeTag('删除标签');
    const a = await makeImage();
    const { design } = await attachDesign(t.db, tag.id, a.id); // 自动 canonical

    const res = await app.inject({ method: 'DELETE', url: `/api/designs/${design.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().tag.canonicalAssetId).toBeNull();

    expect(await t.db.tagDesign.findUnique({ where: { id: design.id } })).toBeNull();
    const assetAfter = await t.db.asset.findUnique({ where: { id: a.id } });
    expect(assetAfter?.status).toBe('ACTIVE');
  });

  it('设计图不存在 → 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/designs/nope' });
    expect(res.statusCode).toBe(404);
  });
});
