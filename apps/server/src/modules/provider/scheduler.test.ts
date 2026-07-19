import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { PROVIDER_PRESETS } from './presets.js';
import {
  autoConfigureKey,
  createFailoverTextGen,
  pickCandidates,
  pickModelForModality,
  AUTO_ROUTE_MODALITIES,
} from './scheduler.js';

let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb.cleanup();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const okModelsResponse = () =>
  new Response(JSON.stringify({ data: [{ id: 'some-model' }] }), { status: 200 });

describe('按需调度：候选队列', () => {
  it('只取 enabled 厂商（有 baseUrl）× enabled 模型，按 sortOrder 升序；镜像 Mock 厂商（无 baseUrl）不入队', async () => {
    const db = tdb.db;
    const real = await db.providerConfig.create({
      data: { name: '真实厂商', vendor: 'openai-compatible', category: 'TEXT', baseUrl: 'https://x.example', apiKey: 'k', enabled: true },
    });
    const mock = await db.providerConfig.create({
      data: { name: 'Mock', vendor: 'mock', category: 'TEXT', baseUrl: '', apiKey: '', enabled: true },
    });
    await db.modelConfig.create({
      data: { providerConfigId: mock.id, key: 'mock-text', label: 'Mock', modality: 'text', capabilityJson: '{}', enabled: true, sortOrder: 0 },
    });
    const m2 = await db.modelConfig.create({
      data: { providerConfigId: real.id, key: 'b-model', label: 'B', modality: 'text', capabilityJson: '{}', enabled: true, sortOrder: 2 },
    });
    const m1 = await db.modelConfig.create({
      data: { providerConfigId: real.id, key: 'a-model', label: 'A', modality: 'text', capabilityJson: '{}', enabled: true, sortOrder: 1 },
    });
    await db.modelConfig.create({
      data: { providerConfigId: real.id, key: 'disabled', label: 'D', modality: 'text', capabilityJson: '{}', enabled: false, sortOrder: 0 },
    });

    const list = await pickCandidates(db, 'text');
    expect(list.map((m) => m.id)).toEqual([m1.id, m2.id]);
    const first = await pickModelForModality(db, 'text');
    expect(first?.key).toBe('a-model');
    // 清场
    await db.modelConfig.deleteMany({});
    await db.providerConfig.deleteMany({});
  });

  // vision（视觉评审）单次调用便宜，与 text/image/tts 一样自动调度；
  // video 单次成本高，刻意留在白名单外由用户显式指定
  it('自动调度模态白名单含 text/image/tts/vision，不含 video', () => {
    expect(AUTO_ROUTE_MODALITIES).toEqual(['text', 'image', 'tts', 'vision']);
    expect(AUTO_ROUTE_MODALITIES).not.toContain('video');
  });
});

describe('失效转移文本生成', () => {
  const seedTwoProviders = async () => {
    const db = tdb.db;
    const p1 = await db.providerConfig.create({
      data: { name: '一号（会挂）', vendor: 'openai-compatible', category: 'TEXT', baseUrl: 'https://down.example', apiKey: 'k1', enabled: true },
    });
    const p2 = await db.providerConfig.create({
      data: { name: '二号（正常）', vendor: 'openai-compatible', category: 'TEXT', baseUrl: 'https://up.example', apiKey: 'k2', enabled: true },
    });
    await db.modelConfig.create({
      data: { providerConfigId: p1.id, key: 'model-down', label: 'D', modality: 'text', capabilityJson: '{}', enabled: true, sortOrder: 0 },
    });
    await db.modelConfig.create({
      data: { providerConfigId: p2.id, key: 'model-up', label: 'U', modality: 'text', capabilityJson: '{}', enabled: true, sortOrder: 1 },
    });
  };
  const cleanup = async () => {
    await tdb.db.modelConfig.deleteMany({});
    await tdb.db.providerConfig.deleteMany({});
  };

  it('队首网络不通 → 自动切换下一家成功（本次故障场景的回归测试）', async () => {
    await seedTwoProviders();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).startsWith('https://down.example')) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
      }),
    );
    const gen = createFailoverTextGen(tdb.db, async () => 'mock');
    await expect(gen('测试')).resolves.toBe('{"ok":true}');
    await cleanup();
  });

  it('全部候选失败 → 明确报错且不静默降级 Mock', async () => {
    await seedTwoProviders();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const gen = createFailoverTextGen(tdb.db, async () => 'mock');
    await expect(gen('测试')).rejects.toThrow(/全部 2 个文本模型调用失败/);
    await cleanup();
  });

  it('无任何真实候选 → 回落 fallback（离线 Mock）', async () => {
    const gen = createFailoverTextGen(tdb.db, async () => 'mock-result');
    await expect(gen('测试')).resolves.toBe('mock-result');
  });
});

describe('贴 key 一键接入', () => {
  it('前缀命中：sk-or-v1- → OpenRouter，新建厂商并导入预置模型（recommended 启用，其余停用）', async () => {
    const db = tdb.db;
    vi.stubGlobal('fetch', vi.fn(async () => okModelsResponse()));
    const result = await autoConfigureKey(db, 'sk-or-v1-abcdefabcdef');
    expect(result.matched).toBe(true);
    expect(result.platform?.id).toBe('openrouter');
    expect(result.action).toBe('created');
    const preset = PROVIDER_PRESETS.find((p) => p.id === 'openrouter')!;
    expect(result.imported?.created).toBe(preset.models.length);
    const models = await db.modelConfig.findMany({ where: { providerConfigId: result.providerId! } });
    for (const m of models) {
      const pm = preset.models.find((x) => x.key === m.key)!;
      expect(m.enabled).toBe(pm.recommended);
    }
  });

  it('再次贴同平台 key：更新既有厂商而非重复建卡，已有模型跳过', async () => {
    const db = tdb.db;
    vi.stubGlobal('fetch', vi.fn(async () => okModelsResponse()));
    const result = await autoConfigureKey(db, 'sk-or-v1-updatedkey00');
    expect(result.matched).toBe(true);
    expect(result.action).toBe('updated');
    expect(result.imported?.created).toBe(0);
    const providers = await db.providerConfig.findMany({
      where: { baseUrl: PROVIDER_PRESETS.find((p) => p.id === 'openrouter')!.baseUrl },
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].apiKey).toBe('sk-or-v1-updatedkey00');
  });

  it('无前缀特征：并行探测，带 key 2xx 且不带 key 被拒 的平台命中', async () => {
    const db = tdb.db;
    const bailianBase = PROVIDER_PRESETS.find((p) => p.id === 'aliyun-bailian')!.baseUrl;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const hasAuth = Boolean((init?.headers as Record<string, string> | undefined)?.Authorization);
        // 百炼：需要鉴权的 /models —— 带 key 200，不带 key 401；其余平台一律 401
        if (String(url).startsWith(bailianBase) && hasAuth) return okModelsResponse();
        return new Response('{"error":"unauthorized"}', { status: 401 });
      }),
    );
    const result = await autoConfigureKey(db, 'sk-plainlookingkey123');
    expect(result.matched).toBe(true);
    expect(result.platform?.id).toBe('aliyun-bailian');
  });

  it('防误判：/models 公开的平台（带不带 key 都 2xx）不能凭 /models 命中，走鉴权探针判别', async () => {
    const db = tdb.db;
    const openrouter = PROVIDER_PRESETS.find((p) => p.id === 'openrouter')!;
    expect(openrouter.authProbePath).toBeTruthy(); // OpenRouter 必须配置鉴权探针
    // 场景 A：假 key —— /models 公开全 200，但鉴权探针 401 → 不得命中任何平台
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/models') && String(url).startsWith(openrouter.baseUrl)) return okModelsResponse();
        return new Response('{"error":"unauthorized"}', { status: 401 });
      }),
    );
    const bad = await autoConfigureKey(db, 'sk-fake-not-a-real-key');
    expect(bad.matched).toBe(false);

    // 场景 B：真 key —— 鉴权探针 200 → 命中 OpenRouter
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.startsWith(openrouter.baseUrl) && u.endsWith('/models')) return okModelsResponse();
        if (u.startsWith(openrouter.baseUrl) && u.endsWith(openrouter.authProbePath!)) {
          return new Response('{"data":{"label":"ok"}}', { status: 200 });
        }
        return new Response('{"error":"unauthorized"}', { status: 401 });
      }),
    );
    const good = await autoConfigureKey(db, 'sk-genuine-looking-key');
    expect(good.matched).toBe(true);
    expect(good.platform?.id).toBe('openrouter');
  });

  it('全部平台探测失败：matched=false 并返回各平台探测摘要', async () => {
    const db = tdb.db;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const result = await autoConfigureKey(db, 'sk-unknownkey12345');
    expect(result.matched).toBe(false);
    expect(result.probed?.length).toBe(PROVIDER_PRESETS.length);
    expect(result.message).toContain('未能识别');
  });

  it('空 key → 400', async () => {
    await expect(autoConfigureKey(tdb.db, '   ')).rejects.toMatchObject({ statusCode: 400 });
  });
});
