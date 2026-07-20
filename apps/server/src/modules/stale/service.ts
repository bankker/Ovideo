// Stale 失效传播引擎 —— v2 §2.2 传播表的唯一实现处。
// 铁律：stale 只是标记，不阻塞下游；staleReasonsJson 追加不覆盖（§2.3 变更溯源）。
import type { Prisma, PrismaClient, Shot } from '@prisma/client';
import { TakeSlotSchema, type StaleReason, type TakeSlot } from '@ovideo/shared';
import { parseJson, toJson } from '../../lib/json.js';
import { notFound } from '../../lib/errors.js';

function makeReason(source: string, detail: string): StaleReason {
  return { source, at: new Date().toISOString(), detail };
}

function appendReason(rawJson: string, reason: StaleReason): string {
  const reasons = parseJson<StaleReason[]>(rawJson, []);
  reasons.push(reason);
  return toJson(reasons);
}

/**
 * §2.2 行1：修改剧本稿内容 / 切换主剧本。
 * 该稿关联的所有 Storyboard 标 stale + 追加原因；资产、标签、绑定一律不动。
 */
export async function onScriptDraftChanged(
  db: PrismaClient,
  draftId: string,
  detail = '剧本稿内容变更',
): Promise<void> {
  const draft = await db.scriptDraft.findUnique({ where: { id: draftId } });
  if (!draft) throw notFound('剧本稿');
  const reason = makeReason('script_draft_changed', detail);
  await db.$transaction(async (tx) => {
    const storyboards = await tx.storyboard.findMany({ where: { scriptDraftId: draftId } });
    for (const sb of storyboards) {
      await tx.storyboard.update({
        where: { id: sb.id },
        data: { stale: true, staleReasonsJson: appendReason(sb.staleReasonsJson, reason) },
      });
    }
  });
}

/**
 * §2.2 行2：对话修改分镜（镜头增/删/改）。
 * changedShotIds 的镜头 keyframe+video 标 stale；removedShotAssetIds 的产物进回收站；
 * 未被触及的镜头零影响。
 */
export async function onStoryboardPatched(
  db: PrismaClient,
  storyboardId: string,
  changedShotIds: string[],
  removedShotAssetIds: string[],
): Promise<void> {
  const reason = makeReason('storyboard_patched', '对话修改分镜：镜头内容变更');
  await db.$transaction(async (tx) => {
    if (changedShotIds.length > 0) {
      // 限定 storyboardId：防止调用方误传其他分镜版本的 shotId
      const shots = await tx.shot.findMany({
        where: { id: { in: changedShotIds }, storyboardId },
      });
      for (const shot of shots) {
        await tx.shot.update({
          where: { id: shot.id },
          data: {
            keyframeStale: true,
            videoStale: true,
            staleReasonsJson: appendReason(shot.staleReasonsJson, reason),
          },
        });
      }
    }
    if (removedShotAssetIds.length > 0) {
      await tx.asset.updateMany({
        where: { id: { in: removedShotAssetIds } },
        data: { status: 'RECYCLED' },
      });
    }
  });
}

/**
 * §2.2 行3/4：绑定变更。
 * shotId 非空（镜头级覆盖）→ 仅该镜头 keyframe 标 stale；
 * shotId 空（标签级默认）→ 最新版本 Storyboard 中含该标签、且该镜头无同 tag 的镜头级覆盖绑定的镜头全部标 stale。
 * 返回受影响 shotId 数组（前端提示"N 个镜头受影响"）。
 */
export async function onBindingChanged(
  db: PrismaClient,
  episodeId: string,
  tagId: string,
  shotId?: string,
): Promise<string[]> {
  if (shotId) {
    const shot = await db.shot.findUnique({ where: { id: shotId } });
    if (!shot) throw notFound('镜头');
    const reason = makeReason('binding_changed', '镜头级绑定覆盖变更');
    await db.shot.update({
      where: { id: shotId },
      data: { keyframeStale: true, staleReasonsJson: appendReason(shot.staleReasonsJson, reason) },
    });
    return [shotId];
  }

  const latest = await db.storyboard.findFirst({
    where: { episodeId },
    orderBy: { version: 'desc' },
  });
  if (!latest) return [];

  const reason = makeReason('binding_changed', '标签级默认绑定变更');
  const affected: string[] = [];
  await db.$transaction(async (tx) => {
    const shots = await tx.shot.findMany({
      where: {
        storyboardId: latest.id,
        tags: { some: { tagId } },
        // Shot.bindings 已按 shotId 关联，再限定 (episodeId, tagId) 即"该 tag 的镜头级覆盖"
        bindings: { none: { episodeId, tagId } },
      },
      orderBy: { sortOrder: 'asc' },
    });
    for (const shot of shots) {
      await tx.shot.update({
        where: { id: shot.id },
        data: { keyframeStale: true, staleReasonsJson: appendReason(shot.staleReasonsJson, reason) },
      });
      affected.push(shot.id);
    }
  });
  return affected;
}

/**
 * §2.2 行5：配音重生成导致 duration_locked 变化。
 * 旧值 = durationLockedMs ?? durationPlannedMs；|新-旧| > 500ms → video 标 stale，否则只更新时长。
 * （Cut 时间轴自动重排属 M3，不在此处理。）
 */
export async function onDubbingDurationChanged(
  db: PrismaClient,
  shotId: string,
  newDurationMs: number,
): Promise<void> {
  const shot = await db.shot.findUnique({ where: { id: shotId } });
  if (!shot) throw notFound('镜头');
  const oldMs = shot.durationLockedMs ?? shot.durationPlannedMs;
  const deltaMs = Math.abs(newDurationMs - oldMs);
  const data: Prisma.ShotUpdateInput = { durationLockedMs: newDurationMs };
  if (deltaMs > 500) {
    data.videoStale = true;
    data.staleReasonsJson = appendReason(
      shot.staleReasonsJson,
      makeReason(
        'dubbing_duration_changed',
        `配音时长 ${oldMs}ms → ${newDurationMs}ms（偏差 ${deltaMs}ms 超过 500ms 阈值）`,
      ),
    );
  }
  await db.shot.update({ where: { id: shotId }, data });
  // 场景时长的定义是"其下镜头时长之和"。配音锁定时长后若不重算，
  // 场景时长会一直停在出版本时的估算值，直到下次出新版本才被纠正。
  await recalcSceneDuration(db, shot.sceneId);
}

/**
 * 按"其下镜头时长之和"重算场景预计时长（锁定时长优先，与时长链同口径）。
 * sceneId 为空（存量镜头/未归属场景）时空操作。
 */
export async function recalcSceneDuration(
  db: PrismaClient,
  sceneId: string | null,
): Promise<void> {
  if (!sceneId) return;
  const shots = await db.shot.findMany({
    where: { sceneId },
    select: { durationPlannedMs: true, durationLockedMs: true },
  });
  const total = shots.reduce((sum, s) => sum + (s.durationLockedMs ?? s.durationPlannedMs), 0);
  await db.scene.update({ where: { id: sceneId }, data: { estimatedDurationMs: total } });
}

/**
 * §2.2 行6/7：更换 selected take。
 * KEYFRAME → video 标 stale；VIDEO → 仅追加溯源记录（"Cut 自动重排"属 M3，届时消费该记录）。
 */
export async function onTakeSelected(db: PrismaClient, shotId: string, slot: TakeSlot): Promise<void> {
  const parsedSlot = TakeSlotSchema.parse(slot);
  const shot = await db.shot.findUnique({ where: { id: shotId } });
  if (!shot) throw notFound('镜头');
  if (parsedSlot === 'KEYFRAME') {
    await db.shot.update({
      where: { id: shotId },
      data: {
        videoStale: true,
        staleReasonsJson: appendReason(
          shot.staleReasonsJson,
          makeReason('take_selected', 'keyframe 更换 selected take'),
        ),
      },
    });
    return;
  }
  // VIDEO：追加溯源记录；组内镜头额外向后传播（v2 §5 规则4：尾帧变了，后续段全部失效）。
  // 无组镜头行为与既有一致：只记录、不改 stale 位。
  const groupId = shot.groupId;
  const groupIndex = shot.groupIndex;
  if (groupId != null && groupIndex != null) {
    const propagateReason = makeReason('take_selected', '上一段视频变更，衔接首帧失效');
    await db.$transaction(async (tx) => {
      await tx.shot.update({
        where: { id: shotId },
        data: {
          staleReasonsJson: appendReason(
            shot.staleReasonsJson,
            makeReason('take_selected', 'video 更换 selected take（Cut 重排待 M3 实现）'),
          ),
        },
      });
      // 同组（同 storyboardId + groupId）中 groupIndex 更大的所有段
      const laterSegments = await tx.shot.findMany({
        where: { storyboardId: shot.storyboardId, groupId, groupIndex: { gt: groupIndex } },
        orderBy: { groupIndex: 'asc' },
      });
      for (const seg of laterSegments) {
        await tx.shot.update({
          where: { id: seg.id },
          data: {
            videoStale: true,
            staleReasonsJson: appendReason(seg.staleReasonsJson, propagateReason),
          },
        });
      }
    });
    return;
  }
  await db.shot.update({
    where: { id: shotId },
    data: {
      staleReasonsJson: appendReason(
        shot.staleReasonsJson,
        makeReason('take_selected', 'video 更换 selected take（Cut 重排待 M3 实现）'),
      ),
    },
  });
}

/**
 * v2 §2.3：消费 stale —— 重新生成（regenerated）或忽略（ignored）。
 * 对应槽位 stale=false，溯源记录保留并追加 source='clear:<mode>'。
 */
export async function clearStale(
  db: PrismaClient,
  shotId: string,
  slot: TakeSlot,
  mode: 'regenerated' | 'ignored',
): Promise<void> {
  const parsedSlot = TakeSlotSchema.parse(slot);
  const shot = await db.shot.findUnique({ where: { id: shotId } });
  if (!shot) throw notFound('镜头');
  const reason = makeReason(
    `clear:${mode}`,
    `${parsedSlot === 'KEYFRAME' ? 'keyframe' : 'video'} 槽位消除 stale（${mode === 'regenerated' ? '重新生成' : '忽略'}）`,
  );
  await db.shot.update({
    where: { id: shotId },
    data: {
      ...(parsedSlot === 'KEYFRAME' ? { keyframeStale: false } : { videoStale: false }),
      staleReasonsJson: appendReason(shot.staleReasonsJson, reason),
    },
  });
}

/**
 * 全局"待重生成"面板数据源：最新版本 Storyboard 中 keyframeStale 或 videoStale 的镜头。
 */
export async function getStaleShots(db: PrismaClient, episodeId: string): Promise<Shot[]> {
  const latest = await db.storyboard.findFirst({
    where: { episodeId },
    orderBy: { version: 'desc' },
  });
  if (!latest) return [];
  return db.shot.findMany({
    where: {
      storyboardId: latest.id,
      OR: [{ keyframeStale: true }, { videoStale: true }],
    },
    orderBy: { sortOrder: 'asc' },
  });
}
