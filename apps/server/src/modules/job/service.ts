import type { PrismaClient, Job } from '@prisma/client';
import {
  JobTypeSchema,
  JobExecutorKindSchema,
  type JobType,
  type JobExecutorKind,
} from '@ovideo/shared';
import { toJson } from '../../lib/json.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { JobExecutorResult } from './registry.js';

export interface EnqueueJobInput {
  projectId: string;
  type: JobType;
  executor?: JobExecutorKind;
  inputPayload: unknown;
  providerConfigId?: string;
  modelKey?: string;
  batchId?: string;
  maxAttempts?: number;
}

export async function enqueueJob(db: PrismaClient, input: EnqueueJobInput): Promise<Job> {
  return db.job.create({
    data: {
      projectId: input.projectId,
      type: JobTypeSchema.parse(input.type),
      executor: JobExecutorKindSchema.parse(input.executor ?? 'LOCAL'),
      inputJson: toJson(input.inputPayload ?? {}),
      providerConfigId: input.providerConfigId,
      modelKey: input.modelKey,
      batchId: input.batchId,
      maxAttempts: input.maxAttempts,
    },
  });
}

/**
 * 事务内领取最早的 QUEUED 任务：置 RUNNING、attempts+1、startedAt 落值。
 * SQLite 下 Prisma 事务串行执行，同进程多路领取不会拿到同一条。队列空返回 null。
 */
export async function claimNextJob(db: PrismaClient): Promise<Job | null> {
  return db.$transaction(async (tx) => {
    const next = await tx.job.findFirst({
      where: { status: 'QUEUED' },
      // id 作 tiebreaker：同毫秒入队时仍保持稳定的先进先出
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!next) return null;
    return tx.job.update({
      where: { id: next.id },
      data: { status: 'RUNNING', attempts: next.attempts + 1, startedAt: new Date(), error: null },
    });
  });
}

export async function completeJob(db: PrismaClient, jobId: string, result: JobExecutorResult): Promise<Job> {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) throw notFound('任务');
  return db.job.update({
    where: { id: jobId },
    data: {
      status: 'SUCCEEDED',
      progress: 100,
      outputJson: toJson({ outputAssetIds: result.outputAssetIds ?? [], output: result.output ?? null }),
      error: null,
      finishedAt: new Date(),
    },
  });
}

/**
 * 执行失败：attempts 未耗尽回 QUEUED 等待再次领取（错误留档供面板展示），
 * 耗尽或 fatal（如无执行器，重试无意义）则置 FAILED。
 */
export async function failJob(
  db: PrismaClient,
  jobId: string,
  errMsg: string,
  opts: { fatal?: boolean } = {},
): Promise<Job> {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) throw notFound('任务');
  if (!opts.fatal && job.attempts < job.maxAttempts) {
    return db.job.update({
      where: { id: jobId },
      data: { status: 'QUEUED', progress: 0, error: errMsg, startedAt: null },
    });
  }
  return db.job.update({
    where: { id: jobId },
    data: { status: 'FAILED', error: errMsg, finishedAt: new Date() },
  });
}

/** M1 仅支持取消排队中的任务；RUNNING 的中断留待执行器支持取消信号后实现 */
export async function cancelJob(db: PrismaClient, jobId: string): Promise<Job> {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) throw notFound('任务');
  if (job.status !== 'QUEUED') {
    throw badRequest(
      job.status === 'RUNNING' ? '任务已在运行，M1 暂不支持中断' : `状态为 ${job.status} 的任务不能取消`,
    );
  }
  return db.job.update({ where: { id: jobId }, data: { status: 'CANCELED', finishedAt: new Date() } });
}

export async function retryJob(db: PrismaClient, jobId: string): Promise<Job> {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) throw notFound('任务');
  if (job.status !== 'FAILED') throw badRequest(`仅失败的任务可重试（当前状态 ${job.status}）`);
  return db.job.update({
    where: { id: jobId },
    data: {
      status: 'QUEUED',
      attempts: 0,
      error: null,
      progress: 0,
      outputJson: null,
      startedAt: null,
      finishedAt: null,
    },
  });
}

export async function updateJobProgress(db: PrismaClient, jobId: string, progress: number): Promise<void> {
  const p = Math.max(0, Math.min(100, Math.round(progress)));
  await db.job.update({ where: { id: jobId }, data: { progress: p } });
}
