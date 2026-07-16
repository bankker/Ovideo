import { z } from 'zod';
import {
  TagTypeSchema,
  ProviderCategorySchema,
  ModalitySchema,
  JobTypeSchema,
  JobExecutorKindSchema,
} from './enums.js';
import { CapabilityDescriptorSchema } from './capability.js';
import { StoryboardPatchSchema } from './storyboard-patch.js';

/** ---------- 项目 / 分集 ---------- */
export const CreateProjectBodySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(''),
});
export const UpdateProjectBodySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  archived: z.boolean().optional(),
});
export const CreateEpisodeBodySchema = z.object({
  title: z.string().min(1).max(100),
});
export const UpdateEpisodeBodySchema = z.object({
  title: z.string().min(1).max(100).optional(),
  sortOrder: z.number().int().optional(),
});

/** ---------- 标签 ---------- */
export const CreateTagBodySchema = z.object({
  type: TagTypeSchema,
  name: z.string().min(1).max(60),
  description: z.string().max(2000).default(''),
});
export const UpdateTagBodySchema = z.object({
  name: z.string().min(1).max(60).optional(),
  description: z.string().max(2000).optional(),
  canonicalAssetId: z.string().nullable().optional(),
});

/** ---------- 剧本稿 / 分镜 ---------- */
export const CreateScriptDraftBodySchema = z.object({
  title: z.string().min(1).max(100).default('剧本稿'),
  content: z.string().default(''),
});
export const UpdateScriptDraftBodySchema = z.object({
  title: z.string().min(1).max(100).optional(),
  content: z.string().optional(),
  setMain: z.boolean().optional(),
});
export const GenerateStoryboardBodySchema = z.object({
  /** 指定文本模型；缺省时服务端选第一个 enabled 的 TEXT 模型，无则用 MOCK */
  modelConfigId: z.string().optional(),
});
export const ApplyPatchBodySchema = z.object({
  patch: StoryboardPatchSchema,
  source: z.string().default('manual'),
});

/** ---------- 绑定 ---------- */
export const PutBindingBodySchema = z.object({
  tagId: z.string(),
  /** null = 标签级默认绑定；非 null = 镜头级覆盖 */
  shotId: z.string().nullable().default(null),
  assetId: z.string().nullable(),
});

/** ---------- Job ---------- */
export const EnqueueJobBodySchema = z.object({
  type: JobTypeSchema,
  executor: JobExecutorKindSchema.default('MOCK'),
  input: z.record(z.unknown()).default({}),
  providerConfigId: z.string().optional(),
  modelKey: z.string().optional(),
});

/** ---------- 后台：厂商 / 模型 ---------- */
export const CreateProviderBodySchema = z.object({
  name: z.string().min(1).max(100),
  vendor: z.string().min(1).max(60),
  /** 兼容保留：厂商不再按模态分家（一把 key 多模态通用），模态归属由旗下 ModelConfig.modality 决定 */
  category: ProviderCategorySchema.default('TEXT'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  enabled: z.boolean().default(true),
});
export const UpdateProviderBodySchema = CreateProviderBodySchema.partial();

export const CreateModelBodySchema = z.object({
  key: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
  modality: ModalitySchema,
  capability: CapabilityDescriptorSchema,
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
export const UpdateModelBodySchema = CreateModelBodySchema.partial();

export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;
export type CreateEpisodeBody = z.infer<typeof CreateEpisodeBodySchema>;
export type CreateTagBody = z.infer<typeof CreateTagBodySchema>;
export type CreateScriptDraftBody = z.infer<typeof CreateScriptDraftBodySchema>;
export type ApplyPatchBody = z.infer<typeof ApplyPatchBodySchema>;
export type PutBindingBody = z.infer<typeof PutBindingBodySchema>;
export type EnqueueJobBody = z.infer<typeof EnqueueJobBodySchema>;
export type CreateProviderBody = z.infer<typeof CreateProviderBodySchema>;
export type CreateModelBody = z.infer<typeof CreateModelBodySchema>;
