import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Episode, Project, ScriptDraft } from '@prisma/client';
import type { NewShotInput, StoryboardPatch } from '@ovideo/shared';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { AppError } from '../../lib/errors.js';
import { findOrCreateTags } from '../tag/service.js';
import { applyPatch, type ApplyPatchInput } from './service.js';

let tdb: TestDb;
let project: Project;
let episode: Episode;
let draft: ScriptDraft;

beforeAll(async () => {
  tdb = await createTestDb();
  project = await tdb.db.project.create({ data: { name: '项目' } });
  episode = await tdb.db.episode.create({ data: { projectId: project.id, title: '第一集' } });
  draft = await tdb.db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
});

afterAll(async () => {
  await tdb.cleanup();
});

function makeShot(text: string, extra: Partial<NewShotInput> = {}): NewShotInput {
  return {
    sourceText: text,
    imagePrompt: `画面：${text}`,
    videoPrompt: `运镜：${text}`,
    durationPlannedMs: 12000,
    tags: [],
    dialogue: [],
    ...extra,
  };
}

/** 每个用例用独立分集，避免版本号互相干扰 */
async function freshEpisode() {
  const ep = await tdb.db.episode.create({ data: { projectId: project.id, title: '独立集' } });
  const dr = await tdb.db.scriptDraft.create({ data: { episodeId: ep.id, isMain: true } });
  return { ep, dr };
}

function apply(input: Partial<ApplyPatchInput> & { patch: StoryboardPatch }, hooks?: Parameters<typeof applyPatch>[2]) {
  return applyPatch(
    tdb.db,
    {
      episodeId: episode.id,
      scriptDraftId: draft.id,
      baseStoryboardId: null,
      source: 'test',
      resolveTags: (tags) => findOrCreateTags(tdb.db, project.id, tags),
      ...input,
    },
    hooks,
  );
}

async function loadShots(storyboardId: string) {
  return tdb.db.shot.findMany({
    where: { storyboardId },
    orderBy: { sortOrder: 'asc' },
    include: {
      tags: { include: { tag: true } },
      dialogue: { orderBy: { sortOrder: 'asc' } },
      takes: true,
    },
  });
}

async function makeAsset() {
  return tdb.db.asset.create({
    data: { projectId: project.id, type: 'IMAGE', source: 'GENERATED', uri: '/x.png' },
  });
}

describe('applyPatch：空基底与 add_shot', () => {
  it('空基底 + add_shot 建 version 1，标签/对白落库，新镜头全部记入 changed', async () => {
    const { ep, dr } = await freshEpisode();
    const { storyboard, changedShotIds, removedShotAssetIds } = await apply({
      episodeId: ep.id,
      scriptDraftId: dr.id,
      patch: [
        {
          op: 'add_shot',
          shot: makeShot('镜头A', {
            tags: [{ name: '林凡', type: 'CHARACTER' }],
            dialogue: [
              { speaker: '林凡', isNarrator: false, text: '你来了。' },
              { isNarrator: false, text: '三年之后。' }, // 无 speaker → 按旁白
            ],
          }),
        },
        { op: 'add_shot', shot: makeShot('镜头B') },
      ],
    });

    expect(storyboard.version).toBe(1);
    const shots = await loadShots(storyboard.id);
    expect(shots.map((s) => s.sourceText)).toEqual(['镜头A', '镜头B']);
    expect(changedShotIds.sort()).toEqual(shots.map((s) => s.id).sort());
    expect(removedShotAssetIds).toEqual([]);

    // 标签解析 + speaker 关联
    expect(shots[0].tags.map((t) => t.tag.name)).toEqual(['林凡']);
    const tag = await tdb.db.tag.findUnique({
      where: { projectId_name: { projectId: project.id, name: '林凡' } },
    });
    expect(shots[0].dialogue[0].speakerTagId).toBe(tag?.id);
    expect(shots[0].dialogue[0].isNarrator).toBe(false);
    expect(shots[0].dialogue[1].isNarrator).toBe(true);

    // 新镜头是空槽：不 stale
    expect(shots[0].keyframeStale).toBe(false);
    expect(shots[0].videoStale).toBe(false);
  });

  it('add_shot 按 afterShotId 定位，null/缺省追加到末尾', async () => {
    const { ep, dr } = await freshEpisode();
    const base = { episodeId: ep.id, scriptDraftId: dr.id };
    const v1 = await apply({
      ...base,
      patch: [
        { op: 'add_shot', shot: makeShot('A') },
        { op: 'add_shot', shot: makeShot('B') },
      ],
    });
    const [a] = await loadShots(v1.storyboard.id);

    const v2 = await apply({
      ...base,
      baseStoryboardId: v1.storyboard.id,
      patch: [
        { op: 'add_shot', afterShotId: a.id, shot: makeShot('C') },
        { op: 'add_shot', afterShotId: null, shot: makeShot('D') },
      ],
    });
    const shots = await loadShots(v2.storyboard.id);
    expect(shots.map((s) => s.sourceText)).toEqual(['A', 'C', 'B', 'D']);
    // 只有新增的两个镜头记入 changed
    expect(v2.changedShotIds.length).toBe(2);

    const bad = apply({
      ...base,
      baseStoryboardId: v2.storyboard.id,
      patch: [{ op: 'add_shot', afterShotId: 'unknown', shot: makeShot('E') }],
    });
    await expect(bad).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('applyPatch：复制携带产物', () => {
  it('未触及镜头的 Take/selected 指针/stale 标志/staleReasons 全部复制并重定向', async () => {
    const { ep, dr } = await freshEpisode();
    const base = { episodeId: ep.id, scriptDraftId: dr.id };
    const v1 = await apply({
      ...base,
      patch: [
        { op: 'add_shot', shot: makeShot('A') },
        { op: 'add_shot', shot: makeShot('B') },
      ],
    });
    const [a1, b1] = await loadShots(v1.storyboard.id);

    // 给 A 造两个 take + selected 指针 + stale 状态
    const assetK = await makeAsset();
    const assetV = await makeAsset();
    const takeK = await tdb.db.take.create({
      data: { shotId: a1.id, slot: 'KEYFRAME', assetId: assetK.id },
    });
    const takeV = await tdb.db.take.create({
      data: { shotId: a1.id, slot: 'VIDEO', assetId: assetV.id, jobId: 'job-1' },
    });
    const reasons = '[{"source":"binding","at":"2026-07-16","detail":"换绑"}]';
    await tdb.db.shot.update({
      where: { id: a1.id },
      data: {
        keyframeSelectedTakeId: takeK.id,
        videoSelectedTakeId: takeV.id,
        keyframeStale: true,
        staleReasonsJson: reasons,
        durationLockedMs: 9500,
      },
    });

    // patch 只改 B，A 应原样复制
    const v2 = await apply({
      ...base,
      baseStoryboardId: v1.storyboard.id,
      patch: [{ op: 'update_shot', shotId: b1.id, fields: { imagePrompt: '新提示词' } }],
    });
    const shots = await loadShots(v2.storyboard.id);
    const a2 = shots.find((s) => s.sourceText === 'A');
    const b2 = shots.find((s) => s.sourceText === 'B');
    expect(a2).toBeDefined();
    expect(b2?.imagePrompt).toBe('新提示词');

    // changed 只含 B 的新 id
    expect(v2.changedShotIds).toEqual([b2?.id]);

    // Take 复制为新行，指向同 asset/jobId
    expect(a2?.takes.length).toBe(2);
    const newK = a2?.takes.find((t) => t.slot === 'KEYFRAME');
    const newV = a2?.takes.find((t) => t.slot === 'VIDEO');
    expect(newK?.assetId).toBe(assetK.id);
    expect(newV?.assetId).toBe(assetV.id);
    expect(newV?.jobId).toBe('job-1');
    expect(newK?.id).not.toBe(takeK.id);

    // selected 指针重定向到新 take
    expect(a2?.keyframeSelectedTakeId).toBe(newK?.id);
    expect(a2?.videoSelectedTakeId).toBe(newV?.id);

    // stale 标志与溯源原样带走
    expect(a2?.keyframeStale).toBe(true);
    expect(a2?.videoStale).toBe(false);
    expect(a2?.staleReasonsJson).toBe(reasons);
    expect(a2?.durationLockedMs).toBe(9500);

    // 旧版本产物不丢
    expect(await tdb.db.take.count({ where: { shotId: a1.id } })).toBe(2);
  });

  it('配音行随版本复制（台词按 sortOrder 映射到新行）；台词被整组替换的镜头不复制配音', async () => {
    const { ep, dr } = await freshEpisode();
    const base = { episodeId: ep.id, scriptDraftId: dr.id };
    const v1 = await apply({
      ...base,
      patch: [
        { op: 'add_shot', shot: makeShot('A', { dialogue: [{ isNarrator: false, text: '你好' }] }) },
        { op: 'add_shot', shot: makeShot('B', { dialogue: [{ isNarrator: true, text: '旧旁白' }] }) },
      ],
    });
    const [a1, b1] = await loadShots(v1.storyboard.id);
    const audio = await makeAsset();
    await tdb.db.dubbingLine.create({
      data: {
        shotId: a1.id,
        dialogueLineId: a1.dialogue[0].id,
        audioAssetId: audio.id,
        durationMs: 1234,
        speed: 1.1,
        status: 'READY',
      },
    });
    await tdb.db.dubbingLine.create({
      data: {
        shotId: b1.id,
        dialogueLineId: b1.dialogue[0].id,
        audioAssetId: audio.id,
        durationMs: 500,
        status: 'READY',
      },
    });

    // 只整组替换 B 的台词；A 原样复制
    const v2 = await apply({
      ...base,
      baseStoryboardId: v1.storyboard.id,
      patch: [
        {
          op: 'update_shot',
          shotId: b1.id,
          fields: { dialogue: [{ isNarrator: true, text: '新旁白' }] },
        },
      ],
    });
    const shots2 = await loadShots(v2.storyboard.id);
    const a2 = shots2.find((s) => s.sourceText === 'A')!;
    const b2 = shots2.find((s) => s.sourceText === 'B')!;

    // A 的配音复制为新行：音频/时长/语速/状态原样，台词指针映射到新台词行
    const dubA2 = await tdb.db.dubbingLine.findMany({ where: { shotId: a2.id } });
    expect(dubA2).toHaveLength(1);
    expect(dubA2[0].audioAssetId).toBe(audio.id);
    expect(dubA2[0].durationMs).toBe(1234);
    expect(dubA2[0].speed).toBeCloseTo(1.1);
    expect(dubA2[0].status).toBe('READY');
    expect(dubA2[0].dialogueLineId).toBe(a2.dialogue[0].id);
    // B 台词被整组替换 → 旧配音不带过来（必须重配音）
    expect(await tdb.db.dubbingLine.count({ where: { shotId: b2.id } })).toBe(0);
    // 旧版本配音不丢
    expect(await tdb.db.dubbingLine.count({ where: { shotId: a1.id } })).toBe(1);
  });

  it('镜头级 Binding 复制为指向新 shot 的新行，标签级绑定不动', async () => {
    const { ep, dr } = await freshEpisode();
    const base = { episodeId: ep.id, scriptDraftId: dr.id };
    const v1 = await apply({ ...base, patch: [{ op: 'add_shot', shot: makeShot('A') }] });
    const [a1] = await loadShots(v1.storyboard.id);

    const tag = await findOrCreateTags(tdb.db, project.id, [{ name: '绑定角色', type: 'CHARACTER' }]);
    const asset = await makeAsset();
    // 标签级默认绑定（shotId=null，shotKey=''）
    const tagLevel = await tdb.db.binding.create({
      data: { episodeId: ep.id, tagId: tag[0].id, shotId: null, shotKey: '', assetId: asset.id },
    });
    // 镜头级覆盖
    await tdb.db.binding.create({
      data: { episodeId: ep.id, tagId: tag[0].id, shotId: a1.id, shotKey: a1.id, assetId: asset.id },
    });

    const v2 = await apply({ ...base, baseStoryboardId: v1.storyboard.id, patch: [] });
    const [a2] = await loadShots(v2.storyboard.id);

    const copied = await tdb.db.binding.findMany({ where: { episodeId: ep.id, shotId: a2.id } });
    expect(copied.length).toBe(1);
    expect(copied[0].assetId).toBe(asset.id);
    expect(copied[0].shotKey).toBe(a2.id);

    // 标签级仍只有一条且未变
    const tagLevels = await tdb.db.binding.findMany({
      where: { episodeId: ep.id, shotKey: '' },
    });
    expect(tagLevels.map((b) => b.id)).toEqual([tagLevel.id]);
  });
});

describe('applyPatch：update / remove / reorder', () => {
  it('update_shot 改字段、整组替换 tags 与 dialogue', async () => {
    const { ep, dr } = await freshEpisode();
    const base = { episodeId: ep.id, scriptDraftId: dr.id };
    const v1 = await apply({
      ...base,
      patch: [
        {
          op: 'add_shot',
          shot: makeShot('A', {
            tags: [{ name: '旧标签', type: 'PROP' }],
            dialogue: [{ speaker: '旧角色', isNarrator: false, text: '旧台词' }],
          }),
        },
      ],
    });
    const [a1] = await loadShots(v1.storyboard.id);

    const v2 = await apply({
      ...base,
      baseStoryboardId: v1.storyboard.id,
      patch: [
        {
          op: 'update_shot',
          shotId: a1.id,
          fields: {
            sourceText: 'A改',
            durationPlannedMs: 15000,
            tags: [{ name: '新标签', type: 'SCENE' }],
            dialogue: [{ isNarrator: true, text: '新旁白' }],
          },
        },
      ],
    });
    const [a2] = await loadShots(v2.storyboard.id);
    expect(a2.sourceText).toBe('A改');
    expect(a2.durationPlannedMs).toBe(15000);
    expect(a2.imagePrompt).toBe('画面：A'); // 未提供的字段保持基底值
    expect(a2.tags.map((t) => t.tag.name)).toEqual(['新标签']);
    expect(a2.dialogue.map((d) => d.text)).toEqual(['新旁白']);
    expect(v2.changedShotIds).toEqual([a2.id]);
  });

  it('remove_shot：新版本不含该镜头，其 take 资产记入 removedShotAssetIds', async () => {
    const { ep, dr } = await freshEpisode();
    const base = { episodeId: ep.id, scriptDraftId: dr.id };
    const v1 = await apply({
      ...base,
      patch: [
        { op: 'add_shot', shot: makeShot('A') },
        { op: 'add_shot', shot: makeShot('B') },
      ],
    });
    const [a1] = await loadShots(v1.storyboard.id);
    const asset = await makeAsset();
    await tdb.db.take.create({ data: { shotId: a1.id, slot: 'KEYFRAME', assetId: asset.id } });

    const v2 = await apply({
      ...base,
      baseStoryboardId: v1.storyboard.id,
      patch: [{ op: 'remove_shot', shotId: a1.id }],
    });
    const shots = await loadShots(v2.storyboard.id);
    expect(shots.map((s) => s.sourceText)).toEqual(['B']);
    expect(v2.removedShotAssetIds).toEqual([asset.id]);
    expect(v2.changedShotIds).toEqual([]);
    // 资产本身不删（回收由失效钩子/回收站处理）
    expect(await tdb.db.asset.findUnique({ where: { id: asset.id } })).not.toBeNull();
  });

  it('reorder 全量新序生效；缺漏/未知 id 均 400', async () => {
    const { ep, dr } = await freshEpisode();
    const base = { episodeId: ep.id, scriptDraftId: dr.id };
    const v1 = await apply({
      ...base,
      patch: [
        { op: 'add_shot', shot: makeShot('A') },
        { op: 'add_shot', shot: makeShot('B') },
        { op: 'add_shot', shot: makeShot('C') },
      ],
    });
    const [a, b, c] = await loadShots(v1.storyboard.id);

    const v2 = await apply({
      ...base,
      baseStoryboardId: v1.storyboard.id,
      patch: [{ op: 'reorder', shotIds: [c.id, a.id, b.id] }],
    });
    const shots = await loadShots(v2.storyboard.id);
    expect(shots.map((s) => s.sourceText)).toEqual(['C', 'A', 'B']);

    await expect(
      apply({
        ...base,
        baseStoryboardId: v1.storyboard.id,
        patch: [{ op: 'reorder', shotIds: [c.id, a.id] }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      apply({
        ...base,
        baseStoryboardId: v1.storyboard.id,
        patch: [{ op: 'reorder', shotIds: [c.id, a.id, 'unknown'] }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('applyPatch：版本、事务与钩子', () => {
  it('多次 patch 版本号在分集内递增', async () => {
    const { ep, dr } = await freshEpisode();
    const base = { episodeId: ep.id, scriptDraftId: dr.id };
    const v1 = await apply({ ...base, patch: [{ op: 'add_shot', shot: makeShot('A') }] });
    const v2 = await apply({ ...base, baseStoryboardId: v1.storyboard.id, patch: [] });
    const v3 = await apply({ ...base, baseStoryboardId: v2.storyboard.id, patch: [] });
    expect([v1.storyboard.version, v2.storyboard.version, v3.storyboard.version]).toEqual([1, 2, 3]);
  });

  it('坏 op 全回滚：不产生新版本与新镜头', async () => {
    const { ep, dr } = await freshEpisode();
    const base = { episodeId: ep.id, scriptDraftId: dr.id };
    const v1 = await apply({ ...base, patch: [{ op: 'add_shot', shot: makeShot('A') }] });

    const before = await tdb.db.storyboard.count({ where: { episodeId: ep.id } });
    const shotsBefore = await tdb.db.shot.count();
    await expect(
      apply({
        ...base,
        baseStoryboardId: v1.storyboard.id,
        patch: [
          { op: 'add_shot', shot: makeShot('X') },
          { op: 'update_shot', shotId: 'unknown', fields: { sourceText: 'boom' } },
        ],
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(await tdb.db.storyboard.count({ where: { episodeId: ep.id } })).toBe(before);
    expect(await tdb.db.shot.count()).toBe(shotsBefore);
  });

  it('基底不存在 404；基底不属于该分集 400', async () => {
    const { ep, dr } = await freshEpisode();
    await expect(
      apply({ episodeId: ep.id, scriptDraftId: dr.id, baseStoryboardId: 'nope', patch: [] }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const other = await freshEpisode();
    const foreign = await apply({
      episodeId: other.ep.id,
      scriptDraftId: other.dr.id,
      patch: [{ op: 'add_shot', shot: makeShot('F') }],
    });
    await expect(
      apply({
        episodeId: ep.id,
        scriptDraftId: dr.id,
        baseStoryboardId: foreign.storyboard.id,
        patch: [],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('完成后调用 onStoryboardPatched 钩子', async () => {
    const { ep, dr } = await freshEpisode();
    const base = { episodeId: ep.id, scriptDraftId: dr.id };
    const v1 = await apply({
      ...base,
      patch: [
        { op: 'add_shot', shot: makeShot('A') },
        { op: 'add_shot', shot: makeShot('B') },
      ],
    });
    const [a1] = await loadShots(v1.storyboard.id);
    const asset = await makeAsset();
    await tdb.db.take.create({ data: { shotId: a1.id, slot: 'VIDEO', assetId: asset.id } });

    const onStoryboardPatched = vi.fn(async () => {});
    const v2 = await apply(
      { ...base, baseStoryboardId: v1.storyboard.id, patch: [{ op: 'remove_shot', shotId: a1.id }] },
      { onStoryboardPatched },
    );
    expect(onStoryboardPatched).toHaveBeenCalledTimes(1);
    expect(onStoryboardPatched).toHaveBeenCalledWith(expect.anything(), v2.storyboard.id, [], [asset.id]);
  });
});
