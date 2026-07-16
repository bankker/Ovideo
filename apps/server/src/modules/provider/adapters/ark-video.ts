// 火山方舟 视频生成适配器（Seedance / wan2 等）。
// 与 OpenAI 兼容接口不同：这是异步任务 API——创建任务 → 轮询状态 → 下载产物。
// 文档形态：POST {base}/contents/generations/tasks → { id }；GET .../tasks/{id} → { status, content.video_url }。
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export interface ArkVideoConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ArkVideoArgs {
  prompt: string;
  /** 首帧图片的本地绝对路径（i2v）；null = 纯文生视频 */
  firstFramePath: string | null;
  durationMs: number;
  outPath: string;
  onProgress?: (percent: number) => Promise<void> | void;
  /** 轮询间隔与总超时（测试注入用） */
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/** Seedance 单次生成支持 5s / 10s，把镜头时长映射到最近档位 */
export function mapSeedanceDurationS(durationMs: number): 5 | 10 {
  return durationMs / 1000 <= 7 ? 5 : 10;
}

function toDataUrl(filePath: string): string {
  const ext = path.extname(filePath).replace('.', '').toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const b64 = fs.readFileSync(filePath).toString('base64');
  return `data:image/${mime};base64,${b64}`;
}

async function arkFetch(url: string, apiKey: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
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
    throw new Error(isTimeout ? `请求超时：${host} 无响应` : `网络不可达：无法连接 ${host}`);
  }
}

/**
 * 生成一段视频到 outPath。
 * 时长映射到 Seedance 支持的 5/10s 档位；分辨率 720p、比例跟随首帧（adaptive）。
 */
export async function arkVideoGenerate(cfg: ArkVideoConfig, args: ArkVideoArgs): Promise<void> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const durationS = mapSeedanceDurationS(args.durationMs);
  const commandText =
    `${args.prompt.trim()} --resolution 720p --duration ${durationS} --ratio adaptive --watermark false`;

  const content: Array<Record<string, unknown>> = [{ type: 'text', text: commandText }];
  if (args.firstFramePath) {
    content.push({ type: 'image_url', image_url: { url: toDataUrl(args.firstFramePath) }, role: 'first_frame' });
  }

  // 1) 创建任务
  const createRes = await arkFetch(`${base}/contents/generations/tasks`, cfg.apiKey, {
    method: 'POST',
    body: JSON.stringify({ model: cfg.model, content }),
  });
  const createText = await createRes.text();
  if (!createRes.ok) {
    throw new Error(`视频任务创建失败：HTTP ${createRes.status}，响应：${createText.slice(0, 300)}`);
  }
  const taskId = (JSON.parse(createText) as { id?: string }).id;
  if (!taskId) throw new Error(`视频任务创建响应缺少任务 id：${createText.slice(0, 200)}`);

  // 2) 轮询（视频生成通常 1~5 分钟）
  const pollInterval = args.pollIntervalMs ?? 4000;
  const timeout = args.timeoutMs ?? 12 * 60 * 1000;
  const startedAt = Date.now();
  let videoUrl: string | null = null;
  let polls = 0;
  for (;;) {
    if (Date.now() - startedAt > timeout) {
      throw new Error(`视频生成超时（超过 ${Math.round(timeout / 60000)} 分钟），任务 ${taskId} 可在方舟控制台查看`);
    }
    await new Promise((r) => setTimeout(r, pollInterval));
    polls += 1;
    const res = await arkFetch(`${base}/contents/generations/tasks/${taskId}`, cfg.apiKey);
    const text = await res.text();
    if (!res.ok) throw new Error(`视频任务查询失败：HTTP ${res.status}，响应：${text.slice(0, 300)}`);
    const task = JSON.parse(text) as {
      status?: string;
      content?: { video_url?: string };
      error?: { code?: string; message?: string };
    };
    const status = (task.status ?? '').toLowerCase();
    if (status === 'succeeded') {
      videoUrl = task.content?.video_url ?? null;
      if (!videoUrl) throw new Error(`视频任务成功但响应缺少 video_url：${text.slice(0, 200)}`);
      break;
    }
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`视频生成${status === 'failed' ? '失败' : '被取消'}：${task.error?.message ?? text.slice(0, 200)}`);
    }
    // queued / running：进度按轮询次数渐近映射到 15~85
    await args.onProgress?.(Math.min(85, 15 + polls * 4));
  }

  // 3) 下载产物（预签名 URL，无需鉴权头）
  const dl = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
  if (!dl.ok || !dl.body) throw new Error(`视频下载失败：HTTP ${dl.status}`);
  await pipeline(Readable.fromWeb(dl.body as import('node:stream/web').ReadableStream), fs.createWriteStream(args.outPath));
  await args.onProgress?.(95);
}
