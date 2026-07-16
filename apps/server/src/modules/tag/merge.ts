// 标签合并：把"语义相同但被拆成多个"的标签归并为一个（如「同一办公室，明亮清新。」→「办公室」）。
// 所有引用（镜头标签/绑定/设计图/对白说话人/角色声音）重指到目标标签，源标签删除。
// 付费产物零删除：设计图资产全部保留（只动关联行）。
import type { PrismaClient, Tag } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';

export interface MergeResult {
  target: Tag;
  moved: {
    shotTags: number;
    bindings: number;
    designs: number;
    dialogueSpeakers: number;
    voiceProfiles: number;
    /** 提示词中 @旧名 → @新名 的镜头数（跨全部分镜版本，@ 是标识符引用，随名而动） */
    promptRewrites: number;
  };
}

/**
 * 项目内全部镜头的提示词提及重写：@旧名/@!旧名 → @新名/@!新名。
 * 提示词里的 @名字 是对标签的标识符引用，合并/重命名后必须跟着改，否则生成时报"标签不存在"。
 */
export async function rewritePromptMentions(
  db: Parameters<typeof mergeTags>[0] | PrismaClient,
  projectId: string,
  oldName: string,
  newName: string,
): Promise<number> {
  if (oldName === newName) return 0;
  const shots = await (db as PrismaClient).shot.findMany({
    where: {
      storyboard: { episode: { projectId } },
      OR: [{ imagePrompt: { contains: `@${oldName}` } }, { videoPrompt: { contains: `@${oldName}` } }],
    },
  });
  let rewrites = 0;
  for (const shot of shots) {
    const imagePrompt = shot.imagePrompt.replaceAll(`@!${oldName}`, `@!${newName}`).replaceAll(`@${oldName}`, `@${newName}`);
    const videoPrompt = shot.videoPrompt.replaceAll(`@!${oldName}`, `@!${newName}`).replaceAll(`@${oldName}`, `@${newName}`);
    if (imagePrompt !== shot.imagePrompt || videoPrompt !== shot.videoPrompt) {
      await (db as PrismaClient).shot.update({ where: { id: shot.id }, data: { imagePrompt, videoPrompt } });
      rewrites += 1;
    }
  }
  return rewrites;
}

export async function mergeTags(
  db: PrismaClient,
  sourceTagId: string,
  targetTagId: string,
): Promise<MergeResult> {
  if (sourceTagId === targetTagId) throw badRequest('不能把标签合并到自身');
  const [source, target] = await Promise.all([
    db.tag.findUnique({ where: { id: sourceTagId } }),
    db.tag.findUnique({ where: { id: targetTagId } }),
  ]);
  if (!source) throw notFound('源标签');
  if (!target) throw notFound('目标标签');
  if (source.projectId !== target.projectId) throw badRequest('只能合并同一项目内的标签');
  if (source.type !== target.type) {
    throw badRequest(`类型不同不能合并（源是${source.type}，目标是${target.type}）`);
  }

  return db.$transaction(async (tx) => {
    // 1) ShotTag（主键 shotId+tagId）：目标已在同一镜头上的删源，否则重指
    const srcShotTags = await tx.shotTag.findMany({ where: { tagId: sourceTagId } });
    let shotTags = 0;
    for (const st of srcShotTags) {
      const dup = await tx.shotTag.findUnique({
        where: { shotId_tagId: { shotId: st.shotId, tagId: targetTagId } },
      });
      if (dup) {
        await tx.shotTag.delete({ where: { shotId_tagId: { shotId: st.shotId, tagId: sourceTagId } } });
      } else {
        await tx.shotTag.update({
          where: { shotId_tagId: { shotId: st.shotId, tagId: sourceTagId } },
          data: { tagId: targetTagId },
        });
        shotTags += 1;
      }
    }

    // 2) Binding（唯一 episodeId+tagId+shotKey）：目标同键位已有绑定的，保留目标、删源
    const srcBindings = await tx.binding.findMany({ where: { tagId: sourceTagId } });
    let bindings = 0;
    for (const b of srcBindings) {
      const dup = await tx.binding.findUnique({
        where: {
          episodeId_tagId_shotKey: { episodeId: b.episodeId, tagId: targetTagId, shotKey: b.shotKey },
        },
      });
      if (dup) {
        await tx.binding.delete({ where: { id: b.id } });
      } else {
        await tx.binding.update({ where: { id: b.id }, data: { tagId: targetTagId } });
        bindings += 1;
      }
    }

    // 3) TagDesign（唯一 tagId+assetId）：同资产已在目标名下的删源关联（资产本体不动）
    const srcDesigns = await tx.tagDesign.findMany({ where: { tagId: sourceTagId } });
    let designs = 0;
    for (const d of srcDesigns) {
      const dup = await tx.tagDesign.findUnique({
        where: { tagId_assetId: { tagId: targetTagId, assetId: d.assetId } },
      });
      if (dup) {
        await tx.tagDesign.delete({ where: { id: d.id } });
      } else {
        await tx.tagDesign.update({ where: { id: d.id }, data: { tagId: targetTagId } });
        designs += 1;
      }
    }

    // 4) 对白说话人与角色声音：直接重指
    const { count: dialogueSpeakers } = await tx.dialogueLine.updateMany({
      where: { speakerTagId: sourceTagId },
      data: { speakerTagId: targetTagId },
    });
    const { count: voiceProfiles } = await tx.voiceProfile.updateMany({
      where: { tagId: sourceTagId },
      data: { tagId: targetTagId },
    });

    // 5) 默认设计图与描述：目标缺失时继承源的（不覆盖目标已有内容）
    const inherit: { canonicalAssetId?: string; description?: string } = {};
    if (!target.canonicalAssetId && source.canonicalAssetId) {
      inherit.canonicalAssetId = source.canonicalAssetId;
    }
    if (!target.description && source.description) inherit.description = source.description;
    const finalTarget =
      Object.keys(inherit).length > 0
        ? await tx.tag.update({ where: { id: targetTagId }, data: inherit })
        : target;

    // 6) 提示词中的 @源名 全部改写为 @目标名（标识符引用随名而动）
    const promptRewrites = await rewritePromptMentions(
      tx as unknown as PrismaClient,
      source.projectId,
      source.name,
      finalTarget.name,
    );

    // 7) 删除源标签（引用已清空，无级联损失）
    await tx.tag.delete({ where: { id: sourceTagId } });

    return {
      target: finalTarget,
      moved: { shotTags, bindings, designs, dialogueSpeakers, voiceProfiles, promptRewrites },
    };
  });
}
