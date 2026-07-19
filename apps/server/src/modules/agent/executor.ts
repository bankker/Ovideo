// 关键图自动收敛的 Job 执行器。
// 运行本身是一条 Job（executor='API'）：可在任务面板看到进度、可取消、失败有中文原因，
// 与其他生成任务同一套观测面 —— agent 不是黑箱后台线程。
import { z } from 'zod';
import { parseJson } from '../../lib/json.js';
import { registerExecutor } from '../job/registry.js';
import { failAgentRun, runKeyframeConverge, type AgentDeps } from './service.js';

const ConvergeInputSchema = z.object({
  runId: z.string(),
  /** 图像模型（缺省由接线处按调度器选队首） */
  modelConfigId: z.string().optional(),
  /** 视觉评审模型（缺省按 modality='vision' 调度） */
  visionModelConfigId: z.string().optional(),
});

/** 统一入口：集成阶段（app 启动）调用一次；测试可注入假的生成/评审实现 */
export function registerAgentExecutors(deps: AgentDeps): void {
  registerExecutor('AGENT_KEYFRAME_CONVERGE', async (ctx) => {
    const input = ConvergeInputSchema.parse(parseJson<unknown>(ctx.job.inputJson, {}));
    try {
      const run = await runKeyframeConverge(ctx.db, deps, {
        runId: input.runId,
        modelConfigId: input.modelConfigId,
        visionModelConfigId: input.visionModelConfigId,
        updateProgress: ctx.updateProgress,
      });
      return {
        output: {
          runId: run.id,
          status: run.status,
          finalTakeId: run.finalTakeId,
          humanOverride: run.humanOverride,
        },
      };
    } catch (err) {
      // 先把失败落到 AgentRun（前端看的是运行卡片，不是 Job 行），再交给 worker 走重试/终态
      await failAgentRun(ctx.db, input.runId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  });
}
