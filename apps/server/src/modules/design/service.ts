import type { Asset, PrismaClient, Tag, TagDesign } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';

/** 缺省组装 prompt 的最大长度（超长描述截断，避免撑爆图像模型输入） */
export const DESIGN_PROMPT_MAX = 500;

/**
 * 组装设计图生成 prompt：
 * - 自定义 prompt（去首尾空白后非空）优先；
 * - 缺省用「标签名，描述」；描述为空时只用标签名（不留孤立分隔符）；
 * - 统一截断到 DESIGN_PROMPT_MAX。
 */
export function buildDesignPrompt(
  tag: { name: string; description: string },
  custom?: string,
): string {
  const trimmed = custom?.trim();
  const raw = trimmed ? trimmed : tag.description ? `${tag.name}，${tag.description}` : tag.name;
  return raw.length > DESIGN_PROMPT_MAX ? raw.slice(0, DESIGN_PROMPT_MAX) : raw;
}

export type TagDesignWithAsset = TagDesign & { asset: Asset };

/** 标签的候选设计图列表（含资产实体），新的在前 */
export async function listDesigns(
  db: PrismaClient,
  tagId: string,
): Promise<{ tag: Tag; designs: TagDesignWithAsset[] }> {
  const tag = await db.tag.findUnique({ where: { id: tagId } });
  if (!tag) throw notFound('标签');
  const designs = await db.tagDesign.findMany({
    where: { tagId },
    include: { asset: true },
    // id 作 tiebreaker：同毫秒创建时排序仍稳定
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return { tag, designs };
}

/**
 * 把资产挂到标签的候选设计图列表。
 * 若该标签尚无 canonicalAssetId 则自动设为 canonical（首图即默认参考）。
 */
export async function attachDesign(
  db: PrismaClient,
  tagId: string,
  assetId: string,
): Promise<{ design: TagDesign; tag: Tag }> {
  const tag = await db.tag.findUnique({ where: { id: tagId } });
  if (!tag) throw notFound('标签');
  const asset = await db.asset.findUnique({ where: { id: assetId } });
  if (!asset || asset.projectId !== tag.projectId) {
    throw badRequest('assetId 对应的资产不存在或不属于该项目');
  }
  const dup = await db.tagDesign.findUnique({
    where: { tagId_assetId: { tagId, assetId } },
  });
  if (dup) throw badRequest('该资产已是该标签的候选设计图');

  return db.$transaction(async (tx) => {
    const design = await tx.tagDesign.create({ data: { tagId, assetId } });
    let updatedTag = tag;
    if (!tag.canonicalAssetId) {
      updatedTag = await tx.tag.update({ where: { id: tagId }, data: { canonicalAssetId: assetId } });
    }
    return { design, tag: updatedTag };
  });
}

/** 设为默认参考图：assetId 必须已在该标签的候选设计图中 */
export async function setCanonical(db: PrismaClient, tagId: string, assetId: string): Promise<Tag> {
  const tag = await db.tag.findUnique({ where: { id: tagId } });
  if (!tag) throw notFound('标签');
  const design = await db.tagDesign.findUnique({
    where: { tagId_assetId: { tagId, assetId } },
  });
  if (!design) throw badRequest('该资产不是该标签的候选设计图，不能设为默认参考');
  return db.tag.update({ where: { id: tagId }, data: { canonicalAssetId: assetId } });
}

/**
 * 解除候选关联：只删 TagDesign 行，资产本体不动（付费产物从不物理删除）。
 * 若被解除的恰是 canonical，则清空 canonicalAssetId。返回标签最新状态。
 */
export async function removeDesign(db: PrismaClient, designId: string): Promise<Tag> {
  const design = await db.tagDesign.findUnique({
    where: { id: designId },
    include: { tag: true },
  });
  if (!design) throw notFound('设计图');
  return db.$transaction(async (tx) => {
    await tx.tagDesign.delete({ where: { id: designId } });
    if (design.tag.canonicalAssetId === design.assetId) {
      return tx.tag.update({ where: { id: design.tagId }, data: { canonicalAssetId: null } });
    }
    return design.tag;
  });
}
