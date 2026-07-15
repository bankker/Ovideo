import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { parseJson } from '../../lib/json.js';
import { enqueueJob } from './service.js';
import { registerExecutor, clearExecutors } from './registry.js';
import { startWorker } from './worker.js';

let t: TestDb;
let db: PrismaClient;
let projectId: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const project = await db.project.create({ data: { name: 'Worker 测试项目' } });
  projectId = project.id;
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(() => {
  clearExecutors();
});

/** 轮询等待条件成立（worker 是异步轮询模型，测试只能等） */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 8000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor 超时');
}

async function jobStatus(id: string): Promise<string | undefined> {
  return (await db.job.findUnique({ where: { id } }))?.status;
}

describe('startWorker', () => {
  it('领取 QUEUED 任务、执行注册的执行器并置 SUCCEEDED', async () => {
    const exec = vi.fn(async ({ updateProgress }: { updateProgress: (p: number) => Promise<void> }) => {
      await updateProgress(50);
      return { outputAssetIds: ['a1'], output: { hello: 'world' } };
    });
    registerExecutor('GENERATE_IMAGE', exec as never);
    const job = await enqueueJob(db, { projectId, type: 'GENERATE_IMAGE', inputPayload: { x: 1 } });

    const worker = startWorker(db, { intervalMs: 20 });
    try {
      await waitFor(async () => (await jobStatus(job.id)) === 'SUCCEEDED');
    } finally {
      await worker.stop();
    }

    expect(exec).toHaveBeenCalledTimes(1);
    const done = await db.job.findUnique({ where: { id: job.id } });
    expect(done?.progress).toBe(100);
    expect(done?.attempts).toBe(1);
    expect(done?.finishedAt).not.toBeNull();
    expect(parseJson(done?.outputJson, null)).toEqual({ outputAssetIds: ['a1'], output: { hello: 'world' } });
  });

  it('执行器抛错且未耗尽 attempts：回 QUEUED 后再次领取，第二次成功', async () => {
    let calls = 0;
    registerExecutor('GENERATE_VIDEO', async () => {
      calls += 1;
      if (calls === 1) throw new Error('第一次挂了');
      return { output: 'ok' };
    });
    const job = await enqueueJob(db, { projectId, type: 'GENERATE_VIDEO', inputPayload: {} });

    const worker = startWorker(db, { intervalMs: 20 });
    try {
      await waitFor(async () => (await jobStatus(job.id)) === 'SUCCEEDED');
    } finally {
      await worker.stop();
    }

    expect(calls).toBe(2);
    expect((await db.job.findUnique({ where: { id: job.id } }))?.attempts).toBe(2);
  });

  it('重试耗尽：置 FAILED 并记录错误', async () => {
    registerExecutor('GENERATE_TTS', async () => {
      throw new Error('永远失败');
    });
    const job = await enqueueJob(db, { projectId, type: 'GENERATE_TTS', inputPayload: {}, maxAttempts: 2 });

    const worker = startWorker(db, { intervalMs: 20 });
    try {
      await waitFor(async () => (await jobStatus(job.id)) === 'FAILED');
    } finally {
      await worker.stop();
    }

    const failed = await db.job.findUnique({ where: { id: job.id } });
    expect(failed?.attempts).toBe(2);
    expect(failed?.error).toBe('永远失败');
  });

  it('无执行器：直接 FAILED，不消耗重试', async () => {
    const job = await enqueueJob(db, { projectId, type: 'EXTRACT_FRAME', inputPayload: {}, maxAttempts: 5 });

    const worker = startWorker(db, { intervalMs: 20 });
    try {
      await waitFor(async () => (await jobStatus(job.id)) === 'FAILED');
    } finally {
      await worker.stop();
    }

    const failed = await db.job.findUnique({ where: { id: job.id } });
    expect(failed?.error).toContain('无执行器');
    expect(failed?.attempts).toBe(1);
  });

  it('并发上限 concurrency=1：两个慢任务不会同时 RUNNING', async () => {
    let active = 0;
    let maxActive = 0;
    registerExecutor('UPSCALE', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 80));
      active -= 1;
      return {};
    });
    const j1 = await enqueueJob(db, { projectId, type: 'UPSCALE', inputPayload: {} });
    const j2 = await enqueueJob(db, { projectId, type: 'UPSCALE', inputPayload: {} });

    const worker = startWorker(db, { intervalMs: 10, concurrency: 1 });
    try {
      await waitFor(
        async () => (await jobStatus(j1.id)) === 'SUCCEEDED' && (await jobStatus(j2.id)) === 'SUCCEEDED',
      );
    } finally {
      await worker.stop();
    }
    expect(maxActive).toBe(1);
  });

  it('concurrency=2：两个任务可同时进入执行', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = 0;
    registerExecutor('EXTRACT_AUDIO', async () => {
      entered += 1;
      await gate;
      return {};
    });
    const j1 = await enqueueJob(db, { projectId, type: 'EXTRACT_AUDIO', inputPayload: {} });
    const j2 = await enqueueJob(db, { projectId, type: 'EXTRACT_AUDIO', inputPayload: {} });

    const worker = startWorker(db, { intervalMs: 10, concurrency: 2 });
    try {
      await waitFor(async () => entered === 2);
      release();
      await waitFor(
        async () => (await jobStatus(j1.id)) === 'SUCCEEDED' && (await jobStatus(j2.id)) === 'SUCCEEDED',
      );
    } finally {
      release();
      await worker.stop();
    }
  });

  it('stop() 等待在跑任务收尾后才返回', async () => {
    registerExecutor('COMPOSE_CUT', async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { output: 'done' };
    });
    const job = await enqueueJob(db, { projectId, type: 'COMPOSE_CUT', inputPayload: {} });

    const worker = startWorker(db, { intervalMs: 10 });
    await waitFor(async () => (await jobStatus(job.id)) === 'RUNNING');
    await worker.stop();
    // stop 返回时任务必须已终态，而不是被丢在 RUNNING
    expect(await jobStatus(job.id)).toBe('SUCCEEDED');
  });
});
