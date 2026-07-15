// 生成函数抽象（M2 S2）：三个可注入的 Gen 函数类型 + Mock 默认实现。
// 真实适配器（API executor 路径）后续按同签名注入，执行器代码不感知 Mock/真实差异。
import { makePlaceholderImage, makePlaceholderVideo, makeSineWav } from '../../lib/ffmpeg.js';

/** modelConfigId 解析出的模型调用配置（真实适配器用；Mock 忽略） */
export interface GenModelCfg {
  baseUrl: string;
  apiKey: string;
  modelKey: string;
}

export type ImageGen = (args: {
  prompt: string;
  refUris: string[];
  outPath: string;
  modelCfg?: GenModelCfg;
}) => Promise<void>;

export type VideoGen = (args: {
  prompt: string;
  firstFrameUri: string | null;
  durationMs: number;
  outPath: string;
  modelCfg?: GenModelCfg;
}) => Promise<void>;

export type TtsGen = (args: {
  text: string;
  speed: number;
  voiceSeed: string;
  outPath: string;
  modelCfg?: GenModelCfg;
}) => Promise<void>;

/** 稳定字符串哈希（确定性：同输入永远同输出，供取色/取音高） */
export function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** 16 个肉眼可区分的 FFmpeg 颜色名：不同 prompt 的占位图/占位视频颜色不同 */
export const MOCK_COLORS = [
  'crimson',
  'coral',
  'orange',
  'gold',
  'yellowgreen',
  'forestgreen',
  'teal',
  'deepskyblue',
  'steelblue',
  'royalblue',
  'slateblue',
  'purple',
  'orchid',
  'hotpink',
  'sienna',
  'dimgray',
] as const;

/** prompt 前 32 字稳定哈希取色（同 prompt 同色，不同镜头/标签肉眼可区分） */
export function colorForPrompt(prompt: string): string {
  return MOCK_COLORS[hashStr(prompt.slice(0, 32)) % MOCK_COLORS.length]!;
}

/** Mock 图像生成：纯色占位 PNG（720x1280 竖屏） */
export const mockImageGen: ImageGen = async ({ prompt, outPath }) => {
  await makePlaceholderImage({ outPath, color: colorForPrompt(prompt) });
};

/** Mock 视频生成：同色系纯色占位 MP4 */
export const mockVideoGen: VideoGen = async ({ prompt, durationMs, outPath }) => {
  await makePlaceholderVideo({ outPath, durationMs, color: colorForPrompt(prompt) });
};

/**
 * Mock TTS：正弦波占位 WAV。
 * 时长 = max(800ms, 去空白字符数 × 220ms / speed)（近似真人语速）；
 * 频率 = 220 + (hash(voiceSeed) % 16) × 40 —— 不同角色不同音高，可听出差异。
 */
export const mockTtsGen: TtsGen = async ({ text, speed, voiceSeed, outPath }) => {
  const charCount = text.replace(/\s/g, '').length;
  const durationMs = Math.max(800, Math.round((charCount * 220) / speed));
  const freq = 220 + (hashStr(voiceSeed) % 16) * 40;
  await makeSineWav({ outPath, durationMs, freq });
};
