// ShotGroup 衔接组（v2 §5）测试：拆分版本复制、串行约束、尾帧衔接（真 ffmpeg）、组内 take 切换传播。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Job, PrismaClient, Shot } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { STORAGE_ROOT, allocFilePath, uriToAbsPath } from '../../lib/storage.js';
import { toJson, parseJson } from '../../lib/json.js';
import { makePlaceholderVideo } from '../../lib/ffmpeg.js';
import { getExecutor, clearExecutors } from '../job/registry.js';
import { registerGenerationExecutors, type GenerationGens } from '../generation/executors.js';
import { mockImageGen, mockTtsGen } from '../generation/gens.js';
import { onTakeSelected } from '../stale/service.js';
import { splitShotIntoGroup, listGroups } from './service.js';

let t: TestDb;
let db: PrismaClient;
let projectId: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const project = await db.project.create({ data: { name: '衔接组测试项目' } });
  projectId = project.id;
});

afterAll(async () => {
  await t.cleanup();
  fs.rmSync(path.join(STORAGE_ROOT, projectId), { recursive: true, force: true });
});

/** 每个用例独立分集/分镜，互不干扰 */
async function seedStoryboard() {
  const episode = await db.episode.create({ data: { projectId, title: '测试集' } });
  const draft = await db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
  const storyboard = await db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  return { episode, draft, storyboard };
}

async function makeAsset(type = 'IMAGE', extra: Record<string, unknown> = {}) {
  return db.asset.create({
    data: {
      projectId,
      type,
      source: 'UPLOADED',
      uri: `/storage/${projectId}/seed-${crypto.randomUUID()}.bin`,
      ...extra,
    },
  });
}

async function newShotsOf(storyboardId: string) {
  return db.shot.findMany({
    where: { storyboardId },
    orderBy: { sortOrder: 'asc' },
    include: { tags: true, dialogue: { orderBy: { sortOrder: 'asc' } }, takes: true },
  });
}

describe('splitShotIntoGroup（拆分 = 新版本复制）', () => {
  it('目标镜头拆为 N 段；其余镜头/产物/绑定原样复制；对白与 takes 只承接段 0', async () => {
    const { episode, storyboard } = await seedStoryboard();
    const tag = await db.tag.create({
      data: { projectId, type: 'CHARACTER', name: `主角-${crypto.randomUUID()}` },
    });

    // 目标镜头：32s 计划时长，携带标签/对白/双槽 take + selected + stale + 镜头级绑定
    const target = await db.shot.create({
      data: {
        storyboardId: storyboard.id,
        sortOrder: 0,
        sourceText: '长镜头原文',
        imagePrompt: '长镜头图提示',
        videoPrompt: '长镜头视频提示',
        durationPlannedMs: 32000,
        keyframeStale: true,
        staleReasonsJson: toJson([{ source: 'binding_changed', at: 'x', detail: '旧记录' }]),
        tags: { create: [{ tagId: tag.id }] },
        dialogue: {
          create: [
            { isNarrator: true, text: '第一句', sortOrder: 0 },
            { isNarrator: true, text: '第二句', sortOrder: 1 },
          ],
        },
      },
    });
    const kfAsset = await makeAsset('IMAGE');
    const vdAsset = await makeAsset('VIDEO');
    const kfTake = await db.take.create({
      data: { shotId: target.id, slot: 'KEYFRAME', assetId: kfAsset.id },
    });
    const vdTake = await db.take.create({
      data: { shotId: target.id, slot: 'VIDEO', assetId: vdAsset.id },
    });
    await db.shot.update({
      where: { id: target.id },
      data: { keyframeSelectedTakeId: kfTake.id, videoSelectedTakeId: vdTake.id },
    });
    const boundAsset = await makeAsset('IMAGE');
    await db.binding.create({
      data: {
        episodeId: episode.id,
        tagId: tag.id,
        shotId: target.id,
        shotKey: target.id,
        assetId: boundAsset.id,
      },
    });

    // 旁观镜头：验证原样复制（含 take + selected）
    const otherAsset = await makeAsset('IMAGE');
    const other = await db.shot.create({
      data: { storyboardId: storyboard.id, sortOrder: 1, sourceText: '普通镜头' },
    });
    const otherTake = await db.take.create({
      data: { shotId: other.id, slot: 'KEYFRAME', assetId: otherAsset.id },
    });
    await db.shot.update({ where: { id: other.id }, data: { keyframeSelectedTakeId: otherTake.id } });

    const onGroupSplit = vi.fn(async () => {});
    const result = await splitShotIntoGroup(db, { shotId: target.id }, { onGroupSplit });

    // 新版本号 = 2；钩子在事务后被调
    expect(result.storyboard.version).toBe(2);
    expect(result.storyboard.episodeId).toBe(episode.id);
    expect(result.groupShotIds).toHaveLength(3); // ceil(32000/15000) = 3
    // 不深比较 PrismaClient：逐参数用引用/值断言
    expect(onGroupSplit).toHaveBeenCalledTimes(1);
    const hookArgs = onGroupSplit.mock.calls[0] as unknown as [PrismaClient, string, string[]];
    expect(hookArgs[0]).toBe(db);
    expect(hookArgs[1]).toBe(result.storyboard.id);
    expect(hookArgs[2]).toEqual(result.groupShotIds);

    const shots = await newShotsOf(result.storyboard.id);
    expect(shots).toHaveLength(4); // 3 段 + 1 旁观镜头
    const segs = shots.slice(0, 3);
    const otherCopy = shots[3]!;

    // 段字段：groupId = 原 shotId、groupIndex 0..2、sortOrder 连续、时长均分（末段拿余数）
    expect(segs.map((s) => s.id)).toEqual(result.groupShotIds);
    for (const [i, seg] of segs.entries()) {
      expect(seg.groupId).toBe(target.id);
      expect(seg.groupIndex).toBe(i);
      expect(seg.sortOrder).toBe(i);
      expect(seg.durationLockedMs).toBeNull(); // 原镜头未锁定 → 各段保持未锁定
      // 提示词/原文每段都带 + 段序后缀
      expect(seg.sourceText).toBe(`长镜头原文（第${i + 1}段/共3段）`);
      expect(seg.imagePrompt).toBe(`长镜头图提示（第${i + 1}段/共3段）`);
      expect(seg.videoPrompt).toBe(`长镜头视频提示（第${i + 1}段/共3段）`);
      // tags 每段都复制
      expect(seg.tags.map((x) => x.tagId)).toEqual([tag.id]);
      // 镜头级绑定复制到每一段（shotKey = 新 shotId）
      const bindings = await db.binding.findMany({ where: { episodeId: episode.id, shotId: seg.id } });
      expect(bindings).toHaveLength(1);
      expect(bindings[0]!.assetId).toBe(boundAsset.id);
      expect(bindings[0]!.shotKey).toBe(seg.id);
    }
    expect(segs.map((s) => s.durationPlannedMs)).toEqual([10666, 10666, 10668]);
    expect(segs.reduce((sum, s) => sum + s.durationPlannedMs, 0)).toBe(32000);

    // 对白只挂段 0
    expect(segs[0]!.dialogue.map((d) => d.text)).toEqual(['第一句', '第二句']);
    expect(segs[1]!.dialogue).toHaveLength(0);
    expect(segs[2]!.dialogue).toHaveLength(0);

    // takes/selected 只承接段 0（指针重定向到新 take），段 1..2 是空槽
    expect(segs[0]!.takes.map((x) => x.assetId).sort()).toEqual([kfAsset.id, vdAsset.id].sort());
    const newKf = segs[0]!.takes.find((x) => x.slot === 'KEYFRAME')!;
    const newVd = segs[0]!.takes.find((x) => x.slot === 'VIDEO')!;
    expect(segs[0]!.keyframeSelectedTakeId).toBe(newKf.id);
    expect(segs[0]!.videoSelectedTakeId).toBe(newVd.id);
    expect(segs[1]!.takes).toHaveLength(0);
    expect(segs[1]!.keyframeSelectedTakeId).toBeNull();
    expect(segs[2]!.takes).toHaveLength(0);

    // stale 状态只承接段 0
    expect(segs[0]!.keyframeStale).toBe(true);
    expect(parseJson<unknown[]>(segs[0]!.staleReasonsJson, [])).toHaveLength(1);
    expect(segs[1]!.keyframeStale).toBe(false);
    expect(parseJson<unknown[]>(segs[1]!.staleReasonsJson, [])).toHaveLength(0);

    // 旁观镜头原样复制：take + selected 重定向
    expect(otherCopy.sourceText).toBe('普通镜头');
    expect(otherCopy.sortOrder).toBe(3);
    expect(otherCopy.groupId).toBeNull();
    expect(otherCopy.takes).toHaveLength(1);
    expect(otherCopy.takes[0]!.assetId).toBe(otherAsset.id);
    expect(otherCopy.keyframeSelectedTakeId).toBe(otherCopy.takes[0]!.id);

    // 旧版本原样保留
    const oldShots = await db.shot.findMany({ where: { storyboardId: storyboard.id } });
    expect(oldShots).toHaveLength(2);
  });

  it('durationLockedMs 优先参与拆分，各段同样均分锁定', async () => {
    const { storyboard } = await seedStoryboard();
    const shot = await db.shot.create({
      data: {
        storyboardId: storyboard.id,
        sortOrder: 0,
        sourceText: '锁定镜头',
        durationPlannedMs: 12000,
        durationLockedMs: 24000,
      },
    });
    const result = await splitShotIntoGroup(db, { shotId: shot.id });
    const segs = await newShotsOf(result.storyboard.id);
    expect(segs).toHaveLength(2); // ceil(24000/15000) = 2
    expect(segs.map((s) => s.durationPlannedMs)).toEqual([12000, 12000]);
    expect(segs.map((s) => s.durationLockedMs)).toEqual([12000, 12000]);
  });

  it('lineage 不断链：段 0 继承目标镜头 lineage，其余段各自开锚，旁镜头沿用原 lineage', async () => {
    const { storyboard } = await seedStoryboard();
    // 存量行（lineageId 为 null）也要能在拆分时被开锚，否则跨版本抽卡历史断在这里
    const target = await db.shot.create({
      data: { storyboardId: storyboard.id, sortOrder: 0, sourceText: '待拆', durationPlannedMs: 24000 },
    });
    const bystander = await db.shot.create({
      data: { storyboardId: storyboard.id, sortOrder: 1, sourceText: '旁观', durationPlannedMs: 8000 },
    });

    const result = await splitShotIntoGroup(db, { shotId: target.id });
    const newShots = await db.shot.findMany({
      where: { storyboardId: result.storyboard.id },
      orderBy: { sortOrder: 'asc' },
    });

    // 原行被开锚为自身 id
    const targetAfter = await db.shot.findUnique({ where: { id: target.id } });
    const bystanderAfter = await db.shot.findUnique({ where: { id: bystander.id } });
    expect(targetAfter?.lineageId).toBe(target.id);
    expect(bystanderAfter?.lineageId).toBe(bystander.id);

    const segs = newShots.filter((s) => s.groupId === target.id);
    expect(segs).toHaveLength(2);
    // 段 0 连着原镜头的抽卡历史；段 1 是全新镜头，自成 lineage
    expect(segs[0].lineageId).toBe(target.id);
    expect(segs[1].lineageId).toBe(segs[1].id);
    // 旁镜头照常继承，不因拆分断链
    const copiedBystander = newShots.find((s) => s.sourceText === '旁观');
    expect(copiedBystander?.lineageId).toBe(bystander.id);
    // 全部新行都有 lineageId（null 即断点）
    expect(newShots.every((s) => s.lineageId !== null)).toBe(true);
  });

  it('maxSegmentMs 可自定义；时长未超上限 → 400 固定文案', async () => {
    const { storyboard } = await seedStoryboard();
    const shot = await db.shot.create({
      data: { storyboardId: storyboard.id, sortOrder: 0, durationPlannedMs: 12000 },
    });
    // 缺省 15000：12000 <= 15000 → 报错
    await expect(splitShotIntoGroup(db, { shotId: shot.id })).rejects.toThrow(
      '该镜头时长未超过单段上限，无需拆分',
    );
    // 自定义 5000：可拆为 3 段
    const result = await splitShotIntoGroup(db, { shotId: shot.id, maxSegmentMs: 5000 });
    expect(result.groupShotIds).toHaveLength(3);
  });

  it('锁定时长未超上限时即使计划时长超限也不拆（时长 = locked ?? planned）', async () => {
    const { storyboard } = await seedStoryboard();
    const shot = await db.shot.create({
      data: {
        storyboardId: storyboard.id,
        sortOrder: 0,
        durationPlannedMs: 30000,
        durationLockedMs: 10000,
      },
    });
    await expect(splitShotIntoGroup(db, { shotId: shot.id })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('已在组内的镜头不可再次拆分', async () => {
    const { storyboard } = await seedStoryboard();
    const shot = await db.shot.create({
      data: {
        storyboardId: storyboard.id,
        sortOrder: 0,
        durationPlannedMs: 32000,
        groupId: 'some-group',
        groupIndex: 0,
      },
    });
    await expect(splitShotIntoGroup(db, { shotId: shot.id })).rejects.toThrow('已在衔接组内');
  });

  it('镜头不存在 → 404', async () => {
    await expect(splitShotIntoGroup(db, { shotId: 'no-such-shot' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('listGroups（组链视图）', () => {
  it('按组聚合，shotIds 按 groupIndex 升序；无组镜头不出现', async () => {
    const { storyboard } = await seedStoryboard();
    await db.shot.create({ data: { storyboardId: storyboard.id, sortOrder: 0 } }); // 无组
    // 故意乱序创建，验证按 groupIndex 排序
    const g1s1 = await db.shot.create({
      data: { storyboardId: storyboard.id, sortOrder: 2, groupId: 'g1', groupIndex: 1 },
    });
    const g1s0 = await db.shot.create({
      data: { storyboardId: storyboard.id, sortOrder: 1, groupId: 'g1', groupIndex: 0 },
    });
    const groups = await listGroups(db, storyboard.id);
    expect(groups).toEqual([{ groupId: 'g1', shotIds: [g1s0.id, g1s1.id] }]);
  });

  it('分镜不存在 → 404', async () => {
    await expect(listGroups(db, 'no-such-sb')).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------- GENERATE_VIDEO 衔接组行为（改造 generation/executors.ts） ----------

/** 构造 Job 行与执行器 ctx（不起 worker，直接调用执行器本体） */
async function makeCtx(type: string, input: unknown) {
  const job: Job = await db.job.create({
    data: { projectId, type, status: 'RUNNING', inputJson: toJson(input) },
  });
  return { db, job, updateProgress: async () => {} };
}

/** 建一个两段衔接组（手工造段，不走拆分，隔离被测逻辑） */
async function seedGroupPair(): Promise<{ seg0: Shot; seg1: Shot }> {
  const { storyboard } = await seedStoryboard();
  const groupId = `grp-${crypto.randomUUID()}`;
  const seg0 = await db.shot.create({
    data: {
      storyboardId: storyboard.id,
      sortOrder: 0,
      sourceText: '组段0',
      videoPrompt: '组段0视频',
      durationPlannedMs: 10000,
      groupId,
      groupIndex: 0,
    },
  });
  const seg1 = await db.shot.create({
    data: {
      storyboardId: storyboard.id,
      sortOrder: 1,
      sourceText: '组段1',
      videoPrompt: '组段1视频',
      durationPlannedMs: 10000,
      groupId,
      groupIndex: 1,
    },
  });
  return { seg0, seg1 };
}

describe('GENERATE_VIDEO 衔接组（串行约束 + 尾帧衔接）', () => {
  beforeEach(() => {
    clearExecutors();
  });

  it('段 1 在上一段无 selected video 时直接抛错（强制串行）', async () => {
    const gens: GenerationGens = {
      imageGen: mockImageGen,
      ttsGen: mockTtsGen,
      videoGen: async (args) => {
        fs.writeFileSync(args.outPath, 'fake-mp4');
      },
    };
    registerGenerationExecutors(gens);
    const { seg1 } = await seedGroupPair();
    const ctx = await makeCtx('GENERATE_VIDEO', { shotId: seg1.id });
    await expect(getExecutor('GENERATE_VIDEO')!(ctx)).rejects.toThrow(
      '衔接组需按顺序生成：请先完成上一段',
    );
  });

  it('段 1 用上一段选定视频的尾帧作首帧：FRAME 资产（EXTRACTED、血缘指向前段视频）+ 视频血缘含它（真 ffmpeg）', async () => {
    const videoArgs: Array<{ firstFrameUri: string | null }> = [];
    registerGenerationExecutors({
      imageGen: mockImageGen,
      ttsGen: mockTtsGen,
      videoGen: async (args) => {
        videoArgs.push({ firstFrameUri: args.firstFrameUri });
        await makePlaceholderVideo({ outPath: args.outPath, durationMs: 1000 });
      },
    });
    const { seg0, seg1 } = await seedGroupPair();

    // 段 0：造 1s 真实占位视频资产并选定
    const seg0File = allocFilePath(projectId, 'mp4');
    await makePlaceholderVideo({ outPath: seg0File.absPath, durationMs: 1000 });
    const seg0Video = await db.asset.create({
      data: {
        projectId,
        type: 'VIDEO',
        source: 'GENERATED',
        uri: seg0File.uri,
        durationMs: 1000,
      },
    });
    const seg0Take = await db.take.create({
      data: { shotId: seg0.id, slot: 'VIDEO', assetId: seg0Video.id },
    });
    await db.shot.update({ where: { id: seg0.id }, data: { videoSelectedTakeId: seg0Take.id } });

    // 段 1 执行（注意：段 1 没有 keyframe，也不需要）
    const ctx = await makeCtx('GENERATE_VIDEO', { shotId: seg1.id });
    const r = await getExecutor('GENERATE_VIDEO')!(ctx);

    // FRAME 资产：source=EXTRACTED、parents=[前段视频]、文件真实存在（PNG 魔数）
    const frames = await db.asset.findMany({ where: { projectId, type: 'FRAME', jobId: ctx.job.id } });
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.source).toBe('EXTRACTED');
    const frameParents = await db.assetParent.findMany({ where: { childId: frame.id } });
    expect(frameParents.map((p) => p.parentId)).toEqual([seg0Video.id]);
    const frameAbs = uriToAbsPath(frame.uri);
    expect(fs.existsSync(frameAbs)).toBe(true);
    expect([...fs.readFileSync(frameAbs).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    // 首帧 = 尾帧资产 uri（不是 keyframe）
    expect(videoArgs[0]!.firstFrameUri).toBe(frame.uri);

    // 产出视频：血缘含尾帧资产；take 落在段 1 并自动 selected
    const videoAsset = await db.asset.findUnique({ where: { id: r.outputAssetIds![0]! } });
    expect(videoAsset?.type).toBe('VIDEO');
    const videoParents = await db.assetParent.findMany({ where: { childId: videoAsset!.id } });
    expect(videoParents.map((p) => p.parentId)).toContain(frame.id);
    const seg1After = await db.shot.findUniqueOrThrow({ where: { id: seg1.id } });
    expect(seg1After.videoSelectedTakeId).toBe((r.output as { takeId: string }).takeId);
  }, 60000);

  it('组内段 0 走原逻辑：仍要求选定关键图', async () => {
    registerGenerationExecutors({
      imageGen: mockImageGen,
      ttsGen: mockTtsGen,
      videoGen: async (args) => {
        fs.writeFileSync(args.outPath, 'fake-mp4');
      },
    });
    const { seg0 } = await seedGroupPair();
    const ctx = await makeCtx('GENERATE_VIDEO', { shotId: seg0.id });
    await expect(getExecutor('GENERATE_VIDEO')!(ctx)).rejects.toThrow('请先生成并选定关键图');
  });
});

// ---------- onTakeSelected VIDEO 分支的组内传播（改造 stale/service.ts） ----------

describe('onTakeSelected VIDEO 组内传播', () => {
  it('组内切换段 i 的 video take → groupIndex 更大的段全部 videoStale + 固定原因；更小的段与本段不动', async () => {
    const { storyboard } = await seedStoryboard();
    const groupId = `grp-${crypto.randomUUID()}`;
    const segs: Shot[] = [];
    for (let i = 0; i < 3; i += 1) {
      segs.push(
        await db.shot.create({
          data: { storyboardId: storyboard.id, sortOrder: i, groupId, groupIndex: i },
        }),
      );
    }
    // 同分镜的无组镜头：不受传播影响
    const bystander = await db.shot.create({
      data: { storyboardId: storyboard.id, sortOrder: 3 },
    });

    await onTakeSelected(db, segs[1]!.id, 'VIDEO');

    const [s0, s1, s2] = await Promise.all(
      segs.map((s) => db.shot.findUniqueOrThrow({ where: { id: s.id } })),
    );
    // 段 0：完全不动
    expect(s0!.videoStale).toBe(false);
    expect(parseJson<unknown[]>(s0!.staleReasonsJson, [])).toHaveLength(0);
    // 段 1（本段）：不置 stale，仅追加 take_selected 溯源（既有 VIDEO 分支行为）
    expect(s1!.videoStale).toBe(false);
    const s1Reasons = parseJson<Array<{ source: string; detail: string }>>(s1!.staleReasonsJson, []);
    expect(s1Reasons).toHaveLength(1);
    expect(s1Reasons[0]!.source).toBe('take_selected');
    // 段 2：videoStale + 固定原因文案
    expect(s2!.videoStale).toBe(true);
    const s2Reasons = parseJson<Array<{ source: string; detail: string }>>(s2!.staleReasonsJson, []);
    expect(s2Reasons.some((r) => r.detail === '上一段视频变更，衔接首帧失效')).toBe(true);
    // 无组旁观镜头：不动
    const bystanderAfter = await db.shot.findUniqueOrThrow({ where: { id: bystander.id } });
    expect(bystanderAfter.videoStale).toBe(false);
    expect(parseJson<unknown[]>(bystanderAfter.staleReasonsJson, [])).toHaveLength(0);
  });

  it('无组镜头切换 video take：行为与既有一致（只记录、不置 stale）', async () => {
    const { storyboard } = await seedStoryboard();
    const shot = await db.shot.create({ data: { storyboardId: storyboard.id, sortOrder: 0 } });
    await onTakeSelected(db, shot.id, 'VIDEO');
    const after = await db.shot.findUniqueOrThrow({ where: { id: shot.id } });
    expect(after.videoStale).toBe(false);
    expect(after.keyframeStale).toBe(false);
    const reasons = parseJson<Array<{ source: string }>>(after.staleReasonsJson, []);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.source).toBe('take_selected');
  });
});

// 拆分的是镜头，不是场景：拆完 N 段仍是同一场戏。
// 复制规则必须与 storyboard/service.applyPatch 完全一致，否则拆分版本会成为
// Scene 的 lineage 断点（Shot.lineageId 此前就踩过同样的坑）。
describe('splitShotIntoGroup：Scene 承载', () => {
  it('分段与同场景旁观镜头共用同一条复制出来的 Scene，lineageId 继承，场景时长不变', async () => {
    const { storyboard } = await seedStoryboard();
    const scene = await db.scene.create({
      data: {
        storyboardId: storyboard.id,
        sortOrder: 0,
        title: '客户会议室',
        location: '客户会议室',
        interiorExterior: 'INT',
        timeOfDay: '白天',
        estimatedDurationMs: 44000,
      },
    });
    await db.scene.update({ where: { id: scene.id }, data: { lineageId: scene.id } });

    const target = await db.shot.create({
      data: {
        storyboardId: storyboard.id,
        sortOrder: 0,
        sceneId: scene.id,
        sourceText: '会议室长镜头',
        durationPlannedMs: 32000,
        shotSize: '中景',
        cameraMovement: '跟',
      },
    });
    const sameScene = await db.shot.create({
      data: {
        storyboardId: storyboard.id,
        sortOrder: 1,
        sceneId: scene.id,
        sourceText: '同场景反应镜头',
        durationPlannedMs: 12000,
      },
    });

    const { storyboard: v2 } = await splitShotIntoGroup(db, {
      shotId: target.id,
      maxSegmentMs: 15000,
    });

    const newScenes = await db.scene.findMany({ where: { storyboardId: v2.id } });
    const newShots = await newShotsOf(v2.id);

    // 同一条基底场景只复制一次（不是每个分段复制一次）
    expect(newScenes).toHaveLength(1);
    const copied = newScenes[0]!;
    expect(copied.id).not.toBe(scene.id);
    expect(copied.lineageId).toBe(scene.id);
    expect(copied).toMatchObject({
      title: '客户会议室',
      location: '客户会议室',
      interiorExterior: 'INT',
      timeOfDay: '白天',
    });

    // 32000/15000 → 3 段；3 段 + 旁观镜头全部挂在这条新场景上
    expect(newShots).toHaveLength(4);
    for (const s of newShots) expect(s.sceneId).toBe(copied.id);
    expect(newShots.filter((s) => s.groupId === target.id)).toHaveLength(3);

    // 各段时长之和 = 原镜头总时长，故场景总时长不因拆分而改变
    expect(copied.estimatedDurationMs).toBe(32000 + 12000);

    // 影视语义每段照抄（拆的是时长，景别/运镜不变）
    for (const s of newShots.filter((x) => x.groupId === target.id)) {
      expect(s.shotSize).toBe('中景');
      expect(s.cameraMovement).toBe('跟');
    }

    // 旧版本原样保留，可回滚
    const oldShots = await newShotsOf(storyboard.id);
    expect(oldShots.map((s) => s.id)).toEqual([target.id, sameScene.id]);
    expect(oldShots.map((s) => s.sceneId)).toEqual([scene.id, scene.id]);
  });

  it('存量 Scene（lineageId 为 null）在拆分复制时与新行一起开锚', async () => {
    const { storyboard } = await seedStoryboard();
    const scene = await db.scene.create({
      data: { storyboardId: storyboard.id, sortOrder: 0, title: '存量场景' },
    });
    expect(scene.lineageId).toBeNull();
    const target = await db.shot.create({
      data: {
        storyboardId: storyboard.id,
        sortOrder: 0,
        sceneId: scene.id,
        durationPlannedMs: 32000,
      },
    });

    const { storyboard: v2 } = await splitShotIntoGroup(db, {
      shotId: target.id,
      maxSegmentMs: 15000,
    });

    const [copied] = await db.scene.findMany({ where: { storyboardId: v2.id } });
    const legacyAfter = await db.scene.findUniqueOrThrow({ where: { id: scene.id } });
    expect(copied!.lineageId).toBe(scene.id);
    expect(legacyAfter.lineageId).toBe(scene.id);
  });

  it('未归属场景的存量镜头拆分后 sceneId 仍为 null（不凭空造场景）', async () => {
    const { storyboard } = await seedStoryboard();
    const target = await db.shot.create({
      data: { storyboardId: storyboard.id, sortOrder: 0, durationPlannedMs: 32000 },
    });

    const { storyboard: v2 } = await splitShotIntoGroup(db, {
      shotId: target.id,
      maxSegmentMs: 15000,
    });

    expect(await db.scene.findMany({ where: { storyboardId: v2.id } })).toHaveLength(0);
    for (const s of await newShotsOf(v2.id)) expect(s.sceneId).toBeNull();
  });
});
