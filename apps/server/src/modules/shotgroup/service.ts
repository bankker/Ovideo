// ShotGroup 首尾帧衔接组（v2 §5）：超长镜头拆分为 N 段串行生成的衔接组。
// 拆分 = 产生新 Storyboard 版本（旧版本原样保留、可回滚），复制规则与 storyboard/service.applyPatch
// 一致（携带 takes/selected/stale/镜头级绑定）；仅目标镜头被替换为 N 个分段（groupId = 原 shotId）。
import type { Prisma, PrismaClient, Storyboard } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';

/** 模型单次生成时长上限缺省值（毫秒，v2 §5：每段 10–15s） */
export const DEFAULT_MAX_SEGMENT_MS = 15000;

export interface SplitShotInput {
  shotId: string;
  /** 模型单次生成上限（毫秒），缺省 15000 */
  maxSegmentMs?: number;
}

export interface SplitGroupHooks {
  /** 拆分完成后回调（事务提交之后；事务内回调外层 client 在 SQLite 下会死锁） */
  onGroupSplit?: (db: PrismaClient, storyboardId: string, groupShotIds: string[]) => Promise<void>;
}

export interface SplitShotResult {
  storyboard: Storyboard;
  /** 新版本中衔接组各段 shotId（按 groupIndex 升序） */
  groupShotIds: string[];
}

type BaseShot = Prisma.ShotGetPayload<{
  include: { tags: true; dialogue: true; takes: true; scene: true };
}>;

type Tx = Prisma.TransactionClient;

/**
 * 把基底版本的 Scene 复制到新版本（同一条基底 Scene 只复制一次），返回新 Scene id。
 * 规则与 storyboard/service.copyScene 完全一致——两处若不一致，
 * 拆分出的版本会成为 lineage 断点（此前 Shot.lineageId 就踩过同样的坑）。
 * base.scene 为 null（存量镜头未归属场景）时返回 null，不凭空造场景。
 */
async function copySceneOf(
  tx: Tx,
  storyboardId: string,
  base: BaseShot,
  cache: Map<string, string>,
): Promise<string | null> {
  const scene = base.scene;
  if (!scene) return null;
  const cached = cache.get(scene.id);
  if (cached) return cached;
  const created = await tx.scene.create({
    data: {
      storyboardId,
      sortOrder: scene.sortOrder,
      title: scene.title,
      location: scene.location,
      interiorExterior: scene.interiorExterior,
      timeOfDay: scene.timeOfDay,
      sourceText: scene.sourceText,
      status: scene.status,
      lineageId: scene.lineageId ?? scene.id,
    },
  });
  if (!scene.lineageId) {
    await tx.scene.update({ where: { id: scene.id }, data: { lineageId: scene.id } });
  }
  cache.set(scene.id, created.id);
  return created.id;
}

/** 总时长均分为 n 段（最后一段拿余数），保证 sum(parts) === totalMs */
function splitDuration(totalMs: number, n: number): number[] {
  const base = Math.floor(totalMs / n);
  const parts = Array.from({ length: n }, () => base);
  parts[n - 1] = totalMs - base * (n - 1);
  return parts;
}

/** 复制镜头的全部 Take（新行指向同 assetId/jobId），selected 指针按 旧take→新take 重定向 */
async function copyTakes(tx: Tx, base: BaseShot, newShotId: string): Promise<void> {
  const takeIdMap = new Map<string, string>();
  for (const take of base.takes) {
    const newTake = await tx.take.create({
      data: { shotId: newShotId, slot: take.slot, assetId: take.assetId, jobId: take.jobId },
    });
    takeIdMap.set(take.id, newTake.id);
  }
  const keyframeSel = base.keyframeSelectedTakeId
    ? (takeIdMap.get(base.keyframeSelectedTakeId) ?? null)
    : null;
  const videoSel = base.videoSelectedTakeId
    ? (takeIdMap.get(base.videoSelectedTakeId) ?? null)
    : null;
  if (keyframeSel || videoSel) {
    await tx.shot.update({
      where: { id: newShotId },
      data: { keyframeSelectedTakeId: keyframeSel, videoSelectedTakeId: videoSel },
    });
  }
}

/** 镜头级 Binding 复制为指向新 shotId 的新行；标签级（shotId=null）不动 */
async function copyShotBindings(
  tx: Tx,
  episodeId: string,
  baseShotId: string,
  newShotId: string,
): Promise<void> {
  const shotBindings = await tx.binding.findMany({ where: { episodeId, shotId: baseShotId } });
  for (const b of shotBindings) {
    await tx.binding.create({
      data: { episodeId, tagId: b.tagId, shotId: newShotId, shotKey: newShotId, assetId: b.assetId },
    });
  }
}

/** 非目标镜头的原样复制（同 applyPatch 的 copy 规则） */
async function copyShotAsIs(
  tx: Tx,
  opts: {
    storyboardId: string;
    episodeId: string;
    base: BaseShot;
    sortOrder: number;
    sceneCache: Map<string, string>;
  },
): Promise<void> {
  const { storyboardId, episodeId, base, sortOrder, sceneCache } = opts;
  // 与 applyPatch 同规则继承 lineage；漏写会让拆分版本成为断点，跨版本抽卡历史在此断链
  if (base.lineageId === null) {
    await tx.shot.update({ where: { id: base.id }, data: { lineageId: base.id } });
  }
  const sceneId = await copySceneOf(tx, storyboardId, base, sceneCache);
  const created = await tx.shot.create({
    data: {
      storyboardId,
      sortOrder,
      sceneId,
      lineageId: base.lineageId ?? base.id,
      sourceText: base.sourceText,
      imagePrompt: base.imagePrompt,
      videoPrompt: base.videoPrompt,
      durationPlannedMs: base.durationPlannedMs,
      durationLockedMs: base.durationLockedMs,
      shotSize: base.shotSize,
      cameraAngle: base.cameraAngle,
      cameraMovement: base.cameraMovement,
      composition: base.composition,
      transition: base.transition,
      groupId: base.groupId,
      groupIndex: base.groupIndex,
      keyframeStale: base.keyframeStale,
      videoStale: base.videoStale,
      staleReasonsJson: base.staleReasonsJson,
      tags: { create: base.tags.map((t) => ({ tagId: t.tagId })) },
      dialogue: {
        create: base.dialogue.map((d) => ({
          speakerTagId: d.speakerTagId,
          isNarrator: d.isNarrator,
          text: d.text,
          sortOrder: d.sortOrder,
        })),
      },
    },
  });
  await copyTakes(tx, base, created.id);
  await copyShotBindings(tx, episodeId, base.id, created.id);
}

/**
 * 把一个超长镜头拆为衔接组（v2 §5）：产生新 Storyboard 版本，目标镜头替换为 N 段
 * （N = ceil(时长 / maxSegmentMs)，时长 = durationLockedMs ?? durationPlannedMs）。
 * - 每段：groupId = 原 shotId、groupIndex = 0..N-1、sortOrder 连续占位、时长均分（末段拿余数）；
 * - 提示词/原文每段都带（追加「（第i段/共N段）」后缀）、tags 每段复制、镜头级绑定每段复制；
 * - 对白只挂段 0；原镜头的 takes/selected/stale 只承接到段 0（段 1..N-1 是全新空槽）。
 */
export async function splitShotIntoGroup(
  db: PrismaClient,
  input: SplitShotInput,
  hooks?: SplitGroupHooks,
): Promise<SplitShotResult> {
  const { shotId, maxSegmentMs = DEFAULT_MAX_SEGMENT_MS } = input;
  if (!Number.isInteger(maxSegmentMs) || maxSegmentMs <= 0) {
    throw badRequest('maxSegmentMs 必须为正整数（毫秒）');
  }

  const target = await db.shot.findUnique({
    where: { id: shotId },
    include: { storyboard: true },
  });
  if (!target) throw notFound('镜头');
  if (target.groupId != null) throw badRequest('该镜头已在衔接组内，不能重复拆分');
  // 时长链路（v2 §3）：配音锁定时长优先，未锁定用计划时长
  const totalMs = target.durationLockedMs ?? target.durationPlannedMs;
  if (totalMs <= maxSegmentMs) throw badRequest('该镜头时长未超过单段上限，无需拆分');

  const episodeId = target.storyboard.episodeId;
  const scriptDraftId = target.storyboard.scriptDraftId;
  const n = Math.ceil(totalMs / maxSegmentMs);
  const parts = splitDuration(totalMs, n);

  const result = await db.$transaction(
    async (tx) => {
      const base = await tx.storyboard.findUniqueOrThrow({
        where: { id: target.storyboardId },
        include: {
          shots: {
            orderBy: { sortOrder: 'asc' },
            include: {
              tags: true,
              dialogue: { orderBy: { sortOrder: 'asc' } },
              takes: true,
              scene: true,
            },
          },
        },
      });

      const agg = await tx.storyboard.aggregate({ where: { episodeId }, _max: { version: true } });
      const storyboard = await tx.storyboard.create({
        data: { episodeId, scriptDraftId, version: (agg._max.version ?? 0) + 1 },
      });

      const groupShotIds: string[] = [];
      /** 基底 Scene id → 新版本 Scene id，保证同一条场景只复制一次 */
      const sceneCache = new Map<string, string>();
      /** 新 Scene id → 其下镜头时长之和 */
      const sceneDurationMs = new Map<string, number>();
      const noteSceneDuration = (sceneId: string | null, durationMs: number) => {
        if (!sceneId) return;
        sceneDurationMs.set(sceneId, (sceneDurationMs.get(sceneId) ?? 0) + durationMs);
      };

      let sortOrder = 0;
      for (const shot of base.shots) {
        if (shot.id !== target.id) {
          await copyShotAsIs(tx, {
            storyboardId: storyboard.id,
            episodeId,
            base: shot,
            sortOrder,
            sceneCache,
          });
          noteSceneDuration(
            sceneCache.get(shot.sceneId ?? '') ?? null,
            shot.durationLockedMs ?? shot.durationPlannedMs,
          );
          sortOrder += 1;
          continue;
        }

        // 段 0 承接原镜头身份，故原镜头是存量行时先开锚（与 copyShotAsIs 同规则）
        if (shot.lineageId === null) {
          await tx.shot.update({ where: { id: shot.id }, data: { lineageId: shot.id } });
        }

        // 拆的是镜头不是场景：N 个分段全部挂在同一条（复制出来的）Scene 上
        const targetSceneId = await copySceneOf(tx, storyboard.id, shot, sceneCache);

        // 目标镜头 → N 个分段（groupId = 原 shotId，天然全局唯一）
        for (let i = 0; i < n; i += 1) {
          const suffix = `（第${i + 1}段/共${n}段）`;
          const created = await tx.shot.create({
            data: {
              storyboardId: storyboard.id,
              sortOrder,
              sceneId: targetSceneId,
              // 段 0 继承原镜头 lineage（连着它的抽卡历史）；段 1..N-1 是全新镜头，建后各自开锚
              lineageId: i === 0 ? (shot.lineageId ?? shot.id) : null,
              sourceText: shot.sourceText ? shot.sourceText + suffix : '',
              imagePrompt: shot.imagePrompt ? shot.imagePrompt + suffix : '',
              videoPrompt: shot.videoPrompt ? shot.videoPrompt + suffix : '',
              durationPlannedMs: parts[i]!,
              // 影视语义每段照抄：拆的是时长，景别/角度/运镜不变
              shotSize: shot.shotSize,
              cameraAngle: shot.cameraAngle,
              cameraMovement: shot.cameraMovement,
              composition: shot.composition,
              transition: shot.transition,
              // 原镜头已锁定时长的，各段同样按均分值锁定；未锁定的保持未锁定
              durationLockedMs: shot.durationLockedMs != null ? parts[i]! : null,
              groupId: shot.id,
              groupIndex: i,
              // 段 0 承接原镜头的产物与 stale 状态；段 1..N-1 是全新空槽
              keyframeStale: i === 0 ? shot.keyframeStale : false,
              videoStale: i === 0 ? shot.videoStale : false,
              staleReasonsJson: i === 0 ? shot.staleReasonsJson : '[]',
              tags: { create: shot.tags.map((t) => ({ tagId: t.tagId })) },
              dialogue:
                i === 0
                  ? {
                      create: shot.dialogue.map((d) => ({
                        speakerTagId: d.speakerTagId,
                        isNarrator: d.isNarrator,
                        text: d.text,
                        sortOrder: d.sortOrder,
                      })),
                    }
                  : undefined,
            },
          });
          if (i === 0) await copyTakes(tx, shot, created.id);
          else await tx.shot.update({ where: { id: created.id }, data: { lineageId: created.id } });
          await copyShotBindings(tx, episodeId, shot.id, created.id);
          // 各段时长之和 = 原镜头总时长，故场景时长不因拆分而改变
          noteSceneDuration(targetSceneId, parts[i]!);
          groupShotIds.push(created.id);
          sortOrder += 1;
        }
      }

      // 场景时长 = 其下镜头时长之和，等镜头全部落库后统一写入
      for (const [sceneId, durationMs] of sceneDurationMs) {
        await tx.scene.update({ where: { id: sceneId }, data: { estimatedDurationMs: durationMs } });
      }

      return { storyboard, groupShotIds };
    },
    { timeout: 20000 },
  );

  // 钩子放在事务提交之后（同 applyPatch 约定）
  await hooks?.onGroupSplit?.(db, result.storyboard.id, result.groupShotIds);
  return result;
}

export interface ShotGroupView {
  groupId: string;
  /** 按 groupIndex 升序 */
  shotIds: string[];
}

/** 某分镜版本内的全部衔接组（前端链视图数据源）；组间按首段 sortOrder 排序 */
export async function listGroups(db: PrismaClient, storyboardId: string): Promise<ShotGroupView[]> {
  const storyboard = await db.storyboard.findUnique({ where: { id: storyboardId } });
  if (!storyboard) throw notFound('分镜');
  const shots = await db.shot.findMany({
    where: { storyboardId, groupId: { not: null } },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, groupId: true, groupIndex: true },
  });
  const byGroup = new Map<string, Array<{ id: string; groupIndex: number }>>();
  for (const s of shots) {
    const list = byGroup.get(s.groupId!) ?? [];
    list.push({ id: s.id, groupIndex: s.groupIndex ?? 0 });
    byGroup.set(s.groupId!, list);
  }
  return [...byGroup.entries()].map(([groupId, list]) => ({
    groupId,
    shotIds: list.sort((a, b) => a.groupIndex - b.groupIndex).map((s) => s.id),
  }));
}
