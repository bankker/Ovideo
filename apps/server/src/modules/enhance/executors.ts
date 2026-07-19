// 单段增强执行器（M3-lite，v2 §3.10 的本地 FFmpeg 版）：UPSCALE 高清放大 / INTERPOLATE 智能补帧。
// 两者同构：取镜头 selected 的 VIDEO take → FFmpeg 滤镜转码 → 新资产（血缘=原视频）→ 新 take 并自动 selected。
// 生产环境把 FFmpeg 换成 GPU 节点（Real-ESRGAN / RIFE / Topaz 等），任务契约不变。
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';
import { parseJson } from '../../lib/json.js';
import { allocFilePath, fileSize, uriToAbsPath } from '../../lib/storage.js';
import { extractFrame, probeDimensions, probeDurationMs, runFfmpeg } from '../../lib/ffmpeg.js';
import { registerExecutor, type JobExecutor } from '../job/registry.js';
import { createAsset } from '../asset/service.js';

const EnhanceInputSchema = z.object({ shotId: z.string() });

/** 单个增强类型的差异点：滤镜串 + meta 标记（产物尺寸一律实测，不做静态假设） */
interface EnhanceSpec {
  kind: 'upscale' | 'interpolate';
  videoFilter: string;
}

/** 读镜头及其 selected 的 VIDEO take（含资产）；无选定视频直接抛错（与路由提前拦截同文案） */
async function loadSelectedVideo(db: PrismaClient, shotId: string) {
  const shot = await db.shot.findUnique({ where: { id: shotId } });
  if (!shot) throw notFound('镜头');
  if (!shot.videoSelectedTakeId) throw badRequest('请先生成并选定视频片段');
  const take = await db.take.findUnique({
    where: { id: shot.videoSelectedTakeId },
    include: { asset: true },
  });
  if (!take) throw notFound('选定的视频 take');
  return { shot, take };
}

/**
 * 公共执行逻辑：转码 → 实测时长/抽帧缩略 → 资产（带血缘与 enhance meta）→ 新 take 自动 selected。
 * 任何一步失败直接向上 rethrow，由 Job worker 统一置 FAILED / 走重试。
 */
function makeEnhanceExecutor(spec: EnhanceSpec): JobExecutor {
  return async (ctx) => {
    const { db, job, updateProgress } = ctx;
    const input = EnhanceInputSchema.parse(parseJson<unknown>(job.inputJson, {}));
    const { shot, take } = await loadSelectedVideo(db, input.shotId);
    await updateProgress(10);

    // FFmpeg 转码：滤镜按增强类型注入；libx264 crf18 保画质；音轨原样 copy 不重编码
    const srcAbs = uriToAbsPath(take.asset.uri);
    const file = allocFilePath(job.projectId, 'mp4');
    await runFfmpeg([
      '-y', '-i', srcAbs,
      '-vf', spec.videoFilter,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      file.absPath,
    ]);
    await updateProgress(70);

    // 实测时长/分辨率 + 抽帧缩略图（与生成执行器同一套元数据链路）
    const actualMs = await probeDurationMs(file.absPath);
    const dims = await probeDimensions(file.absPath);
    const thumbFile = allocFilePath(job.projectId, 'png');
    await extractFrame({
      videoPath: file.absPath,
      timeMs: Math.min(500, Math.floor(actualMs / 2)),
      outPath: thumbFile.absPath,
    });

    const asset = await createAsset(db, {
      projectId: job.projectId,
      type: 'VIDEO',
      source: 'GENERATED',
      uri: file.uri,
      mime: 'video/mp4',
      sizeBytes: fileSize(file.absPath),
      // 产物尺寸实测（放大是等比缩放，随源片比例变化；补帧分辨率不变）
      width: dims?.width ?? take.asset.width ?? undefined,
      height: dims?.height ?? take.asset.height ?? undefined,
      durationMs: actualMs,
      meta: { enhance: spec.kind, from: take.assetId },
      jobId: job.id,
      parentIds: [take.assetId],
    });
    await db.asset.update({ where: { id: asset.id }, data: { thumbUri: thumbFile.uri } });

    // 新 take 无条件自动 selected：与抽卡"首个才自动选"不同——用户点增强就是要用增强后的版本替换原片段
    const newTake = await db.take.create({
      data: { shotId: shot.id, slot: 'VIDEO', assetId: asset.id, jobId: job.id },
    });
    await db.shot.update({ where: { id: shot.id }, data: { videoSelectedTakeId: newTake.id } });

    // stale 不动（既不清除也不追加）：增强是同内容的画质提升（只改分辨率/帧率，画面语义不变），
    // 不触发下游失效——§2.2 传播矩阵里换 selected 视频本就只留溯源不标 stale；
    // 反向同理：若视频原本因关键图变更而 stale，放大/补帧后的它依然 stale，这里不越权清除。
    await updateProgress(95);
    return { outputAssetIds: [asset.id], output: { takeId: newTake.id } };
  };
}

/** 统一入口：集成阶段（app 启动）调用一次 */
export function registerEnhanceExecutors(): void {
  // 高清放大：等比 1.5 倍 lanczos 缩放（720p 档→1080p 档），比例跟随源片，宽高取偶对齐编码器
  registerExecutor(
    'UPSCALE',
    makeEnhanceExecutor({
      kind: 'upscale',
      videoFilter: 'scale=trunc(iw*3/4)*2:trunc(ih*3/4)*2:flags=lanczos',
    }),
  );
  // 智能补帧：minterpolate 运动补偿插值到 48fps。CPU 路径很慢，仅本地开发可用；生产替换为 GPU 节点（RIFE 等）
  registerExecutor(
    'INTERPOLATE',
    makeEnhanceExecutor({
      kind: 'interpolate',
      videoFilter: 'minterpolate=fps=48:mi_mode=mci:mc_mode=aobmc',
    }),
  );
}
