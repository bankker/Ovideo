// 单段增强路由（M3-lite，v2 §3.10）：POST /api/shots/:id/enhance → 入队 UPSCALE / INTERPOLATE 任务。
import type { FastifyPluginAsync } from 'fastify';
import type { Job, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { badRequest, notFound } from '../../lib/errors.js';
import type { EnqueueJobInput } from '../job/service.js';

const EnhanceBodySchema = z.object({
  kind: z.enum(['upscale', 'interpolate']),
});

export interface EnhanceRoutesOptions {
  db: PrismaClient;
  /** 入队函数（集成阶段注入 job 模块 enqueueJob 绑定 db 的偏函数） */
  enqueue: (input: EnqueueJobInput) => Promise<Job>;
}

export const enhanceRoutes: FastifyPluginAsync<EnhanceRoutesOptions> = async (app, opts) => {
  const { db, enqueue } = opts;

  app.post<{ Params: { id: string } }>('/api/shots/:id/enhance', async (req, reply) => {
    const { kind } = EnhanceBodySchema.parse(req.body ?? {});
    const shot = await db.shot.findUnique({
      where: { id: req.params.id },
      include: { storyboard: { include: { episode: true } } },
    });
    if (!shot) throw notFound('镜头');
    // 提前拦截（执行器内还会兜底校验）：无选定视频时入队只会必然失败
    if (!shot.videoSelectedTakeId) throw badRequest('请先生成并选定视频片段');

    const job = await enqueue({
      projectId: shot.storyboard.episode.projectId,
      type: kind === 'upscale' ? 'UPSCALE' : 'INTERPOLATE',
      // 本地 FFmpeg 增强挂在 MOCK 执行器类别下；接入 GPU 集群后换 'GPU'
      executor: 'LOCAL',
      inputPayload: { shotId: shot.id },
    });
    reply.code(202);
    return job;
  });
};
