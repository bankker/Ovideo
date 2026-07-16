import type { ModelConfig, PrismaClient, Prisma, ProviderConfig } from '@prisma/client';
import { z } from 'zod';
import {
  CapabilityDescriptorSchema,
  UpdateModelBodySchema,
  UpdateProviderBodySchema,
  type CapabilityDescriptor,
  type CapabilityEntry,
  type CreateModelBody,
  type CreateProviderBody,
  type Modality,
} from '@ovideo/shared';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { parseJson, toJson } from '../../lib/json.js';
import { chatComplete } from './adapters/openai-compatible.js';
import { defaultCapabilityFor } from './presets.js';

export type UpdateProviderBody = z.infer<typeof UpdateProviderBodySchema>;
export type UpdateModelBody = z.infer<typeof UpdateModelBodySchema>;

export type ProviderWithModels = ProviderConfig & { models: ModelConfig[] };

/** apiKey 脱敏：保留前 4 后 2；短 key 前后截取会泄露全文，整体打码 */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 6) return '***';
  return `${key.slice(0, 4)}***${key.slice(-2)}`;
}

/** ---------- Provider CRUD ---------- */

export async function listProviders(db: PrismaClient): Promise<ProviderWithModels[]> {
  return db.providerConfig.findMany({
    orderBy: { createdAt: 'asc' },
    include: { models: { orderBy: { sortOrder: 'asc' } } },
  });
}

export async function getProvider(db: PrismaClient, id: string): Promise<ProviderWithModels> {
  const provider = await db.providerConfig.findUnique({
    where: { id },
    include: { models: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!provider) throw notFound('厂商配置');
  return provider;
}

export async function createProvider(
  db: PrismaClient,
  input: CreateProviderBody,
): Promise<ProviderConfig> {
  return db.providerConfig.create({ data: input });
}

export async function updateProvider(
  db: PrismaClient,
  id: string,
  input: UpdateProviderBody,
): Promise<ProviderConfig> {
  const existing = await db.providerConfig.findUnique({ where: { id } });
  if (!existing) throw notFound('厂商配置');
  return db.providerConfig.update({ where: { id }, data: input });
}

export async function deleteProvider(db: PrismaClient, id: string): Promise<void> {
  const existing = await db.providerConfig.findUnique({ where: { id } });
  if (!existing) throw notFound('厂商配置');
  await db.providerConfig.delete({ where: { id } }); // 模型级联删除（schema onDelete: Cascade）
}

/** ---------- Model CRUD ---------- */

export async function listModels(db: PrismaClient, providerConfigId: string): Promise<ModelConfig[]> {
  await getProvider(db, providerConfigId);
  return db.modelConfig.findMany({
    where: { providerConfigId },
    orderBy: { sortOrder: 'asc' },
  });
}

export async function createModel(
  db: PrismaClient,
  providerConfigId: string,
  input: CreateModelBody,
): Promise<ModelConfig> {
  await getProvider(db, providerConfigId);
  const dup = await db.modelConfig.findUnique({
    where: { providerConfigId_key: { providerConfigId, key: input.key } },
  });
  if (dup) throw conflict(`同厂商下模型 key 已存在：${input.key}`);
  return db.modelConfig.create({
    data: {
      providerConfigId,
      key: input.key,
      label: input.label,
      modality: input.modality,
      capabilityJson: toJson(input.capability),
      enabled: input.enabled,
      sortOrder: input.sortOrder,
    },
  });
}

export async function updateModel(
  db: PrismaClient,
  id: string,
  input: UpdateModelBody,
): Promise<ModelConfig> {
  const existing = await db.modelConfig.findUnique({ where: { id } });
  if (!existing) throw notFound('模型配置');
  if (input.key !== undefined && input.key !== existing.key) {
    const dup = await db.modelConfig.findUnique({
      where: { providerConfigId_key: { providerConfigId: existing.providerConfigId, key: input.key } },
    });
    if (dup) throw conflict(`同厂商下模型 key 已存在：${input.key}`);
  }
  const data: Prisma.ModelConfigUpdateInput = {};
  if (input.key !== undefined) data.key = input.key;
  if (input.label !== undefined) data.label = input.label;
  if (input.modality !== undefined) data.modality = input.modality;
  if (input.capability !== undefined) data.capabilityJson = toJson(input.capability);
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  return db.modelConfig.update({ where: { id }, data });
}

export async function deleteModel(db: PrismaClient, id: string): Promise<void> {
  const existing = await db.modelConfig.findUnique({ where: { id } });
  if (!existing) throw notFound('模型配置');
  await db.modelConfig.delete({ where: { id } });
}

/** ---------- 能力投影（v2 §8：前台动态模型列表的唯一数据源） ---------- */

export async function listCapabilities(
  db: PrismaClient,
  modality?: Modality,
): Promise<CapabilityEntry[]> {
  const models = await db.modelConfig.findMany({
    where: {
      enabled: true,
      provider: { enabled: true },
      ...(modality ? { modality } : {}),
    },
    include: { provider: true },
    orderBy: [{ provider: { name: 'asc' } }, { sortOrder: 'asc' }],
  });

  const entries: CapabilityEntry[] = [];
  for (const m of models) {
    // capabilityJson 坏 JSON 或不符合描述 schema 的条目跳过，不让单条脏数据拖垮整个投影
    const capability = CapabilityDescriptorSchema.safeParse(parseJson<unknown>(m.capabilityJson, null));
    if (!capability.success) continue;
    entries.push({
      modelConfigId: m.id,
      providerConfigId: m.providerConfigId,
      providerName: m.provider.name,
      modelKey: m.key,
      label: m.label,
      capability: capability.data,
    });
  }
  return entries;
}

/** ---------- 模型自动发现 / 批量导入 ---------- */

/** baseUrl 统一去尾斜杠后拼接路径 */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/** 从模型 id 推断模态：图像 → 视频 → 语音 → 兜底文本 */
export function inferModality(modelId: string): Modality {
  if (/(image|seedream|wanx|dall|flux|t2i)/i.test(modelId)) return 'image';
  if (/(video|seedance|kling|veo|sora|t2v|i2v)/i.test(modelId)) return 'video';
  if (/(tts|speech|voice|cosyvoice|audio)/i.test(modelId)) return 'tts';
  return 'text';
}

function errorSummary(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 200);
}

export interface DiscoveredModel {
  key: string;
  label: string;
  modality: Modality;
  /** 该厂商下是否已存在同 key 模型（前端据此默认不勾选，避免重复导入） */
  exists: boolean;
}

/**
 * 调厂商 OpenAI 兼容 GET /models 自动发现模型列表（傻瓜化：用户不用手抄模型名）。
 * 兼容 { data: [{ id }] } 与直接数组两种响应形状。
 */
export async function discoverModels(
  db: PrismaClient,
  providerId: string,
): Promise<{ models: DiscoveredModel[] }> {
  const provider = await db.providerConfig.findUnique({ where: { id: providerId } });
  if (!provider) throw notFound('厂商配置');
  if (!provider.baseUrl || !provider.apiKey) {
    throw badRequest('请先填写 baseUrl 与 API Key，再使用自动发现模型');
  }

  let res: Response;
  let text: string;
  try {
    res = await fetch(joinUrl(provider.baseUrl, '/models'), {
      headers: { authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    text = await res.text();
  } catch (err) {
    throw new AppError(502, `无法获取模型列表：${errorSummary(err)}`);
  }
  if (!res.ok) {
    throw new AppError(502, `无法获取模型列表：HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError(502, `无法获取模型列表：响应不是 JSON（${text.slice(0, 100)}）`);
  }
  const rawList = Array.isArray(parsed)
    ? parsed
    : (parsed as { data?: unknown }).data;
  if (!Array.isArray(rawList)) {
    throw new AppError(502, '无法获取模型列表：响应缺少 data 数组');
  }

  const ids = rawList
    .map((item) => (typeof item === 'string' ? item : (item as { id?: unknown })?.id))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  const existing = await db.modelConfig.findMany({
    where: { providerConfigId: providerId },
    select: { key: true },
  });
  const existingKeys = new Set(existing.map((m) => m.key));

  return {
    models: ids.map((id) => ({
      key: id,
      label: id,
      modality: inferModality(id),
      exists: existingKeys.has(id),
    })),
  };
}

export interface BatchCreateModelInput {
  key: string;
  label?: string;
  modality: Modality;
  capability?: CapabilityDescriptor;
}

/**
 * 批量创建模型（发现列表勾选后一键导入）：
 * capability 缺省用模态默认模板，label 缺省=key，sortOrder 接续现有最大值，同 key 跳过。
 */
export async function batchCreateModels(
  db: PrismaClient,
  providerId: string,
  models: BatchCreateModelInput[],
): Promise<{ created: number; skipped: number }> {
  await getProvider(db, providerId);

  const agg = await db.modelConfig.aggregate({
    where: { providerConfigId: providerId },
    _max: { sortOrder: true },
  });
  let nextSortOrder = (agg._max.sortOrder ?? -1) + 1;

  let created = 0;
  let skipped = 0;
  for (const m of models) {
    const dup = await db.modelConfig.findUnique({
      where: { providerConfigId_key: { providerConfigId: providerId, key: m.key } },
    });
    if (dup) {
      skipped += 1;
      continue;
    }
    await db.modelConfig.create({
      data: {
        providerConfigId: providerId,
        key: m.key,
        label: m.label ?? m.key,
        modality: m.modality,
        capabilityJson: toJson(m.capability ?? defaultCapabilityFor(m.modality)),
        enabled: true,
        sortOrder: nextSortOrder,
      },
    });
    nextSortOrder += 1;
    created += 1;
  }
  return { created, skipped };
}

/** ---------- 连通测试 ---------- */

export interface ProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  message: string;
}

/**
 * 连通测试（厂商级，不分模态）：
 * 1. 未配 baseUrl → Mock 模式直接 ok；
 * 2. 先 GET /models 测连通：401/403 判鉴权失败；404/405（网关不支持列表）时若有 enabled 的
 *    文本模型则退回 chatComplete('ping') 实测，否则视为端点可达；
 * 3. 网络错误 → ok=false 带原因。
 */
export async function testProvider(db: PrismaClient, id: string): Promise<ProviderTestResult> {
  const provider = await db.providerConfig.findUnique({ where: { id } });
  if (!provider) throw notFound('厂商配置');

  if (!provider.baseUrl) {
    return { ok: true, message: 'Mock 模式（本地生成，无需外部连接）' };
  }

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(joinUrl(provider.baseUrl, '/models'), {
      headers: { authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    return { ok: false, message: `连接失败：${errorSummary(err)}` };
  }
  const latencyMs = Date.now() - startedAt;

  if (res.status === 401 || res.status === 403) {
    return { ok: false, latencyMs, message: '鉴权失败，请检查 API Key' };
  }

  if (res.status === 404 || res.status === 405) {
    // 网关不支持模型列表：有 enabled 文本模型则实测一条 ping，否则仅确认端点可达
    const model = await db.modelConfig.findFirst({
      where: { providerConfigId: id, enabled: true, modality: 'text' },
      orderBy: { sortOrder: 'asc' },
    });
    if (!model) {
      return { ok: true, latencyMs, message: '端点可达（该网关不支持模型列表）' };
    }
    try {
      await chatComplete(
        { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: model.key },
        [{ role: 'user', content: 'ping' }],
        { timeoutMs: 15000 },
      );
      return { ok: true, latencyMs: Date.now() - startedAt, message: '连通成功' };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - startedAt, message: errorSummary(err) };
    }
  }

  if (!res.ok) {
    return { ok: false, latencyMs, message: `连通异常：HTTP ${res.status}` };
  }
  return { ok: true, latencyMs, message: '连通成功' };
}
