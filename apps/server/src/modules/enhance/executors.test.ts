import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Job, PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { STORAGE_ROOT, allocFilePath, uriToAbsPath } from '../../lib/storage.js';
import { toJson, parseJson } from '../../lib/json.js';
import { makePlaceholderVideo, runFfmpeg } from '../../lib/ffmpeg.js';
import { getExecutor, clearExecutors } from '../job/registry.js';
import { registerEnhanceExecutors } from './executors.js';

let t: TestDb;
let db: PrismaClient;
let projectId: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const project = await db.project.create({ data: { name: '增强执行器测试项目' } });
  projectId = project.id;
});

afterAll(async () => {
  await t.cleanup();
  fs.rmSync(path.join(STORAGE_ROOT, projectId), { recursive: true, force: true });
});

beforeEach(() => {
  clearExecutors();
  registerEnhanceExecutors();
});

/** 每个用例独立分集/分镜/镜头 */
async function seedShot(shotData: Record<string, unknown> = {}) {
  const episode = await db.episode.create({ data: { projectId, title: '测试集' } });
  const draft = await db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
  const storyboard = await db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  const shot = await db.shot.create({
    data: { storyboardId: storyboard.id, sortOrder: 0, sourceText: '打斗镜头', ...shotData },
  });
  return { episode, storyboard, shot };
}

/** 真 ffmpeg 造占位视频资产 + VIDEO take 并 selected（增强执行器的前置条件） */
async function seedShotWithSelectedVideo(opts: {
  durationMs: number;
  width: number;
  height: number;
  shotData?: Record<string, unknown>;
}) {
  const { shot } = await seedShot(opts.shotData ?? {});
  const file = allocFilePath(projectId, 'mp4');
  await makePlaceholderVideo({
    outPath: file.absPath,
    durationMs: opts.durationMs,
    width: opts.width,
    height: opts.height,
  });
  const asset = await db.asset.create({
    data: {
      projectId,
      type: 'VIDEO',
      source: 'GENERATED',
      uri: file.uri,
      mime: 'video/mp4',
      width: opts.width,
      height: opts.height,
    },
  });
  const take = await db.take.create({ data: { shotId: shot.id, slot: 'VIDEO', assetId: asset.id } });
  await db.shot.update({ where: { id: shot.id }, data: { videoSelectedTakeId: take.id } });
  return { shot, asset, take };
}

/** 构造 Job 行与执行器 ctx（不起 worker，直接调用执行器本体） */
async function makeCtx(type: string, input: unknown) {
  const job: Job = await db.job.create({
    data: { projectId, type, status: 'RUNNING', inputJson: toJson(input) },
  });
  return { db, job, updateProgress: async () => {} };
}

/** lib/ffmpeg.js 没有流级探测函数：就地用 ffprobe 读视频流 width/height/r_frame_rate */
async function probeVideoStream(absPath: string): Promise<{ width: number; height: number; fps: number }> {
  const out = await runFfmpeg(
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate',
      '-of', 'default=noprint_wrappers=1',
      absPath,
    ],
    'ffprobe',
  );
  const map = new Map(
    out
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split('=') as [string, string]),
  );
  const [num, den] = (map.get('r_frame_rate') ?? '0/1').split('/').map(Number);
  return {
    width: Number(map.get('width')),
    height: Number(map.get('height')),
    fps: den ? num! / den : 0,
  };
}

describe('UPSCALE（真 ffmpeg）', () => {
  it('720x1280 → 1080x1920；新资产元数据/血缘/meta 齐全；新 take 自动 selected；stale 不动', async () => {
    // 种 videoStale: true 验证"stale 不动"：增强既不清除已有失效，也不追加溯源
    const { shot, asset: src, take: srcTake } = await seedShotWithSelectedVideo({
      durationMs: 1000,
      width: 720,
      height: 1280,
      shotData: { videoStale: true },
    });

    const ctx = await makeCtx('UPSCALE', { shotId: shot.id });
    const r = await getExecutor('UPSCALE')!(ctx);

    const out = await db.asset.findUnique({ where: { id: r.outputAssetIds![0]! } });
    expect(out?.type).toBe('VIDEO');
    expect(out?.source).toBe('GENERATED');
    expect(out?.jobId).toBe(ctx.job.id);
    expect(out?.width).toBe(1080);
    expect(out?.height).toBe(1920);
    expect(out!.sizeBytes).toBeGreaterThan(0);
    expect(parseJson<Record<string, unknown>>(out!.metaJson, {})).toEqual({ enhance: 'upscale', from: src.id });

    // ffprobe 实测产物真实是 1080x1920
    const absPath = uriToAbsPath(out!.uri);
    expect(fs.existsSync(absPath)).toBe(true);
    const probe = await probeVideoStream(absPath);
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    // 实测时长 ≈ 原 1s（转码不改时长）
    expect(out!.durationMs!).toBeGreaterThan(500);
    expect(out!.durationMs!).toBeLessThan(2000);

    // 血缘 parents = [原视频资产]
    const parents = await db.assetParent.findMany({ where: { childId: out!.id } });
    expect(parents.map((p) => p.parentId)).toEqual([src.id]);

    // 新 take 自动 selected（增强产物替换使用）；原 take 保留不删（付费产物从不物理删除）
    const takeId = (r.output as { takeId: string }).takeId;
    const newTake = await db.take.findUnique({ where: { id: takeId } });
    expect(newTake?.slot).toBe('VIDEO');
    expect(newTake?.assetId).toBe(out!.id);
    const after = await db.shot.findUnique({ where: { id: shot.id } });
    expect(after?.videoSelectedTakeId).toBe(takeId);
    expect(after?.videoSelectedTakeId).not.toBe(srcTake.id);
    expect(await db.take.count({ where: { shotId: shot.id, slot: 'VIDEO' } })).toBe(2);

    // stale 不动：同内容增强不清除 videoStale，也不追加溯源记录
    expect(after?.videoStale).toBe(true);
    expect(parseJson<unknown[]>(after!.staleReasonsJson, [])).toHaveLength(0);

    // 抽帧缩略图真实存在
    expect(out!.thumbUri).toBeTruthy();
    expect(fs.existsSync(uriToAbsPath(out!.thumbUri!))).toBe(true);
  }, 120000);

  it('无 selected video 抛「请先生成并选定视频片段」', async () => {
    const { shot } = await seedShot();
    const ctx = await makeCtx('UPSCALE', { shotId: shot.id });
    await expect(getExecutor('UPSCALE')!(ctx)).rejects.toThrow('请先生成并选定视频片段');
  });

  it('镜头不存在抛 404 文案', async () => {
    const ctx = await makeCtx('UPSCALE', { shotId: 'no-such-shot' });
    await expect(getExecutor('UPSCALE')!(ctx)).rejects.toThrow('镜头 不存在');
  });
});

describe('INTERPOLATE（真 ffmpeg；minterpolate CPU 慢，用 0.5 秒超小视频）', () => {
  it('24fps → 48fps；meta 标 interpolate；尺寸继承原资产；新 take 替换 selected；血缘齐全', async () => {
    const { shot, asset: src } = await seedShotWithSelectedVideo({
      durationMs: 500,
      width: 144,
      height: 256,
    });

    const ctx = await makeCtx('INTERPOLATE', { shotId: shot.id });
    const r = await getExecutor('INTERPOLATE')!(ctx);

    const out = await db.asset.findUnique({ where: { id: r.outputAssetIds![0]! } });
    expect(out?.type).toBe('VIDEO');
    expect(parseJson<Record<string, unknown>>(out!.metaJson, {})).toEqual({ enhance: 'interpolate', from: src.id });
    // 补帧不改分辨率：继承原资产宽高
    expect(out?.width).toBe(144);
    expect(out?.height).toBe(256);

    // ffprobe 实测帧率：占位视频 24fps → minterpolate 后 48fps
    const absPath = uriToAbsPath(out!.uri);
    expect(fs.existsSync(absPath)).toBe(true);
    const probe = await probeVideoStream(absPath);
    expect(probe.fps).toBeGreaterThan(40);
    expect(probe.fps).toBeLessThanOrEqual(50);

    const parents = await db.assetParent.findMany({ where: { childId: out!.id } });
    expect(parents.map((p) => p.parentId)).toEqual([src.id]);

    const takeId = (r.output as { takeId: string }).takeId;
    const after = await db.shot.findUnique({ where: { id: shot.id } });
    expect(after?.videoSelectedTakeId).toBe(takeId);
    // stale 不动（默认 false 保持 false，无溯源追加）
    expect(after?.videoStale).toBe(false);
    expect(parseJson<unknown[]>(after!.staleReasonsJson, [])).toHaveLength(0);
  }, 120000);

  it('无 selected video 抛「请先生成并选定视频片段」', async () => {
    const { shot } = await seedShot();
    const ctx = await makeCtx('INTERPOLATE', { shotId: shot.id });
    await expect(getExecutor('INTERPOLATE')!(ctx)).rejects.toThrow('请先生成并选定视频片段');
  });
});
