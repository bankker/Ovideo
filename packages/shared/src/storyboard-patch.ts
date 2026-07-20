import { z } from 'zod';
import { TagTypeSchema } from './enums.js';

/**
 * 分镜补丁协议（v2 §4 的机制核心）。
 * 三步生成与对话修改的产出都是 patch（变更集），不是整份重写——
 * 从机制上杜绝旧系统“重新生成在镜头 11 之后重复累加”的缺陷。
 * 应用 patch = 基于当前 Storyboard 版本复制未变镜头 + 应用 ops → 新版本。
 */

export const ShotDialogueInputSchema = z.object({
  /** 说话角色的标签名；缺省且 isNarrator=false 时按旁白处理 */
  speaker: z.string().optional(),
  isNarrator: z.boolean().default(false),
  text: z.string(),
});
export type ShotDialogueInput = z.infer<typeof ShotDialogueInputSchema>;

/**
 * 镜头所属场景的引用。
 * sceneKey 只在单个 patch 内有意义：应用 patch 时按它分组，同一 sceneKey 的多个镜头
 * 归入同一条 Scene 行——这样"先拆场景、再在场景内拆镜头"的两级生成可以用一组
 * add_shot 表达，无需给 patch 协议新增 op（既有调用方零改动）。
 */
export const ShotSceneRefSchema = z.object({
  /** 同一 patch 内的分组键 */
  sceneKey: z.string().min(1),
  /** 场景序号（0-based，展示为 S01/S02） */
  sortOrder: z.number().int().nonnegative(),
  title: z.string().optional(),
  location: z.string().optional(),
  interiorExterior: z.string().optional(),
  timeOfDay: z.string().optional(),
  sourceText: z.string().optional(),
});
export type ShotSceneRef = z.infer<typeof ShotSceneRefSchema>;

export const NewShotInputSchema = z.object({
  sourceText: z.string().default(''),
  imagePrompt: z.string().default(''),
  videoPrompt: z.string().default(''),
  /** 拆分策略：同场景连续剧情 10–15s/镜头（v2 §4） */
  durationPlannedMs: z.number().int().positive().default(12000),
  tags: z.array(z.object({ name: z.string().min(1), type: TagTypeSchema })).default([]),
  dialogue: z.array(ShotDialogueInputSchema).default([]),
  /**
   * 该镜头所属场景。不传 = 不归属任何场景（保持旧行为，用于兼容既有调用方如对话改分镜）。
   * 必须保持可选：Scene 是可空关联，代码不得假设镜头一定有场景。
   */
  sceneRef: ShotSceneRefSchema.optional(),
  // ---- 影视语义（可选，缺省由服务层落为空串）----
  /** 景别：远景/全景/中景/近景/特写 */
  shotSize: z.string().optional(),
  /** 角度：平视/俯拍/仰拍/过肩 */
  cameraAngle: z.string().optional(),
  /** 运镜：固定/推/拉/摇/跟 */
  cameraMovement: z.string().optional(),
  /** 构图描述 */
  composition: z.string().optional(),
  /** 转场：切/叠化/淡入淡出 */
  transition: z.string().optional(),
});
export type NewShotInput = z.infer<typeof NewShotInputSchema>;

export const ShotEditableFieldsSchema = z
  .object({
    sourceText: z.string(),
    imagePrompt: z.string(),
    videoPrompt: z.string(),
    durationPlannedMs: z.number().int().positive(),
    tags: z.array(z.object({ name: z.string().min(1), type: TagTypeSchema })),
    dialogue: z.array(ShotDialogueInputSchema),
    // 影视语义：update_shot 可单独改这几项，不影响提示词/时长
    shotSize: z.string(),
    cameraAngle: z.string(),
    cameraMovement: z.string(),
    composition: z.string(),
    transition: z.string(),
  })
  .partial();
export type ShotEditableFields = z.infer<typeof ShotEditableFieldsSchema>;

export const StoryboardPatchOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_shot'),
    /** 插入到该镜头之后；null/缺省 = 追加到末尾 */
    afterShotId: z.string().nullable().optional(),
    shot: NewShotInputSchema,
  }),
  z.object({
    op: z.literal('update_shot'),
    shotId: z.string(),
    fields: ShotEditableFieldsSchema,
  }),
  z.object({
    op: z.literal('remove_shot'),
    shotId: z.string(),
  }),
  z.object({
    op: z.literal('reorder'),
    /** 全量镜头 id 的新顺序 */
    shotIds: z.array(z.string()),
  }),
]);
export type StoryboardPatchOp = z.infer<typeof StoryboardPatchOpSchema>;

export const StoryboardPatchSchema = z.array(StoryboardPatchOpSchema);
export type StoryboardPatch = z.infer<typeof StoryboardPatchSchema>;

/** LLM 三步生成的结构化输出：整体就是一组 add_shot */
export const GeneratedStoryboardSchema = z.object({
  shots: z.array(NewShotInputSchema).min(1),
});
export type GeneratedStoryboard = z.infer<typeof GeneratedStoryboardSchema>;
