// Dubbing 配音路由（M2）。依赖全部经 options 注入：db + enqueue（job 模块的入队函数）。
// 跨模块契约：TTS Job 的 inputPayload = { kind: 'dubbing', dubbingLineId }，由 generation 执行器消费。
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { JobExecutorKind, JobType } from '@ovideo/shared';
import { notFound } from '../../lib/errors.js';
import { listDubbingLines, syncDubbingLines, updateDubbingLine } from './service.js';

/** 任务入队函数：由集成阶段注入 job 模块的 enqueueJob，保持模块解耦 */
export type EnqueueFn = (input: {
  projectId: string;
  type: JobType;
  executor: JobExecutorKind;
  inputPayload: Record<string, unknown>;
  batchId?: string;
}) => Promise<unknown>;

const PatchDubbingLineBodySchema = z.object({
  speed: z.number().min(0.5).max(2).optional(),
  text: z.string().min(1).optional(),
});

const GenerateDubbingBodySchema = z.object({
  /** 入队前顺手更新语速（S1 路由表 body { speed? }） */
  speed: z.number().min(0.5).max(2).optional(),
  /** 指定语音模型；缺省走按需调度（tts 队首真实模型） */
  modelConfigId: z.string().optional(),
});

const GenerateAllDubbingBodySchema = z.object({
  modelConfigId: z.string().optional(),
});

export interface DubbingRoutesOptions {
  db: PrismaClient;
  enqueue: EnqueueFn;
}

export const dubbingRoutes: FastifyPluginAsync<DubbingRoutesOptions> = async (
  app,
  { db, enqueue },
) => {
  // 幂等同步：为该镜头每条对白建配音行（已同步的跳过），返回全部行
  app.post('/api/shots/:id/sync-dubbing', async (req) => {
    const { id } = req.params as { id: string };
    return syncDubbingLines(db, id);
  });

  app.get('/api/shots/:id/dubbing', async (req) => {
    const { id } = req.params as { id: string };
    return listDubbingLines(db, id);
  });

  app.patch('/api/dubbing-lines/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = PatchDubbingLineBodySchema.parse(req.body ?? {});
    return updateDubbingLine(db, id, body);
  });

  // 角色音色设置：voiceId 为语音模型音色名（如 Cherry/Ethan），空串清除回到自动分配
  app.patch('/api/voice-profiles/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ voiceId: z.string().max(60) }).parse(req.body ?? {});
    const profile = await db.voiceProfile.findUnique({ where: { id } });
    if (!profile) throw notFound('角色声音');
    return db.voiceProfile.update({ where: { id }, data: { voiceId: body.voiceId || null } });
  });

  // 单句 TTS：入队 GENERATE_TTS，行置 GENERATING，202 返回 job
  app.post('/api/dubbing-lines/:id/generate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = GenerateDubbingBodySchema.parse(req.body ?? {});
    const line = await db.dubbingLine.findUnique({
      where: { id },
      include: { shot: { include: { storyboard: { include: { episode: true } } } } },
    });
    if (!line) throw notFound('配音行');
    if (body.speed !== undefined && body.speed !== line.speed) {
      await updateDubbingLine(db, id, { speed: body.speed });
    }
    const job = await enqueue({
      projectId: line.shot.storyboard.episode.projectId,
      type: 'GENERATE_TTS',
      executor: 'API',
      inputPayload: { kind: 'dubbing', dubbingLineId: id, modelConfigId: body.modelConfigId },
    });
    await db.dubbingLine.update({ where: { id }, data: { status: 'GENERATING' } });
    reply.code(202);
    return job;
  });

  // 全部生成：先对分镜全部镜头做 sync-dubbing 语义的同步，再对 status != READY 的行批量入队（共享 batchId）
  app.post('/api/storyboards/:id/dubbing/generate-all', async (req) => {
    const { id } = req.params as { id: string };
    const allBody = GenerateAllDubbingBodySchema.parse(req.body ?? {});
    const storyboard = await db.storyboard.findUnique({
      where: { id },
      include: { episode: true, shots: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!storyboard) throw notFound('分镜');

    for (const shot of storyboard.shots) {
      await syncDubbingLines(db, shot.id);
    }

    const batchId = `dub-${id}-${Date.now()}`;
    const shotOrder = new Map(storyboard.shots.map((s, i) => [s.id, i]));
    const pending = await db.dubbingLine.findMany({
      where: {
        shotId: { in: storyboard.shots.map((s) => s.id) },
        status: { not: 'READY' },
      },
      include: { dialogueLine: true },
    });
    // 入队顺序稳定：镜头 sortOrder → 对白 sortOrder（自由行排最后）
    pending.sort((a, b) => {
      const so = (shotOrder.get(a.shotId) ?? 0) - (shotOrder.get(b.shotId) ?? 0);
      if (so !== 0) return so;
      const ao = a.dialogueLine?.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bo = b.dialogueLine?.sortOrder ?? Number.MAX_SAFE_INTEGER;
      return ao - bo;
    });

    let enqueued = 0;
    for (const line of pending) {
      await enqueue({
        projectId: storyboard.episode.projectId,
        type: 'GENERATE_TTS',
        executor: 'API',
        inputPayload: { kind: 'dubbing', dubbingLineId: line.id, modelConfigId: allBody.modelConfigId },
        batchId,
      });
      await db.dubbingLine.update({ where: { id: line.id }, data: { status: 'GENERATING' } });
      enqueued += 1;
    }
    return { batchId, enqueued };
  });

  // 配音页镜头小结：计划/锁定时长 + 各行时长与状态
  app.get('/api/shots/:id/duration', async (req) => {
    const { id } = req.params as { id: string };
    const shot = await db.shot.findUnique({ where: { id } });
    if (!shot) throw notFound('镜头');
    const lines = await listDubbingLines(db, id);
    return {
      durationPlannedMs: shot.durationPlannedMs,
      durationLockedMs: shot.durationLockedMs,
      lines: lines.map((l) => ({ id: l.id, durationMs: l.durationMs, status: l.status })),
    };
  });
};
