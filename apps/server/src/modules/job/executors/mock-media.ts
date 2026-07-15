import { z } from 'zod';
import { parseJson } from '../../../lib/json.js';
import { allocFilePath, fileSize } from '../../../lib/storage.js';
import { makePlaceholderImage, makePlaceholderVideo, makeSineWav } from '../../../lib/ffmpeg.js';
import { registerExecutor, type JobExecutor } from '../registry.js';

// Mock 占位媒体统一竖屏 720x1280（与 lib/ffmpeg.js 默认值一致）
const WIDTH = 720;
const HEIGHT = 1280;

/** input 里的 projectId 仅冗余信息，落库归属一律以 job.projectId 为准 */
const MockMediaInputSchema = z.object({
  projectId: z.string().optional(),
  durationMs: z.number().int().positive().optional(),
  color: z.string().optional(),
});

function parseInput(raw: string): z.infer<typeof MockMediaInputSchema> {
  return MockMediaInputSchema.parse(parseJson<Record<string, unknown>>(raw, {}));
}

const generateImage: JobExecutor = async ({ db, job, updateProgress }) => {
  const input = parseInput(job.inputJson);
  await updateProgress(10);
  const file = allocFilePath(job.projectId, 'png');
  await makePlaceholderImage({ outPath: file.absPath, color: input.color, width: WIDTH, height: HEIGHT });
  await updateProgress(90);
  const asset = await db.asset.create({
    data: {
      projectId: job.projectId,
      type: 'IMAGE',
      source: 'GENERATED',
      uri: file.uri,
      mime: 'image/png',
      sizeBytes: fileSize(file.absPath),
      width: WIDTH,
      height: HEIGHT,
      jobId: job.id,
    },
  });
  return { outputAssetIds: [asset.id] };
};

const generateVideo: JobExecutor = async ({ db, job, updateProgress }) => {
  const input = parseInput(job.inputJson);
  const durationMs = input.durationMs ?? 2000;
  await updateProgress(10);
  const file = allocFilePath(job.projectId, 'mp4');
  await makePlaceholderVideo({
    outPath: file.absPath,
    durationMs,
    color: input.color,
    width: WIDTH,
    height: HEIGHT,
  });
  await updateProgress(90);
  const asset = await db.asset.create({
    data: {
      projectId: job.projectId,
      type: 'VIDEO',
      source: 'GENERATED',
      uri: file.uri,
      mime: 'video/mp4',
      sizeBytes: fileSize(file.absPath),
      width: WIDTH,
      height: HEIGHT,
      durationMs,
      jobId: job.id,
    },
  });
  return { outputAssetIds: [asset.id] };
};

const generateTts: JobExecutor = async ({ db, job, updateProgress }) => {
  const input = parseInput(job.inputJson);
  const durationMs = input.durationMs ?? 1000;
  await updateProgress(10);
  const file = allocFilePath(job.projectId, 'wav');
  await makeSineWav({ outPath: file.absPath, durationMs });
  await updateProgress(90);
  const asset = await db.asset.create({
    data: {
      projectId: job.projectId,
      type: 'AUDIO',
      source: 'GENERATED',
      uri: file.uri,
      mime: 'audio/wav',
      sizeBytes: fileSize(file.absPath),
      durationMs,
      jobId: job.id,
    },
  });
  return { outputAssetIds: [asset.id] };
};

/** 集成阶段（app 启动）调用一次：无真实厂商 key 时端到端流程仍可跑通 */
export function registerMockMediaExecutors(): void {
  registerExecutor('GENERATE_IMAGE', generateImage);
  registerExecutor('GENERATE_VIDEO', generateVideo);
  registerExecutor('GENERATE_TTS', generateTts);
}
