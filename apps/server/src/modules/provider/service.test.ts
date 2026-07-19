import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { AppError } from '../../lib/errors.js';
import {
  batchCreateModels,
  createModel,
  createProvider,
  deleteModel,
  deleteProvider,
  discoverModels,
  getProvider,
  inferModality,
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

describe('inferModality 模态推断', () => {
  it('图像关键词', () => {
    expect(inferModality('doubao-seedream-3-0-t2i-250415')).toBe('image');
    expect(inferModality('dall-e-3')).toBe('image');
    expect(inferModality('FLUX.1-dev')).toBe('image');
    expect(inferModality('wanx-v1')).toBe('image');
  });
  it('视频关键词', () => {
    expect(inferModality('doubao-seedance-1-0-pro')).toBe('video');
    expect(inferModality('kling-v1')).toBe('video');
    expect(inferModality('veo-3')).toBe('video');
    expect(inferModality('sora-2')).toBe('video');
    expect(inferModality('wan-i2v')).toBe('video');
  });
  it('语音关键词', () => {
    expect(inferModality('tts-1')).toBe('tts');
    expect(inferModality('cosyvoice-v2')).toBe('tts');
    expect(inferModality('gpt-4o-mini-speech')).toBe('tts');
  });
  it('兜底文本', () => {
    expect(inferModality('deepseek-chat')).toBe('text');
    expect(inferModality('qwen-plus')).toBe('text');
  });
});

describe('discoverModels 自动发现', () => {
  it('baseUrl 或 apiKey 为空：抛 400 中文提示', async () => {
    const p = await createProvider(db, {
      name: '发现空配置厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: '',
      apiKey: '',
      enabled: true,
    });
    await expect(discoverModels(db, p.id)).rejects.toMatchObject({ statusCode: 400 });

    const p2 = await createProvider(db, {
      name: '发现缺key厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: 'https://api.example.com',
      apiKey: '',
      enabled: true,
    });
    await expect(discoverModels(db, p2.id)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('成功：解析 { data:[{id}] }，推断模态并标记 exists（含 baseUrl 尾斜杠与 Bearer 鉴权）', async () => {
    const p = await createProvider(db, {
      name: '发现成功厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: 'https://ark.example.com/api/v3/',
      apiKey: 'sk-discover',
      enabled: true,
    });
    // 预先存在的模型 → exists=true
    await createModel(db, p.id, { key: 'doubao-seed-1-6', label: '已有', modality: 'text', capability: textCapability, enabled: true, sortOrder: 0 });

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'doubao-seed-1-6' },
              { id: 'doubao-seedream-3-0-t2i' },
              { id: 'doubao-seedance-1-0-pro' },
              { id: 'cosyvoice-v2' },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await discoverModels(db, p.id);
    expect(r.models).toEqual([
      { key: 'doubao-seed-1-6', label: 'doubao-seed-1-6', modality: 'text', exists: true },
      { key: 'doubao-seedream-3-0-t2i', label: 'doubao-seedream-3-0-t2i', modality: 'image', exists: false },
      { key: 'doubao-seedance-1-0-pro', label: 'doubao-seedance-1-0-pro', modality: 'video', exists: false },
      { key: 'cosyvoice-v2', label: 'cosyvoice-v2', modality: 'tts', exists: false },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ark.example.com/api/v3/models'); // 尾斜杠已去除
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-discover');
  });

  it('兼容直接数组响应', async () => {
    const p = await createProvider(db, {
      name: '发现数组厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: 'https://arr.example.com',
      apiKey: 'k',
      enabled: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([{ id: 'm-1' }, { id: 'kling-video' }]), { status: 200 })),
    );
    const r = await discoverModels(db, p.id);
    expect(r.models.map((m) => m.key)).toEqual(['m-1', 'kling-video']);
    expect(r.models[1].modality).toBe('video');
  });

  it('鉴权失败（HTTP 401）：抛 502 且带原因', async () => {
    const p = await createProvider(db, {
      name: '发现401厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: 'https://auth.example.com',
      apiKey: 'bad',
      enabled: true,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    await expect(discoverModels(db, p.id)).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringMatching(/^无法获取模型列表：.*401/),
    });
  });

  it('网络失败：抛 502 且带原因摘要', async () => {
    const p = await createProvider(db, {
      name: '发现断网厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: 'https://down.example.com',
      apiKey: 'k',
      enabled: true,
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));
    await expect(discoverModels(db, p.id)).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('不存在的厂商抛 404', async () => {
    await expect(discoverModels(db, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('batchCreateModels 批量导入', () => {
  it('缺省 capability 用模态模板、label 缺省=key、sortOrder 接续现有最大值、重复 key 跳过', async () => {
    const p = await createProvider(db, {
      name: '批量厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: '',
      apiKey: '',
      enabled: true,
    });
    // 现有模型 sortOrder 最大值 7
    await createModel(db, p.id, { key: 'existed', label: '已有', modality: 'text', capability: textCapability, enabled: true, sortOrder: 7 });

    const r = await batchCreateModels(db, p.id, [
      { key: 'existed', modality: 'text' }, // 重复 → 跳过
      { key: 'new-text', modality: 'text' },
      { key: 'new-image', label: '新图', modality: 'image' },
      { key: 'new-video', modality: 'video', capability: { modality: 'video', input: ['prompt'], output: { maxDurationS: 5 } } },
    ]);
    expect(r).toEqual({ created: 3, skipped: 1 });

    const models = await listModels(db, p.id);
    const byKey = Object.fromEntries(models.map((m) => [m.key, m]));

    // label 缺省=key；显式 label 保留
    expect(byKey['new-text'].label).toBe('new-text');
    expect(byKey['new-image'].label).toBe('新图');

    // capability 缺省按模态模板；显式 capability 保留
    expect(JSON.parse(byKey['new-text'].capabilityJson)).toEqual({ modality: 'text', input: ['prompt'] });
    expect(JSON.parse(byKey['new-image'].capabilityJson)).toEqual({ modality: 'image', input: ['prompt', 'ref_images'] });
    expect(JSON.parse(byKey['new-video'].capabilityJson)).toEqual({ modality: 'video', input: ['prompt'], output: { maxDurationS: 5 } });

    // sortOrder 接续：7 之后依次 8/9/10
    expect(byKey['new-text'].sortOrder).toBe(8);
    expect(byKey['new-image'].sortOrder).toBe(9);
    expect(byKey['new-video'].sortOrder).toBe(10);

    // 已存在的模型不被覆盖
    expect(byKey['existed'].label).toBe('已有');
    expect(byKey['existed'].sortOrder).toBe(7);
  });

  it('空厂商从 sortOrder=0 开始', async () => {
    const p = await createProvider(db, {
      name: '批量空厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: '',
      apiKey: '',
      enabled: true,
    });
    await batchCreateModels(db, p.id, [{ key: 'a', modality: 'text' }, { key: 'b', modality: 'text' }]);
    const models = await listModels(db, p.id);
    expect(models.map((m) => [m.key, m.sortOrder])).toEqual([['a', 0], ['b', 1]]);
  });

  it('不存在的厂商抛 404', async () => {
    await expect(batchCreateModels(db, 'nope', [{ key: 'k', modality: 'text' }])).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('testProvider', () => {
  it('baseUrl 为空：ok=false 提示配置（无 Mock）', async () => {
    const p = await createProvider(db, {
      name: 'Mock厂',
      vendor: 'openai-compatible',
      category: 'IMAGE', // category 已是兼容字段，不影响测试逻辑
      baseUrl: '',
      apiKey: '',
      enabled: true,
    });
    const r = await testProvider(db, p.id);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('未配置 Base URL');
  });

  it('GET /models 成功：ok=true 返回 latencyMs（Bearer 鉴权）', async () => {
    const p = await createProvider(db, {
      name: '连通厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: 'https://llm.example.com/',
      apiKey: 'sk-real',
      enabled: true,
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await testProvider(db, p.id);
    expect(r.ok).toBe(true);
    expect(r.message).toBe('连通成功');
    expect(typeof r.latencyMs).toBe('number');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/models');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-real');
  });

  it('/models 返回 401：鉴权失败提示', async () => {
    const p = await createProvider(db, {
      name: '鉴权失败厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: 'https://auth.example.com',
      apiKey: 'bad',
      enabled: true,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 401 })));
    const r = await testProvider(db, p.id);
    expect(r).toMatchObject({ ok: false, message: '鉴权失败，请检查 API Key' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    const r2 = await testProvider(db, p.id);
    expect(r2).toMatchObject({ ok: false, message: '鉴权失败，请检查 API Key' });
  });

  it('/models 404 且有 enabled 文本模型：退回 chatComplete ping 实测', async () => {
    const p = await createProvider(db, {
      name: '无列表网关厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: 'https://gw.example.com',
      apiKey: 'sk-gw',
      enabled: true,
    });
    await createModel(db, p.id, { key: 'second', label: '次', modality: 'text', capability: textCapability, enabled: true, sortOrder: 5 });
    await createModel(db, p.id, { key: 'first', label: '首', modality: 'text', capability: textCapability, enabled: true, sortOrder: 1 });
    await createModel(db, p.id, { key: 'off', label: '停', modality: 'text', capability: textCapability, enabled: false, sortOrder: 0 });

    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/models')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await testProvider(db, p.id);
    expect(r.ok).toBe(true);
    expect(r.message).toBe('连通成功');

    const pingCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/chat/completions')) as unknown as [string, RequestInit];
    expect(pingCall).toBeTruthy();
    const body = JSON.parse(pingCall[1].body as string);
    expect(body.model).toBe('first'); // 取 sortOrder 最小的 enabled 文本模型
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
  });

  it('/models 404 且 ping 失败：ok=false', async () => {
    const p = await createProvider(db, {
      name: '无列表坏网关厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: 'https://badgw.example.com',
      apiKey: 'k',
      enabled: true,
    });
    await createModel(db, p.id, { key: 'm', label: 'm', modality: 'text', capability: textCapability, enabled: true, sortOrder: 0 });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/models')) return new Response('nf', { status: 404 });
      return new Response('boom', { status: 500 });
    }));
    const r = await testProvider(db, p.id);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/500/);
  });

  it('/models 405 且无 enabled 文本模型：ok=true 端点可达', async () => {
    const p = await createProvider(db, {
      name: '无列表无模型厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: 'https://empty.example.com',
      apiKey: 'k',
      enabled: true,
    });
    // 只有 image 模型（非 text）→ 不做 ping
    await createModel(db, p.id, { key: 'img', label: '图', modality: 'image', capability: { modality: 'image' as const, input: ['prompt' as const] }, enabled: true, sortOrder: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 405 })));
    const r = await testProvider(db, p.id);
    expect(r.ok).toBe(true);
    expect(r.message).toBe('端点可达（该网关不支持模型列表）');
  });

  it('/models 其它错误状态（500）：ok=false', async () => {
    const p = await createProvider(db, {
      name: '5xx厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: 'https://err.example.com',
      apiKey: 'k',
      enabled: true,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
    const r = await testProvider(db, p.id);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/500/);
  });

  it('网络错误：ok=false 且带原因', async () => {
    const p = await createProvider(db, {
      name: '断网厂',
      vendor: 'openai-compatible',
      category: 'TEXT',
      baseUrl: 'https://down.example.com',
      apiKey: 'k',
      enabled: true,
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed: ETIMEDOUT'); }));
    const r = await testProvider(db, p.id);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('ETIMEDOUT');
  });

  it('不存在的厂商抛 404', async () => {
    await expect(testProvider(db, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});
