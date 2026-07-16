import type { PrismaClient, Tag } from '@prisma/client';
import type { TagType } from '@ovideo/shared';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { rewritePromptMentions } from './merge.js';

export async function listTags(db: PrismaClient, projectId: string): Promise<Tag[]> {
  return db.tag.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
}

export async function createTag(
  db: PrismaClient,
  projectId: string,
  input: { type: TagType; name: string; description: string },
): Promise<Tag> {
  const dup = await db.tag.findUnique({
    where: { projectId_name: { projectId, name: input.name } },
  });
  if (dup) throw conflict(`标签「${input.name}」已存在`);
  return db.tag.create({ data: { projectId, ...input } });
}

export async function updateTag(
  db: PrismaClient,
  id: string,
  input: { name?: string; description?: string; canonicalAssetId?: string | null },
): Promise<Tag> {
  const tag = await db.tag.findUnique({ where: { id } });
  if (!tag) throw notFound('标签');
  if (input.name !== undefined && input.name !== tag.name) {
    const dup = await db.tag.findUnique({
      where: { projectId_name: { projectId: tag.projectId, name: input.name } },
    });
    if (dup) throw conflict(`标签「${input.name}」已存在`);
  }
  if (typeof input.canonicalAssetId === 'string') {
    const asset = await db.asset.findUnique({ where: { id: input.canonicalAssetId } });
    if (!asset || asset.projectId !== tag.projectId) {
      throw badRequest('canonicalAssetId 对应的资产不存在或不属于该项目');
    }
  }
  const updated = await db.tag.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      // canonicalAssetId 允许显式置 null（清除默认设计图）
      ...(input.canonicalAssetId !== undefined && { canonicalAssetId: input.canonicalAssetId }),
    },
  });
  // 重命名时把提示词里的 @旧名 全部改写为 @新名（@ 是标识符引用，随名而动）
  if (input.name !== undefined && input.name !== tag.name) {
    await rewritePromptMentions(db, tag.projectId, tag.name, input.name);
  }
  return updated;
}

/**
 * 按名字批量复用/新建标签（storyboard patch 的标签解析入口）。
 * 名字是项目内唯一键：同名标签一律复用（即使入参 type 不同——一致性锚点以库内为准）。
 * 返回顺序 = 入参去重后的顺序。
 */
export async function findOrCreateTags(
  db: PrismaClient,
  projectId: string,
  tags: Array<{ name: string; type: TagType }>,
): Promise<Tag[]> {
  const unique = new Map<string, TagType>();
  for (const t of tags) {
    if (!unique.has(t.name)) unique.set(t.name, t.type);
  }
  if (unique.size === 0) return [];
  const names = [...unique.keys()];
  const existing = await db.tag.findMany({ where: { projectId, name: { in: names } } });
  const byName = new Map(existing.map((t) => [t.name, t]));
  for (const [name, type] of unique) {
    if (!byName.has(name)) {
      const created = await db.tag.create({ data: { projectId, name, type } });
      byName.set(name, created);
    }
  }
  return names.map((n) => byName.get(n) as Tag);
}
