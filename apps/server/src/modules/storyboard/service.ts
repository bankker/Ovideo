import type { Prisma, PrismaClient, Storyboard, Tag } from '@prisma/client';
import type {
  NewShotInput,
  ShotDialogueInput,
  ShotEditableFields,
  StoryboardPatch,
  TagType,
} from '@ovideo/shared';
import { badRequest, notFound } from '../../lib/errors.js';

/** 标签解析函数：由调用方注入（路由绑定 tag/service.findOrCreateTags 到具体 projectId），保持模块解耦 */
export type ResolveTagsFn = (tags: Array<{ name: string; type: TagType }>) => Promise<Tag[]>;

export interface ApplyPatchInput {
  episodeId: string;
  scriptDraftId: string;
  /** 基底分镜版本；null/缺省 = 空基底（三步生成的首版） */
  baseStoryboardId?: string | null;
  patch: StoryboardPatch;
  source: string;
  resolveTags: ResolveTagsFn;
}

export interface ApplyPatchHooks {
  onStoryboardPatched?: (
    db: PrismaClient,
    storyboardId: string,
    changedShotIds: string[],
    removedShotAssetIds: string[],
  ) => Promise<void>;
}

export interface ApplyPatchResult {
  storyboard: Storyboard;
  /** 新版本中"被 update 的镜头 + add 的新镜头"的（新）id，供失效传播与前端高亮 */
  changedShotIds: string[];
  /** 被 remove 镜头名下全部 take 的资产 id，供回收站处理——付费产物从不物理删除 */
  removedShotAssetIds: string[];
}

type BaseShot = Prisma.ShotGetPayload<{
  include: { tags: true; dialogue: true; takes: true };
}>;

type Entry =
  | { kind: 'copy'; base: BaseShot; overrides: ShotEditableFields }
  | { kind: 'new'; shot: NewShotInput };

/**
 * patch 应用 = 基于基底版本复制未变镜头 + 应用 ops → 产生新 Storyboard 版本。
 * 复制携带全部产物（Take/selected 指针/stale 标志/镜头级 Binding），从机制上保证：
 * 1) 旧版本原样保留（可回滚）；2) 未触及镜头的付费产物零丢失；3) LLM 输出永远是变更集而非整份重写。
 */
export async function applyPatch(
  db: PrismaClient,
  input: ApplyPatchInput,
  hooks?: ApplyPatchHooks,
): Promise<ApplyPatchResult> {
  const { episodeId, scriptDraftId, baseStoryboardId, patch } = input;

  // 标签解析放在事务之外：SQLite 单连接下事务内再走外层 client 会死锁；
  // 且标签是项目级一致性锚点，patch 失败时已建标签保留也无害。
  const tagByName = await resolveAllTags(patch, input.resolveTags);

  const result = await db.$transaction(
    async (tx) => {
      let baseShots: BaseShot[] = [];
      if (baseStoryboardId) {
        const base = await tx.storyboard.findUnique({
          where: { id: baseStoryboardId },
          include: {
            shots: {
              orderBy: { sortOrder: 'asc' },
              include: { tags: true, dialogue: { orderBy: { sortOrder: 'asc' } }, takes: true },
            },
          },
        });
        if (!base) throw notFound('基底分镜');
        if (base.episodeId !== episodeId) throw badRequest('基底分镜不属于该分集');
        baseShots = base.shots;
      }

      // ---- 在"旧 id → 条目"的工作列表上顺序应用 ops ----
      let entries: Entry[] = baseShots.map((s) => ({ kind: 'copy', base: s, overrides: {} }));
      const changedBaseIds = new Set<string>();
      const removedAssetIds = new Set<string>();

      const findCopyIndex = (shotId: string) =>
        entries.findIndex((e) => e.kind === 'copy' && e.base.id === shotId);

      for (const op of patch) {
        switch (op.op) {
          case 'add_shot': {
            const entry: Entry = { kind: 'new', shot: op.shot };
            if (op.afterShotId == null) {
              entries.push(entry);
            } else {
              const idx = findCopyIndex(op.afterShotId);
              if (idx < 0) throw badRequest(`add_shot 的 afterShotId 不是基底镜头：${op.afterShotId}`);
              entries.splice(idx + 1, 0, entry);
            }
            break;
          }
          case 'update_shot': {
            const idx = findCopyIndex(op.shotId);
            if (idx < 0) throw badRequest(`update_shot 的镜头不存在：${op.shotId}`);
            const entry = entries[idx] as Extract<Entry, { kind: 'copy' }>;
            entry.overrides = { ...entry.overrides, ...op.fields };
            changedBaseIds.add(op.shotId);
            break;
          }
          case 'remove_shot': {
            const idx = findCopyIndex(op.shotId);
            if (idx < 0) throw badRequest(`remove_shot 的镜头不存在：${op.shotId}`);
            const entry = entries[idx] as Extract<Entry, { kind: 'copy' }>;
            for (const take of entry.base.takes) removedAssetIds.add(take.assetId);
            entries.splice(idx, 1);
            changedBaseIds.delete(op.shotId);
            break;
          }
          case 'reorder': {
            const copies = entries.filter(
              (e): e is Extract<Entry, { kind: 'copy' }> => e.kind === 'copy',
            );
            const currentIds = new Set(copies.map((e) => e.base.id));
            const distinct = new Set(op.shotIds);
            if (
              op.shotIds.length !== currentIds.size ||
              distinct.size !== op.shotIds.length ||
              op.shotIds.some((sid) => !currentIds.has(sid))
            ) {
              throw badRequest('reorder 的 shotIds 必须恰好是基底镜头 id 的全量新序（不可缺漏/重复/含未知 id）');
            }
            const byId = new Map(copies.map((e) => [e.base.id, e]));
            const news = entries.filter((e) => e.kind === 'new');
            // 本次 patch 新增的镜头尚无 id，无法参与 reorder，统一排到末尾
            entries = [...op.shotIds.map((sid) => byId.get(sid) as Entry), ...news];
            break;
          }
        }
      }

      // ---- 生成新版本 ----
      const agg = await tx.storyboard.aggregate({
        where: { episodeId },
        _max: { version: true },
      });
      const storyboard = await tx.storyboard.create({
        data: { episodeId, scriptDraftId, version: (agg._max.version ?? 0) + 1 },
      });

      const changedShotIds: string[] = [];
      let sortOrder = 0;
      for (const entry of entries) {
        if (entry.kind === 'new') {
          const created = await tx.shot.create({
            data: {
              storyboardId: storyboard.id,
              sortOrder,
              sourceText: entry.shot.sourceText,
              imagePrompt: entry.shot.imagePrompt,
              videoPrompt: entry.shot.videoPrompt,
              durationPlannedMs: entry.shot.durationPlannedMs,
              tags: { create: buildShotTagCreates(entry.shot.tags, tagByName) },
              dialogue: { create: buildDialogueCreates(entry.shot.dialogue, tagByName) },
            },
          });
          // 新镜头是空槽（不 stale），但前端需要高亮，故记入 changed
          changedShotIds.push(created.id);
        } else {
          const { base, overrides } = entry;
          const created = await tx.shot.create({
            data: {
              storyboardId: storyboard.id,
              sortOrder,
              sourceText: overrides.sourceText ?? base.sourceText,
              imagePrompt: overrides.imagePrompt ?? base.imagePrompt,
              videoPrompt: overrides.videoPrompt ?? base.videoPrompt,
              durationPlannedMs: overrides.durationPlannedMs ?? base.durationPlannedMs,
              durationLockedMs: base.durationLockedMs,
              groupId: base.groupId,
              groupIndex: base.groupIndex,
              keyframeStale: base.keyframeStale,
              videoStale: base.videoStale,
              staleReasonsJson: base.staleReasonsJson,
              tags: {
                // fields.tags 提供 = 整组替换；否则原样复制
                create: overrides.tags
                  ? buildShotTagCreates(overrides.tags, tagByName)
                  : base.tags.map((t) => ({ tagId: t.tagId })),
              },
              dialogue: {
                create: overrides.dialogue
                  ? buildDialogueCreates(overrides.dialogue, tagByName)
                  : base.dialogue.map((d) => ({
                      speakerTagId: d.speakerTagId,
                      isNarrator: d.isNarrator,
                      text: d.text,
                      sortOrder: d.sortOrder,
                    })),
              },
            },
          });

          // 复制 Take（新行指向同 assetId/jobId），selected 指针按 旧take→新take 重定向
          const takeIdMap = new Map<string, string>();
          for (const take of base.takes) {
            const newTake = await tx.take.create({
              data: { shotId: created.id, slot: take.slot, assetId: take.assetId, jobId: take.jobId },
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
              where: { id: created.id },
              data: { keyframeSelectedTakeId: keyframeSel, videoSelectedTakeId: videoSel },
            });
          }

          // 镜头级 Binding 复制为指向新 shotId 的新行；标签级（shotId=null）不动
          const shotBindings = await tx.binding.findMany({
            where: { episodeId, shotId: base.id },
          });
          for (const b of shotBindings) {
            await tx.binding.create({
              data: {
                episodeId,
                tagId: b.tagId,
                shotId: created.id,
                shotKey: created.id,
                assetId: b.assetId,
              },
            });
          }

          if (changedBaseIds.has(base.id)) changedShotIds.push(created.id);
        }
        sortOrder += 1;
      }

      return { storyboard, changedShotIds, removedShotAssetIds: [...removedAssetIds] };
    },
    { timeout: 20000 },
  );

  // 钩子放在事务提交之后：钩子（失效传播）自己写库，事务内回调外层 client 会死锁
  await hooks?.onStoryboardPatched?.(
    db,
    result.storyboard.id,
    result.changedShotIds,
    result.removedShotAssetIds,
  );
  return result;
}

/** 预收集 patch 里全部标签输入（含 dialogue 的 speaker，按 CHARACTER 解析），一次性 findOrCreate */
async function resolveAllTags(
  patch: StoryboardPatch,
  resolveTags: ResolveTagsFn,
): Promise<Map<string, Tag>> {
  const inputs: Array<{ name: string; type: TagType }> = [];
  const collect = (tags: Array<{ name: string; type: TagType }>, dialogue: ShotDialogueInput[]) => {
    inputs.push(...tags);
    for (const d of dialogue) {
      if (d.speaker) inputs.push({ name: d.speaker, type: 'CHARACTER' });
    }
  };
  for (const op of patch) {
    if (op.op === 'add_shot') collect(op.shot.tags, op.shot.dialogue);
    else if (op.op === 'update_shot') collect(op.fields.tags ?? [], op.fields.dialogue ?? []);
  }
  const resolved = inputs.length > 0 ? await resolveTags(inputs) : [];
  return new Map(resolved.map((t) => [t.name, t]));
}

function buildShotTagCreates(
  tags: Array<{ name: string; type: TagType }>,
  tagByName: Map<string, Tag>,
): Array<{ tagId: string }> {
  const ids = new Set<string>();
  for (const t of tags) {
    const tag = tagByName.get(t.name);
    if (!tag) throw badRequest(`标签解析失败：${t.name}`);
    ids.add(tag.id);
  }
  return [...ids].map((tagId) => ({ tagId }));
}

function buildDialogueCreates(
  dialogue: ShotDialogueInput[],
  tagByName: Map<string, Tag>,
): Array<{ speakerTagId: string | null; isNarrator: boolean; text: string; sortOrder: number }> {
  return dialogue.map((d, i) => ({
    speakerTagId: d.speaker ? (tagByName.get(d.speaker)?.id ?? null) : null,
    // 协议约定：speaker 缺省且 isNarrator=false 时按旁白处理
    isNarrator: d.isNarrator || !d.speaker,
    text: d.text,
    sortOrder: i,
  }));
}
