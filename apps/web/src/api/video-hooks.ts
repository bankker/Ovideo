import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssetSource,
  AssetStatus,
  AssetType,
  CapabilityEntry,
  CutStatus,
  JobStatus,
  Modality,
  StaleReason,
  TakeSlot,
} from '@ovideo/shared';
import { api } from './client';
import type { JobEntity, ShotDetail, StoryboardDetail } from './workflow-hooks';

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

/** storyboard 详情里的 take 带 asset 对象（服务端 include: { asset: true }） */
export interface TakeEntity {
  id: string;
  shotId: string;
  slot: TakeSlot;
  assetId: string;
  asset: AssetEntity;
  jobId: string | null;
  createdAt: string;
}

export interface ShotWithTakes extends ShotDetail {
  takes: TakeEntity[];
}

export interface StoryboardWithTakes extends Omit<StoryboardDetail, 'shots'> {
  shots: ShotWithTakes[];
}

/** Cut.itemsJson 的条目（COMPOSE_CUT 创建时的选定视频快照） */
export interface CutItem {
  shotId: string;
  takeId: string;
  assetUri: string;
  assetId?: string;
  durationMs?: number;
}

export interface CutEntity {
  id: string;
  episodeId: string;
  version: number;
  /** 服务端已把 itemsJson 解析为对象数组返回 */
  items: CutItem[];
  audioTracksJson: string;
  outputAssetId: string | null;
  status: CutStatus;
  createdAt: string;
  updatedAt: string;
}

/** Cut 详情（成品页播放器用；outputAsset 在 READY 后存在） */
export interface CutDetail extends CutEntity {
  outputAsset?: AssetEntity | null;
}

export interface CreateCutResult {
  cut: CutEntity;
  job: JobEntity;
}

/** ---------- 解析工具 ---------- */

export function parseStaleReasons(json: string): StaleReason[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is StaleReason =>
        typeof r === 'object' && r !== null && 'source' in r && 'at' in r && 'detail' in r,
    );
  } catch {
    return [];
  }
}

export function parseCutItems(itemsJson: string): CutItem[] {
  try {
    const parsed: unknown = JSON.parse(itemsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is CutItem => typeof r === 'object' && r !== null && 'shotId' in r,
    );
  } catch {
    return [];
  }
}

/** 毫秒 → 保留一位小数的秒（展示用） */
export function fmtSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
}

const JOB_TERMINAL: JobStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELED'];

export function isGenJobFinished(status: JobStatus | undefined): boolean {
  return status !== undefined && JOB_TERMINAL.includes(status);
}

/** ---------- 能力（模型选择器数据源；视频必须显式选择模型） ---------- */

export function useCapabilities(modality: Modality) {
  return useQuery({
    queryKey: ['capabilities', modality],
    queryFn: () => api<CapabilityEntry[]>('/capabilities', { query: { modality } }),
  });
}

/** ---------- 分镜详情（takes 带 asset；与 workflow-hooks 共用 ['storyboard', id] 缓存键） ---------- */

export function useStoryboardTakes(storyboardId: string | null) {
  return useQuery({
    queryKey: ['storyboard', storyboardId ?? ''],
    queryFn: () => api<StoryboardWithTakes>(`/storyboards/${storyboardId}`),
    enabled: storyboardId !== null,
  });
}

/** ---------- Job 轮询（生成类任务；视频生成秒级~分钟级，默认 2s） ---------- */

export function useGenJob(jobId: string | null, intervalMs = 2000) {
  return useQuery({
    queryKey: ['job', jobId ?? ''],
    queryFn: () => api<JobEntity>(`/jobs/${jobId}`),
    enabled: jobId !== null,
    refetchInterval: (query) =>
      isGenJobFinished(query.state.data?.status) ? false : intervalMs,
    // 视频生成动辄数分钟，后台标签页也持续跟进
    refetchIntervalInBackground: true,
  });
}

/** ---------- 镜头产物动作 ---------- */

/** 切换选定 take（抽卡语义）；成功后失效 storyboard 详情 */
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
    }) => api(`/shots/${shotId}/select-take`, { method: 'POST', body: { slot, takeId } }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['storyboard', vars.storyboardId] });
    },
  });
}

/** 消除失效角标（mode: 'ignored' = 用户确认忽略上游变更） */
export function useClearStale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      shotId,
      slot,
      mode,
    }: {
      shotId: string;
      slot: TakeSlot;
      mode: 'ignored' | 'regenerated';
      storyboardId: string;
    }) => api(`/shots/${shotId}/clear-stale`, { method: 'POST', body: { slot, mode } }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['storyboard', vars.storyboardId] });
    },
  });
}

/** 生成视频片段（I2V）：返回 Job，调用方用 useGenJob 轮询 */
export function useGenerateShotVideo() {
  return useMutation({
    mutationFn: ({ shotId, modelConfigId }: { shotId: string; modelConfigId?: string }) =>
      api<JobEntity>(`/shots/${shotId}/generate-video`, {
        method: 'POST',
        body: modelConfigId !== undefined ? { modelConfigId } : {},
      }),
  });
}

/** ---------- 成片 Cut ---------- */

export function useCuts(episodeId: string) {
  return useQuery({
    queryKey: ['cuts', episodeId],
    queryFn: () => api<CutDetail[]>(`/episodes/${episodeId}/cuts`),
    enabled: episodeId !== '',
    // 有合成中的 Cut 时保持刷新
    refetchInterval: (query) =>
      query.state.data?.some((c) => c.status === 'COMPOSING') === true ? 3000 : false,
  });
}

export function useCut(cutId: string | null) {
  return useQuery({
    queryKey: ['cut', cutId ?? ''],
    queryFn: () => api<CutDetail>(`/cuts/${cutId}`),
    enabled: cutId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'COMPOSING' ? 2000 : false),
  });
}

/** 从选定 video takes 创建 Cut 并入队 COMPOSE_CUT；返回 { cut, job } */
export function useCreateCut(episodeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (storyboardId: string) =>
      api<CreateCutResult>(`/episodes/${episodeId}/cuts`, {
        method: 'POST',
        body: { storyboardId },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cuts', episodeId] });
    },
  });
}
