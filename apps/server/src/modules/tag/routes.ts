import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { CreateTagBodySchema, UpdateTagBodySchema } from '@ovideo/shared';
import { notFound } from '../../lib/errors.js';
import { createTag, listTags, updateTag } from './service.js';

export interface TagRoutesOptions {
  db: PrismaClient;
}

export const tagRoutes: FastifyPluginAsync<TagRoutesOptions> = async (app, { db }) => {
  app.get('/api/projects/:id/tags', async (req) => {
    const { id } = req.params as { id: string };
    const project = await db.project.findUnique({ where: { id } });
    if (!project) throw notFound('项目');
    return listTags(db, id);
  });

  app.post('/api/projects/:id/tags', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CreateTagBodySchema.parse(req.body);
    const project = await db.project.findUnique({ where: { id } });
    if (!project) throw notFound('项目');
    reply.code(201);
    return createTag(db, id, body);
  });

  app.patch('/api/tags/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = UpdateTagBodySchema.parse(req.body ?? {});
    return updateTag(db, id, body);
  });
};
