// 关键图自动收敛 agent 的 HTTP 入口。
// 【默认不改变现有交互】分镜页原有「生成关键图/重抽」按钮行为一字未动，
// 这里是并列的新入口 —— 用户想让 agent 自己收敛时才走这条路。
import type { FastifyPluginAsync } from 'fastify';
import type { Job, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { badRequest, notFound } from '../../lib/errors.js';
import type { EnqueueJobInput } from '../job/service.js';
import {
  createAgentRun,
  findRunningRun,
  listAgentRuns,
  MAX_ROUNDS_HARD_LIMIT,
} from './service.js';

const ConvergeBodySchema = z.object({
  /** 成本闸门：最大轮次默认 3、硬上限 5（一轮 = 一次真实生图 + 一次视觉评审） */
  maxRounds: z.number().int().min(1).max(MAX_ROUNDS_HARD_LIMIT).optional(),
  modelConfigId: z.string().optional(),
  visionModelConfigId: z.string().optional(),
});

export interface AgentRoutesOptions {
  db: PrismaClient;
  /** 入队函数（集成阶段注入 job 模块的 enqueueJob 偏函数，与 generation 模块同款） */
  enqueue: (input: EnqueueJobInput) => Promise<Job>;
}

export const agentRoutes: FastifyPluginAsync<AgentRoutesOptions> = async (app, opts) => {
  const { db, enqueue } = opts;

  app.post<{ Params: { id: string } }>('/api/shots/:id/agent/keyframe-converge', async (req, reply) => {
    const body = ConvergeBodySchema.parse(req.body ?? {});
    const shot = await db.shot.findUnique({
      where: { id: req.params.id },
      include: { storyboard: { include: { episode: true } } },
    });
    if (!shot) throw notFound('镜头');

    // 同一镜头并发跑两个收敛毫无意义（互相抢选定指针），且平白翻倍烧钱
    const running = await findRunningRun(db, shot.id);
    if (running) throw badRequest('该镜头已有正在运行的自动收敛任务');

    const projectId = shot.storyboard.episode.projectId;
    const run = await createAgentRun(db, { projectId, shotId: shot.id, maxRounds: body.maxRounds });
    let job: Job;
    try {
      job = await enqueue({
        projectId,
        type: 'AGENT_KEYFRAME_CONVERGE',
        executor: 'API',
        // 不重试：每一轮都在真花生图的钱，失败重跑会翻倍消耗；
        // 要再来一次由人显式点按钮（服务层另有幂等守卫兜底）
        maxAttempts: 1,
        inputPayload: {
          runId: run.id,
          modelConfigId: body.modelConfigId,
          visionModelConfigId: body.visionModelConfigId,
        },
      });
    } catch (err) {
      // 入队失败若不收尾，这条 RUNNING 记录会永久占位、堵死该镜头后续所有发起
      await db.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          error: `任务入队失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 1000),
          finishedAt: new Date(),
        },
      });
      throw err;
    }

    const updated = await db.agentRun.update({ where: { id: run.id }, data: { jobId: job.id } });
    reply.code(202);
    return { run: updated, job };
  });

  app.get<{ Params: { id: string } }>('/api/shots/:id/agent-runs', async (req) => {
    const shot = await db.shot.findUnique({ where: { id: req.params.id } });
    if (!shot) throw notFound('镜头');
    // roundsJson 原样回字符串：前端按 AgentRound[] 自行解析（与其他 *Json 字段一致）
    return { runs: await listAgentRuns(db, shot.id) };
  });
};
