import type { FastifyPluginAsync } from 'fastify';
import type { ModelConfig, PrismaClient, ProviderConfig } from '@prisma/client';
import { z } from 'zod';
import {
  CapabilityDescriptorSchema,
  CreateModelBodySchema,
  CreateProviderBodySchema,
  ModalitySchema,
  UpdateModelBodySchema,
  UpdateProviderBodySchema,
} from '@ovideo/shared';
import { parseJson } from '../../lib/json.js';
import { PROVIDER_PRESETS } from './presets.js';
import { autoConfigureKey } from './scheduler.js';
import {
  batchCreateModels,
  createModel,
  createProvider,
  deleteModel,
  deleteProvider,
  discoverModels,
  listCapabilities,
  listModels,
  listProviders,
  maskKey,
  testProvider,
  updateModel,
  updateProvider,
} from './service.js';

const CapabilitiesQuerySchema = z.object({ modality: ModalitySchema.optional() });
const IdParamsSchema = z.object({ id: z.string().min(1) });

/** 批量导入模型：capability/label 可缺省（服务层按模态模板与 key 补全） */
const BatchCreateModelsBodySchema = z.object({
  models: z
    .array(
      z.object({
        key: z.string().min(1).max(120),
        label: z.string().min(1).max(120).optional(),
        modality: ModalitySchema,
        capability: CapabilityDescriptorSchema.optional(),
      }),
    )
    .min(1),
});

/** 模型响应视图：capabilityJson 还原为对象，前端不感知 SQLite 的 JSON-as-String */
function modelView(m: ModelConfig) {
  return {
    id: m.id,
    providerConfigId: m.providerConfigId,
    key: m.key,
    label: m.label,
    modality: m.modality,
    capability: parseJson<Record<string, unknown>>(m.capabilityJson, {}),
    enabled: m.enabled,
    sortOrder: m.sortOrder,
  };
}

/** 厂商响应视图：apiKey 一律脱敏 */
function providerView(p: ProviderConfig & { models?: ModelConfig[] }) {
  return {
    id: p.id,
    name: p.name,
    vendor: p.vendor,
    category: p.category,
    baseUrl: p.baseUrl,
    apiKey: maskKey(p.apiKey),
    enabled: p.enabled,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(p.models ? { models: p.models.map(modelView) } : {}),
  };
}

export const providerRoutes: FastifyPluginAsync<{ db: PrismaClient }> = async (app, opts) => {
  const { db } = opts;

  /** ---------- 厂商 ---------- */

  app.get('/api/admin/providers', async () => {
    const providers = await listProviders(db);
    return providers.map(providerView);
  });

  app.post('/api/admin/providers', async (req, reply) => {
    const body = CreateProviderBodySchema.parse(req.body);
    const provider = await createProvider(db, body);
    return reply.status(201).send(providerView(provider));
  });

  app.patch('/api/admin/providers/:id', async (req) => {
    const { id } = IdParamsSchema.parse(req.params);
    const body = UpdateProviderBodySchema.parse(req.body);
    return providerView(await updateProvider(db, id, body));
  });

  app.delete('/api/admin/providers/:id', async (req) => {
    const { id } = IdParamsSchema.parse(req.params);
    await deleteProvider(db, id);
    return { ok: true };
  });

  app.post('/api/admin/providers/:id/test', async (req) => {
    const { id } = IdParamsSchema.parse(req.params);
    return testProvider(db, id);
  });

  /** ---------- 预置库 / 自动发现 / 批量导入 ---------- */

  app.get('/api/admin/provider-presets', async () => {
    return { presets: PROVIDER_PRESETS };
  });

  app.post('/api/admin/providers/:id/discover-models', async (req) => {
    const { id } = IdParamsSchema.parse(req.params);
    return discoverModels(db, id);
  });

  app.post('/api/admin/providers/:id/models/batch', async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    const body = BatchCreateModelsBodySchema.parse(req.body);
    const result = await batchCreateModels(db, id, body.models);
    return reply.status(201).send(result);
  });

  /** ---------- 模型 ---------- */

  app.get('/api/admin/providers/:id/models', async (req) => {
    const { id } = IdParamsSchema.parse(req.params);
    const models = await listModels(db, id);
    return models.map(modelView);
  });

  app.post('/api/admin/providers/:id/models', async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    const body = CreateModelBodySchema.parse(req.body);
    const model = await createModel(db, id, body);
    return reply.status(201).send(modelView(model));
  });

  app.patch('/api/admin/models/:id', async (req) => {
    const { id } = IdParamsSchema.parse(req.params);
    const body = UpdateModelBodySchema.parse(req.body);
    return modelView(await updateModel(db, id, body));
  });

  app.delete('/api/admin/models/:id', async (req) => {
    const { id } = IdParamsSchema.parse(req.params);
    await deleteModel(db, id);
    return { ok: true };
  });

  /** ---------- 贴 key 一键接入（识别平台 → 建/更新厂商 → 导入预置模型 → 连通测试） ---------- */

  app.post('/api/admin/auto-config-key', async (req) => {
    const { apiKey } = AutoConfigKeyBodySchema.parse(req.body);
    return autoConfigureKey(db, apiKey);
  });

  /** ---------- 前台能力投影 ---------- */

  app.get('/api/capabilities', async (req) => {
    const { modality } = CapabilitiesQuerySchema.parse(req.query);
    return listCapabilities(db, modality);
  });
};

const AutoConfigKeyBodySchema = z.object({ apiKey: z.string().min(8, '请粘贴完整的 API Key') });
