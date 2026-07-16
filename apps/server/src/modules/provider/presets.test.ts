import { describe, expect, it } from 'vitest';
import { CapabilityDescriptorSchema } from '@ovideo/shared';
import { defaultCapabilityFor, PROVIDER_PRESETS } from './presets.js';

describe('defaultCapabilityFor 模态默认能力模板', () => {
  it('text：仅 prompt 输入', () => {
    expect(defaultCapabilityFor('text')).toEqual({ modality: 'text', input: ['prompt'] });
  });
  it('image：prompt + 参考图', () => {
    expect(defaultCapabilityFor('image')).toEqual({ modality: 'image', input: ['prompt', 'ref_images'] });
  });
  it('video：prompt + 首帧，含最大时长', () => {
    expect(defaultCapabilityFor('video')).toEqual({
      modality: 'video',
      input: ['prompt', 'first_frame'],
      output: { maxDurationS: 15 },
    });
  });
  it('tts：仅 prompt 输入', () => {
    expect(defaultCapabilityFor('tts')).toEqual({ modality: 'tts', input: ['prompt'] });
  });
  it('四种模态的模板均通过 CapabilityDescriptorSchema 校验', () => {
    for (const m of ['text', 'image', 'video', 'tts'] as const) {
      expect(CapabilityDescriptorSchema.safeParse(defaultCapabilityFor(m)).success).toBe(true);
    }
  });
});

describe('PROVIDER_PRESETS 预置库结构完整性', () => {
  it('包含全部 7 个平台且 id 唯一', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toEqual([
      'volcengine-ark',
      'aliyun-bailian',
      'deepseek',
      'openrouter',
      'google-gemini',
      'moonshot',
      'zhipu',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每个平台：vendor 固定 openai-compatible、baseUrl 为 https、至少一个模型', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.vendor).toBe('openai-compatible');
      expect(p.baseUrl).toMatch(/^https:\/\//);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.models.length).toBeGreaterThan(0);
    }
  });

  it('每个平台至少一个 recommended 模型', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(
        p.models.some((m) => m.recommended),
        `${p.id} 缺少 recommended 模型`,
      ).toBe(true);
    }
  });

  it('每个模型：capability 通过 CapabilityDescriptorSchema 校验且 modality 与声明一致，平台内 key 唯一', () => {
    for (const p of PROVIDER_PRESETS) {
      const keys = p.models.map((m) => m.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const m of p.models) {
        expect(m.label.length).toBeGreaterThan(0);
        const parsed = CapabilityDescriptorSchema.safeParse(m.capability);
        expect(parsed.success, `${p.id}/${m.key} capability 非法`).toBe(true);
        if (parsed.success) expect(parsed.data.modality).toBe(m.modality);
      }
    }
  });

  it('需代理的海外平台带国内网络提示', () => {
    for (const id of ['openrouter', 'google-gemini']) {
      const p = PROVIDER_PRESETS.find((x) => x.id === id)!;
      expect(p.note).toContain('国内网络可能需要代理');
    }
  });

  it('火山方舟视频模型标注 M3 接入提示且 recommended=false', () => {
    const ark = PROVIDER_PRESETS.find((p) => p.id === 'volcengine-ark')!;
    const video = ark.models.find((m) => m.key === 'doubao-seedance-1-0-pro')!;
    expect(video.modality).toBe('video');
    expect(video.recommended).toBe(false);
    expect(video.note).toBe('视频适配器 M3 接入后可用');
  });
});
