// 按需调度（v3.6）：任务未显式指定模型时，按模态自动选用已启用的真实模型；
// 以及"贴 key 一键接入"——识别平台 → 建/更新厂商 → 导入预置模型。
import type { ModelConfig, PrismaClient, ProviderConfig } from '@prisma/client';
import type { Modality } from '@ovideo/shared';
import { badRequest } from '../../lib/errors.js';
import { PROVIDER_PRESETS, type ProviderPreset } from './presets.js';
import { batchCreateModels, testProvider, type ProviderTestResult } from './service.js';
import { chatComplete } from './adapters/openai-compatible.js';

export type ModelWithProvider = ModelConfig & { provider: ProviderConfig };

/**
 * 自动调度只覆盖已有真实适配器的模态；video/tts 的真实适配器 M3 接入后再放开，
 * 避免自动选中一个必然报错的模型。
 */
export const AUTO_ROUTE_MODALITIES: Modality[] = ['text', 'image'];

/** 该模态的调度候选队列：已启用厂商（有 baseUrl）× 已启用模型，按 sortOrder 升序 */
export async function pickCandidates(db: PrismaClient, modality: Modality): Promise<ModelWithProvider[]> {
  return db.modelConfig.findMany({
    where: { enabled: true, modality, provider: { enabled: true, NOT: { baseUrl: '' } } },
    include: { provider: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
}

/** 队首模型；无候选返回 null（调用方回落 Mock） */
export async function pickModelForModality(db: PrismaClient, modality: Modality): Promise<ModelWithProvider | null> {
  const list = await pickCandidates(db, modality);
  return list[0] ?? null;
}

/**
 * 带失效转移的文本生成：依次尝试文本模态候选队列（某家网络不通/报错自动换下一家），
 * 全部失败才抛错（不静默降级）；一个真实候选都没有时走 fallback（确定性 Mock，离线可用）。
 * 对话式修改与三步生成任务共用此策略。
 */
export function createFailoverTextGen(
  db: PrismaClient,
  fallback: (prompt: string) => Promise<string>,
): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    const candidates = await pickCandidates(db, 'text');
    if (candidates.length === 0) return fallback(prompt);
    const failures: string[] = [];
    for (const model of candidates) {
      try {
        return await chatComplete(
          { baseUrl: model.provider.baseUrl, apiKey: model.provider.apiKey, model: model.key },
          [{ role: 'user', content: prompt }],
          { jsonMode: true },
        );
      } catch (err) {
        failures.push(`${model.key}: ${err instanceof Error ? err.message.slice(0, 140) : '未知错误'}`);
      }
    }
    throw new Error(`全部 ${candidates.length} 个文本模型调用失败——${failures.join('；')}`);
  };
}

/* ---------------- 贴 key 一键接入 ---------------- */

export interface AutoConfigResult {
  matched: boolean;
  /** 识别到的平台预置 id 与名称 */
  platform?: { id: string; name: string };
  providerId?: string;
  /** 新建厂商还是更新既有厂商的 key */
  action?: 'created' | 'updated';
  imported?: { created: number; skipped: number };
  test?: ProviderTestResult;
  message: string;
  /** 未识别时：各平台探测结果摘要（帮助排查） */
  probed?: Array<{ platform: string; status: string }>;
}

/** 前缀特征一眼可辨的平台 */
function matchByPrefix(apiKey: string): ProviderPreset | null {
  const rules: Array<[RegExp, string]> = [
    [/^sk-or-v1-/, 'openrouter'],
    [/^AIza/, 'google-gemini'],
    [/^[0-9a-f]{8,}\.[A-Za-z0-9]+$/, 'zhipu'], // 智谱 id.secret 双段式
  ];
  for (const [re, presetId] of rules) {
    if (re.test(apiKey)) return PROVIDER_PRESETS.find((p) => p.id === presetId) ?? null;
  }
  return null;
}

async function fetchStatus(url: string, apiKey: string | null, timeoutMs: number): Promise<{ ok: boolean; status: string }> {
  try {
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: err instanceof Error ? (err.name === 'TimeoutError' ? '超时' : '网络不可达') : '未知错误' };
  }
}

/**
 * 对单个平台探测这把 key 的归属。
 * 关键防御（双请求对照）：部分平台的 /models 是公开接口（如 OpenRouter，不带 key 也 2xx），
 * 单靠"带 key 2xx"会把任意字符串误判为该平台的 key。
 * 规则：带 key 2xx 且 不带 key 非 2xx → 命中；两者都 2xx（公开端点）→ 改用平台的鉴权探针
 * （authProbePath）判别，未配置探针则判为"无法判别"。
 */
async function probePreset(preset: ProviderPreset, apiKey: string, timeoutMs = 8000): Promise<{ ok: boolean; status: string }> {
  const base = preset.baseUrl.replace(/\/+$/, '');
  const [withKey, withoutKey] = await Promise.all([
    fetchStatus(`${base}/models`, apiKey, timeoutMs),
    fetchStatus(`${base}/models`, null, timeoutMs),
  ]);
  if (!withKey.ok) return { ok: false, status: withKey.status };
  if (!withoutKey.ok) return { ok: true, status: withKey.status };
  // 公开端点：/models 无法判别 key 归属
  if (preset.authProbePath) {
    const probe = await fetchStatus(`${base}${preset.authProbePath}`, apiKey, timeoutMs);
    return { ok: probe.ok, status: `鉴权探针 ${probe.status}` };
  }
  return { ok: false, status: '无法判别（该平台模型列表公开且未配置鉴权探针）' };
}

/**
 * 贴 key 一键接入：
 * 1) 前缀特征直接命中，否则并行探测全部预置平台的 /models；
 * 2) 命中后：同 baseUrl 已有厂商 → 更新其 key 并启用；否则按预置新建厂商；
 * 3) 导入该平台预置模型（recommended 启用，其余停用；已存在跳过）；
 * 4) 连通测试。
 * 全程不落日志明文 key。
 */
export async function autoConfigureKey(db: PrismaClient, apiKey: string): Promise<AutoConfigResult> {
  const key = apiKey.trim();
  if (!key) throw badRequest('请粘贴 API Key');

  let preset = matchByPrefix(key);
  let probed: Array<{ platform: string; status: string }> | undefined;

  if (preset) {
    // 前缀命中也做一次确认探测；失败不改判（部分平台 /models 需要额外头，仍按前缀走）
    await probePreset(preset, key);
  } else {
    const results = await Promise.all(
      PROVIDER_PRESETS.map(async (p) => ({ preset: p, result: await probePreset(p, key) })),
    );
    probed = results.map((r) => ({ platform: r.preset.name, status: r.result.status }));
    const hits = results.filter((r) => r.result.ok);
    if (hits.length === 0) {
      return {
        matched: false,
        probed,
        message: '未能识别这把 Key 所属的平台（各平台探测均未通过）。可在下方"新增厂商"里手动选择平台后填入。',
      };
    }
    preset = hits[0].preset;
  }

  // 建/更新厂商
  const existing = await db.providerConfig.findFirst({ where: { baseUrl: preset.baseUrl } });
  let provider: ProviderConfig;
  let action: 'created' | 'updated';
  if (existing) {
    provider = await db.providerConfig.update({
      where: { id: existing.id },
      data: { apiKey: key, enabled: true },
    });
    action = 'updated';
  } else {
    provider = await db.providerConfig.create({
      data: {
        name: preset.name,
        vendor: preset.vendor,
        category: 'TEXT', // 兼容字段，不参与逻辑
        baseUrl: preset.baseUrl,
        apiKey: key,
        enabled: true,
      },
    });
    action = 'created';
  }

  // 导入预置模型（已存在的由 batchCreateModels 跳过）
  const imported = await batchCreateModels(
    db,
    provider.id,
    preset.models.map((m) => ({ key: m.key, label: m.label, modality: m.modality, capability: m.capability })),
  );
  // recommended=false 的预置模型若本次新建，置为停用（batchCreateModels 默认启用）
  const notRecommended = preset.models.filter((m) => !m.recommended).map((m) => m.key);
  if (notRecommended.length > 0 && imported.created > 0) {
    await db.modelConfig.updateMany({
      where: { providerConfigId: provider.id, key: { in: notRecommended } },
      data: { enabled: false },
    });
  }

  const test = await testProvider(db, provider.id);
  return {
    matched: true,
    platform: { id: preset.id, name: preset.name },
    providerId: provider.id,
    action,
    imported,
    test,
    message:
      `已识别为「${preset.name}」，${action === 'created' ? '新建厂商' : '更新既有厂商的 Key'}，` +
      `导入模型 ${imported.created} 个（跳过已有 ${imported.skipped} 个），连通测试${test.ok ? '通过' : `未通过：${test.message ?? ''}`}`,
  };
}
