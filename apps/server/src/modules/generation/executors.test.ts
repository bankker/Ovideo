import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Job, PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { STORAGE_ROOT, uriToAbsPath } from '../../lib/storage.js';
import { toJson, parseJson } from '../../lib/json.js';
import { makePlaceholderVideo } from '../../lib/ffmpeg.js';
import { getExecutor, clearExecutors } from '../job/registry.js';
import { registerGenerationExecutors, DUBBING_GAP_MS, type GenerationGens } from './executors.js';
import { mockImageGen, mockVideoGen, mockTtsGen, type GenModelCfg } from './gens.js';

let t: TestDb;
let db: PrismaClient;
let projectId: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const project = await db.project.create({ data: { name: '生成执行器测试项目' } });
  projectId = project.id;
});

afterAll(async () => {
  await t.cleanup();
  fs.rmSync(path.join(STORAGE_ROOT, projectId), { recursive: true, force: true });
});

beforeEach(() => {
  clearExecutors();
});

/** 每个用例独立分集/分镜/镜头，绑定作用域互不干扰 */
async function seedShot(shotData: Record<string, unknown> = {}) {
  const episode = await db.episode.create({ data: { projectId, title: '测试集' } });
  const draft = await db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
  const storyboard = await db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  const shot = await db.shot.create({
    data: {
      storyboardId: storyboard.id,
      sortOrder: 0,
      sourceText: '男主走进教室',
      imagePrompt: '男主走进教室，阳光斜照',
      ...shotData,
    },
  });
  return { episode, storyboard, shot };
}

async function makeUploadedAsset() {
  return db.asset.create({
    data: {
      projectId,
      type: 'IMAGE',
      source: 'UPLOADED',
      uri: `/storage/${projectId}/ref-${crypto.randomUUID()}.png`,
    },
  });
}

/** 构造 Job 行与执行器 ctx（不起 worker，直接调用执行器本体） */
async function makeCtx(type: string, input: unknown) {
  const job: Job = await db.job.create({
    data: { projectId, type, status: 'RUNNING', inputJson: toJson(input) },
  });
  return { db, job, updateProgress: async () => {} };
}

/** 可捕获调用参数的假 Gen：写占位文件即可（不跑真 ffmpeg 的用例用） */
function makeFakeGens() {
  const imageCalls: Array<{ prompt: string; refUris: string[]; outPath: string; modelCfg?: GenModelCfg }> = [];
  const gens: GenerationGens = {
    imageGen: async (args) => {
      imageCalls.push(args);
      fs.writeFileSync(args.outPath, 'fake-png');
    },
    videoGen: async (args) => {
      fs.writeFileSync(args.outPath, 'fake-mp4');
    },
    ttsGen: async (args) => {
      fs.writeFileSync(args.outPath, 'fake-wav');
    },
  };
  return { gens, imageCalls };
}

async function parentIdsOf(assetId: string): Promise<string[]> {
  const rows = await db.assetParent.findMany({ where: { childId: assetId } });
  return rows.map((r) => r.parentId).sort();
}

describe('GENERATE_IMAGE / kind=keyframe（假 Gen）', () => {
  it('执行时实时解析绑定作参考图与血缘；首个 take 自动 selected；换绑后重生成用新资产（Bug6 防复发）', async () => {
    const { gens, imageCalls } = makeFakeGens();
    registerGenerationExecutors(gens);
    const exec = getExecutor('GENERATE_IMAGE')!;

    const { episode, shot } = await seedShot();
    const tag = await db.tag.create({ data: { projectId, type: 'CHARACTER', name: `男主-${crypto.randomUUID()}` } });
    await db.shotTag.create({ data: { shotId: shot.id, tagId: tag.id } });
    const assetA = await makeUploadedAsset();
    const binding = await db.binding.create({
      data: { episodeId: episode.id, tagId: tag.id, shotId: null, shotKey: '', assetId: assetA.id },
    });

    // 第一次执行：参考图 = 标签级默认绑定 assetA
    const ctx1 = await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: shot.id });
    const r1 = await exec(ctx1);
    expect(imageCalls).toHaveLength(1);
    // 有参考图时提示词附带"图-名"对应说明（形象一致性）
    expect(imageCalls[0]!.prompt).toContain('男主走进教室，阳光斜照');
    expect(imageCalls[0]!.prompt).toContain('【形象一致性】参考图1：');
    expect(imageCalls[0]!.refUris).toEqual([assetA.uri]);
    expect(imageCalls[0]!.modelCfg).toBeUndefined();

    const asset1 = await db.asset.findUnique({ where: { id: r1.outputAssetIds![0]! } });
    expect(asset1?.type).toBe('IMAGE');
    expect(asset1?.source).toBe('GENERATED');
    expect(asset1?.jobId).toBe(ctx1.job.id);
    expect(asset1?.thumbUri).toBe(asset1?.uri); // 图片缩略图 = 原图
    expect(await parentIdsOf(asset1!.id)).toEqual([assetA.id]);

    const take1 = await db.take.findUnique({ where: { id: (r1.output as { takeId: string }).takeId } });
    expect(take1?.slot).toBe('KEYFRAME');
    expect(take1?.shotId).toBe(shot.id);
    let after = await db.shot.findUnique({ where: { id: shot.id } });
    expect(after?.keyframeSelectedTakeId).toBe(take1!.id);

    // 换绑到 assetB 后重生成：执行时才解析，血缘必须用新资产（旧系统 Bug6：创建时快照会拿到 assetA）
    const assetB = await makeUploadedAsset();
    await db.binding.update({ where: { id: binding.id }, data: { assetId: assetB.id } });
    const ctx2 = await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: shot.id });
    const r2 = await exec(ctx2);
    expect(imageCalls[1]!.refUris).toEqual([assetB.uri]);
    expect(await parentIdsOf(r2.outputAssetIds![0]!)).toEqual([assetB.id]);

    // 重抽只加 take，selected 指针不动
    after = await db.shot.findUnique({ where: { id: shot.id } });
    expect(after?.keyframeSelectedTakeId).toBe(take1!.id);
    expect(await db.take.count({ where: { shotId: shot.id, slot: 'KEYFRAME' } })).toBe(2);
  });

  it('镜头级覆盖绑定优先于标签级默认', async () => {
    const { gens, imageCalls } = makeFakeGens();
    registerGenerationExecutors(gens);
    const { episode, shot } = await seedShot();
    const tag = await db.tag.create({ data: { projectId, type: 'SCENE', name: `教室-${crypto.randomUUID()}` } });
    await db.shotTag.create({ data: { shotId: shot.id, tagId: tag.id } });
    const tagLevel = await makeUploadedAsset();
    const shotLevel = await makeUploadedAsset();
    await db.binding.create({
      data: { episodeId: episode.id, tagId: tag.id, shotId: null, shotKey: '', assetId: tagLevel.id },
    });
    await db.binding.create({
      data: { episodeId: episode.id, tagId: tag.id, shotId: shot.id, shotKey: shot.id, assetId: shotLevel.id },
    });

    const ctx = await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: shot.id });
    const r = await getExecutor('GENERATE_IMAGE')!(ctx);
    expect(imageCalls[0]!.refUris).toEqual([shotLevel.uri]);
    expect(await parentIdsOf(r.outputAssetIds![0]!)).toEqual([shotLevel.id]);
  });

  it('原本 stale 才清除并留 clear:regenerated 溯源；非 stale 执行不追加无意义记录', async () => {
    const { gens } = makeFakeGens();
    registerGenerationExecutors(gens);
    const exec = getExecutor('GENERATE_IMAGE')!;

    const { shot: staleShot } = await seedShot({ keyframeStale: true });
    await exec(await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: staleShot.id }));
    const cleared = await db.shot.findUnique({ where: { id: staleShot.id } });
    expect(cleared?.keyframeStale).toBe(false);
    const reasons = parseJson<Array<{ source: string }>>(cleared!.staleReasonsJson, []);
    expect(reasons.some((r) => r.source === 'clear:regenerated')).toBe(true);

    const { shot: freshShot } = await seedShot();
    await exec(await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: freshShot.id }));
    const untouched = await db.shot.findUnique({ where: { id: freshShot.id } });
    expect(untouched?.keyframeStale).toBe(false);
    expect(parseJson<unknown[]>(untouched!.staleReasonsJson, [])).toHaveLength(0);
  });

  it('镜头不存在抛 404 文案', async () => {
    const { gens } = makeFakeGens();
    registerGenerationExecutors(gens);
    const ctx = await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: 'no-such-shot' });
    await expect(getExecutor('GENERATE_IMAGE')!(ctx)).rejects.toThrow('镜头 不存在');
  });

  it('modelConfigId：模型/厂商停用抛错；启用时把 baseUrl/apiKey/modelKey 传给 Gen', async () => {
    const { gens, imageCalls } = makeFakeGens();
    registerGenerationExecutors(gens);
    const exec = getExecutor('GENERATE_IMAGE')!;
    const { shot } = await seedShot();

    const disabledProvider = await db.providerConfig.create({
      data: { name: '停用厂商', vendor: 'x', category: 'IMAGE', enabled: false },
    });
    const modelOfDisabled = await db.modelConfig.create({
      data: { providerConfigId: disabledProvider.id, key: 'm0', label: 'm0', modality: 'image' },
    });
    await expect(
      exec(await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: shot.id, modelConfigId: modelOfDisabled.id })),
    ).rejects.toThrow('厂商已停用');

    const provider = await db.providerConfig.create({
      data: { name: '图像厂商', vendor: 'x', category: 'IMAGE', baseUrl: 'http://img.local', apiKey: 'sk-test' },
    });
    const disabledModel = await db.modelConfig.create({
      data: { providerConfigId: provider.id, key: 'm1', label: 'm1', modality: 'image', enabled: false },
    });
    await expect(
      exec(await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: shot.id, modelConfigId: disabledModel.id })),
    ).rejects.toThrow('模型已停用');

    const model = await db.modelConfig.create({
      data: { providerConfigId: provider.id, key: 'm2', label: 'm2', modality: 'image' },
    });
    await exec(await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: shot.id, modelConfigId: model.id }));
    expect(imageCalls.at(-1)!.modelCfg).toEqual({ baseUrl: 'http://img.local', apiKey: 'sk-test', modelKey: 'm2' });
  });
});

describe('GENERATE_IMAGE / kind=keyframe：@ 显式指定参考图', () => {
  it('@ 分层语义：@角色 发参考图、@场景 仅锚定文字、@!场景 强制发（顺序=@顺序）', async () => {
    const { gens, imageCalls } = makeFakeGens();
    registerGenerationExecutors(gens);
    const exec = getExecutor('GENERATE_IMAGE')!;

    const assetHero = await makeUploadedAsset();
    const assetScene = await makeUploadedAsset();
    const tagHero = await db.tag.create({
      data: { projectId, type: 'CHARACTER', name: `英雄甲-${crypto.randomUUID().slice(0, 6)}`, canonicalAssetId: assetHero.id },
    });
    const tagScene = await db.tag.create({
      data: { projectId, type: 'SCENE', name: `天台-${crypto.randomUUID().slice(0, 6)}`, canonicalAssetId: assetScene.id },
    });
    // 镜头本身还挂着一个"不该被带上"的干扰标签（有设计图但未被 @）
    const assetOther = await makeUploadedAsset();
    const tagOther = await db.tag.create({
      data: { projectId, type: 'CHARACTER', name: `路人乙-${crypto.randomUUID().slice(0, 6)}`, canonicalAssetId: assetOther.id },
    });

    // 场景 A：普通 @场景 —— 只锚定文字，参考图仅角色
    const { shot: shotA } = await seedShot({
      imagePrompt: `@${tagScene.name} 上，@${tagHero.name} 迎风而立`,
      tags: { create: [{ tagId: tagOther.id }, { tagId: tagHero.id }] },
    });
    const rA = await exec(await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: shotA.id }));
    expect(imageCalls[0]!.refUris).toEqual([assetHero.uri]); // 场景未入参考位，干扰标签未携带
    const parentsA = await parentIdsOf((rA.outputAssetIds ?? [])[0]);
    expect(parentsA).toEqual([assetHero.id]);
    // 提及处的 @ 剥掉、名字保留（一致性说明里的"@指定"标注不受影响）
    expect(imageCalls[0]!.prompt).not.toContain(`@${tagScene.name}`);
    expect(imageCalls[0]!.prompt).toContain(`${tagScene.name} 上，${tagHero.name} 迎风而立`);
    expect(imageCalls[0]!.prompt).toContain('@指定');

    // 场景 B：@!场景 —— 强制入参考位，且尊重 @ 书写顺序（场景在前）
    const { shot: shotB } = await seedShot({
      imagePrompt: `@!${tagScene.name} 上，@${tagHero.name} 迎风而立`,
      tags: { create: [{ tagId: tagHero.id }] },
    });
    await exec(await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: shotB.id }));
    expect(imageCalls[1]!.refUris).toEqual([assetScene.uri, assetHero.uri]);
    expect(imageCalls[1]!.prompt).not.toContain('@!');
    expect(imageCalls[1]!.prompt).toContain('强制');
  });

  it('@ 不存在的标签 → 明确报错；@ 无设计图的标签 → 明确报错', async () => {
    const { gens } = makeFakeGens();
    registerGenerationExecutors(gens);
    const exec = getExecutor('GENERATE_IMAGE')!;

    const { shot: s1 } = await seedShot({ imagePrompt: '@不存在的角色 走过' });
    await expect(exec(await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: s1.id }))).rejects.toThrow(
      /@ 指定的标签「不存在的角色」不存在/,
    );

    const bare = await db.tag.create({
      data: { projectId, type: 'CHARACTER', name: `无图丙-${crypto.randomUUID().slice(0, 6)}` },
    });
    const { shot: s2 } = await seedShot({ imagePrompt: `@${bare.name} 走过` });
    await expect(exec(await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: s2.id }))).rejects.toThrow(
      /还没有设计图/,
    );
  });
});

describe('GENERATE_IMAGE / kind=design（假 Gen）', () => {
  it('无 canonical：参考图为空，产出 TagDesign 并自动设为 canonical', async () => {
    const { gens, imageCalls } = makeFakeGens();
    registerGenerationExecutors(gens);
    const tag = await db.tag.create({ data: { projectId, type: 'CHARACTER', name: `女主-${crypto.randomUUID()}` } });

    const ctx = await makeCtx('GENERATE_IMAGE', { kind: 'design', tagId: tag.id, prompt: '双马尾少女立绘' });
    const r = await getExecutor('GENERATE_IMAGE')!(ctx);

    expect(imageCalls[0]!.prompt).toBe('双马尾少女立绘');
    expect(imageCalls[0]!.refUris).toEqual([]);
    const assetId = r.outputAssetIds![0]!;
    const designId = (r.output as { designId: string }).designId;
    const design = await db.tagDesign.findUnique({ where: { id: designId } });
    expect(design?.tagId).toBe(tag.id);
    expect(design?.assetId).toBe(assetId);
    const after = await db.tag.findUnique({ where: { id: tag.id } });
    expect(after?.canonicalAssetId).toBe(assetId);
  });

  it('已有 canonical：作参考图且 canonical 不被改写', async () => {
    const { gens, imageCalls } = makeFakeGens();
    registerGenerationExecutors(gens);
    const canonical = await makeUploadedAsset();
    const tag = await db.tag.create({
      data: { projectId, type: 'PROP', name: `怀表-${crypto.randomUUID()}`, canonicalAssetId: canonical.id },
    });

    const ctx = await makeCtx('GENERATE_IMAGE', { kind: 'design', tagId: tag.id, prompt: '复古黄铜怀表' });
    await getExecutor('GENERATE_IMAGE')!(ctx);
    expect(imageCalls[0]!.refUris).toEqual([canonical.uri]);
    const after = await db.tag.findUnique({ where: { id: tag.id } });
    expect(after?.canonicalAssetId).toBe(canonical.id);
    expect(await db.tagDesign.count({ where: { tagId: tag.id } })).toBe(1);
  });
});

describe('GENERATE_IMAGE / kind=keyframe（真 ffmpeg，Mock Gen 全链路）', () => {
  it('真实产出 PNG；Asset/Take/selected/血缘齐全；换绑后重生成血缘用新资产', async () => {
    registerGenerationExecutors({ imageGen: mockImageGen, videoGen: mockVideoGen, ttsGen: mockTtsGen });
    const exec = getExecutor('GENERATE_IMAGE')!;

    const { episode, shot } = await seedShot();
    const tag = await db.tag.create({ data: { projectId, type: 'CHARACTER', name: `真主-${crypto.randomUUID()}` } });
    await db.shotTag.create({ data: { shotId: shot.id, tagId: tag.id } });
    const assetA = await makeUploadedAsset();
    const binding = await db.binding.create({
      data: { episodeId: episode.id, tagId: tag.id, shotId: null, shotKey: '', assetId: assetA.id },
    });

    const ctx = await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: shot.id });
    const r = await exec(ctx);
    const asset = await db.asset.findUnique({ where: { id: r.outputAssetIds![0]! } });
    expect(asset).not.toBeNull();

    // 文件真实生成且是 PNG（魔数 89 50 4E 47）
    const absPath = uriToAbsPath(asset!.uri);
    expect(fs.existsSync(absPath)).toBe(true);
    const head = fs.readFileSync(absPath).subarray(0, 4);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(asset!.sizeBytes).toBeGreaterThan(0);

    // Asset/Take/selected/血缘
    expect(asset!.type).toBe('IMAGE');
    expect(asset!.jobId).toBe(ctx.job.id);
    expect(await parentIdsOf(asset!.id)).toEqual([assetA.id]);
    const takeId = (r.output as { takeId: string }).takeId;
    const after = await db.shot.findUnique({ where: { id: shot.id } });
    expect(after?.keyframeSelectedTakeId).toBe(takeId);

    // Bug6 防复发（真 ffmpeg 路径）：换绑后再执行，parents 必须是新资产
    const assetB = await makeUploadedAsset();
    await db.binding.update({ where: { id: binding.id }, data: { assetId: assetB.id } });
    const r2 = await exec(await makeCtx('GENERATE_IMAGE', { kind: 'keyframe', shotId: shot.id }));
    expect(await parentIdsOf(r2.outputAssetIds![0]!)).toEqual([assetB.id]);
  }, 60000);
});

describe('GENERATE_VIDEO', () => {
  it('无选定关键图直接抛错', async () => {
    const { gens } = makeFakeGens();
    registerGenerationExecutors(gens);
    const { shot } = await seedShot();
    const ctx = await makeCtx('GENERATE_VIDEO', { shotId: shot.id });
    await expect(getExecutor('GENERATE_VIDEO')!(ctx)).rejects.toThrow('请先生成并选定关键图');
  });

  it('时长取 durationLockedMs 优先；实测时长/抽帧缩略图/血缘/Take/selected/清 stale 齐全（真 ffmpeg）', async () => {
    // 假 videoGen 捕获参数，但产真实视频（时长固定 1s，供 probe 与抽帧）
    const videoArgs: Array<{ firstFrameUri: string | null; durationMs: number }> = [];
    registerGenerationExecutors({
      imageGen: mockImageGen,
      ttsGen: mockTtsGen,
      videoGen: async (args) => {
        videoArgs.push({ firstFrameUri: args.firstFrameUri, durationMs: args.durationMs });
        await makePlaceholderVideo({ outPath: args.outPath, durationMs: 1000 });
      },
    });

    const { shot } = await seedShot({ durationPlannedMs: 12000, durationLockedMs: 2000, videoStale: true });
    const keyframeAsset = await makeUploadedAsset();
    const keyframeTake = await db.take.create({
      data: { shotId: shot.id, slot: 'KEYFRAME', assetId: keyframeAsset.id },
    });
    await db.shot.update({ where: { id: shot.id }, data: { keyframeSelectedTakeId: keyframeTake.id } });

    const ctx = await makeCtx('GENERATE_VIDEO', { shotId: shot.id });
    const r = await getExecutor('GENERATE_VIDEO')!(ctx);

    // 首帧 = 选定关键图；时长 = 锁定时长（非计划时长）
    expect(videoArgs[0]!.firstFrameUri).toBe(keyframeAsset.uri);
    expect(videoArgs[0]!.durationMs).toBe(2000);

    const asset = await db.asset.findUnique({ where: { id: r.outputAssetIds![0]! } });
    expect(asset?.type).toBe('VIDEO');
    // 实测时长 ≈ 1000ms（占位视频实际长度，而非请求的 2000ms）
    expect(asset!.durationMs!).toBeGreaterThan(500);
    expect(asset!.durationMs!).toBeLessThan(2000);
    // 抽帧缩略图真实存在
    expect(asset!.thumbUri).toBeTruthy();
    expect(fs.existsSync(uriToAbsPath(asset!.thumbUri!))).toBe(true);
    expect(await parentIdsOf(asset!.id)).toEqual([keyframeAsset.id]);

    const takeId = (r.output as { takeId: string }).takeId;
    const take = await db.take.findUnique({ where: { id: takeId } });
    expect(take?.slot).toBe('VIDEO');
    const after = await db.shot.findUnique({ where: { id: shot.id } });
    expect(after?.videoSelectedTakeId).toBe(takeId);
    expect(after?.videoStale).toBe(false); // 原本 stale → 清除
  }, 60000);

  it('口パク注入：具名台词镜头视频提示词自动补说话状态，纯旁白镜头不注入（真 ffmpeg）', async () => {
    const prompts: string[] = [];
    registerGenerationExecutors({
      imageGen: mockImageGen,
      ttsGen: mockTtsGen,
      videoGen: async (args) => {
        prompts.push(args.prompt);
        await makePlaceholderVideo({ outPath: args.outPath, durationMs: 1000 });
      },
    });
    const speaker = await db.tag.create({
      data: { projectId, type: 'CHARACTER', name: `说话人-${crypto.randomUUID().slice(0, 8)}` },
    });

    const prepareShot = async (withSpeaker: boolean) => {
      const { shot } = await seedShot();
      const keyframeAsset = await makeUploadedAsset();
      const take = await db.take.create({
        data: { shotId: shot.id, slot: 'KEYFRAME', assetId: keyframeAsset.id },
      });
      await db.shot.update({ where: { id: shot.id }, data: { keyframeSelectedTakeId: take.id } });
      // 两种镜头都带一条旁白（旁白绝不驱动口型）
      await db.dialogueLine.create({
        data: { shotId: shot.id, isNarrator: true, text: '旁白', sortOrder: 0 },
      });
      if (withSpeaker) {
        await db.dialogueLine.create({
          data: { shotId: shot.id, speakerTagId: speaker.id, text: '台词', sortOrder: 1 },
        });
      }
      return shot;
    };

    const talking = await prepareShot(true);
    await getExecutor('GENERATE_VIDEO')!(await makeCtx('GENERATE_VIDEO', { shotId: talking.id }));
    expect(prompts[0]).toContain(`${speaker.name}正在说话，嘴部自然开合`);

    const narratorOnly = await prepareShot(false);
    await getExecutor('GENERATE_VIDEO')!(
      await makeCtx('GENERATE_VIDEO', { shotId: narratorOnly.id }),
    );
    expect(prompts[1]).not.toContain('正在说话');

    // 生成透明度：实际提示词落在资产 meta
    const withMeta = await db.asset.findFirst({
      where: { metaJson: { contains: '正在说话' } },
    });
    expect(withMeta).not.toBeNull();
  }, 60000);
});

describe('GENERATE_TTS', () => {
  it('生成音频回写行状态与时长；重算镜头总时长（含 300ms 行间隔）并锁定；偏差超阈值 videoStale（真 ffmpeg）', async () => {
    registerGenerationExecutors({ imageGen: mockImageGen, videoGen: mockVideoGen, ttsGen: mockTtsGen });
    const { shot } = await seedShot({ durationPlannedMs: 12000 });

    const dlg = await db.dialogueLine.create({
      data: { shotId: shot.id, isNarrator: true, text: '你好世界啊', sortOrder: 0 },
    });
    const line = await db.dubbingLine.create({
      data: { shotId: shot.id, dialogueLineId: dlg.id, speed: 1.0 },
    });
    // 预置另一条已 READY 的行（1000ms），验证求和 + (n-1)×300ms 间隔
    await db.dubbingLine.create({
      data: { shotId: shot.id, status: 'READY', durationMs: 1000 },
    });

    const ctx = await makeCtx('GENERATE_TTS', { kind: 'dubbing', dubbingLineId: line.id });
    const r = await getExecutor('GENERATE_TTS')!(ctx);

    const after = await db.dubbingLine.findUnique({ where: { id: line.id } });
    expect(after?.status).toBe('READY');
    // Mock TTS：5 个非空白字 × 220ms = 1100ms（probe 有少量容差）
    expect(after!.durationMs!).toBeGreaterThan(900);
    expect(after!.durationMs!).toBeLessThan(1400);
    expect(after?.audioAssetId).toBe(r.outputAssetIds![0]);

    const asset = await db.asset.findUnique({ where: { id: after!.audioAssetId! } });
    expect(asset?.type).toBe('AUDIO');
    expect(asset?.durationMs).toBe(after!.durationMs);
    expect(fs.existsSync(uriToAbsPath(asset!.uri))).toBe(true);

    // 时长链路：总时长 = 本行 + 1000 + 1×300 间隔；写入 durationLockedMs；
    // 与旧值（计划 12000ms）偏差 > 500ms → videoStale
    const shotAfter = await db.shot.findUnique({ where: { id: shot.id } });
    expect(shotAfter?.durationLockedMs).toBe(after!.durationMs! + 1000 + DUBBING_GAP_MS);
    expect(shotAfter?.videoStale).toBe(true);
    const reasons = parseJson<Array<{ source: string }>>(shotAfter!.staleReasonsJson, []);
    expect(reasons.some((x) => x.source === 'dubbing_duration_changed')).toBe(true);
  }, 60000);

  it('生成中途抛错：行状态置 FAILED 并向上抛出', async () => {
    registerGenerationExecutors({
      imageGen: mockImageGen,
      videoGen: mockVideoGen,
      ttsGen: async () => {
        throw new Error('TTS 服务不可用');
      },
    });
    const { shot } = await seedShot();
    const dlg = await db.dialogueLine.create({
      data: { shotId: shot.id, isNarrator: true, text: '一句话', sortOrder: 0 },
    });
    const line = await db.dubbingLine.create({ data: { shotId: shot.id, dialogueLineId: dlg.id } });

    const ctx = await makeCtx('GENERATE_TTS', { kind: 'dubbing', dubbingLineId: line.id });
    await expect(getExecutor('GENERATE_TTS')!(ctx)).rejects.toThrow('TTS 服务不可用');
    const after = await db.dubbingLine.findUnique({ where: { id: line.id } });
    expect(after?.status).toBe('FAILED');
  });

  it('配音行没有关联对白文本：置 FAILED 并抛错', async () => {
    const { gens } = makeFakeGens();
    registerGenerationExecutors(gens);
    const { shot } = await seedShot();
    const line = await db.dubbingLine.create({ data: { shotId: shot.id } });

    const ctx = await makeCtx('GENERATE_TTS', { kind: 'dubbing', dubbingLineId: line.id });
    await expect(getExecutor('GENERATE_TTS')!(ctx)).rejects.toThrow('配音行没有关联的对白文本');
    const after = await db.dubbingLine.findUnique({ where: { id: line.id } });
    expect(after?.status).toBe('FAILED');
  });

  it('配音行不存在抛 404 文案', async () => {
    const { gens } = makeFakeGens();
    registerGenerationExecutors(gens);
    const ctx = await makeCtx('GENERATE_TTS', { kind: 'dubbing', dubbingLineId: 'no-such-line' });
    await expect(getExecutor('GENERATE_TTS')!(ctx)).rejects.toThrow('配音行 不存在');
  });
});
