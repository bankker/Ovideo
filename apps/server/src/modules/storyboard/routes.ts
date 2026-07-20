import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient, Tag } from '@prisma/client';
import type { TagType } from '@ovideo/shared';
import { ApplyPatchBodySchema } from '@ovideo/shared';
import { notFound } from '../../lib/errors.js';
import { findOrCreateTags } from '../tag/service.js';
import { applyPatch, storyboardDetailInclude, type ApplyPatchHooks } from './service.js';

export interface StoryboardRoutesOptions {
  db: PrismaClient;
  /** 失效传播钩子（集成阶段注入 stale 模块实现） */
  hooks?: ApplyPatchHooks;
  /** 标签解析；缺省用同组 tag/service 的 findOrCreateTags */
  resolveTags?: (
    projectId: string,
    tags: Array<{ name: string; type: TagType }>,
  ) => Promise<Tag[]>;
}

export const storyboardRoutes: FastifyPluginAsync<StoryboardRoutesOptions> = async (app, opts) => {
  const { db } = opts;
  const resolveTags =
    opts.resolveTags ??
    ((projectId: string, tags: Array<{ name: string; type: TagType }>) =>
      findOrCreateTags(db, projectId, tags));

  app.get('/api/episodes/:id/storyboards', async (req) => {
    const { id } = req.params as { id: string };
    const episode = await db.episode.findUnique({ where: { id } });
    if (!episode) throw notFound('分集');
    const list = await db.storyboard.findMany({
      where: { episodeId: id },
      orderBy: { version: 'desc' },
      include: { _count: { select: { shots: true } } },
    });
    return list.map(({ _count, ...sb }) => ({ ...sb, shotCount: _count.shots }));
  });

  app.get('/api/storyboards/:id', async (req) => {
    const { id } = req.params as { id: string };
    const storyboard = await db.storyboard.findUnique({
      where: { id },
      include: storyboardDetailInclude,
    });
    if (!storyboard) throw notFound('分镜');
    return storyboard;
  });

  app.post('/api/storyboards/:id/apply-patch', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ApplyPatchBodySchema.parse(req.body);
    const storyboard = await db.storyboard.findUnique({
      where: { id },
      include: { episode: true },
    });
    if (!storyboard) throw notFound('分镜');
    const result = await applyPatch(
      db,
      {
        episodeId: storyboard.episodeId,
        scriptDraftId: storyboard.scriptDraftId,
        baseStoryboardId: storyboard.id,
        patch: body.patch,
        source: body.source,
        resolveTags: (tags) => resolveTags(storyboard.episode.projectId, tags),
      },
      opts.hooks,
    );
    reply.code(201);
    return result;
  });
};
