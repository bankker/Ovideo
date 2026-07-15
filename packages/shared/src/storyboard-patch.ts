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

export const NewShotInputSchema = z.object({
  sourceText: z.string().default(''),
  imagePrompt: z.string().default(''),
  videoPrompt: z.string().default(''),
  /** 拆分策略：同场景连续剧情 10–15s/镜头（v2 §4） */
  durationPlannedMs: z.number().int().positive().default(12000),
  tags: z.array(z.object({ name: z.string().min(1), type: TagTypeSchema })).default([]),
  dialogue: z.array(ShotDialogueInputSchema).default([]),
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
