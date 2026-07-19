import { useEffect, useRef, useState } from 'react';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssetSource,
  AssetStatus,
  AssetType,
  CapabilityEntry,
  DubbingStatus,
  Modality,
  TakeSlot,
} from '@ovideo/shared';
import { api } from './client';
import { useJob, type JobEntity, type ShotDetail, type StoryboardSummary } from './workflow-hooks';

/** ---------- 响应实体类型（形状 = Prisma 模型） ---------- */

export interface AssetEntity {
  id: string;
  projectId: string;
  type: AssetType;
  source: AssetSource;
  uri: string;
  thumbUri: string | null;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  metaJson: string;
  status: AssetStatus;
  jobId: string | null;
  createdAt: string;
}

/** 抽卡 take（storyboard 详情里带 asset 对象） */
export interface TakeItem {
  id: string;
  shotId: string;
  slot: TakeSlot;
  assetId: string;
  jobId: string | null;
  createdAt: string;
  asset: AssetEntity;
}

/** M2 分镜详情里的镜头：M1 ShotDetail + takes */
export interface ProduceShot extends ShotDetail {
  takes?: TakeItem[];
}

export interface ProduceStoryboardDetail extends StoryboardSummary {
  shots: ProduceShot[];
}

export interface DubbingLineEntity {
  id: string;
  shotId: string;
  dialogueLineId: string | null;
  voiceProfileId: string | null;
  speed: number;
  audioAssetId: string | null;
  durationMs: number | null;
  status: DubbingStatus;
  createdAt: string;
  voiceProfile?: { id: string; name: string; tagId: string | null } | null;
  audioAsset?: AssetEntity | null;
  dialogueLine?: {
    id: string;
    text: string;
    isNarrator: boolean;
    speakerTagId: string | null;
    sortOrder: number;
  } | null;
  /** 部分实现可能把文本冗余在行上 */
  text?: string;
}

/** GET /api/episodes/:id/stale-shots 条目 */
export interface StaleShotItem {
  id: string;
  storyboardId: string;
  sortOrder: number;
  keyframeStale: boolean;
  videoStale: boolean;
  staleReasonsJson: string;
}

export interface GenerateAllDubbingResult {
  enqueued?: number;
  batchId?: string;
  jobs?: JobEntity[];
}

/** ---------- 能力投影（模型选择 Select 数据源） ---------- */

export function useCapabilities(modality: Modality) {
  return useQuery({
    queryKey: ['capabilities', modality],
    queryFn: () => api<CapabilityEntry[]>('/capabilities', { query: { modality } }),
    staleTime: 60_000,
  });
}

/** ---------- 分镜详情（复用既有 ['storyboard', id] key，可选轮询） ---------- */

export function useStoryboardDetail(storyboardId: string | null, pollMs?: number) {
  return useQuery({
    queryKey: ['storyboard', storyboardId ?? ''],
    queryFn: () => api<ProduceStoryboardDetail>(`/storyboards/${storyboardId}`),
    enabled: storyboardId !== null,
    refetchInterval: pollMs ?? false,
  });
}

/** ---------- 配音 ---------- */

/** 单镜头配音行查询（有 GENERATING 行时自动 5s 轮询）；供 useQuery/useQueries 共用 */
export function dubbingQueryOptions(shotId: string) {
  return queryOptions({
    queryKey: ['dubbing', shotId],
    queryFn: () => api<DubbingLineEntity[]>(`/shots/${shotId}/dubbing`),
    refetchInterval: (query) => {
      const lines = query.state.data;
      return lines !== undefined && lines.some((l) => l.status === 'GENERATING') ? 5000 : false;
    },
  });
}

export function useShotDubbing(shotId: string) {
  return useQuery(dubbingQueryOptions(shotId));
}

/** 从对白同步生成配音行 */
export function useSyncDubbing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shotId: string) =>
      api<DubbingLineEntity[]>(`/shots/${shotId}/sync-dubbing`, { method: 'POST', body: {} }),
    onSuccess: (_data, shotId) => {
      void qc.invalidateQueries({ queryKey: ['dubbing', shotId] });
    },
  });
}

/** 更新配音行（语速等） */
export function useUpdateDubbingLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      lineId,
      speed,
      text,
    }: {
      lineId: string;
      shotId: string;
      speed?: number;
      /** 台词文案：服务端会改写来源对白并把该行打回待生成 */
      text?: string;
    }) =>
      api<DubbingLineEntity>(`/dubbing-lines/${lineId}`, {
        method: 'PATCH',
        body: {
          ...(speed !== undefined ? { speed } : {}),
          ...(text !== undefined ? { text } : {}),
        },
      }),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ['dubbing', variables.shotId] });
      // 台词改写会同步改到分镜对白，分镜/时长视图需要一并刷新
      void qc.invalidateQueries({ queryKey: ['storyboard'] });
    },
  });
}

/** 单句 TTS 生成（返回 Job，调用方轮询） */
export function useGenerateDubbingLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, modelConfigId }: { lineId: string; shotId: string; modelConfigId?: string }) =>
      api<JobEntity>(`/dubbing-lines/${lineId}/generate`, {
        method: 'POST',
        body: modelConfigId !== undefined ? { modelConfigId } : {},
      }),
    onSuccess: (_data, variables) => {
      // 行状态切到 GENERATING，触发该行查询的轮询
      void qc.invalidateQueries({ queryKey: ['dubbing', variables.shotId] });
    },
  });
}

/** 整个分镜全部生成（batch） */
export function useGenerateAllDubbing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ storyboardId, modelConfigId }: { storyboardId: string; modelConfigId?: string }) =>
      api<GenerateAllDubbingResult>(`/storyboards/${storyboardId}/dubbing/generate-all`, {
        method: 'POST',
        body: modelConfigId !== undefined ? { modelConfigId } : {},
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dubbing'] });
    },
  });
}

/** ---------- 镜头产物（关键图 / take 选择 / stale） ---------- */

export function useGenerateKeyframe() {
  return useMutation({
    mutationFn: ({
      shotId,
      modelConfigId,
      size,
    }: {
      shotId: string;
      modelConfigId?: string;
      /** 图像尺寸（如 '1024x1792'，由页面比例选择映射而来） */
      size?: string;
    }) =>
      api<JobEntity>(`/shots/${shotId}/generate-keyframe`, {
        method: 'POST',
        body: {
          ...(modelConfigId !== undefined ? { modelConfigId } : {}),
          ...(size !== undefined ? { size } : {}),
        },
      }),
  });
}

export function useSelectTake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      shotId,
      slot,
      takeId,
    }: {
      shotId: string;
      slot: TakeSlot;
      takeId: string;
      storyboardId: string;
    }) => api<unknown>(`/shots/${shotId}/select-take`, { method: 'POST', body: { slot, takeId } }),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ['storyboard', variables.storyboardId] });
    },
  });
}

export function useClearStale(episodeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      shotId,
      slot,
      mode = 'ignored',
    }: {
      shotId: string;
      slot: TakeSlot;
      mode?: string;
      storyboardId: string;
    }) => api<unknown>(`/shots/${shotId}/clear-stale`, { method: 'POST', body: { slot, mode } }),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ['storyboard', variables.storyboardId] });
      void qc.invalidateQueries({ queryKey: ['stale-shots', episodeId] });
    },
  });
}

/** 全局「待重生成」列表（轻量轮询，批量重生成后靠它感知完成） */
export function useStaleShots(episodeId: string) {
  return useQuery({
    queryKey: ['stale-shots', episodeId],
    queryFn: () => api<StaleShotItem[]>(`/episodes/${episodeId}/stale-shots`),
    enabled: episodeId !== '',
    refetchInterval: 10_000,
  });
}

/** ---------- 生成类按钮统一 Job 轮询封装 ----------
 * start(jobId) 后轮询至终态：SUCCEEDED → onSucceeded；FAILED/CANCELED → onFailed。
 */
export function useShotJob(handlers: {
  onSucceeded?: (job: JobEntity) => void;
  onFailed?: (job: JobEntity) => void;
}): { start: (jobId: string) => void; running: boolean; job: JobEntity | undefined } {
  const [jobId, setJobId] = useState<string | null>(null);
  const jobQuery = useJob(jobId);
  const job = jobQuery.data;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (job === undefined || job.id !== jobId) return;
    if (job.status === 'SUCCEEDED') {
      setJobId(null);
      handlersRef.current.onSucceeded?.(job);
    } else if (job.status === 'FAILED' || job.status === 'CANCELED') {
      setJobId(null);
      handlersRef.current.onFailed?.(job);
    }
  }, [job, jobId]);

  return { start: setJobId, running: jobId !== null, job };
}
