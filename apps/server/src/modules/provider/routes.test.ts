import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { providerRoutes } from './routes.js';

let t: TestDb;
let db: PrismaClient;
let app: FastifyInstance;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  app = Fastify();
  // 错误处理器须先于路由插件注册：Fastify 子作用域在创建时继承父级 errorHandler，
  // 与集成态 app.ts（先 registerErrorHandler 再挂模块路由）保持一致
  registerErrorHandler(app);
  await app.register(providerRoutes, { db });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

const textCapability = { modality: 'text', input: ['prompt'] };

describe('providers 路由', () => {
  it('POST 创建厂商，响应中 apiKey 脱敏', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/providers',
      payload: {
        name: '路由厂',
        vendor: 'openai',
        category: 'TEXT',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-secret-123456',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('路由厂');
    expect(body.apiKey).toBe('sk-s***56');
    expect(body.apiKey).not.toContain('secret');
  });

  it('GET 列表：apiKey 脱敏且含 models', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/providers' });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(Array.isArray(list)).toBe(true);
    const p = list.find((x: { name: string }) => x.name === '路由厂');
    expect(p).toBeTruthy();
    expect(p.apiKey).toBe('sk-s***56');
    expect(Array.isArray(p.models)).toBe(true);
  });

  it('PATCH 更新；DELETE 删除', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '临时厂', vendor: 'v', category: 'TEXT' },
      })
    ).json();

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/admin/providers/${created.id}`,
      payload: { name: '临时厂改', enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().name).toBe('临时厂改');
    expect(patched.json().enabled).toBe(false);

    const del = await app.inject({ method: 'DELETE', url: `/api/admin/providers/${created.id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json().ok).toBe(true);

    const gone = await app.inject({
      method: 'PATCH',
      url: `/api/admin/providers/${created.id}`,
      payload: { name: 'x' },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('POST 参数非法返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/providers',
      payload: { vendor: 'v', category: 'TEXT' }, // 缺 name
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('models 路由', () => {
  it('POST/GET/PATCH/DELETE 模型；capability 解析后存储并以对象返回', async () => {
    const p = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '模型路由厂', vendor: 'v', category: 'TEXT' },
      })
    ).json();

    const created = await app.inject({
      method: 'POST',
      url: `/api/admin/providers/${p.id}/models`,
      payload: { key: 'm1', label: '模型一', modality: 'text', capability: textCapability },
    });
    expect(created.statusCode).toBe(201);
    const model = created.json();
    expect(model.key).toBe('m1');
    expect(model.capability).toMatchObject({ modality: 'text', input: ['prompt'] });

    const list = await app.inject({ method: 'GET', url: `/api/admin/providers/${p.id}/models` });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((m: { key: string }) => m.key)).toEqual(['m1']);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/admin/models/${model.id}`,
      payload: { label: '模型一改', enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().label).toBe('模型一改');
    expect(patched.json().enabled).toBe(false);

    const del = await app.inject({ method: 'DELETE', url: `/api/admin/models/${model.id}` });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/admin/providers/${p.id}/models` })).json()).toEqual([]);
  });

  it('capability 非法（缺 modality）返回 400', async () => {
    const p = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '坏能力厂', vendor: 'v', category: 'TEXT' },
      })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/providers/${p.id}/models`,
      payload: { key: 'bad', label: '坏', modality: 'text', capability: { input: ['prompt'] } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('重复 key 返回 409', async () => {
    const p = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '重复key路由厂', vendor: 'v', category: 'TEXT' },
      })
    ).json();
    const payload = { key: 'dup', label: '重', modality: 'text', capability: textCapability };
    await app.inject({ method: 'POST', url: `/api/admin/providers/${p.id}/models`, payload });
    const res = await app.inject({ method: 'POST', url: `/api/admin/providers/${p.id}/models`, payload });
    expect(res.statusCode).toBe(409);
  });
});

describe('capabilities 路由', () => {
  it('仅返回 enabled 厂商/模型的投影，支持 modality 过滤', async () => {
    const pOn = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '能力路由厂', vendor: 'v', category: 'IMAGE' },
      })
    ).json();
    const pOff = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '能力停用厂', vendor: 'v', category: 'IMAGE', enabled: false },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/api/admin/providers/${pOn.id}/models`,
      payload: { key: 'img-on', label: '图上', modality: 'image', capability: { modality: 'image' } },
    });
    await app.inject({
      method: 'POST',
      url: `/api/admin/providers/${pOn.id}/models`,
      payload: { key: 'img-off', label: '图停', modality: 'image', capability: { modality: 'image' }, enabled: false },
    });
    await app.inject({
      method: 'POST',
      url: `/api/admin/providers/${pOff.id}/models`,
      payload: { key: 'img-x', label: '图X', modality: 'image', capability: { modality: 'image' } },
    });

    const res = await app.inject({ method: 'GET', url: '/api/capabilities?modality=image' });
    expect(res.statusCode).toBe(200);
    const keys = res.json().map((e: { modelKey: string }) => e.modelKey);
    expect(keys).toContain('img-on');
    expect(keys).not.toContain('img-off');
    expect(keys).not.toContain('img-x');
    const entry = res.json().find((e: { modelKey: string }) => e.modelKey === 'img-on');
    expect(entry.providerName).toBe('能力路由厂');
    expect(entry.capability.modality).toBe('image');
    // 能力投影不暴露 apiKey
    expect(entry.apiKey).toBeUndefined();
  });

  it('modality 非法返回 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/capabilities?modality=nope' });
    expect(res.statusCode).toBe(400);
  });
});

describe('连通测试路由', () => {
  it('TEXT 且未配 baseUrl：MOCK 模式 ok', async () => {
    const p = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '测试路由厂', vendor: 'v', category: 'TEXT' },
      })
    ).json();
    const res = await app.inject({ method: 'POST', url: `/api/admin/providers/${p.id}/test` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, message: 'MOCK 模式（未配置 baseUrl）' });
  });

  it('非 TEXT：ok=false', async () => {
    const p = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '测试图厂', vendor: 'v', category: 'IMAGE' },
      })
    ).json();
    const res = await app.inject({ method: 'POST', url: `/api/admin/providers/${p.id}/test` });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
  });

  it('不存在的厂商返回 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/providers/nope/test' });
    expect(res.statusCode).toBe(404);
  });
});
