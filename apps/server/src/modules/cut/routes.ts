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

/**
 * 音轨模式：SMART（默认）= 有配音的镜头以配音替换视频原声，无配音镜头保留原声；
 * DUCK = 有配音镜头原声压低到 25% 与配音混合；MIX = 原声与配音等响叠加（旧行为）。
 */
const AudioMixModeSchema = z.enum(['SMART', 'DUCK', 'MIX']);
/** AUTO = 画布跟随首个片段的实际分辨率（默认）；显式比例强制统一画布 */
const CutRatioSchema = z.enum(['AUTO', '9:16', '16:9', '1:1', '3:4', '4:3']);
const CreateCutBodySchema = z.object({
  storyboardId: z.string().min(1),
  audioMixMode: AudioMixModeSchema.default('SMART'),
  ratio: CutRatioSchema.default('AUTO'),
});

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
      inputPayload: { cutId: created.id, audioMixMode: body.audioMixMode, ratio: body.ratio },
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
