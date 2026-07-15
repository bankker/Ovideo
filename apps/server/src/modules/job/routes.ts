import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient, Job } from '@prisma/client';
import { z } from 'zod';
import { JobStatusSchema } from '@ovideo/shared';
import { parseJson } from '../../lib/json.js';
import { notFound } from '../../lib/errors.js';
import { cancelJob, retryJob } from './service.js';

const ListJobsQuerySchema = z.object({
  status: JobStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** 响应统一把 inputJson/outputJson 解析为 input/output 对象，前端无需二次 JSON.parse */
function serializeJob(job: Job) {
  const { inputJson, outputJson, ...rest } = job;
  return {
    ...rest,
    input: parseJson<unknown>(inputJson, {}),
    output: outputJson === null ? null : parseJson<unknown>(outputJson, null),
  };
}

export const jobRoutes: FastifyPluginAsync<{ db: PrismaClient }> = async (app, { db }) => {
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/jobs', async (req) => {
    const { status, limit } = ListJobsQuerySchema.parse(req.query);
    const jobs = await db.job.findMany({
      where: { projectId: req.params.projectId, ...(status ? { status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return jobs.map(serializeJob);
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req) => {
    const job = await db.job.findUnique({ where: { id: req.params.id } });
    if (!job) throw notFound('任务');
    return serializeJob(job);
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req) =>
    serializeJob(await cancelJob(db, req.params.id)),
  );

  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (req) =>
    serializeJob(await retryJob(db, req.params.id)),
  );
};
