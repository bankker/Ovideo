import { z } from 'zod';

/** 标签类型：角色 / 场景 / 道具（v2 §1，一致性锚点） */
export const TagTypeSchema = z.enum(['CHARACTER', 'SCENE', 'PROP']);
export type TagType = z.infer<typeof TagTypeSchema>;

export const AssetTypeSchema = z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'FRAME', 'VOICE_SAMPLE', 'FINAL']);
export type AssetType = z.infer<typeof AssetTypeSchema>;

export const AssetSourceSchema = z.enum(['GENERATED', 'UPLOADED', 'EXTRACTED']);
export type AssetSource = z.infer<typeof AssetSourceSchema>;

export const AssetStatusSchema = z.enum(['ACTIVE', 'RECYCLED']);
export type AssetStatus = z.infer<typeof AssetStatusSchema>;

/** 镜头的两个产物槽 */
export const TakeSlotSchema = z.enum(['KEYFRAME', 'VIDEO']);
export type TakeSlot = z.infer<typeof TakeSlotSchema>;

export const JobStatusSchema = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** LOCAL=本地 FFmpeg 处理（拼接/放大/补帧/抽帧等）；MOCK 仅为历史任务行兼容保留，运行时不再产生 */
export const JobExecutorKindSchema = z.enum(['LOCAL', 'API', 'GPU', 'MOCK']);
export type JobExecutorKind = z.infer<typeof JobExecutorKindSchema>;

export const JobTypeSchema = z.enum([
  // 一句话创意 → 剧本正文；产出写回 ScriptDraft.content，与手工粘贴剧本汇入同一条路径
  'GENERATE_SCRIPT',
  'GENERATE_STORYBOARD',
  'GENERATE_IMAGE',
  'GENERATE_VIDEO',
  'GENERATE_TTS',
  'UPSCALE',
  'INTERPOLATE',
  'EXTRACT_FRAME',
  'EXTRACT_AUDIO',
  'COMPOSE_CUT',
  'PROVIDER_TEST',
  // 关键图自动收敛 agent：生成→视觉评审→重抽/改写的多轮闭环（只生图，绝不触发视频生成）
  'AGENT_KEYFRAME_CONVERGE',
]);
export type JobType = z.infer<typeof JobTypeSchema>;

export const ProviderCategorySchema = z.enum(['TEXT', 'IMAGE', 'VIDEO', 'TTS']);
export type ProviderCategory = z.infer<typeof ProviderCategorySchema>;

/** vision = 视觉理解（看图打分/评审），只读图不产图，与产图的 image 模态区分开 */
export const ModalitySchema = z.enum(['text', 'image', 'video', 'tts', 'vision']);
export type Modality = z.infer<typeof ModalitySchema>;

export const DubbingStatusSchema = z.enum(['PENDING', 'GENERATING', 'READY', 'FAILED']);
export type DubbingStatus = z.infer<typeof DubbingStatusSchema>;

export const CutStatusSchema = z.enum(['DRAFT', 'COMPOSING', 'READY', 'FAILED']);
export type CutStatus = z.infer<typeof CutStatusSchema>;

/** 失效原因条目（写入 Shot.staleReasonsJson / Storyboard.staleReasonsJson，追加式） */
export const StaleReasonSchema = z.object({
  source: z.string(),
  at: z.string(),
  detail: z.string(),
});
export type StaleReason = z.infer<typeof StaleReasonSchema>;
