import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { StaleReason } from '@ovideo/shared';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { parseJson, toJson } from '../../lib/json.js';
import {
  onScriptDraftChanged,
  onStoryboardPatched,
  onBindingChanged,
  onDubbingDurationChanged,
  onTakeSelected,
  clearStale,
  getStaleShots,
} from './service.js';

let t: TestDb;
let db: PrismaClient;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});

afterAll(async () => {
  await t.cleanup();
});

/** 造一套最小图谱：project → episode → draft(isMain) → storyboard(version) */
async function seedBase(version = 1) {
  const project = await db.project.create({ data: { name: `P-${crypto.randomUUID()}` } });
  const episode = await db.episode.create({ data: { projectId: project.id, title: 'E1' } });
  const draft = await db.scriptDraft.create({
    data: { episodeId: episode.id, isMain: true, content: '第一幕' },
  });
  const storyboard = await db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version },
  });
  return { project, episode, draft, storyboard };
}

async function createShot(storyboardId: string, sortOrder = 0, extra: Record<string, unknown> = {}) {
  return db.shot.create({ data: { storyboardId, sortOrder, ...extra } });
}

function reasonsOf(json: string): StaleReason[] {
  return parseJson<StaleReason[]>(json, []);
}

describe('onScriptDraftChanged（§2.2 行1：改剧本稿 → Storyboard 标 stale，资产/标签/绑定不动）', () => {
  it('该稿关联的所有 Storyboard 标 stale 并追加原因', async () => {
    const { episode, draft } = await seedBase();
    const sb2 = await db.storyboard.create({
      data: { episodeId: episode.id, scriptDraftId: draft.id, version: 2 },
    });

    await onScriptDraftChanged(db, draft.id, '改了第一幕台词');

    const sbs = await db.storyboard.findMany({ where: { scriptDraftId: draft.id } });
    expect(sbs).toHaveLength(2);
    for (const sb of sbs) {
      expect(sb.stale).toBe(true);
      const reasons = reasonsOf(sb.staleReasonsJson);
      expect(reasons).toHaveLength(1);
      expect(reasons[0]!.source).toBe('script_draft_changed');
      expect(reasons[0]!.detail).toBe('改了第一幕台词');
      expect(Date.parse(reasons[0]!.at)).not.toBeNaN();
    }
    expect(sb2.id).toBeTruthy();
  });

  it('不影响其他剧本稿的 Storyboard', async () => {
    const { episode, draft } = await seedBase();
    const otherDraft = await db.scriptDraft.create({ data: { episodeId: episode.id } });
    const otherSb = await db.storyboard.create({
      data: { episodeId: episode.id, scriptDraftId: otherDraft.id, version: 2 },
    });

    await onScriptDraftChanged(db, draft.id);

    const after = await db.storyboard.findUniqueOrThrow({ where: { id: otherSb.id } });
    expect(after.stale).toBe(false);
  });

  it('资产、标签、绑定一律不动', async () => {
    const { project, episode, draft } = await seedBase();
    const asset = await db.asset.create({
      data: { projectId: project.id, type: 'IMAGE', source: 'UPLOADED', uri: '/storage/a.png' },
    });
    const tag = await db.tag.create({
      data: { projectId: project.id, type: 'CHARACTER', name: '主角', canonicalAssetId: asset.id },
    });
    const binding = await db.binding.create({
      data: { episodeId: episode.id, tagId: tag.id, assetId: asset.id, shotKey: '' },
    });

    await onScriptDraftChanged(db, draft.id);

    const assetAfter = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
    const tagAfter = await db.tag.findUniqueOrThrow({ where: { id: tag.id } });
    const bindingAfter = await db.binding.findUniqueOrThrow({ where: { id: binding.id } });
    expect(assetAfter.status).toBe('ACTIVE');
    expect(tagAfter.canonicalAssetId).toBe(asset.id);
    expect(bindingAfter.assetId).toBe(asset.id);
  });

  it('原因是追加不是覆盖', async () => {
    const { draft, storyboard } = await seedBase();
    const pre: StaleReason = { source: 'pre_existing', at: new Date().toISOString(), detail: '旧记录' };
    await db.storyboard.update({
      where: { id: storyboard.id },
      data: { staleReasonsJson: toJson([pre]) },
    });

    await onScriptDraftChanged(db, draft.id);

    const after = await db.storyboard.findUniqueOrThrow({ where: { id: storyboard.id } });
    const reasons = reasonsOf(after.staleReasonsJson);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]!.source).toBe('pre_existing');
    expect(reasons[1]!.source).toBe('script_draft_changed');
  });

  it('剧本稿不存在 → 404', async () => {
    await expect(onScriptDraftChanged(db, 'no-such-draft')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('onStoryboardPatched（§2.2 行2：对话改分镜 → 仅被改镜头标 stale；删镜头产物进回收站）', () => {
  it('changedShotIds 的镜头 keyframe+video 标 stale，未触及镜头零影响', async () => {
    const { storyboard } = await seedBase();
    const changed = await createShot(storyboard.id, 0);
    const untouched = await createShot(storyboard.id, 1);

    await onStoryboardPatched(db, storyboard.id, [changed.id], []);

    const changedAfter = await db.shot.findUniqueOrThrow({ where: { id: changed.id } });
    const untouchedAfter = await db.shot.findUniqueOrThrow({ where: { id: untouched.id } });
    expect(changedAfter.keyframeStale).toBe(true);
    expect(changedAfter.videoStale).toBe(true);
    const reasons = reasonsOf(changedAfter.staleReasonsJson);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.source).toBe('storyboard_patched');
    expect(untouchedAfter.keyframeStale).toBe(false);
    expect(untouchedAfter.videoStale).toBe(false);
    expect(reasonsOf(untouchedAfter.staleReasonsJson)).toHaveLength(0);
  });

  it('removedShotAssetIds 对应资产进回收站（RECYCLED），其余资产不动', async () => {
    const { project, storyboard } = await seedBase();
    const removed = await db.asset.create({
      data: { projectId: project.id, type: 'IMAGE', source: 'GENERATED', uri: '/storage/r.png' },
    });
    const kept = await db.asset.create({
      data: { projectId: project.id, type: 'IMAGE', source: 'GENERATED', uri: '/storage/k.png' },
    });

    await onStoryboardPatched(db, storyboard.id, [], [removed.id]);

    const removedAfter = await db.asset.findUniqueOrThrow({ where: { id: removed.id } });
    const keptAfter = await db.asset.findUniqueOrThrow({ where: { id: kept.id } });
    expect(removedAfter.status).toBe('RECYCLED');
    expect(keptAfter.status).toBe('ACTIVE');
  });

  it('不属于该 Storyboard 的 shotId 被忽略（防误传）', async () => {
    const { storyboard } = await seedBase();
    const other = await seedBase();
    const foreignShot = await createShot(other.storyboard.id, 0);

    await onStoryboardPatched(db, storyboard.id, [foreignShot.id], []);

    const after = await db.shot.findUniqueOrThrow({ where: { id: foreignShot.id } });
    expect(after.keyframeStale).toBe(false);
    expect(after.videoStale).toBe(false);
  });
});

describe('onBindingChanged（§2.2 行3/4：标签级波及无覆盖镜头；镜头级仅波及该镜头）', () => {
  it('shotId 非空（镜头级覆盖）→ 仅该镜头 keyframe 标 stale，video 不动', async () => {
    const { project, episode, storyboard } = await seedBase();
    const tag = await db.tag.create({ data: { projectId: project.id, type: 'CHARACTER', name: '甲' } });
    const target = await createShot(storyboard.id, 0);
    const bystander = await createShot(storyboard.id, 1);
    await db.shotTag.createMany({
      data: [
        { shotId: target.id, tagId: tag.id },
        { shotId: bystander.id, tagId: tag.id },
      ],
    });

    const affected = await onBindingChanged(db, episode.id, tag.id, target.id);

    expect(affected).toEqual([target.id]);
    const targetAfter = await db.shot.findUniqueOrThrow({ where: { id: target.id } });
    const bystanderAfter = await db.shot.findUniqueOrThrow({ where: { id: bystander.id } });
    expect(targetAfter.keyframeStale).toBe(true);
    expect(targetAfter.videoStale).toBe(false);
    expect(reasonsOf(targetAfter.staleReasonsJson)[0]!.source).toBe('binding_changed');
    expect(bystanderAfter.keyframeStale).toBe(false);
  });

  it('shotId 为空（标签级默认）→ 最新版本中含该标签且无镜头级覆盖的镜头全部标 stale，并返回受影响 shotId', async () => {
    const { project, episode, storyboard: v1 } = await seedBase();
    const draft2 = await db.scriptDraft.create({ data: { episodeId: episode.id } });
    const v2 = await db.storyboard.create({
      data: { episodeId: episode.id, scriptDraftId: draft2.id, version: 2 },
    });
    const tag = await db.tag.create({ data: { projectId: project.id, type: 'SCENE', name: '客厅' } });
    const otherTag = await db.tag.create({ data: { projectId: project.id, type: 'PROP', name: '沙发' } });
    const asset = await db.asset.create({
      data: { projectId: project.id, type: 'IMAGE', source: 'UPLOADED', uri: '/storage/s.png' },
    });

    // v2（最新版本）：plain 含标签无覆盖；overridden 含标签但有镜头级覆盖绑定；unrelated 不含该标签
    const plain = await createShot(v2.id, 0);
    const overridden = await createShot(v2.id, 1);
    const unrelated = await createShot(v2.id, 2);
    // v1（旧版本）：同样含标签，但不应被波及
    const oldShot = await createShot(v1.id, 0);
    await db.shotTag.createMany({
      data: [
        { shotId: plain.id, tagId: tag.id },
        { shotId: overridden.id, tagId: tag.id },
        { shotId: unrelated.id, tagId: otherTag.id },
        { shotId: oldShot.id, tagId: tag.id },
      ],
    });
    // overridden 的镜头级覆盖绑定（同 tag）
    await db.binding.create({
      data: { episodeId: episode.id, tagId: tag.id, shotId: overridden.id, shotKey: overridden.id, assetId: asset.id },
    });
    // plain 上挂一个"其他标签"的镜头级绑定：不构成对本 tag 的覆盖，plain 仍应被波及
    await db.binding.create({
      data: { episodeId: episode.id, tagId: otherTag.id, shotId: plain.id, shotKey: plain.id, assetId: asset.id },
    });

    const affected = await onBindingChanged(db, episode.id, tag.id);

    expect(affected).toEqual([plain.id]);
    const plainAfter = await db.shot.findUniqueOrThrow({ where: { id: plain.id } });
    const overriddenAfter = await db.shot.findUniqueOrThrow({ where: { id: overridden.id } });
    const unrelatedAfter = await db.shot.findUniqueOrThrow({ where: { id: unrelated.id } });
    const oldAfter = await db.shot.findUniqueOrThrow({ where: { id: oldShot.id } });
    expect(plainAfter.keyframeStale).toBe(true);
    expect(plainAfter.videoStale).toBe(false);
    expect(reasonsOf(plainAfter.staleReasonsJson)[0]!.source).toBe('binding_changed');
    expect(overriddenAfter.keyframeStale).toBe(false); // 镜头级覆盖存在 → 标签级变更不波及
    expect(unrelatedAfter.keyframeStale).toBe(false);
    expect(oldAfter.keyframeStale).toBe(false); // 旧版本 Storyboard 不波及
  });

  it('分集没有任何 Storyboard → 返回空数组', async () => {
    const project = await db.project.create({ data: { name: `P-${crypto.randomUUID()}` } });
    const episode = await db.episode.create({ data: { projectId: project.id, title: 'E空' } });
    const tag = await db.tag.create({ data: { projectId: project.id, type: 'CHARACTER', name: '乙' } });

    const affected = await onBindingChanged(db, episode.id, tag.id);
    expect(affected).toEqual([]);
  });
});

describe('onDubbingDurationChanged（§2.2 行5：|Δ|>500ms → video 标 stale）', () => {
  it('偏差 > 500ms → 写入新时长且 video 标 stale + 原因', async () => {
    const { storyboard } = await seedBase();
    const shot = await createShot(storyboard.id, 0, { durationLockedMs: 10000 });

    await onDubbingDurationChanged(db, shot.id, 11000);

    const after = await db.shot.findUniqueOrThrow({ where: { id: shot.id } });
    expect(after.durationLockedMs).toBe(11000);
    expect(after.videoStale).toBe(true);
    const reasons = reasonsOf(after.staleReasonsJson);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.source).toBe('dubbing_duration_changed');
  });

  it('偏差恰为 500ms（阈值边界）→ 只更新时长，不标 stale、不追加原因', async () => {
    const { storyboard } = await seedBase();
    const shot = await createShot(storyboard.id, 0, { durationLockedMs: 10000 });

    await onDubbingDurationChanged(db, shot.id, 10500);

    const after = await db.shot.findUniqueOrThrow({ where: { id: shot.id } });
    expect(after.durationLockedMs).toBe(10500);
    expect(after.videoStale).toBe(false);
    expect(reasonsOf(after.staleReasonsJson)).toHaveLength(0);
  });

  it('旧 durationLockedMs 为 null → 以 durationPlannedMs 为旧值比较', async () => {
    const { storyboard } = await seedBase();
    // planned=12000，新值 12400，偏差 400 ≤ 500 → 不标 stale
    const small = await createShot(storyboard.id, 0, { durationPlannedMs: 12000 });
    // planned=12000，新值 13000，偏差 1000 > 500 → 标 stale
    const big = await createShot(storyboard.id, 1, { durationPlannedMs: 12000 });

    await onDubbingDurationChanged(db, small.id, 12400);
    await onDubbingDurationChanged(db, big.id, 13000);

    const smallAfter = await db.shot.findUniqueOrThrow({ where: { id: small.id } });
    const bigAfter = await db.shot.findUniqueOrThrow({ where: { id: big.id } });
    expect(smallAfter.durationLockedMs).toBe(12400);
    expect(smallAfter.videoStale).toBe(false);
    expect(bigAfter.durationLockedMs).toBe(13000);
    expect(bigAfter.videoStale).toBe(true);
  });

  it('镜头不存在 → 404', async () => {
    await expect(onDubbingDurationChanged(db, 'no-such-shot', 1000)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('onTakeSelected（§2.2 行6/7：keyframe 换 take → video 标 stale；video 换 take → 仅记录）', () => {
  it("slot='KEYFRAME' → video 标 stale + 原因，keyframe 位不动", async () => {
    const { storyboard } = await seedBase();
    const shot = await createShot(storyboard.id, 0);

    await onTakeSelected(db, shot.id, 'KEYFRAME');

    const after = await db.shot.findUniqueOrThrow({ where: { id: shot.id } });
    expect(after.videoStale).toBe(true);
    expect(after.keyframeStale).toBe(false);
    expect(reasonsOf(after.staleReasonsJson)[0]!.source).toBe('take_selected');
  });

  it("slot='VIDEO' → 不改任何 stale 位，仅追加原因（Cut 重排属 M3）", async () => {
    const { storyboard } = await seedBase();
    const shot = await createShot(storyboard.id, 0);

    await onTakeSelected(db, shot.id, 'VIDEO');

    const after = await db.shot.findUniqueOrThrow({ where: { id: shot.id } });
    expect(after.keyframeStale).toBe(false);
    expect(after.videoStale).toBe(false);
    const reasons = reasonsOf(after.staleReasonsJson);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.source).toBe('take_selected');
  });
});

describe('clearStale（v2 §2.3：重新生成/忽略消 stale，溯源记录保留）', () => {
  it("KEYFRAME + 'regenerated' → keyframeStale=false，追加 source='clear:regenerated'，旧原因保留", async () => {
    const { storyboard } = await seedBase();
    const pre: StaleReason = { source: 'binding_changed', at: new Date().toISOString(), detail: '换图' };
    const shot = await createShot(storyboard.id, 0, {
      keyframeStale: true,
      videoStale: true,
      staleReasonsJson: toJson([pre]),
    });

    await clearStale(db, shot.id, 'KEYFRAME', 'regenerated');

    const after = await db.shot.findUniqueOrThrow({ where: { id: shot.id } });
    expect(after.keyframeStale).toBe(false);
    expect(after.videoStale).toBe(true); // 另一槽位不受影响
    const reasons = reasonsOf(after.staleReasonsJson);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]!.source).toBe('binding_changed'); // 溯源保留
    expect(reasons[1]!.source).toBe('clear:regenerated');
  });

  it("VIDEO + 'ignored' → videoStale=false，追加 source='clear:ignored'", async () => {
    const { storyboard } = await seedBase();
    const shot = await createShot(storyboard.id, 0, { videoStale: true });

    await clearStale(db, shot.id, 'VIDEO', 'ignored');

    const after = await db.shot.findUniqueOrThrow({ where: { id: shot.id } });
    expect(after.videoStale).toBe(false);
    expect(reasonsOf(after.staleReasonsJson).at(-1)!.source).toBe('clear:ignored');
  });

  it('镜头不存在 → 404', async () => {
    await expect(clearStale(db, 'no-such-shot', 'KEYFRAME', 'ignored')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('getStaleShots（全局"待重生成"面板数据源）', () => {
  it('只取最新版本 Storyboard 中 keyframeStale 或 videoStale 的镜头，按 sortOrder 排序', async () => {
    const { episode, storyboard: v1 } = await seedBase();
    const draft2 = await db.scriptDraft.create({ data: { episodeId: episode.id } });
    const v2 = await db.storyboard.create({
      data: { episodeId: episode.id, scriptDraftId: draft2.id, version: 2 },
    });

    await createShot(v1.id, 0, { keyframeStale: true }); // 旧版本，不应出现
    const clean = await createShot(v2.id, 0);
    const kfStale = await createShot(v2.id, 2, { keyframeStale: true });
    const vidStale = await createShot(v2.id, 1, { videoStale: true });

    const shots = await getStaleShots(db, episode.id);

    expect(shots.map((s) => s.id)).toEqual([vidStale.id, kfStale.id]);
    expect(shots.map((s) => s.id)).not.toContain(clean.id);
  });

  it('分集没有 Storyboard → 返回空数组', async () => {
    const project = await db.project.create({ data: { name: `P-${crypto.randomUUID()}` } });
    const episode = await db.episode.create({ data: { projectId: project.id, title: 'E空' } });
    expect(await getStaleShots(db, episode.id)).toEqual([]);
  });
});
