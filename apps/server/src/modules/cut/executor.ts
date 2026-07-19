// COMPOSE_CUT 执行器：把 Cut.itemsJson 里的选定视频片段逐段转码到统一规格、
// 混入该镜头的配音（audioTracksJson 快照，台词从镜头起点顺序播放），
// 再用 concat demuxer 合并为 FINAL 资产（720x1280 / 24fps / H264+AAC）。
// 铁律：血缘 parents = 全部片段资产 + 配音音频资产；失败时 Cut 置 FAILED 后 rethrow（错误留给 Job 面板）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Cut } from '@prisma/client';
import { z } from 'zod';
import { badRequest, notFound } from '../../lib/errors.js';
import { extractFrame, probeDimensions, probeDurationMs, runFfmpeg } from '../../lib/ffmpeg.js';
import { parseJson } from '../../lib/json.js';
import { allocFilePath, fileSize, uriToAbsPath } from '../../lib/storage.js';
import { createAsset } from '../asset/service.js';
import {
  registerExecutor,
  type JobExecutor,
  type JobExecutorContext,
  type JobExecutorResult,
} from '../job/registry.js';
import type { CutAudioLine, CutItem } from './service.js';

const FPS = 24;

const ComposeCutInputSchema = z.object({
  cutId: z.string().min(1),
  // SMART=配音替换原声（默认）；DUCK=原声压低 25% 垫底；MIX=等响叠加（旧行为）。仅影响有配音的镜头。
  audioMixMode: z.enum(['SMART', 'DUCK', 'MIX']).default('SMART'),
  // AUTO=画布跟随首个片段的实际分辨率（默认）；显式比例用固定画布
  ratio: z.enum(['AUTO', '9:16', '16:9', '1:1', '3:4', '4:3']).default('AUTO'),
});

/** 显式比例 → 固定画布 */
const RATIO_CANVAS: Record<string, { width: number; height: number }> = {
  '9:16': { width: 720, height: 1280 },
  '16:9': { width: 1280, height: 720 },
  '1:1': { width: 1080, height: 1080 },
  '3:4': { width: 960, height: 1280 },
  '4:3': { width: 1280, height: 960 },
};

/** AUTO 兜底画布（首片段探测失败时） */
const FALLBACK_CANVAS = { width: 720, height: 1280 };

/**
 * 配音时间轴常量：与时长链一致（TTS 锁定时长 = Σ行时长 + 行间 300ms 间隔）。
 * HEAD_PAD 让台词不顶着切镜开口，TAIL_PAD 让尾句说完再切镜。
 */
const LINE_GAP_MS = 300;
const HEAD_PAD_MS = 200;
const TAIL_PAD_MS = 500;

/** 镜头配音时间轴总长（含头尾留白）；任一行缺实测时长则返回 null（无法精确对齐时不动画面） */
function dubTimelineMs(lines: CutAudioLine[]): number | null {
  let total = 0;
  for (const l of lines) {
    if (l.durationMs === null || l.durationMs === undefined) return null;
    total += l.durationMs;
  }
  return HEAD_PAD_MS + total + LINE_GAP_MS * (lines.length - 1) + TAIL_PAD_MS;
}

/** 各音轨模式下，有配音镜头的视频原声音量系数 */
const ORIGINAL_VOLUME: Record<'SMART' | 'DUCK' | 'MIX', number> = {
  SMART: 0,
  DUCK: 0.25,
  MIX: 1,
};

/** 统一规格的视频滤镜：等比缩放 + 居中补边 + 固定帧率（容错各段分辨率/帧率差异） */
function buildVf(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${FPS}`;
}

/** 解析成片画布：AUTO 跟随首个片段实际分辨率（取偶对齐编码器要求），显式比例查表 */
async function resolveCanvas(
  ratio: 'AUTO' | '9:16' | '16:9' | '1:1' | '3:4' | '4:3',
  firstSegmentPath: string,
): Promise<{ width: number; height: number }> {
  if (ratio !== 'AUTO') return RATIO_CANVAS[ratio];
  const dims = await probeDimensions(firstSegmentPath);
  if (!dims) return FALLBACK_CANVAS;
  return { width: Math.round(dims.width / 2) * 2, height: Math.round(dims.height / 2) * 2 };
}

/** 集成阶段（app 启动）调用一次 */
export function registerCutExecutor(): void {
  registerExecutor('COMPOSE_CUT', composeCut);
}

export const composeCut: JobExecutor = async (ctx) => {
  const { db, job } = ctx;
  const { cutId, audioMixMode, ratio } = ComposeCutInputSchema.parse(
    parseJson<Record<string, unknown>>(job.inputJson, {}),
  );
  const cut = await db.cut.findUnique({ where: { id: cutId } });
  if (!cut) throw notFound('成片');
  try {
    return await doCompose(ctx, cut, audioMixMode, ratio);
  } catch (err) {
    // 失败先落 Cut 状态再 rethrow：Job 面板与美化页都能看到失败态
    await db.cut
      .update({ where: { id: cut.id }, data: { status: 'FAILED' } })
      .catch(() => undefined);
    throw err;
  }
};

async function doCompose(
  ctx: JobExecutorContext,
  cut: Cut,
  audioMixMode: 'SMART' | 'DUCK' | 'MIX',
  ratio: 'AUTO' | '9:16' | '16:9' | '1:1' | '3:4' | '4:3',
): Promise<JobExecutorResult> {
  const { db, job, updateProgress } = ctx;
  const items = parseJson<CutItem[]>(cut.itemsJson, []);
  if (items.length === 0) throw badRequest('成片没有可合成的片段');
  const canvas = await resolveCanvas(ratio, uriToAbsPath(items[0].uri));
  // 配音快照按镜头分组（组内已按台词顺序排好）
  const audioLines = parseJson<CutAudioLine[]>(cut.audioTracksJson, []);
  const audioByShot = new Map<string, CutAudioLine[]>();
  for (const line of audioLines) {
    const list = audioByShot.get(line.shotId) ?? [];
    list.push(line);
    audioByShot.set(line.shotId, list);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovideo-cut-'));
  try {
    // 1) 逐段转码到统一规格的临时文件；有配音的镜头再混入台词音频
    const segPaths: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const src = uriToAbsPath(items[i].uri);
      const seg = path.join(tmpDir, `seg-${String(i).padStart(3, '0')}.mp4`);
      await transcodeSegment(src, seg, canvas);
      const shotAudio = audioByShot.get(items[i].shotId) ?? [];
      if (shotAudio.length > 0) {
        // 精确对齐配音时间轴：视频过长按台词裁剪（口型段=可见段），过短末帧定格补足
        const targetMs = dubTimelineMs(shotAudio);
        let fitted = seg;
        if (targetMs !== null) {
          const fit = path.join(tmpDir, `seg-${String(i).padStart(3, '0')}-fit.mp4`);
          if (await fitSegmentDuration(seg, fit, targetMs)) fitted = fit;
        }
        const mixed = path.join(tmpDir, `seg-${String(i).padStart(3, '0')}-dub.mp4`);
        await mixDubbing(fitted, shotAudio, mixed, ORIGINAL_VOLUME[audioMixMode]);
        segPaths.push(mixed);
      } else {
        segPaths.push(seg);
      }
      await updateProgress(Math.round(10 + (60 * (i + 1)) / items.length));
    }

    // 2) concat demuxer 合并（文件列表写临时 txt，路径转义单引号）
    const listPath = path.join(tmpDir, 'concat.txt');
    fs.writeFileSync(listPath, segPaths.map((p) => `file '${escapeConcatPath(p)}'`).join('\n'), 'utf8');
    const out = allocFilePath(job.projectId, 'mp4');
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', out.absPath]);
    await updateProgress(80);

    // 3) 探测时长 + 500ms 处抽帧做缩略图（片子比 500ms 还短时取中点兜底）
    const durationMs = await probeDurationMs(out.absPath);
    const thumb = allocFilePath(job.projectId, 'png');
    const thumbAtMs = durationMs > 600 ? 500 : Math.max(0, Math.floor(durationMs / 2));
    await extractFrame({ videoPath: out.absPath, timeMs: thumbAtMs, outPath: thumb.absPath });
    await updateProgress(90);

    // 4) FINAL 资产：血缘 parents = 全部片段资产 + 配音音频资产（付费产物永不物理删除的溯源基础）
    const parentIds = [
      ...new Set([...items.map((it) => it.assetId), ...audioLines.map((l) => l.assetId)]),
    ];
    const asset = await createAsset(db, {
      projectId: job.projectId,
      type: 'FINAL',
      source: 'GENERATED',
      uri: out.uri,
      mime: 'video/mp4',
      sizeBytes: fileSize(out.absPath),
      width: canvas.width,
      height: canvas.height,
      durationMs,
      jobId: job.id,
      parentIds,
      meta: { cutId: cut.id, segmentCount: items.length, dubbedLineCount: audioLines.length },
    });
    // createAsset 不收 thumbUri（M1 冻结接口），补一笔 update
    await db.asset.update({ where: { id: asset.id }, data: { thumbUri: thumb.uri } });

    await db.cut.update({
      where: { id: cut.id },
      data: { status: 'READY', outputAssetId: asset.id },
    });
    return {
      outputAssetIds: [asset.id],
      output: { cutId: cut.id, outputAssetId: asset.id, durationMs },
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** 单段转码：无音轨的源补静音轨，保证 concat 各段流布局一致 */
async function transcodeSegment(
  srcPath: string,
  outPath: string,
  canvas: { width: number; height: number },
): Promise<void> {
  if (!fs.existsSync(srcPath)) {
    throw badRequest(`片段源文件不存在：${srcPath}`);
  }
  const vf = buildVf(canvas.width, canvas.height);
  const common = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2'];
  if (await hasAudioStream(srcPath)) {
    await runFfmpeg(['-y', '-i', srcPath, '-vf', vf, ...common, outPath]);
    return;
  }
  await runFfmpeg([
    '-y',
    '-i', srcPath,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-vf', vf,
    ...common,
    '-map', '0:v:0', '-map', '1:a:0', '-shortest',
    outPath,
  ]);
}

/**
 * 把片段精确适配到配音时间轴长度：过长 → 按 targetMs 裁剪（说话段=可见段，口型与台词同长）；
 * 过短 → 末帧定格（tpad clone）补足，绝不截断台词。误差 ≤120ms 时跳过（返回 false，避免无谓二压）。
 */
async function fitSegmentDuration(
  segPath: string,
  outPath: string,
  targetMs: number,
): Promise<boolean> {
  const actualMs = await probeDurationMs(segPath);
  if (Math.abs(actualMs - targetMs) <= 120) return false;
  const targetS = (targetMs / 1000).toFixed(3);
  if (actualMs > targetMs) {
    await runFfmpeg([
      '-y', '-i', segPath,
      '-t', targetS,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      outPath,
    ]);
    return true;
  }
  const extraS = ((targetMs - actualMs) / 1000 + 0.2).toFixed(3); // 略多补一点，再用 -t 精确封口
  await runFfmpeg([
    '-y', '-i', segPath,
    '-vf', `tpad=stop_mode=clone:stop_duration=${extraS}`,
    '-af', 'apad',
    '-t', targetS,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    outPath,
  ]);
  return true;
}

/**
 * 把镜头的配音行混入片段：台词按序 concat（行间插 300ms 静音，与时长链一致），
 * 整轨延迟 HEAD_PAD 后与片段自身音轨混合。originalVolume 控制原声占比
 * （0=替换 / 0.25=垫底 / 1=等响叠加），duration=first 锁定片段时长。视频流直接 copy 不二压。
 */
async function mixDubbing(
  segPath: string,
  lines: CutAudioLine[],
  outPath: string,
  originalVolume: number,
): Promise<void> {
  const lineAbsPaths = lines.map((l) => uriToAbsPath(l.uri));
  for (let k = 0; k < lineAbsPaths.length; k++) {
    if (!fs.existsSync(lineAbsPaths[k])) {
      throw badRequest(`配音音频文件不存在：${lines[k].uri}（可在配音页重新生成后再合成）`);
    }
  }
  const inputs = lineAbsPaths.flatMap((p) => ['-i', p]);
  // 各台词统一到 44100/立体声/fltp；行间 300ms 静音；整轨 adelay 头部留白；与原声混合（不归一化，保配音响度）
  const parts: string[] = [];
  const concatIn: string[] = [];
  for (let k = 0; k < lineAbsPaths.length; k++) {
    parts.push(
      `[${k + 1}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[l${k}]`,
    );
    concatIn.push(`[l${k}]`);
    if (k < lineAbsPaths.length - 1) {
      parts.push(
        `aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration=${(LINE_GAP_MS / 1000).toFixed(1)}[g${k}]`,
      );
      concatIn.push(`[g${k}]`);
    }
  }
  const fc =
    `[0:a]volume=${originalVolume}[orig];${parts.join(';')};` +
    `${concatIn.join('')}concat=n=${concatIn.length}:v=0:a=1[cat];` +
    `[cat]adelay=${HEAD_PAD_MS}:all=1[dub];` +
    `[orig][dub]amix=inputs=2:duration=first:normalize=0[aout]`;
  await runFfmpeg([
    '-y',
    '-i', segPath,
    ...inputs,
    '-filter_complex', fc,
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    outPath,
  ]);
}

async function hasAudioStream(mediaPath: string): Promise<boolean> {
  const out = await runFfmpeg(
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', mediaPath],
    'ffprobe',
  );
  return out.trim().length > 0;
}

/** concat demuxer 列表项：反斜杠统一为正斜杠，单引号按 ffmpeg 规则转义 */
function escapeConcatPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/'/g, `'\\''`);
}
