import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  vi.unstubAllGlobals();
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
  it('未配 baseUrl：ok=false 提示配置（不区分厂商 category）', async () => {
    const p = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '测试路由厂', vendor: 'v' },
      })
    ).json();
    const res = await app.inject({ method: 'POST', url: `/api/admin/providers/${p.id}/test` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, message: '未配置 Base URL：请填写厂商端点或用「一键接入」自动配置' });
  });

  it('category 为 IMAGE 也走同一逻辑（category 已是兼容字段）', async () => {
    const p = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '测试图厂', vendor: 'v', category: 'IMAGE' },
      })
    ).json();
    const res = await app.inject({ method: 'POST', url: `/api/admin/providers/${p.id}/test` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, message: '未配置 Base URL：请填写厂商端点或用「一键接入」自动配置' });
  });

  it('配置 baseUrl 后 GET /models 成功：连通成功且带 latencyMs', async () => {
    const p = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '测试连通厂', vendor: 'v', baseUrl: 'https://llm.example.com', apiKey: 'sk-x' },
      })
    ).json();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const res = await app.inject({ method: 'POST', url: `/api/admin/providers/${p.id}/test` });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().message).toBe('连通成功');
    expect(typeof res.json().latencyMs).toBe('number');
  });

  it('不存在的厂商返回 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/providers/nope/test' });
    expect(res.statusCode).toBe(404);
  });
});

describe('预置库 / 自动发现 / 批量导入路由', () => {
  it('GET /api/admin/provider-presets：返回完整预置库', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/provider-presets' });
    expect(res.statusCode).toBe(200);
    const { presets } = res.json();
    expect(Array.isArray(presets)).toBe(true);
    expect(presets.length).toBe(7);
    const ark = presets.find((p: { id: string }) => p.id === 'volcengine-ark');
    expect(ark.vendor).toBe('openai-compatible');
    expect(ark.models.some((m: { recommended: boolean }) => m.recommended)).toBe(true);
    expect(ark.models[0].capability).toMatchObject({ modality: 'text' });
  });

  it('POST discover-models：成功返回推断结果；未配 baseUrl/apiKey 返回 400', async () => {
    const bare = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '发现路由空厂', vendor: 'openai-compatible' },
      })
    ).json();
    const r400 = await app.inject({ method: 'POST', url: `/api/admin/providers/${bare.id}/discover-models` });
    expect(r400.statusCode).toBe(400);

    const p = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '发现路由厂', vendor: 'openai-compatible', baseUrl: 'https://ark.example.com/v3', apiKey: 'sk-d' },
      })
    ).json();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'chat-a' }, { id: 'seedream-t2i' }] }), { status: 200 })),
    );
    const res = await app.inject({ method: 'POST', url: `/api/admin/providers/${p.id}/discover-models` });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual([
      { key: 'chat-a', label: 'chat-a', modality: 'text', exists: false },
      { key: 'seedream-t2i', label: 'seedream-t2i', modality: 'image', exists: false },
    ]);
  });

  it('POST discover-models：上游失败返回 502', async () => {
    const p = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '发现路由坏厂', vendor: 'openai-compatible', baseUrl: 'https://down.example.com', apiKey: 'k' },
      })
    ).json();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const res = await app.inject({ method: 'POST', url: `/api/admin/providers/${p.id}/discover-models` });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('无法获取模型列表');
  });

  it('POST models/batch：缺省 capability/label 补全，重复跳过；空数组返回 400', async () => {
    const p = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/providers',
        payload: { name: '批量路由厂', vendor: 'openai-compatible' },
      })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/providers/${p.id}/models/batch`,
      payload: { models: [{ key: 'batch-a', modality: 'text' }, { key: 'seedream-x', modality: 'image' }] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ created: 2, skipped: 0 });

    // 重复导入：全部跳过
    const again = await app.inject({
      method: 'POST',
      url: `/api/admin/providers/${p.id}/models/batch`,
      payload: { models: [{ key: 'batch-a', modality: 'text' }] },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual({ created: 0, skipped: 1 });

    const list = (await app.inject({ method: 'GET', url: `/api/admin/providers/${p.id}/models` })).json();
    const img = list.find((m: { key: string }) => m.key === 'seedream-x');
    expect(img.label).toBe('seedream-x');
    expect(img.capability).toEqual({ modality: 'image', input: ['prompt', 'ref_images'] });
    expect(img.enabled).toBe(true);

    const empty = await app.inject({
      method: 'POST',
      url: `/api/admin/providers/${p.id}/models/batch`,
      payload: { models: [] },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('models/batch 不存在的厂商返回 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/providers/nope/models/batch',
      payload: { models: [{ key: 'k', modality: 'text' }] },
    });
    expect(res.statusCode).toBe(404);
  });
});
