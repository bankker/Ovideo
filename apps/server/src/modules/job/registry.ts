import type { PrismaClient, Job } from '@prisma/client';
import type { JobType } from '@ovideo/shared';

export interface JobExecutorContext {
  db: PrismaClient;
  job: Job;
  updateProgress(p: number): Promise<void>;
}

export interface JobExecutorResult {
  outputAssetIds?: string[];
  output?: unknown;
}

/** 执行器契约（C4）：产出资产 id 与任意 output，落库/状态流转由 worker 负责 */
export type JobExecutor = (ctx: JobExecutorContext) => Promise<JobExecutorResult>;

// 模块级注册表：集成阶段由 app 启动时注册各模块的执行器，worker 按 Job.type 查找
const executors = new Map<JobType, JobExecutor>();

export function registerExecutor(type: JobType, fn: JobExecutor): void {
  executors.set(type, fn);
}

export function getExecutor(type: JobType): JobExecutor | undefined {
  return executors.get(type);
}

/** 测试用：清空注册表，避免用例间串台 */
export function clearExecutors(): void {
  executors.clear();
}
