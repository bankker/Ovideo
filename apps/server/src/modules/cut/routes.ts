// Cut 成片路由：创建（快照 + 入队 COMPOSE_CUT）/ 列表 / 详情。
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JobExecutorKind, JobType } from '@ovideo/shared';
import { z } from 'zod';
import { notFound } from '../../lib/errors.js';
import { createCut, getCut, listCuts } from './service.js';

/** 任务入队函数：由集成阶段注入 job 模块的 enqueueJob，保持模块解耦 */
export type EnqueueFn = (input: {
  projectId: string;
  type: JobType;
  executor: JobExecutorKind;
  inputPayload: Record<string, unknown>;
}) => Promise<unknown>;

export interface CutRoutesOptions {
  db: PrismaClient;
  enqueue: EnqueueFn;
}

const CreateCutBodySchema = z.object({ storyboardId: z.string().min(1) });

export const cutRoutes: FastifyPluginAsync<CutRoutesOptions> = async (app, { db, enqueue }) => {
  // 创建成片并入队合成任务（合成免费，一律 MOCK 执行器 = 本机 ffmpeg）
  app.post('/api/episodes/:id/cuts', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CreateCutBodySchema.parse(req.body ?? {});
    const episode = await db.episode.findUnique({ where: { id } });
    if (!episode) throw notFound('分集');

    const created = await createCut(db, { episodeId: id, storyboardId: body.storyboardId });
    const job = await enqueue({
      projectId: episode.projectId,
      type: 'COMPOSE_CUT',
      executor: 'LOCAL',
      inputPayload: { cutId: created.id },
    });
    reply.code(202);
    return { cut: await getCut(db, created.id), job };
  });

  app.get('/api/episodes/:id/cuts', async (req) => {
    const { id } = req.params as { id: string };
    return listCuts(db, id);
  });

  app.get('/api/cuts/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getCut(db, id);
  });
};
