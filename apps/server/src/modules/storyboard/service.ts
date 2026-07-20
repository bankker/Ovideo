import type { Prisma, PrismaClient, Scene as PrismaScene, Storyboard, Tag } from '@prisma/client';
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
  include: { tags: true; dialogue: true; takes: true; dubbingLines: true; scene: true };
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
              include: {
                tags: true,
                dialogue: { orderBy: { sortOrder: 'asc' } },
                takes: true,
                dubbingLines: true,
                // 复制镜头时要把它所属的 Scene 一并复制到新版本，故基底查询就带出来
                scene: true,
              },
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
      // 本次新版本里已建好的 Scene：
      // - newSceneIdByKey：同一 patch 内 sceneKey 相同的新镜头共用一条 Scene（只建一次）
      // - copiedSceneIdByBaseId：同一条基底 Scene 只复制一次，其名下多个镜头共同改指它
      const newSceneIdByKey = new Map<string, string>();
      const copiedSceneIdByBaseId = new Map<string, string>();
      /** 新 Scene id → 其下镜头时长之和，循环末尾一次性写回 estimatedDurationMs */
      const sceneDurationMs = new Map<string, number>();

      const noteSceneDuration = (sceneId: string | null, durationMs: number) => {
        if (!sceneId) return;
        sceneDurationMs.set(sceneId, (sceneDurationMs.get(sceneId) ?? 0) + durationMs);
      };

      let sortOrder = 0;
      for (const entry of entries) {
        if (entry.kind === 'new') {
          // sceneRef 缺省 = 不归属任何场景（旧行为，兼容对话改分镜等既有调用方）
          const sceneId = entry.shot.sceneRef
            ? await ensureNewScene(tx, storyboard.id, entry.shot.sceneRef, newSceneIdByKey)
            : null;
          const created = await tx.shot.create({
            data: {
              storyboardId: storyboard.id,
              sortOrder,
              sceneId,
              sourceText: entry.shot.sourceText,
              imagePrompt: entry.shot.imagePrompt,
              videoPrompt: entry.shot.videoPrompt,
              durationPlannedMs: entry.shot.durationPlannedMs,
              shotSize: entry.shot.shotSize ?? '',
              cameraAngle: entry.shot.cameraAngle ?? '',
              cameraMovement: entry.shot.cameraMovement ?? '',
              composition: entry.shot.composition ?? '',
              transition: entry.shot.transition ?? '',
              tags: { create: buildShotTagCreates(entry.shot.tags, tagByName) },
              dialogue: { create: buildDialogueCreates(entry.shot.dialogue, tagByName) },
            },
          });
          // 新镜头尚无锁定时长，计划时长即其对场景时长的贡献
          noteSceneDuration(sceneId, entry.shot.durationPlannedMs);
          // 本次新增的镜头开启一条新 lineage，以自身 id 为锚点（cuid 由库生成，故只能建后回填）
          await tx.shot.update({ where: { id: created.id }, data: { lineageId: created.id } });
          // 新镜头是空槽（不 stale），但前端需要高亮，故记入 changed
          changedShotIds.push(created.id);
        } else {
          const { base, overrides } = entry;
          // 基底镜头归属的 Scene 必须在新版本里有一份对应行，否则新 Shot 会指向旧版本的
          // Scene（跨版本串味，删旧版本时还会被 SetNull 悄悄清空）
          const sceneId = base.scene
            ? await copyScene(tx, storyboard.id, base.scene, copiedSceneIdByBaseId)
            : null;
          const created = await tx.shot.create({
            data: {
              storyboardId: storyboard.id,
              sortOrder,
              sceneId,
              // 继承基底的 lineage；基底是 lineageId 引入前的存量行时以其自身 id 开锚
              lineageId: base.lineageId ?? base.id,
              sourceText: overrides.sourceText ?? base.sourceText,
              imagePrompt: overrides.imagePrompt ?? base.imagePrompt,
              videoPrompt: overrides.videoPrompt ?? base.videoPrompt,
              durationPlannedMs: overrides.durationPlannedMs ?? base.durationPlannedMs,
              durationLockedMs: base.durationLockedMs,
              shotSize: overrides.shotSize ?? base.shotSize,
              cameraAngle: overrides.cameraAngle ?? base.cameraAngle,
              cameraMovement: overrides.cameraMovement ?? base.cameraMovement,
              composition: overrides.composition ?? base.composition,
              transition: overrides.transition ?? base.transition,
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

          // 复制配音行（台词被整组替换时跳过——新台词必须重配音）：
          // 按 sortOrder 把旧台词行映射到刚创建的新台词行，音频资产/时长/状态原样带过去，
          // 保证改提示词出新版本后配音不丢（丢了会导致合成时"配音替换原声"静默失效）。
          if (!overrides.dialogue && base.dubbingLines.length > 0) {
            const newDialogue = await tx.dialogueLine.findMany({
              where: { shotId: created.id },
            });
            const oldIdBySort = new Map(base.dialogue.map((d) => [d.id, d.sortOrder]));
            const newIdBySort = new Map(newDialogue.map((d) => [d.sortOrder, d.id]));
            for (const line of base.dubbingLines) {
              const sort = line.dialogueLineId ? oldIdBySort.get(line.dialogueLineId) : undefined;
              await tx.dubbingLine.create({
                data: {
                  shotId: created.id,
                  dialogueLineId: sort !== undefined ? (newIdBySort.get(sort) ?? null) : null,
                  voiceProfileId: line.voiceProfileId,
                  speed: line.speed,
                  audioAssetId: line.audioAssetId,
                  durationMs: line.durationMs,
                  status: line.status,
                },
              });
            }
          }

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

          // 基底是 lineageId 引入前的存量行时顺手开锚：否则新行指向的 lineage 里查不到基底自己，
          // 基底名下的历史 take 依旧不可见（正是本次要修的问题）
          if (!base.lineageId) {
            await tx.shot.update({ where: { id: base.id }, data: { lineageId: base.id } });
          }

          // 时长链路（v2 §3）：配音锁定时长优先，未锁定用计划时长
          noteSceneDuration(
            sceneId,
            base.durationLockedMs ?? overrides.durationPlannedMs ?? base.durationPlannedMs,
          );

          if (changedBaseIds.has(base.id)) changedShotIds.push(created.id);
        }
        sortOrder += 1;
      }

      // 场景时长 = 其下镜头时长之和，等镜头全部落库后统一写入
      for (const [sceneId, durationMs] of sceneDurationMs) {
        await tx.scene.update({ where: { id: sceneId }, data: { estimatedDurationMs: durationMs } });
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

/**
 * 为一组带同一 sceneKey 的新镜头建（或复用）Scene 行。
 * sceneKey 只在本次 patch 内有意义，故缓存也只活在本次版本生成的作用域内。
 */
async function ensureNewScene(
  tx: Prisma.TransactionClient,
  storyboardId: string,
  ref: NonNullable<NewShotInput['sceneRef']>,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(ref.sceneKey);
  if (cached) return cached;
  const scene = await tx.scene.create({
    data: {
      storyboardId,
      sortOrder: ref.sortOrder,
      title: ref.title ?? '',
      location: ref.location ?? '',
      interiorExterior: ref.interiorExterior ?? '',
      timeOfDay: ref.timeOfDay ?? '',
      sourceText: ref.sourceText ?? '',
    },
  });
  // 新场景开启一条新 lineage，以自身 id 为锚点（cuid 由库生成，故只能建后回填）——
  // 规则与 Shot.lineageId 完全一致
  await tx.scene.update({ where: { id: scene.id }, data: { lineageId: scene.id } });
  cache.set(ref.sceneKey, scene.id);
  return scene.id;
}

/**
 * 把基底版本的一条 Scene 复制到新版本，返回新 Scene id。
 * 同一条基底 Scene 只复制一次（它名下的多个镜头共享这条新行）。
 * estimatedDurationMs 不在这里带过来：镜头可能被 update/remove，时长要按新版本实际镜头重算。
 */
async function copyScene(
  tx: Prisma.TransactionClient,
  storyboardId: string,
  base: PrismaScene,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(base.id);
  if (cached) return cached;
  const created = await tx.scene.create({
    data: {
      storyboardId,
      sortOrder: base.sortOrder,
      title: base.title,
      location: base.location,
      interiorExterior: base.interiorExterior,
      timeOfDay: base.timeOfDay,
      sourceText: base.sourceText,
      status: base.status,
      // 继承基底的 lineage；基底是 lineageId 引入前的存量行时以其自身 id 开锚
      lineageId: base.lineageId ?? base.id,
    },
  });
  // 存量基底行顺手开锚：否则新行指向的 lineage 里查不到基底自己，跨版本追溯会断在这一代
  if (!base.lineageId) {
    await tx.scene.update({ where: { id: base.id }, data: { lineageId: base.id } });
  }
  cache.set(base.id, created.id);
  return created.id;
}

/** 预收集 patch 里全部标签输入（含 dialogue 的 speaker，按 CHARACTER 解析），一次性 findOrCreate */
/**
 * 旁白不是角色：它没有形象、不需要设计图、也不该驱动口型。
 * 提示词里已要求模型把旁白写成 isNarrator，但模型并不总听话（AI 生成的剧本必然含「旁白：」行），
 * 故在入库前硬兜底——一旦建出名为「旁白」的角色标签，后续设计/绑定/口型全会跟着错。
 */
const NARRATOR_NAMES = new Set(['旁白', '旁白音', '画外音', 'narrator', 'Narrator', 'NARRATOR']);

export function isNarratorName(name: string): boolean {
  return NARRATOR_NAMES.has(name.trim());
}

async function resolveAllTags(
  patch: StoryboardPatch,
  resolveTags: ResolveTagsFn,
): Promise<Map<string, Tag>> {
  const inputs: Array<{ name: string; type: TagType }> = [];
  const collect = (tags: Array<{ name: string; type: TagType }>, dialogue: ShotDialogueInput[]) => {
    inputs.push(...tags.filter((t) => !(t.type === 'CHARACTER' && isNarratorName(t.name))));
    for (const d of dialogue) {
      if (d.speaker && !isNarratorName(d.speaker)) {
        inputs.push({ name: d.speaker, type: 'CHARACTER' });
      }
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
    // 旁白在 resolveAllTags 已被剔除，这里同步跳过（不是解析失败）
    if (t.type === 'CHARACTER' && isNarratorName(t.name)) continue;
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
  return dialogue.map((d, i) => {
    // speaker 写成「旁白」的行按旁白处理，绝不挂角色标签（模型常把旁白当角色写）
    const narrator = d.isNarrator || !d.speaker || isNarratorName(d.speaker);
    return {
      speakerTagId: narrator || !d.speaker ? null : (tagByName.get(d.speaker)?.id ?? null),
      // 协议约定：speaker 缺省且 isNarrator=false 时按旁白处理
      isNarrator: narrator,
      text: d.text,
      sortOrder: i,
    };
  });
}
