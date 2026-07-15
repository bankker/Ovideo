import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { JobEntity, StoryboardSummary } from './workflow-hooks';

/** ---------- M3-lite：衔接组拆分 + 单段增强 ---------- */

/** 单段增强类型：高清放大 / 智能补帧（对口型 M3 完整版开放） */
export type EnhanceKind = 'upscale' | 'interpolate';

/** POST /shots/:id/split-group 响应：服务端产出新分镜版本 */
export interface SplitGroupResult {
  storyboard: StoryboardSummary;
}

/** 镜头的衔接组字段（v2 §5；服务端 storyboard 详情自带，前端既有 Shot 类型未声明） */
export interface ShotGroupFields {
  groupId: string | null;
  groupIndex: number | null;
}

/** 从 storyboard 详情返回的 shot 对象上安全读取衔接组字段 */
export function getShotGroup(shot: unknown): ShotGroupFields {
  if (typeof shot !== 'object' || shot === null) {
    return { groupId: null, groupIndex: null };
  }
  const s = shot as { groupId?: unknown; groupIndex?: unknown };
  return {
    groupId: typeof s.groupId === 'string' ? s.groupId : null,
    groupIndex: typeof s.groupIndex === 'number' ? s.groupIndex : null,
  };
}

/**
 * 拆分为衔接组：POST /shots/:id/split-group（body {}）→ { storyboard }。
 * 成功后失效版本列表 ['storyboards', episodeId]；调用方负责把选中版本切到新 storyboard.id。
 */
export function useSplitGroup(episodeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shotId: string) =>
      api<SplitGroupResult>(`/shots/${shotId}/split-group`, { method: 'POST', body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['storyboards', episodeId] });
    },
  });
}

/**
 * 单段增强：POST /shots/:id/enhance（body { kind }）→ 202 Job。
 * 调用方用 useGenJob 轮询；SUCCEEDED 后失效 ['storyboard', shot.storyboardId]。
 */
export function useEnhanceShot() {
  return useMutation({
    mutationFn: ({ shotId, kind }: { shotId: string; kind: EnhanceKind }) =>
      api<JobEntity>(`/shots/${shotId}/enhance`, { method: 'POST', body: { kind } }),
  });
}
