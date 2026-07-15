import type { PrismaClient, Job } from '@prisma/client';
import type { JobType } from '@ovideo/shared';
import { getExecutor } from './registry.js';
import { claimNextJob, completeJob, failJob, updateJobProgress } from './service.js';

export interface WorkerOptions {
  intervalMs?: number;
  concurrency?: number;
}

export interface JobWorker {
  /** 停止领取新任务，并等待在跑的任务全部收尾 */
  stop(): Promise<void>;
}

export function startWorker(db: PrismaClient, opts: WorkerOptions = {}): JobWorker {
  const intervalMs = opts.intervalMs ?? 300;
  const concurrency = opts.concurrency ?? 2;
  let stopped = false;
  let ticking = false;
  const inflight = new Set<Promise<void>>();

  async function runJob(job: Job): Promise<void> {
    const executor = getExecutor(job.type as JobType);
    if (!executor) {
      // 无执行器属于配置错误，重试不会自愈，直接终态
      await failJob(db, job.id, `无执行器：${job.type}`, { fatal: true });
      return;
    }
    try {
      const result = await executor({
        db,
        job,
        updateProgress: (p) => updateJobProgress(db, job.id, p),
      });
      await completeJob(db, job.id, result ?? {});
    } catch (err) {
      await failJob(db, job.id, err instanceof Error ? err.message : String(err));
    }
  }

  async function tick(): Promise<void> {
    // ticking 防重入：领取是异步的，interval 触发可能叠在上一轮未完成时
    if (ticking || stopped) return;
    ticking = true;
    try {
      while (!stopped && inflight.size < concurrency) {
        const job = await claimNextJob(db);
        if (!job) break;
        const p = runJob(job)
          .catch(() => {
            /* runJob 内部已兜错；这里仅防状态落库本身失败导致 unhandled rejection */
          })
          .finally(() => {
            inflight.delete(p);
          });
        inflight.add(p);
      }
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick(); // 启动即先扫一轮，减少首个任务的等待

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await Promise.allSettled([...inflight]);
    },
  };
}
