// OpenAI 兼容图像生成适配器：POST /images/generations（b64_json → 直接落盘）。
// 错误处理与超时风格同 openai-compatible.ts（AbortSignal.timeout，错误带状态码与响应片段）。
import fs from 'node:fs';
import path from 'node:path';

export interface OpenAiImageConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface OpenAiImageArgs {
  prompt: string;
  /** 生成图直接写入该绝对路径（由调用方 allocFilePath 预分配） */
  outPath: string;
  /** 缺省竖屏 1024x1792（平台统一 9:16 方向） */
  size?: string;
  /**
   * 参考图本地绝对路径（角色/场景一致性的关键）：以 base64 data URL 经 `image` 字段上送。
   * 这是火山方舟 Seedream 等对 OpenAI images 协议的扩展；标准 OpenAI 端点会忽略未知字段。
   * 最多取前 5 张（Ark 上限），空数组时不携带该字段。
   */
  refImagePaths?: string[];
}

const MAX_REF_IMAGES = 5;

function toDataUrl(filePath: string): string {
  const ext = path.extname(filePath).replace('.', '').toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

/** 图像生成默认超时 120s（比文本长：出图普遍慢） */
const DEFAULT_TIMEOUT_MS = 120_000;

export async function openaiImageGenerate(
  cfg: OpenAiImageConfig,
  args: OpenAiImageArgs,
): Promise<void> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/images/generations`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      prompt: args.prompt,
      size: args.size ?? '1024x1792',
      response_format: 'b64_json',
      ...(args.refImagePaths && args.refImagePaths.length > 0
        ? { image: args.refImagePaths.slice(0, MAX_REF_IMAGES).map(toDataUrl) }
        : {}),
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`图像生成请求失败：HTTP ${res.status}，响应：${text.slice(0, 300)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`图像生成响应结构异常（非 JSON）：${text.slice(0, 300)}`);
  }
  const b64 = (parsed as { data?: Array<{ b64_json?: unknown }> })?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || b64.length === 0) {
    throw new Error(`图像生成响应结构异常（缺 data[0].b64_json）：${text.slice(0, 300)}`);
  }
  fs.writeFileSync(args.outPath, Buffer.from(b64, 'base64'));
}
