import { z } from 'zod';
import { ModalitySchema } from './enums.js';

/**
 * 模型能力描述（v2 §8）。
 * 前台所有“选模型”位点按 modality + input 能力过滤本描述渲染按钮与参数表单；
 * 前端零硬编码——后台新增/停用模型，前台自动出现/消失。
 */
export const CapabilityInputSchema = z.enum([
  'prompt',
  'first_frame',
  'first_last_frame',
  'ref_images',
  'voice_sample',
  'audio',
]);
export type CapabilityInput = z.infer<typeof CapabilityInputSchema>;

export const CapabilityDescriptorSchema = z.object({
  modality: ModalitySchema,
  input: z.array(CapabilityInputSchema).default(['prompt']),
  output: z
    .object({
      resolutions: z.array(z.string()).optional(),
      ratios: z.array(z.string()).optional(),
      maxDurationS: z.number().positive().optional(),
    })
    .optional(),
  /** JSON Schema：前端据此渲染该模型的参数表单 */
  paramsSchema: z.record(z.unknown()).optional(),
  /** 语音模型的可选音色（配音页"角色声音"面板数据源） */
  voices: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  flags: z
    .object({
      supportsVoiceReference: z.boolean().optional(),
      supportsPreview: z.boolean().optional(),
    })
    .optional(),
});
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;

/** GET /api/capabilities 的条目：enabled ModelConfig 的前台投影 */
export const CapabilityEntrySchema = z.object({
  modelConfigId: z.string(),
  providerConfigId: z.string(),
  providerName: z.string(),
  modelKey: z.string(),
  label: z.string(),
  capability: CapabilityDescriptorSchema,
});
export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>;
