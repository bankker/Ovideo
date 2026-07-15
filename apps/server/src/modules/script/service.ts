import type { PrismaClient, ScriptDraft } from '@prisma/client';
import { notFound } from '../../lib/errors.js';

/** 失效传播钩子（集成阶段注入 stale 模块的 onScriptDraftChanged） */
export interface ScriptHooks {
  onScriptDraftChanged?: (db: PrismaClient, scriptDraftId: string) => Promise<void>;
}

export async function listDrafts(db: PrismaClient, episodeId: string): Promise<ScriptDraft[]> {
  const episode = await db.episode.findUnique({ where: { id: episodeId } });
  if (!episode) throw notFound('分集');
  return db.scriptDraft.findMany({
    where: { episodeId },
    orderBy: [{ isMain: 'desc' }, { createdAt: 'asc' }],
  });
}

export async function createDraft(
  db: PrismaClient,
  episodeId: string,
  input: { title: string; content: string },
): Promise<ScriptDraft> {
  const episode = await db.episode.findUnique({ where: { id: episodeId } });
  if (!episode) throw notFound('分集');
  const count = await db.scriptDraft.count({ where: { episodeId } });
  // 本集第一稿自动成为主剧本（每集恰一个 isMain）
  return db.scriptDraft.create({ data: { episodeId, ...input, isMain: count === 0 } });
}

export async function updateDraft(
  db: PrismaClient,
  id: string,
  input: { title?: string; content?: string; setMain?: boolean },
  hooks?: ScriptHooks,
): Promise<ScriptDraft> {
  const draft = await db.scriptDraft.findUnique({ where: { id } });
  if (!draft) throw notFound('剧本稿');
  const contentChanged = input.content !== undefined && input.content !== draft.content;

  const updated = await db.$transaction(async (tx) => {
    if (input.setMain) {
      // 先清后设，保证"每集恰一个主剧本"
      await tx.scriptDraft.updateMany({
        where: { episodeId: draft.episodeId, isMain: true },
        data: { isMain: false },
      });
    }
    return tx.scriptDraft.update({
      where: { id },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.content !== undefined && { content: input.content }),
        ...(input.setMain && { isMain: true }),
      },
    });
  });

  if (contentChanged) await hooks?.onScriptDraftChanged?.(db, id);
  return updated;
}
