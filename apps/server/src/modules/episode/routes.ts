import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { CreateEpisodeBodySchema, UpdateEpisodeBodySchema } from '@ovideo/shared';
import { notFound } from '../../lib/errors.js';

export interface EpisodeRoutesOptions {
  db: PrismaClient;
}

export const episodeRoutes: FastifyPluginAsync<EpisodeRoutesOptions> = async (app, { db }) => {
  app.get('/api/projects/:id/episodes', async (req) => {
    const { id } = req.params as { id: string };
    const project = await db.project.findUnique({ where: { id } });
    if (!project) throw notFound('项目');
    return db.episode.findMany({
      where: { projectId: id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  });

  app.post('/api/projects/:id/episodes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CreateEpisodeBodySchema.parse(req.body);
    const project = await db.project.findUnique({ where: { id } });
    if (!project) throw notFound('项目');
    const max = await db.episode.aggregate({ where: { projectId: id }, _max: { sortOrder: true } });
    reply.code(201);
    return db.episode.create({
      data: { projectId: id, title: body.title, sortOrder: (max._max.sortOrder ?? 0) + 1 },
    });
  });

  app.patch('/api/episodes/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = UpdateEpisodeBodySchema.parse(req.body ?? {});
    const episode = await db.episode.findUnique({ where: { id } });
    if (!episode) throw notFound('分集');
    return db.episode.update({
      where: { id },
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
      },
    });
  });

  app.delete('/api/episodes/:id', async (req) => {
    const { id } = req.params as { id: string };
    const episode = await db.episode.findUnique({ where: { id } });
    if (!episode) throw notFound('分集');
    await db.episode.delete({ where: { id } });
    return { ok: true };
  });
};
