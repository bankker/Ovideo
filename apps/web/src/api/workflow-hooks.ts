import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  JobExecutorKind,
  JobStatus,
  JobType,
  StoryboardPatch,
  TagType,
} from '@ovideo/shared';
import { api } from './client';

/** ---------- 响应实体类型（形状 = Prisma 模型；仅 Job 的 input/output 已解析为对象） ---------- */

export interface ScriptDraft {
  id: string;
  episodeId: string;
  title: string;
  content: string;
  isMain: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoryboardSummary {
  id: string;
  episodeId: string;
  scriptDraftId: string;
  version: number;
  stale: boolean;
  staleReasonsJson: string;
  createdAt: string;
}

export interface ShotTagItem {
  shotId: string;
  tagId: string;
  tag: {
    id: string;
    projectId: string;
    type: TagType;
    name: string;
    description: string;
    canonicalAssetId: string | null;
  };
}

export interface DialogueLineItem {
  id: string;
  shotId: string;
  speakerTagId: string | null;
  isNarrator: boolean;
  text: string;
  sortOrder: number;
}

/** 场景 = 分镜的一级结构，镜头通过 shot.sceneId 归属于它（详情响应里不嵌套 shots，前端自行分组） */
export interface SceneItem {
  id: string;
  storyboardId: string;
  sortOrder: number;
  title: string;
  location: string;
  interiorExterior: string;
  timeOfDay: string;
  sourceText: string;
  estimatedDurationMs: number;
  status: string;
  lineageId: string | null;
}

export interface ShotDetail {
  id: string;
  storyboardId: string;
  sceneId: string | null;
  /**
   * 跨版本稳定的镜头身份。每次 apply-patch 都会复制出一批新 Shot（id 全换），
   * 只有 lineageId 在版本之间不变——凡是"同一个镜头在新旧版本里的对应关系"都靠它。
   */
  lineageId: string | null;
  sortOrder: number;
  sourceText: string;
  imagePrompt: string;
  videoPrompt: string;
  durationPlannedMs: number;
  durationLockedMs: number | null;
  keyframeSelectedTakeId: string | null;
  videoSelectedTakeId: string | null;
  keyframeStale: boolean;
  videoStale: boolean;
  staleReasonsJson: string;
  // 影视语义字段：取值域见 @ovideo/shared 的 SHOT_SIZES 等；未填时服务端存空串而非 null
  shotSize: string;
  cameraAngle: string;
  cameraMovement: string;
  composition: string;
  transition: string;
  tags: ShotTagItem[];
  dialogue: DialogueLineItem[];
}

export interface StoryboardDetail extends StoryboardSummary {
  scenes: SceneItem[];
  shots: ShotDetail[];
}

export interface JobEntity {
  id: string;
  projectId: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  executor: JobExecutorKind;
  input: unknown;
  output: unknown;
  error: string | null;
  providerConfigId: string | null;
  modelKey: string | null;
  batchId: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ApplyPatchResult {
  storyboard: StoryboardDetail;
  changedShotIds: string[];
  removedShotAssetIds: string[];
}

const JOB_TERMINAL_STATUS: JobStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELED'];

export function isJobFinished(status: JobStatus | undefined): boolean {
  return status !== undefined && JOB_TERMINAL_STATUS.includes(status);
}

/** ---------- 剧本稿 ---------- */

export function useScriptDrafts(episodeId: string) {
  return useQuery({
    queryKey: ['script-drafts', episodeId],
    queryFn: () => api<ScriptDraft[]>(`/episodes/${episodeId}/script-drafts`),
    enabled: episodeId !== '',
  });
}

export function useCreateScriptDraft(episodeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string; content?: string }) =>
      api<ScriptDraft>(`/episodes/${episodeId}/script-drafts`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['script-drafts', episodeId] });
    },
  });
}

export function useUpdateScriptDraft(episodeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      draftId,
      ...body
    }: {
      draftId: string;
      title?: string;
      content?: string;
      setMain?: boolean;
    }) => api<ScriptDraft>(`/script-drafts/${draftId}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['script-drafts', episodeId] });
    },
  });
}

/** ---------- 三步生成 + Job 轮询 ---------- */

/**
 * 发起三步生成。
 * directive 是分镜规划向导拼出来的中文导演说明（拆镜风格、目标时长、节奏等），
 * 服务端把它整段插进提示词的「导演要求」；不传时服务端行为与从前完全一致。
 */
export function useGenerateStoryboard() {
  return useMutation({
    mutationFn: ({
      draftId,
      modelConfigId,
      directive,
    }: {
      draftId: string;
      modelConfigId?: string;
      directive?: string;
    }) =>
      api<JobEntity>(`/script-drafts/${draftId}/generate-storyboard`, {
        method: 'POST',
        body: {
          ...(modelConfigId !== undefined ? { modelConfigId } : {}),
          ...(directive !== undefined && directive !== '' ? { directive } : {}),
        },
      }),
  });
}

/** 轮询单个 Job（终态自动停止） */
export function useJob(jobId: string | null) {
  return useQuery({
    queryKey: ['job', jobId ?? ''],
    queryFn: () => api<JobEntity>(`/jobs/${jobId}`),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return isJobFinished(status) ? false : 1500;
    },
    // 任务可能长达数分钟（视频生成），用户切走标签页也要继续跟进，
    // 回来时才有完成态和后续联动（自动选中新版本、重复标签检查等）
    refetchIntervalInBackground: true,
  });
}

/** 项目任务列表（用于任务徽标计数，轮询刷新） */
export function useProjectJobs(projectId: string) {
  return useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => api<JobEntity[]>(`/projects/${projectId}/jobs`),
    enabled: projectId !== '',
    refetchInterval: 3000,
  });
}

/** ---------- 分镜 ---------- */

export function useStoryboards(episodeId: string) {
  return useQuery({
    queryKey: ['storyboards', episodeId],
    queryFn: () => api<StoryboardSummary[]>(`/episodes/${episodeId}/storyboards`),
    enabled: episodeId !== '',
  });
}

export function useStoryboard(storyboardId: string | null) {
  return useQuery({
    queryKey: ['storyboard', storyboardId ?? ''],
    queryFn: () => api<StoryboardDetail>(`/storyboards/${storyboardId}`),
    enabled: storyboardId !== null,
  });
}

/**
 * 应用分镜补丁 → 服务端产出新 Storyboard 版本。
 * onSuccess：把新版本详情写入缓存并失效版本列表；调用方在 onSuccess 回调里把选中版本切到 storyboard.id。
 */
export function useApplyPatch(episodeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      storyboardId,
      patch,
      source = 'manual',
    }: {
      storyboardId: string;
      patch: StoryboardPatch;
      source?: string;
    }) =>
      api<ApplyPatchResult>(`/storyboards/${storyboardId}/apply-patch`, {
        method: 'POST',
        body: { patch, source },
      }),
    onSuccess: (result) => {
      qc.setQueryData(['storyboard', result.storyboard.id], result.storyboard);
      void qc.invalidateQueries({ queryKey: ['storyboards', episodeId] });
    },
  });
}
