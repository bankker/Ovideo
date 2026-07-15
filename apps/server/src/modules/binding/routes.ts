import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { PutBindingBodySchema } from '@ovideo/shared';
import { notFound } from '../../lib/errors.js';
import { listBindings, setBinding, type BindingHooks } from './service.js';

export interface BindingRoutesOptions {
  db: PrismaClient;
  /** 失效传播钩子由集成阶段注入（本模块不 import stale 模块） */
  hooks?: BindingHooks;
}

export const bindingRoutes: FastifyPluginAsync<BindingRoutesOptions> = async (
  app,
  { db, hooks },
) => {
  app.get('/api/episodes/:id/bindings', async (req) => {
    const { id } = req.params as { id: string };
    const episode = await db.episode.findUnique({ where: { id } });
    if (!episode) throw notFound('分集');
    return listBindings(db, id);
  });

  app.put('/api/episodes/:id/bindings', async (req) => {
    const { id } = req.params as { id: string };
    const body = PutBindingBodySchema.parse(req.body);
    const binding = await setBinding(
      db,
      { episodeId: id, tagId: body.tagId, shotId: body.shotId, assetId: body.assetId },
      hooks,
    );
    return { binding };
  });
};
