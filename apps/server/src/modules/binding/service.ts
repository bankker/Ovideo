import type { Binding, PrismaClient } from '@prisma/client';
import { notFound } from '../../lib/errors.js';

/**
 * 绑定变更钩子：由集成阶段注入失效传播模块的 onBindingChanged（v2 §2.2），
 * 本模块只定义类型、不 import stale 模块。
 */
export type OnBindingChanged = (
  db: PrismaClient,
  episodeId: string,
  tagId: string,
  shotId?: string,
) => Promise<void>;

export interface BindingHooks {
  onBindingChanged?: OnBindingChanged;
}

export interface SetBindingInput {
  episodeId: string;
  tagId: string;
  /** null = 标签级默认；非 null = 镜头级覆盖 */
  shotId: string | null;
  /** null = 删除该绑定行 */
  assetId: string | null;
}

/**
 * 写绑定：唯一键 (episodeId, tagId, shotKey)，shotKey = shotId ?? ''
 * （SQLite 唯一索引把 NULL 视为互不相同，哨兵值保证标签级默认只有一行；shotKey 由本服务维护）。
 */
export async function setBinding(
  db: PrismaClient,
  input: SetBindingInput,
  hooks: BindingHooks = {},
): Promise<Binding | null> {
  const { episodeId, tagId, shotId, assetId } = input;
  const shotKey = shotId ?? '';

  const episode = await db.episode.findUnique({ where: { id: episodeId } });
  if (!episode) throw notFound('分集');
  const tag = await db.tag.findUnique({ where: { id: tagId } });
  if (!tag) throw notFound('标签');
  if (shotId !== null) {
    const shot = await db.shot.findUnique({ where: { id: shotId } });
    if (!shot) throw notFound('镜头');
  }

  if (assetId === null) {
    const { count } = await db.binding.deleteMany({ where: { episodeId, tagId, shotKey } });
    // 行本就不存在的删除是空操作，不触发失效传播
    if (count > 0) await hooks.onBindingChanged?.(db, episodeId, tagId, shotId ?? undefined);
    return null;
  }

  const asset = await db.asset.findUnique({ where: { id: assetId } });
  if (!asset) throw notFound('资产');
  const binding = await db.binding.upsert({
    where: { episodeId_tagId_shotKey: { episodeId, tagId, shotKey } },
    update: { assetId },
    create: { episodeId, tagId, shotId, shotKey, assetId },
  });
  await hooks.onBindingChanged?.(db, episodeId, tagId, shotId ?? undefined);
  return binding;
}

export async function listBindings(db: PrismaClient, episodeId: string): Promise<Binding[]> {
  return db.binding.findMany({ where: { episodeId }, orderBy: { updatedAt: 'desc' } });
}

/**
 * 执行时实时解析（修旧系统 Bug6：禁止任务创建时快照绑定）：
 * 镜头级覆盖 > 标签级默认，均无返回 null。
 */
export async function resolveBinding(
  db: PrismaClient,
  episodeId: string,
  tagId: string,
  shotId: string,
): Promise<string | null> {
  const shotLevel = await db.binding.findUnique({
    where: { episodeId_tagId_shotKey: { episodeId, tagId, shotKey: shotId } },
  });
  if (shotLevel) return shotLevel.assetId;
  const tagLevel = await db.binding.findUnique({
    where: { episodeId_tagId_shotKey: { episodeId, tagId, shotKey: '' } },
  });
  return tagLevel?.assetId ?? null;
}
