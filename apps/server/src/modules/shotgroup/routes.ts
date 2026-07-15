// ShotGroup 衔接组路由（v2 §5）：拆分超长镜头 + 组链视图查询。
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { listGroups, splitShotIntoGroup, type SplitGroupHooks } from './service.js';

const SplitGroupBodySchema = z.object({
  maxSegmentMs: z.number().int().positive().optional(),
});

export interface ShotGroupRoutesOptions {
  db: PrismaClient;
  /** 拆分完成钩子（集成阶段按需注入） */
  hooks?: SplitGroupHooks;
}

export const shotGroupRoutes: FastifyPluginAsync<ShotGroupRoutesOptions> = async (app, opts) => {
  const { db } = opts;

  // 把超长镜头拆为衔接组 → 产生新 Storyboard 版本
  app.post('/api/shots/:id/split-group', async (req) => {
    const { id } = req.params as { id: string };
    const body = SplitGroupBodySchema.parse(req.body ?? {});
    return splitShotIntoGroup(db, { shotId: id, maxSegmentMs: body.maxSegmentMs }, opts.hooks);
  });

  // 某分镜版本的全部衔接组（前端渲染链视图用）
  app.get('/api/storyboards/:id/groups', async (req) => {
    const { id } = req.params as { id: string };
    return { groups: await listGroups(db, id) };
  });
};
