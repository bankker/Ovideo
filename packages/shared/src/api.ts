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
  /** 项目级画风设定，生成提示词自动携带（全剧风格一致） */
  stylePrompt: z.string().max(500).optional(),
  /** 项目画幅：分镜关键图与成片画布的唯一真相 */
  aspectRatio: z.enum(["9:16", "16:9", "1:1", "3:4", "4:3"]).optional(),
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
  /**
   * 导演要求：分镜规划向导拼出来的一段中文说明（拆镜风格、目标时长、节奏、运镜等），
   * 原样插进拆镜提示词。缺省时提示词与从前逐字一致。
   */
  directive: z.string().max(1000).optional(),
});
export const ApplyPatchBodySchema = z.object({
  patch: StoryboardPatchSchema,
  source: z.string().default('manual'),
});

/**
 * ---------- 影视语义取值域 ----------
 * 放在 shared 而不是服务端拆镜模块里：这几个值同时被三处消费——拆镜提示词（约束模型只做选择题）、
 * 镜头检查器的下拉选项、下游提示词拼装的枚举匹配。任一侧抄一份都会随时间漂移。
 */
export const SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写'] as const;
export const CAMERA_ANGLES = ['平视', '俯拍', '仰拍', '过肩'] as const;
export const CAMERA_MOVEMENTS = ['固定', '推', '拉', '摇', '跟'] as const;
export const TRANSITIONS = ['切', '叠化', '淡入淡出'] as const;

/**
 * 单镜时长的硬边界。
 * 上限 8s 不是审美偏好：两级生成里一个镜头就是一次视频调用，模型单次上限就是 8 秒，
 * 填 12s 不会得到 12s 的片子，只会在生成时被截断或降质。下限 2s 是为了避免短到装不下
 * 一句台词的碎镜。与上面几组枚举同理放在 shared：拆镜提示词、镜头检查器、镜头表三处消费，
 * 任一侧抄字面量都会随时间漂移。
 */
export const SHOT_DURATION_MIN_MS = 2000;
export const SHOT_DURATION_MAX_MS = 8000;

export type ShotSize = (typeof SHOT_SIZES)[number];
export type CameraAngle = (typeof CAMERA_ANGLES)[number];
export type CameraMovement = (typeof CAMERA_MOVEMENTS)[number];
export type Transition = (typeof TRANSITIONS)[number];

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
