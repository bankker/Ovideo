import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { AppError } from '../../lib/errors.js';
import {
  createModel,
  createProvider,
  deleteModel,
  deleteProvider,
  getProvider,
  listCapabilities,
  listModels,
  listProviders,
  maskKey,
  testProvider,
  updateModel,
  updateProvider,
} from './service.js';

let t: TestDb;
let db: PrismaClient;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});

afterAll(async () => {
  await t.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const textCapability = { modality: 'text' as const, input: ['prompt' as const] };

describe('maskKey', () => {
  it('保留前 4 后 2，中间脱敏', () => {
    expect(maskKey('sk-test-abcdef')).toBe('sk-t***ef');
  });
  it('空串返回空串', () => {
    expect(maskKey('')).toBe('');
  });
  it('短 key 整体脱敏（避免前后截取泄露全文）', () => {
    expect(maskKey('abcde')).toBe('***');
  });
});

describe('provider CRUD', () => {
  it('创建 / 查询 / 更新 / 删除', async () => {
    const p = await createProvider(db, {
      name: 'CRUD厂',
      vendor: 'openai',
      category: 'TEXT',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-1234567890',
      enabled: true,
    });
    expect(p.id).toBeTruthy();

    const fetched = await getProvider(db, p.id);
    expect(fetched.name).toBe('CRUD厂');
    expect(fetched.models).toEqual([]);

    const updated = await updateProvider(db, p.id, { name: 'CRUD厂改', enabled: false });
    expect(updated.name).toBe('CRUD厂改');
    expect(updated.enabled).toBe(false);

    const all = await listProviders(db);
    expect(all.some((x) => x.id === p.id)).toBe(true);

    await deleteProvider(db, p.id);
    await expect(getProvider(db, p.id)).rejects.toThrow(AppError);
  });

  it('更新/删除不存在的厂商抛 404', async () => {
    await expect(updateProvider(db, 'nope', { name: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteProvider(db, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('model CRUD', () => {
  it('创建模型（capability 序列化入 capabilityJson）与列表/更新/删除', async () => {
    const p = await createProvider(db, {
      name: '模型厂',
      vendor: 'v',
      category: 'TEXT',
      baseUrl: '',
      apiKey: '',
      enabled: true,
    });
    const m = await createModel(db, p.id, {
      key: 'gpt-x',
      label: 'GPT X',
      modality: 'text',
      capability: textCapability,
      enabled: true,
      sortOrder: 1,
    });
    expect(JSON.parse(m.capabilityJson).modality).toBe('text');

    const models = await listModels(db, p.id);
    expect(models.map((x) => x.key)).toContain('gpt-x');

    const updated = await updateModel(db, m.id, { label: 'GPT X2', enabled: false });
    expect(updated.label).toBe('GPT X2');
    expect(updated.enabled).toBe(false);

    await deleteModel(db, m.id);
    expect((await listModels(db, p.id)).length).toBe(0);
  });

  it('同厂商下重复 key 抛 409', async () => {
    const p = await createProvider(db, {
      name: '重复key厂',
      vendor: 'v',
      category: 'TEXT',
      baseUrl: '',
      apiKey: '',
      enabled: true,
    });
    const input = {
      key: 'dup',
      label: 'Dup',
      modality: 'text' as const,
      capability: textCapability,
      enabled: true,
      sortOrder: 0,
    };
    await createModel(db, p.id, input);
    await expect(createModel(db, p.id, input)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('在不存在的厂商下建模型抛 404；更新不存在的模型抛 404', async () => {
    await expect(
      createModel(db, 'nope', {
        key: 'k',
        label: 'l',
        modality: 'text',
        capability: textCapability,
        enabled: true,
        sortOrder: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(updateModel(db, 'nope', { label: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteModel(db, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('listCapabilities 能力投影', () => {
  it('仅投影 enabled 厂商下的 enabled 模型，坏 JSON 跳过，按厂商名+sortOrder 排序', async () => {
    const pB = await createProvider(db, {
      name: 'B能力厂',
      vendor: 'v',
      category: 'TEXT',
      baseUrl: '',
      apiKey: '',
      enabled: true,
    });
    const pA = await createProvider(db, {
      name: 'A能力厂',
      vendor: 'v',
      category: 'TEXT',
      baseUrl: '',
      apiKey: '',
      enabled: true,
    });
    const pOff = await createProvider(db, {
      name: '停用厂',
      vendor: 'v',
      category: 'TEXT',
      baseUrl: '',
      apiKey: '',
      enabled: false,
    });

    // B 厂两个模型，sortOrder 逆序创建以验证排序
    await createModel(db, pB.id, { key: 'b2', label: 'B2', modality: 'text', capability: textCapability, enabled: true, sortOrder: 2 });
    await createModel(db, pB.id, { key: 'b1', label: 'B1', modality: 'text', capability: textCapability, enabled: true, sortOrder: 1 });
    // B 厂 disabled 模型不出现
    await createModel(db, pB.id, { key: 'b-off', label: 'BOff', modality: 'text', capability: textCapability, enabled: false, sortOrder: 0 });
    // A 厂一个 image 模型（用于 modality 过滤验证）
    await createModel(db, pA.id, { key: 'a-img', label: 'AImg', modality: 'image', capability: { modality: 'image' as const, input: ['prompt' as const] }, enabled: true, sortOrder: 0 });
    // 停用厂的 enabled 模型不出现
    await createModel(db, pOff.id, { key: 'off-m', label: 'OffM', modality: 'text', capability: textCapability, enabled: true, sortOrder: 0 });
    // 坏 JSON：直接写库绕过服务校验
    await db.modelConfig.create({
      data: { providerConfigId: pA.id, key: 'a-bad', label: 'ABad', modality: 'text', capabilityJson: '{not json', enabled: true, sortOrder: 0 },
    });

    const all = await listCapabilities(db);
    const keys = all.map((e) => e.modelKey);
    expect(keys).toContain('b1');
    expect(keys).toContain('b2');
    expect(keys).toContain('a-img');
    expect(keys).not.toContain('b-off');
    expect(keys).not.toContain('off-m');
    expect(keys).not.toContain('a-bad');

    // 排序：A 厂在 B 厂前；B 厂内 b1(sortOrder1) 在 b2(sortOrder2) 前
    const idxAImg = keys.indexOf('a-img');
    const idxB1 = keys.indexOf('b1');
    const idxB2 = keys.indexOf('b2');
    expect(idxAImg).toBeLessThan(idxB1);
    expect(idxB1).toBeLessThan(idxB2);

    // 条目形状
    const b1 = all.find((e) => e.modelKey === 'b1')!;
    expect(b1.providerName).toBe('B能力厂');
    expect(b1.providerConfigId).toBe(pB.id);
    expect(b1.label).toBe('B1');
    expect(b1.capability.modality).toBe('text');

    // modality 过滤
    const images = await listCapabilities(db, 'image');
    expect(images.map((e) => e.modelKey)).toEqual(['a-img']);
  });
});

describe('testProvider', () => {
  it('非 TEXT 厂商：ok=false 并提示 M1 限制', async () => {
    const p = await createProvider(db, {
      name: '图厂',
      vendor: 'v',
      category: 'IMAGE',
      baseUrl: 'https://img.example.com',
      apiKey: 'k',
      enabled: true,
    });
    const r = await testProvider(db, p.id);
    expect(r.ok).toBe(false);
    expect(r.message).toBe('M1 仅支持 TEXT 厂商真实连通测试');
  });

  it('TEXT 且 baseUrl 为空：MOCK 模式直接 ok', async () => {
    const p = await createProvider(db, {
      name: 'Mock文厂',
      vendor: 'v',
      category: 'TEXT',
      baseUrl: '',
      apiKey: '',
      enabled: true,
    });
    const r = await testProvider(db, p.id);
    expect(r.ok).toBe(true);
    expect(r.message).toBe('MOCK 模式（未配置 baseUrl）');
  });

  it('TEXT 且有 baseUrl：用第一个 enabled 模型发 ping，成功返回 latencyMs', async () => {
    const p = await createProvider(db, {
      name: '真文厂',
      vendor: 'v',
      category: 'TEXT',
      baseUrl: 'https://llm.example.com',
      apiKey: 'sk-real',
      enabled: true,
    });
    await createModel(db, p.id, { key: 'second', label: '次', modality: 'text', capability: textCapability, enabled: true, sortOrder: 5 });
    await createModel(db, p.id, { key: 'first', label: '首', modality: 'text', capability: textCapability, enabled: true, sortOrder: 1 });
    await createModel(db, p.id, { key: 'off', label: '停', modality: 'text', capability: textCapability, enabled: false, sortOrder: 0 });

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await testProvider(db, p.id);
    expect(r.ok).toBe(true);
    expect(typeof r.latencyMs).toBe('number');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('first'); // 取 sortOrder 最小的 enabled 模型
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
  });

  it('TEXT 有 baseUrl 但请求失败：ok=false 且带错误信息', async () => {
    const p = await createProvider(db, {
      name: '坏文厂',
      vendor: 'v',
      category: 'TEXT',
      baseUrl: 'https://bad.example.com',
      apiKey: 'k',
      enabled: true,
    });
    await createModel(db, p.id, { key: 'm', label: 'm', modality: 'text', capability: textCapability, enabled: true, sortOrder: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 401 })));

    const r = await testProvider(db, p.id);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/401/);
  });

  it('TEXT 有 baseUrl 但没有 enabled 模型：ok=false', async () => {
    const p = await createProvider(db, {
      name: '空模型厂',
      vendor: 'v',
      category: 'TEXT',
      baseUrl: 'https://empty.example.com',
      apiKey: 'k',
      enabled: true,
    });
    const r = await testProvider(db, p.id);
    expect(r.ok).toBe(false);
  });

  it('不存在的厂商抛 404', async () => {
    await expect(testProvider(db, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});
