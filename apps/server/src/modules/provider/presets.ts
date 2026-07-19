import type { CapabilityDescriptor, Modality } from '@ovideo/shared';

/**
 * 平台预置库（纯数据）：让用户免手写 JSON——选平台 → 填 key → 勾模型即可用。
 * 所有预置均为 OpenAI 兼容网关；capability 由 defaultCapabilityFor 按模态统一生成。
 */

export interface ProviderPreset {
  id: string;
  name: string;
  vendor: 'openai-compatible';
  baseUrl: string;
  note?: string;
  /**
   * 鉴权探针路径：/models 为公开接口（不带 key 也 2xx）的平台必须配置，
   * 否则"贴 key 识别归属"无法在该平台上判别（见 scheduler.probePreset 的双请求对照）。
   */
  authProbePath?: string;
  models: PresetModel[];
}

export interface PresetModel {
  key: string;
  label: string;
  modality: Modality;
  capability: CapabilityDescriptor;
  recommended: boolean;
  note?: string;
}

/** 按模态生成默认能力描述：新建/批量导入模型时 capability 缺省的唯一来源 */
export function defaultCapabilityFor(modality: Modality): CapabilityDescriptor {
  switch (modality) {
    case 'text':
      return { modality: 'text', input: ['prompt'] };
    case 'image':
      return { modality: 'image', input: ['prompt', 'ref_images'] };
    case 'video':
      return { modality: 'video', input: ['prompt', 'first_frame'], output: { maxDurationS: 15 } };
    case 'tts':
      return { modality: 'tts', input: ['prompt'] };
    case 'vision':
      // 视觉理解：吃提示词 + 待评审/参考图，产出文本判定（不产图）
      return { modality: 'vision', input: ['prompt', 'image'] };
  }
}

function preset(
  key: string,
  label: string,
  modality: Modality,
  recommended: boolean,
  note?: string,
): PresetModel {
  return {
    key,
    label,
    modality,
    capability: defaultCapabilityFor(modality),
    recommended,
    ...(note ? { note } : {}),
  };
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'volcengine-ark',
    name: '火山方舟（豆包/Seedream）',
    vendor: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    note: '国内直连，无需代理；一把 API Key 同时可用文本/图像/视频模型',
    models: [
      preset('doubao-seed-1-6-250615', 'Doubao Seed 1.6', 'text', true),
      preset('doubao-1-5-pro-32k-250115', 'Doubao 1.5 Pro 32K', 'text', false),
      preset('doubao-seedream-4-0-250828', 'Seedream 4.0 文生图', 'image', true),
      preset('doubao-seedream-3-0-t2i-250415', 'Seedream 3.0 文生图（旧版，部分账号无权限）', 'image', false),
      preset('doubao-seedance-1-0-pro-250528', 'Seedance 1.0 Pro 视频', 'video', true, '单次生成 5s/10s，超长镜头请用衔接组'),
    ],
  },
  {
    id: 'aliyun-bailian',
    name: '阿里云百炼（通义千问）',
    vendor: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    note: '国内直连，无需代理',
    models: [
      preset('qwen-plus', 'Qwen Plus', 'text', true),
      preset('qwen-max', 'Qwen Max', 'text', false),
      preset('qwen-flash', 'Qwen Flash', 'text', false),
      {
        key: 'qwen-tts',
        label: 'Qwen-TTS 语音合成',
        modality: 'tts',
        recommended: true,
        note: '配音功能的语音模型，同一把 Key 即用',
        capability: {
          ...defaultCapabilityFor('tts'),
          voices: [
            { id: 'Cherry', label: '芊悦（女·活泼）' },
            { id: 'Ethan', label: '晨煦（男·阳光）' },
            { id: 'Chelsie', label: '千雪（女·温柔）' },
            { id: 'Serena', label: '苏瑶（女·沉稳）' },
          ],
        },
      },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    note: '国内直连，无需代理',
    models: [
      preset('deepseek-chat', 'DeepSeek Chat', 'text', true),
      preset('deepseek-reasoner', 'DeepSeek Reasoner', 'text', false),
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter（聚合网关）',
    vendor: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    note: '国内网络可能需要代理',
    authProbePath: '/key', // OpenRouter 的 /models 公开，需用 /key 验证 key 归属
    models: [
      preset('google/gemini-2.5-flash', 'Gemini 2.5 Flash', 'text', true),
      preset('openai/gpt-4o', 'GPT-4o', 'text', false),
      preset('anthropic/claude-sonnet-4', 'Claude Sonnet 4', 'text', false),
      preset('deepseek/deepseek-chat', 'DeepSeek Chat', 'text', false),
    ],
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini（直连）',
    vendor: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    note: '国内网络可能需要代理',
    models: [
      preset('gemini-2.5-flash', 'Gemini 2.5 Flash', 'text', true),
      preset('gemini-2.5-pro', 'Gemini 2.5 Pro', 'text', false),
    ],
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    vendor: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    note: '国内直连，无需代理',
    models: [
      preset('kimi-k2-0711-preview', 'Kimi K2', 'text', true),
      preset('moonshot-v1-8k', 'Moonshot v1 8K', 'text', false),
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    vendor: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    note: '国内直连，无需代理',
    models: [
      preset('glm-4.5', 'GLM-4.5', 'text', true),
      preset('glm-4.5-air', 'GLM-4.5 Air', 'text', false),
    ],
  },
];
