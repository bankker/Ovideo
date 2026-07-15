import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { createCut, getCut, listCuts, type CutItem } from './service.js';

let t: TestDb;
let projectId: string;

beforeAll(async () => {
  t = await createTestDb();
  const p = await t.db.project.create({ data: { name: 'cut 服务测试项目' } });
  projectId = p.id;
});

afterAll(async () => {
  await t.cleanup();
});

/** 建 分集 + 分镜 + N 个镜头 的最小 fixture */
async function makeStoryboard(db: PrismaClient, shotCount: number) {
  const episode = await db.episode.create({ data: { projectId, title: '第1集' } });
  const draft = await db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
  const storyboard = await db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  const shots = [];
  for (let i = 0; i < shotCount; i++) {
    shots.push(
      await db.shot.create({
        data: { storyboardId: storyboard.id, sortOrder: i, sourceText: `镜头${i + 1}` },
      }),
    );
  }
  return { episode, storyboard, shots };
}

/** 给镜头建视频资产 + take 并置为 selected */
async function selectVideoTake(db: PrismaClient, shotId: string, durationMs = 1000) {
  const asset = await db.asset.create({
    data: {
      projectId,
      type: 'VIDEO',
      source: 'GENERATED',
      uri: `/storage/${projectId}/${shotId}-clip.mp4`,
      durationMs,
    },
  });
  const take = await db.take.create({ data: { shotId, slot: 'VIDEO', assetId: asset.id } });
  await db.shot.update({ where: { id: shotId }, data: { videoSelectedTakeId: take.id } });
  return { asset, take };
}

describe('createCut', () => {
  it('有镜头未选定视频片段 → 400，文案含镜头序号', async () => {
    const { episode, storyboard, shots } = await makeStoryboard(t.db, 3);
    // 只给第 1 个镜头选定，第 2、3 缺失
    await selectVideoTake(t.db, shots[0].id);
    await expect(
      createCut(t.db, { episodeId: episode.id, storyboardId: storyboard.id }),
    ).rejects.toThrow('以下镜头还没有选定视频片段：#2, #3');
  });

  it('selected 指针悬空（take 已不存在）也算未选定', async () => {
    const { episode, storyboard, shots } = await makeStoryboard(t.db, 1);
    await t.db.shot.update({
      where: { id: shots[0].id },
      data: { videoSelectedTakeId: 'take-已不存在' },
    });
    await expect(
      createCut(t.db, { episodeId: episode.id, storyboardId: storyboard.id }),
    ).rejects.toThrow('以下镜头还没有选定视频片段：#1');
  });

  it('全部选定 → 快照 items（sortOrder 序）、status=COMPOSING、version 自增', async () => {
    const { episode, storyboard, shots } = await makeStoryboard(t.db, 2);
    const a = await selectVideoTake(t.db, shots[0].id, 1200);
    const b = await selectVideoTake(t.db, shots[1].id, 800);

    const cut = await createCut(t.db, { episodeId: episode.id, storyboardId: storyboard.id });
    expect(cut.status).toBe('COMPOSING');
    expect(cut.version).toBe(1);
    const items = JSON.parse(cut.itemsJson) as CutItem[];
    expect(items).toEqual([
      {
        shotId: shots[0].id,
        sortOrder: 0,
        takeId: a.take.id,
        assetId: a.asset.id,
        uri: a.asset.uri,
        durationMs: 1200,
      },
      {
        shotId: shots[1].id,
        sortOrder: 1,
        takeId: b.take.id,
        assetId: b.asset.id,
        uri: b.asset.uri,
        durationMs: 800,
      },
    ]);

    const cut2 = await createCut(t.db, { episodeId: episode.id, storyboardId: storyboard.id });
    expect(cut2.version).toBe(2);
  });

  it('分镜不存在或不属于该分集 → 404', async () => {
    const { episode, storyboard, shots } = await makeStoryboard(t.db, 1);
    await selectVideoTake(t.db, shots[0].id);
    await expect(createCut(t.db, { episodeId: episode.id, storyboardId: 'nope' })).rejects.toThrow(
      '分镜 不存在',
    );
    const other = await t.db.episode.create({ data: { projectId, title: '别的分集' } });
    await expect(
      createCut(t.db, { episodeId: other.id, storyboardId: storyboard.id }),
    ).rejects.toThrow('分镜 不存在');
  });

  it('分镜没有镜头 → 400', async () => {
    const { episode, storyboard } = await makeStoryboard(t.db, 0);
    await expect(
      createCut(t.db, { episodeId: episode.id, storyboardId: storyboard.id }),
    ).rejects.toThrow('没有镜头');
  });
});

describe('getCut / listCuts', () => {
  it('itemsJson 解析为 items；outputAssetId 有值时附带 outputAsset', async () => {
    const { episode, storyboard, shots } = await makeStoryboard(t.db, 1);
    await selectVideoTake(t.db, shots[0].id);
    const cut = await createCut(t.db, { episodeId: episode.id, storyboardId: storyboard.id });

    const before = await getCut(t.db, cut.id);
    expect(before.items).toHaveLength(1);
    expect(before.items[0].shotId).toBe(shots[0].id);
    expect(before.outputAsset).toBeNull();
    expect('itemsJson' in before).toBe(false);

    const final = await t.db.asset.create({
      data: {
        projectId,
        type: 'FINAL',
        source: 'GENERATED',
        uri: `/storage/${projectId}/final.mp4`,
      },
    });
    await t.db.cut.update({
      where: { id: cut.id },
      data: { status: 'READY', outputAssetId: final.id },
    });

    const after = await getCut(t.db, cut.id);
    expect(after.outputAsset?.id).toBe(final.id);
    expect(after.outputAsset?.type).toBe('FINAL');
  });

  it('getCut 不存在 → 404', async () => {
    await expect(getCut(t.db, 'nope')).rejects.toThrow('成片 不存在');
  });

  it('listCuts 新版本在前', async () => {
    const { episode, storyboard, shots } = await makeStoryboard(t.db, 1);
    await selectVideoTake(t.db, shots[0].id);
    const c1 = await createCut(t.db, { episodeId: episode.id, storyboardId: storyboard.id });
    const c2 = await createCut(t.db, { episodeId: episode.id, storyboardId: storyboard.id });

    const list = await listCuts(t.db, episode.id);
    expect(list.map((c) => c.id)).toEqual([c2.id, c1.id]);
    expect(list[0].version).toBe(2);
  });
});
