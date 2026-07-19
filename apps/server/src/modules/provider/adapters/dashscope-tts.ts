// 阿里云百炼 Qwen-TTS 适配器（DashScope 原生 API，非 OpenAI 兼容格式）。
// 请求：POST {origin}/api/v1/services/aigc/multimodal-generation/generation
// 响应：output.audio.url（临时下载地址）或 output.audio.data（base64），下载/解码落盘。
// 语速：Qwen-TTS 无原生语速参数，用 ffmpeg atempo 后处理（0.5~2.0 恰在单级 atempo 范围内），
// 保证配音页的语速调节与时长链路继续生效。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runFfmpeg } from '../../../lib/ffmpeg.js';

export interface DashScopeTtsConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface DashScopeTtsArgs {
  text: string;
  /** 0.5 ~ 2.0，1.0 原速 */
  speed: number;
  /** 稳定音色种子（同角色同音色）；也可传 Qwen-TTS 音色名直接指定 */
  voiceSeed: string;
  outPath: string;
}

/** Qwen-TTS 内置音色池（男女声交错，按种子稳定分配，保证同角色全剧同音色） */
export const QWEN_TTS_VOICES = ['Cherry', 'Ethan', 'Chelsie', 'Serena'] as const;

export function pickVoice(voiceSeed: string): string {
  // 直接指定了合法音色名则原样使用（VoiceProfile.voiceId 场景）
  if ((QWEN_TTS_VOICES as readonly string[]).includes(voiceSeed)) return voiceSeed;
  if (voiceSeed === 'narrator') return 'Serena'; // 旁白固定用沉稳女声
  const hash = crypto.createHash('md5').update(voiceSeed).digest();
  return QWEN_TTS_VOICES[hash[0] % QWEN_TTS_VOICES.length];
}

function ttsEndpoint(baseUrl: string): string {
  // provider.baseUrl 通常是 OpenAI 兼容路径（…/compatible-mode/v1），TTS 走原生路径，只取 origin
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    origin = 'https://dashscope.aliyuncs.com';
  }
  return `${origin}/api/v1/services/aigc/multimodal-generation/generation`;
}

export async function dashscopeTtsGenerate(
  cfg: DashScopeTtsConfig,
  args: DashScopeTtsArgs,
): Promise<void> {
  const url = ttsEndpoint(cfg.baseUrl);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        input: { text: args.text, voice: pickVoice(args.voiceSeed) },
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    })();
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    throw new Error(isTimeout ? `语音合成请求超时：${host} 无响应` : `网络不可达：无法连接 ${host}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`语音合成请求失败：HTTP ${res.status}，响应：${text.slice(0, 300)}`);
  }
  let parsed: { output?: { audio?: { url?: string; data?: string } } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`语音合成响应结构异常（非 JSON）：${text.slice(0, 300)}`);
  }
  const audio = parsed.output?.audio;
  if (!audio?.url && !audio?.data) {
    throw new Error(`语音合成响应缺少音频（output.audio.url/data）：${text.slice(0, 300)}`);
  }

  // 先落原始音频到临时文件
  const rawPath = path.join(os.tmpdir(), `qwen-tts-${crypto.randomUUID()}.wav`);
  try {
    if (audio.url) {
      const dl = await fetch(audio.url, { signal: AbortSignal.timeout(60_000) });
      if (!dl.ok) throw new Error(`语音文件下载失败：HTTP ${dl.status}`);
      fs.writeFileSync(rawPath, Buffer.from(await dl.arrayBuffer()));
    } else {
      fs.writeFileSync(rawPath, Buffer.from(audio.data!, 'base64'));
    }

    // 语速后处理：atempo 变速不变调；1.0 直接转码统一格式
    const speed = Math.min(2, Math.max(0.5, args.speed || 1));
    const filters = speed === 1 ? [] : ['-filter:a', `atempo=${speed}`];
    await runFfmpeg(['-y', '-i', rawPath, ...filters, '-ar', '32000', '-ac', '1', args.outPath]);
  } finally {
    fs.rmSync(rawPath, { force: true });
  }
}
