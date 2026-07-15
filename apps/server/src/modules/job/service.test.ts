import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ZodError } from 'zod';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { AppError } from '../../lib/errors.js';
import { parseJson } from '../../lib/json.js';
import {
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  cancelJob,
  retryJob,
  updateJobProgress,
} from './service.js';

let t: TestDb;
let db: PrismaClient;
let projectId: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const project = await db.project.create({ data: { name: 'Job 服务测试项目' } });
  projectId = project.id;
});

afterAll(async () => {
  await t.cleanup();
});

describe('enqueueJob', () => {
  it('创建 QUEUED 任务并序列化 inputJson，默认 executor=MOCK / maxAttempts=2', async () => {
    const job = await enqueueJob(db, {
      projectId,
      type: 'GENERATE_IMAGE',
      inputPayload: { color: 'red', n: 1 },
    });
    expect(job.status).toBe('QUEUED');
    expect(job.executor).toBe('MOCK');
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(2);
    expect(job.progress).toBe(0);
    expect(parseJson(job.inputJson, {})).toEqual({ color: 'red', n: 1 });
  });

  it('支持可选字段 providerConfigId/modelKey/batchId/maxAttempts', async () => {
    const job = await enqueueJob(db, {
      projectId,
      type: 'GENERATE_VIDEO',
      executor: 'API',
      inputPayload: {},
      modelKey: 'seedance-1',
      batchId: 'batch-1',
      maxAttempts: 5,
    });
    expect(job.executor).toBe('API');
    expect(job.modelKey).toBe('seedance-1');
    expect(job.batchId).toBe('batch-1');
    expect(job.maxAttempts).toBe(5);
  });

  it('非法 type 抛 ZodError', async () => {
    await expect(
      enqueueJob(db, { projectId, type: 'NOT_A_TYPE' as never, inputPayload: {} }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});

/** claimNextJob 全局取最早的 QUEUED：依赖“领到自己的任务”的用例先清空队列 */
async function drainQueue(): Promise<void> {
  await db.job.updateMany({ where: { status: 'QUEUED' }, data: { status: 'CANCELED' } });
}

describe('claimNextJob', () => {
  it('按 createdAt 先进先出领取，置 RUNNING 且 attempts+1、startedAt 落值', async () => {
    await drainQueue();
    const a = await enqueueJob(db, { projectId, type: 'GENERATE_TTS', inputPayload: { seq: 'a' } });
    const b = await enqueueJob(db, { projectId, type: 'GENERATE_TTS', inputPayload: { seq: 'b' } });
    // 强制 a 更早，排除同毫秒 createdAt 的不确定性
    await db.job.update({ where: { id: a.id }, data: { createdAt: new Date(Date.now() - 5000) } });

    const first = await claimNextJob(db);
    expect(first?.id).toBe(a.id);
    expect(first?.status).toBe('RUNNING');
    expect(first?.attempts).toBe(1);
    expect(first?.startedAt).not.toBeNull();

    const second = await claimNextJob(db);
    expect(second?.id).toBe(b.id);

    const third = await claimNextJob(db);
    expect(third).toBeNull();
  });
});

describe('completeJob', () => {
  it('置 SUCCEEDED：progress=100、outputJson 落值、finishedAt 落值', async () => {
    await drainQueue();
    const job = await enqueueJob(db, { projectId, type: 'GENERATE_IMAGE', inputPayload: {} });
    await claimNextJob(db);
    const done = await completeJob(db, job.id, { outputAssetIds: ['asset-1'], output: { ok: 1 } });
    expect(done.status).toBe('SUCCEEDED');
    expect(done.progress).toBe(100);
    expect(done.finishedAt).not.toBeNull();
    expect(parseJson(done.outputJson, null)).toEqual({ outputAssetIds: ['asset-1'], output: { ok: 1 } });
  });

  it('任务不存在抛 404', async () => {
    await expect(completeJob(db, 'nope', {})).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('failJob', () => {
  it('attempts < maxAttempts：回 QUEUED 并记录错误', async () => {
    await drainQueue();
    const job = await enqueueJob(db, { projectId, type: 'GENERATE_IMAGE', inputPayload: {} });
    await claimNextJob(db); // attempts=1 < maxAttempts=2
    const failed = await failJob(db, job.id, '第一次失败');
    expect(failed.status).toBe('QUEUED');
    expect(failed.error).toBe('第一次失败');
    expect(failed.finishedAt).toBeNull();
  });

  it('attempts 达到 maxAttempts：置 FAILED（error + finishedAt）', async () => {
    await drainQueue();
    const job = await enqueueJob(db, { projectId, type: 'GENERATE_IMAGE', inputPayload: {}, maxAttempts: 1 });
    await claimNextJob(db); // attempts=1 = maxAttempts
    const failed = await failJob(db, job.id, '彻底失败');
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toBe('彻底失败');
    expect(failed.finishedAt).not.toBeNull();
  });

  it('fatal=true 时不重试直接 FAILED', async () => {
    await drainQueue();
    const job = await enqueueJob(db, { projectId, type: 'GENERATE_IMAGE', inputPayload: {}, maxAttempts: 9 });
    await claimNextJob(db);
    const failed = await failJob(db, job.id, '无执行器', { fatal: true });
    expect(failed.status).toBe('FAILED');
  });
});

describe('cancelJob', () => {
  it('QUEUED 可取消', async () => {
    const job = await enqueueJob(db, { projectId, type: 'GENERATE_IMAGE', inputPayload: {} });
    const canceled = await cancelJob(db, job.id);
    expect(canceled.status).toBe('CANCELED');
  });

  it('RUNNING 不可取消（M1 不支持中断），报 400', async () => {
    const job = await enqueueJob(db, { projectId, type: 'GENERATE_IMAGE', inputPayload: {} });
    await db.job.update({ where: { id: job.id }, data: { status: 'RUNNING' } });
    await expect(cancelJob(db, job.id)).rejects.toMatchObject({ statusCode: 400 });
    // 复原，避免影响其他用例的 claim
    await db.job.update({ where: { id: job.id }, data: { status: 'CANCELED' } });
  });

  it('任务不存在抛 404', async () => {
    await expect(cancelJob(db, 'nope')).rejects.toBeInstanceOf(AppError);
    await expect(cancelJob(db, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('retryJob', () => {
  it('FAILED 重回 QUEUED：attempts=0、error/进度/时间戳清空', async () => {
    await drainQueue();
    const job = await enqueueJob(db, { projectId, type: 'GENERATE_IMAGE', inputPayload: {}, maxAttempts: 1 });
    await claimNextJob(db);
    await failJob(db, job.id, '失败了');
    const retried = await retryJob(db, job.id);
    expect(retried.status).toBe('QUEUED');
    expect(retried.attempts).toBe(0);
    expect(retried.error).toBeNull();
    expect(retried.progress).toBe(0);
    expect(retried.startedAt).toBeNull();
    expect(retried.finishedAt).toBeNull();
    // 收尾：避免残留 QUEUED 干扰其他用例
    await cancelJob(db, job.id);
  });

  it('非 FAILED 状态不可重试，报 400', async () => {
    const job = await enqueueJob(db, { projectId, type: 'GENERATE_IMAGE', inputPayload: {} });
    await expect(retryJob(db, job.id)).rejects.toMatchObject({ statusCode: 400 });
    await cancelJob(db, job.id);
  });
});

describe('updateJobProgress', () => {
  it('进度裁剪到 [0,100] 的整数', async () => {
    const job = await enqueueJob(db, { projectId, type: 'GENERATE_IMAGE', inputPayload: {} });
    await updateJobProgress(db, job.id, 141.9);
    expect((await db.job.findUnique({ where: { id: job.id } }))?.progress).toBe(100);
    await updateJobProgress(db, job.id, -3);
    expect((await db.job.findUnique({ where: { id: job.id } }))?.progress).toBe(0);
    await updateJobProgress(db, job.id, 42.4);
    expect((await db.job.findUnique({ where: { id: job.id } }))?.progress).toBe(42);
    await cancelJob(db, job.id);
  });
});
