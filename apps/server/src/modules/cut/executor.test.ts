// COMPOSE_CUT 执行器测试：用真 ffmpeg 生成两段 1 秒占位视频，跑完整合成链路。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Job } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { makePlaceholderVideo, makeSineWav, probeDurationMs, runFfmpeg } from '../../lib/ffmpeg.js';
import { allocFilePath, fileSize, STORAGE_ROOT, uriToAbsPath } from '../../lib/storage.js';
import { toJson } from '../../lib/json.js';
import { clearExecutors, getExecutor } from '../job/registry.js';
import { createCut, type CutAudioLine } from './service.js';
import { composeCut, registerCutExecutor } from './executor.js';

let t: TestDb;
let projectId: string;
let episodeId: string;
let storyboardId: string;
let segmentAssetIds: string[];

beforeAll(async () => {
  t = await createTestDb();
  const p = await t.db.project.create({ data: { name: 'cut 执行器测试项目' } });
  projectId = p.id;
  const episode = await t.db.episode.create({ data: { projectId, title: '第1集' } });
  episodeId = episode.id;
  const draft = await t.db.scriptDraft.create({ data: { episodeId, isMain: true } });
  const sb = await t.db.storyboard.create({
    data: { episodeId, scriptDraftId: draft.id, version: 1 },
  });
  storyboardId = sb.id;

  // 两段 1 秒占位视频（真 ffmpeg 生成）→ 资产 + take + selected
  segmentAssetIds = [];
  const colors = ['steelblue', 'darkorange'];
  for (let i = 0; i < 2; i++) {
    const file = allocFilePath(projectId, 'mp4');
    await makePlaceholderVideo({ outPath: file.absPath, durationMs: 1000, color: colors[i] });
    const asset = await t.db.asset.create({
      data: {
        projectId,
        type: 'VIDEO',
        source: 'GENERATED',
        uri: file.uri,
        mime: 'video/mp4',
        sizeBytes: fileSize(file.absPath),
        durationMs: await probeDurationMs(file.absPath),
      },
    });
    segmentAssetIds.push(asset.id);
    const shot = await t.db.shot.create({
      data: { storyboardId, sortOrder: i, sourceText: `镜头${i + 1}` },
    });
    const take = await t.db.take.create({
      data: { shotId: shot.id, slot: 'VIDEO', assetId: asset.id },
    });
    await t.db.shot.update({ where: { id: shot.id }, data: { videoSelectedTakeId: take.id } });
  }
}, 60_000);

afterAll(async () => {
  clearExecutors();
  await t.cleanup();
  fs.rmSync(path.join(STORAGE_ROOT, projectId), { recursive: true, force: true });
});

async function makeJob(inputPayload: unknown): Promise<Job> {
  return t.db.job.create({
    data: {
      projectId,
      type: 'COMPOSE_CUT',
      status: 'RUNNING',
      inputJson: toJson(inputPayload),
    },
  });
}

describe('COMPOSE_CUT 执行器（真 ffmpeg）', () => {
  it('registerCutExecutor 把执行器挂到 COMPOSE_CUT', () => {
    clearExecutors();
    expect(getExecutor('COMPOSE_CUT')).toBeUndefined();
    registerCutExecutor();
    expect(getExecutor('COMPOSE_CUT')).toBe(composeCut);
  });

  it(
    '两段 1 秒片段 → FINAL 资产、时长≈2000ms、缩略图、血缘 parents=两段、Cut READY',
    async () => {
      const cut = await createCut(t.db, { episodeId, storyboardId });
      const job = await makeJob({ cutId: cut.id });

      const result = await composeCut({ db: t.db, job, updateProgress: async () => {} });
      const assetId = result.outputAssetIds?.[0];
      expect(assetId).toBeTruthy();

      const asset = await t.db.asset.findUnique({ where: { id: assetId! } });
      expect(asset).not.toBeNull();
      expect(asset!.type).toBe('FINAL');
      expect(asset!.source).toBe('GENERATED');
      expect(asset!.jobId).toBe(job.id);
      // 两段各 1s，合成后 ≈ 2000ms（编码封装误差容忍 ±400ms）
      expect(asset!.durationMs).toBeGreaterThanOrEqual(1600);
      expect(asset!.durationMs).toBeLessThanOrEqual(2400);
      // 成片与缩略图都真实落盘
      expect(fs.existsSync(uriToAbsPath(asset!.uri))).toBe(true);
      expect(asset!.thumbUri).toBeTruthy();
      expect(fs.existsSync(uriToAbsPath(asset!.thumbUri!))).toBe(true);

      // 血缘：parents = 两个片段资产
      const parents = await t.db.assetParent.findMany({ where: { childId: assetId! } });
      expect(new Set(parents.map((r) => r.parentId))).toEqual(new Set(segmentAssetIds));

      const after = await t.db.cut.findUnique({ where: { id: cut.id } });
      expect(after!.status).toBe('READY');
      expect(after!.outputAssetId).toBe(assetId);
    },
    120_000,
  );

  it('片段源文件缺失 → 执行器抛错且 Cut 置 FAILED', async () => {
    const cut = await t.db.cut.create({
      data: {
        episodeId,
        version: 99,
        status: 'COMPOSING',
        itemsJson: toJson([
          {
            shotId: 's1',
            sortOrder: 0,
            takeId: 'tk1',
            assetId: segmentAssetIds[0],
            uri: `/storage/${projectId}/不存在的片段.mp4`,
            durationMs: 1000,
          },
        ]),
      },
    });
    const job = await makeJob({ cutId: cut.id });
    await expect(composeCut({ db: t.db, job, updateProgress: async () => {} })).rejects.toThrow(
      '片段源文件不存在',
    );
    const after = await t.db.cut.findUnique({ where: { id: cut.id } });
    expect(after!.status).toBe('FAILED');
  });

  it('cutId 不存在 → 404（无 Cut 可标 FAILED，直接抛）', async () => {
    const job = await makeJob({ cutId: 'nope' });
    await expect(composeCut({ db: t.db, job, updateProgress: async () => {} })).rejects.toThrow(
      '成片 不存在',
    );
  });

  it(
    '画幅自适应：横屏片段 AUTO 合成 → 成片保持横屏；显式 9:16 → 强制竖屏画布',
    async () => {
      const draft4 = await t.db.scriptDraft.create({ data: { episodeId, isMain: false } });
      const sb4 = await t.db.storyboard.create({
        data: { episodeId, scriptDraftId: draft4.id, version: 4 },
      });
      const landscape = allocFilePath(projectId, 'mp4');
      await makePlaceholderVideo({
        outPath: landscape.absPath,
        durationMs: 1000,
        width: 1280,
        height: 720,
      });
      const asset = await t.db.asset.create({
        data: {
          projectId,
          type: 'VIDEO',
          source: 'GENERATED',
          uri: landscape.uri,
          mime: 'video/mp4',
          sizeBytes: fileSize(landscape.absPath),
          durationMs: await probeDurationMs(landscape.absPath),
        },
      });
      const shot = await t.db.shot.create({
        data: { storyboardId: sb4.id, sortOrder: 0, sourceText: '横屏镜头' },
      });
      const take = await t.db.take.create({
        data: { shotId: shot.id, slot: 'VIDEO', assetId: asset.id },
      });
      await t.db.shot.update({ where: { id: shot.id }, data: { videoSelectedTakeId: take.id } });

      const composeWithRatio = async (ratio: string) => {
        const cut = await createCut(t.db, { episodeId, storyboardId: sb4.id });
        const job = await makeJob({ cutId: cut.id, ratio });
        const result = await composeCut({ db: t.db, job, updateProgress: async () => {} });
        const out = await t.db.asset.findUnique({ where: { id: result.outputAssetIds![0] } });
        const dims = await runFfmpeg(
          ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', uriToAbsPath(out!.uri)],
          'ffprobe',
        );
        return { record: { w: out!.width, h: out!.height }, actual: dims.trim() };
      };

      const auto = await composeWithRatio('AUTO');
      expect(auto.actual).toBe('1280x720');
      expect(auto.record).toEqual({ w: 1280, h: 720 });

      const portrait = await composeWithRatio('9:16');
      expect(portrait.actual).toBe('720x1280');
      expect(portrait.record).toEqual({ w: 720, h: 1280 });
    },
    120_000,
  );

  it(
    '音轨模式：440Hz 原声视频 + 880Hz 配音 → SMART 压掉原声保留配音，MIX 两者叠加',
    async () => {
      const draft3 = await t.db.scriptDraft.create({ data: { episodeId, isMain: false } });
      const sb3 = await t.db.storyboard.create({
        data: { episodeId, scriptDraftId: draft3.id, version: 3 },
      });
      // makePlaceholderVideo 自带 440Hz 正弦音轨 = "视频生成的声音"
      const tonedVideo = allocFilePath(projectId, 'mp4');
      await makePlaceholderVideo({ outPath: tonedVideo.absPath, durationMs: 1000, color: 'indigo' });
      const videoAsset = await t.db.asset.create({
        data: {
          projectId,
          type: 'VIDEO',
          source: 'GENERATED',
          uri: tonedVideo.uri,
          mime: 'video/mp4',
          sizeBytes: fileSize(tonedVideo.absPath),
          durationMs: await probeDurationMs(tonedVideo.absPath),
        },
      });
      const shot = await t.db.shot.create({
        data: { storyboardId: sb3.id, sortOrder: 0, sourceText: '双音轨镜头' },
      });
      const take = await t.db.take.create({
        data: { shotId: shot.id, slot: 'VIDEO', assetId: videoAsset.id },
      });
      await t.db.shot.update({ where: { id: shot.id }, data: { videoSelectedTakeId: take.id } });

      const wav = allocFilePath(projectId, 'wav');
      await makeSineWav({ outPath: wav.absPath, durationMs: 500, freq: 880 });
      const audioAsset = await t.db.asset.create({
        data: {
          projectId,
          type: 'AUDIO',
          source: 'GENERATED',
          uri: wav.uri,
          mime: 'audio/wav',
          sizeBytes: fileSize(wav.absPath),
          durationMs: await probeDurationMs(wav.absPath),
        },
      });
      const dialogue = await t.db.dialogueLine.create({
        data: { shotId: shot.id, text: '台词', sortOrder: 0 },
      });
      await t.db.dubbingLine.create({
        data: {
          shotId: shot.id,
          dialogueLineId: dialogue.id,
          audioAssetId: audioAsset.id,
          durationMs: 500,
          status: 'READY',
        },
      });

      const bandpassMeanDb = async (mediaPath: string, freq: number): Promise<number> => {
        const out = await runFfmpeg([
          '-i', mediaPath,
          '-map', '0:a:0',
          '-af', `bandpass=f=${freq}:w=100,volumedetect`,
          '-f', 'null', '-',
        ]);
        const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(out);
        return m ? parseFloat(m[1]) : -91;
      };

      const compose = async (audioMixMode: 'SMART' | 'MIX'): Promise<string> => {
        const cut = await createCut(t.db, { episodeId, storyboardId: sb3.id });
        const job = await makeJob({ cutId: cut.id, audioMixMode });
        const result = await composeCut({ db: t.db, job, updateProgress: async () => {} });
        const asset = await t.db.asset.findUnique({ where: { id: result.outputAssetIds![0] } });
        return uriToAbsPath(asset!.uri);
      };

      const smartOut = await compose('SMART');
      const mixOut = await compose('MIX');

      const smart440 = await bandpassMeanDb(smartOut, 440);
      const mix440 = await bandpassMeanDb(mixOut, 440);
      const smart880 = await bandpassMeanDb(smartOut, 880);
      // SMART 把原声(440)压掉：显著低于 MIX；配音(880)仍然可闻
      expect(mix440 - smart440).toBeGreaterThan(12);
      expect(smart880).toBeGreaterThan(-45);
    },
    120_000,
  );

  it(
    '配音混入：静音视频镜头 + 两条 READY 配音行 → 快照进 audioTracksJson、成片可听见声音、血缘含音频资产',
    async () => {
      // 独立分镜：仅一个镜头，视频无音轨（转码会补静音）——若混音失效，成片必然全程静音
      const draft2 = await t.db.scriptDraft.create({ data: { episodeId, isMain: false } });
      const sb2 = await t.db.storyboard.create({
        data: { episodeId, scriptDraftId: draft2.id, version: 2 },
      });
      const silentVideo = allocFilePath(projectId, 'mp4');
      await runFfmpeg([
        '-y',
        '-f', 'lavfi', '-i', 'color=c=seagreen:s=720x1280:d=1.2:r=24',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        silentVideo.absPath,
      ]);
      const videoAsset = await t.db.asset.create({
        data: {
          projectId,
          type: 'VIDEO',
          source: 'GENERATED',
          uri: silentVideo.uri,
          mime: 'video/mp4',
          sizeBytes: fileSize(silentVideo.absPath),
          durationMs: await probeDurationMs(silentVideo.absPath),
        },
      });
      const shot = await t.db.shot.create({
        data: { storyboardId: sb2.id, sortOrder: 0, sourceText: '配音镜头' },
      });
      const take = await t.db.take.create({
        data: { shotId: shot.id, slot: 'VIDEO', assetId: videoAsset.id },
      });
      await t.db.shot.update({ where: { id: shot.id }, data: { videoSelectedTakeId: take.id } });

      // 两条台词行（sortOrder 0/1）各挂一条 READY 配音（400ms 正弦）
      const audioAssetIds: string[] = [];
      for (let k = 0; k < 2; k++) {
        const wav = allocFilePath(projectId, 'wav');
        await makeSineWav({ outPath: wav.absPath, durationMs: 400, freq: k === 0 ? 660 : 880 });
        const audioAsset = await t.db.asset.create({
          data: {
            projectId,
            type: 'AUDIO',
            source: 'GENERATED',
            uri: wav.uri,
            mime: 'audio/wav',
            sizeBytes: fileSize(wav.absPath),
            durationMs: await probeDurationMs(wav.absPath),
          },
        });
        audioAssetIds.push(audioAsset.id);
        const dialogue = await t.db.dialogueLine.create({
          data: { shotId: shot.id, text: `台词${k + 1}`, sortOrder: k },
        });
        await t.db.dubbingLine.create({
          data: {
            shotId: shot.id,
            dialogueLineId: dialogue.id,
            audioAssetId: audioAsset.id,
            durationMs: 400,
            status: 'READY',
          },
        });
      }

      const cut = await createCut(t.db, { episodeId, storyboardId: sb2.id });
      const snapshot = JSON.parse(cut.audioTracksJson) as CutAudioLine[];
      expect(snapshot).toHaveLength(2);
      expect(snapshot.map((l) => l.order)).toEqual([0, 1]);
      expect(snapshot.every((l) => l.shotId === shot.id)).toBe(true);

      const job = await makeJob({ cutId: cut.id });
      const result = await composeCut({ db: t.db, job, updateProgress: async () => {} });
      const assetId = result.outputAssetIds?.[0];
      expect(assetId).toBeTruthy();

      // volumedetect：纯静音约 -91dB；混入正弦配音后 mean_volume 必须显著高于静音线
      const finalAsset = await t.db.asset.findUnique({ where: { id: assetId! } });
      const vd = await runFfmpeg([
        '-i', uriToAbsPath(finalAsset!.uri),
        '-map', '0:a:0',
        '-af', 'volumedetect',
        '-f', 'null', '-',
      ]);
      const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(vd);
      expect(mean).not.toBeNull();
      expect(parseFloat(mean![1])).toBeGreaterThan(-50);

      // 血缘：parents = 视频片段 + 两条配音音频
      const parents = await t.db.assetParent.findMany({ where: { childId: assetId! } });
      expect(new Set(parents.map((r) => r.parentId))).toEqual(
        new Set([videoAsset.id, ...audioAssetIds]),
      );
    },
    120_000,
  );
});
