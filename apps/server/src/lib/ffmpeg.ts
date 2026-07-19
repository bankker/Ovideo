import { spawn } from 'node:child_process';

/** 以 spawn 方式跑 ffmpeg/ffprobe（开发机与生产镜像均要求 PATH 里有 ffmpeg） */
export function runFfmpeg(args: string[], bin = 'ffmpeg'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout || stderr);
      else reject(new Error(`${bin} 退出码 ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/** 纯色占位图（Mock 图像执行器用；不用 drawtext，避免 Windows 字体路径转义问题） */
export async function makePlaceholderImage(opts: {
  outPath: string;
  color?: string;
  width?: number;
  height?: number;
}): Promise<void> {
  const { outPath, color = 'steelblue', width = 720, height = 1280 } = opts;
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:d=1`, '-frames:v', '1', outPath]);
}

/** 纯色占位视频（Mock 视频执行器用） */
export async function makePlaceholderVideo(opts: {
  outPath: string;
  durationMs: number;
  color?: string;
  width?: number;
  height?: number;
}): Promise<void> {
  const { outPath, durationMs, color = 'darkslategray', width = 720, height = 1280 } = opts;
  const sec = Math.max(0.5, durationMs / 1000).toFixed(2);
  await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:d=${sec}:r=24`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    outPath,
  ]);
}

/** 正弦波占位音频（Mock TTS 执行器用），时长按 durationMs */
export async function makeSineWav(opts: { outPath: string; durationMs: number; freq?: number }): Promise<void> {
  const { outPath, durationMs, freq = 440 } = opts;
  const sec = Math.max(0.2, durationMs / 1000).toFixed(2);
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${sec}`, outPath]);
}

/** 抽帧：videoPath 的 timeMs 处抽一帧到 outPath（v2 §5 首尾帧衔接的基础能力） */
export async function extractFrame(opts: { videoPath: string; timeMs: number; outPath: string }): Promise<void> {
  const { videoPath, timeMs, outPath } = opts;
  await runFfmpeg(['-y', '-ss', (timeMs / 1000).toFixed(3), '-i', videoPath, '-frames:v', '1', outPath]);
}

/** ffprobe 读视频流分辨率；无视频流/解析失败返回 null */
export async function probeDimensions(
  mediaPath: string,
): Promise<{ width: number; height: number } | null> {
  try {
    const out = await runFfmpeg(
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', mediaPath],
      'ffprobe',
    );
    const m = /^(\d+)x(\d+)/.exec(out.trim());
    if (!m) return null;
    return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
  } catch {
    return null;
  }
}

/** ffprobe 读媒体时长（毫秒） */
export async function probeDurationMs(mediaPath: string): Promise<number> {
  const out = await runFfmpeg(
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', mediaPath],
    'ffprobe',
  );
  const sec = parseFloat(out.trim());
  return Number.isFinite(sec) ? Math.round(sec * 1000) : 0;
}
