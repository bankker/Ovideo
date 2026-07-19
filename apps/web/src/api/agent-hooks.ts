import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { JobEntity } from './workflow-hooks';

/** ---------- 关键图自动收敛 agent ----------
 * 这是与手工抽卡并列的「AI 辅助线」：agent 只调用既有生成能力，
 * 自身状态独立存 AgentRun，不改动 Shot/Take 的既有语义。
 */

export type AgentRunStatus = 'RUNNING' | 'PASSED' | 'NEEDS_HUMAN' | 'FAILED' | 'CANCELED';

/** 形状 = Prisma model AgentRun */
export interface AgentRun {
  id: string;
  projectId: string;
  shotId: string;
  kind: string;
  status: AgentRunStatus;
  maxRounds: number;
  /** 每轮记录的 JSON 字符串，用 parseAgentRounds 解析 */
  roundsJson: string;
  finalTakeId: string | null;
  /** true = 运行期间人手动改过选定关键图，agent 未覆盖 */
  humanOverride: boolean;
  jobId: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** 单轮记录（服务端写入 roundsJson 的元素形状） */
export interface AgentRound {
  round: number;
  takeId: string;
  /** 该轮候选图，可直接作 img src */
  assetUri: string;
  /** 0-100 形象一致性（物种/配色/服装 vs 参考图） */
  identityMatch: number;
  /** 0-100 画面是否符合提示词 */
  promptMatch: number;
  issues: string[];
  verdict: 'pass' | 'retry' | 'fix_prompt';
  action: string;
  promptUsed: string;
  /** verdict=fix_prompt 时的改写建议（仅本次运行内生效，不写回 Shot） */
  suggestedPrompt?: string;
}

interface AgentRunsResponse {
  runs: AgentRun[];
}

export interface StartConvergeResult {
  run: AgentRun;
  job: JobEntity;
}

/** roundsJson → AgentRound[]；服务端字段缺失或非法时静默降级为空数组，避免报告面板整块崩掉 */
export function parseAgentRounds(roundsJson: string): AgentRound[] {
  try {
    const parsed: unknown = JSON.parse(roundsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is AgentRound =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as AgentRound).round === 'number' &&
        typeof (r as AgentRound).verdict === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * 某镜头的自动收敛运行历史（服务端按新到旧返回）。
 * 有 RUNNING 的 run 时 3s 轮询；收敛一轮就是一次生图，耗时以分钟计，
 * 故与其他长任务一致开启后台标签页轮询。
 */
export function useAgentRuns(shotId: string | null) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['agent-runs', shotId ?? ''],
    queryFn: () => api<AgentRunsResponse>(`/shots/${shotId}/agent-runs`),
    enabled: shotId !== null,
    select: (data) => data.runs,
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => r.status === 'RUNNING') === true ? 3000 : false,
    refetchIntervalInBackground: true,
  });

  // 运行落到终态的那一刻刷新分镜详情：agent 追加的候选 take 与改动的选定指针
  // 只存在于分镜数据里，不刷新的话要等用户手动切版本才看得到结果。
  const running = query.data?.some((r) => r.status === 'RUNNING') ?? false;
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !running) {
      void qc.invalidateQueries({ queryKey: ['storyboard'] });
      void qc.invalidateQueries({ queryKey: ['shot-keyframe-takes'] });
    }
    wasRunningRef.current = running;
  }, [running, qc]);

  return query;
}

/** 启动关键图自动收敛；成功后刷新该镜头的运行列表与分镜详情（agent 会追加候选 take） */
export function useStartKeyframeConverge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      shotId,
      maxRounds,
      modelConfigId,
      visionModelConfigId,
    }: {
      shotId: string;
      /** 1..5，服务端硬上限 5；不传用服务端默认 3 */
      maxRounds?: number;
      modelConfigId?: string;
      visionModelConfigId?: string;
    }) =>
      api<StartConvergeResult>(`/shots/${shotId}/agent/keyframe-converge`, {
        method: 'POST',
        body: {
          ...(maxRounds !== undefined ? { maxRounds } : {}),
          ...(modelConfigId !== undefined ? { modelConfigId } : {}),
          ...(visionModelConfigId !== undefined ? { visionModelConfigId } : {}),
        },
      }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['agent-runs', vars.shotId] });
      void qc.invalidateQueries({ queryKey: ['storyboard'] });
    },
  });
}
