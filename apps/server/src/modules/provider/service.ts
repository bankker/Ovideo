import type { ModelConfig, PrismaClient, Prisma, ProviderConfig } from '@prisma/client';
import { z } from 'zod';
import {
  CapabilityDescriptorSchema,
  UpdateModelBodySchema,
  UpdateProviderBodySchema,
  type CapabilityEntry,
  type CreateModelBody,
  type CreateProviderBody,
  type Modality,
} from '@ovideo/shared';
import { conflict, notFound } from '../../lib/errors.js';
import { parseJson, toJson } from '../../lib/json.js';
import { chatComplete } from './adapters/openai-compatible.js';

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

/** ---------- 连通测试 ---------- */

export interface ProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  message: string;
}

/**
 * M1 仅 TEXT 厂商做真实连通测试（发一条 ping）；
 * 真实生成测试（极小请求验证端到端）在 M2 扩展到其余类别。
 */
export async function testProvider(db: PrismaClient, id: string): Promise<ProviderTestResult> {
  const provider = await db.providerConfig.findUnique({ where: { id } });
  if (!provider) throw notFound('厂商配置');

  if (provider.category !== 'TEXT') {
    return { ok: false, message: 'M1 仅支持 TEXT 厂商真实连通测试' };
  }
  if (!provider.baseUrl) {
    return { ok: true, message: 'MOCK 模式（未配置 baseUrl）' };
  }

  const model = await db.modelConfig.findFirst({
    where: { providerConfigId: id, enabled: true },
    orderBy: { sortOrder: 'asc' },
  });
  if (!model) {
    return { ok: false, message: '该厂商下没有已启用的模型，无法连通测试' };
  }

  const startedAt = Date.now();
  try {
    await chatComplete(
      { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: model.key },
      [{ role: 'user', content: 'ping' }],
      { timeoutMs: 15000 },
    );
    return { ok: true, latencyMs: Date.now() - startedAt, message: '连通成功' };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
