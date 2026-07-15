/**
 * 后台（厂商/模型）与 Job 面板的数据层 hooks。
 * queryKey 约定：providers → ['providers']；jobs → ['jobs', projectId]。
 * 服务端响应无包壳：列表为数组，详情为对象；错误 { error } 已由 client.ts 抛 Error。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type {
  JobExecutorKind,
  JobStatus,
  Modality,
  ProviderCategory,
} from '@ovideo/shared';

/** ---------- 类型（响应形状 = Prisma 模型；Job 的 input/output 已被服务端解析为对象） ---------- */

export interface JobItem {
  id: string;
  projectId: string;
  /** JobType；后端可能扩展，保留 string 兜底展示 */
  type: string;
  status: JobStatus;
  progress: number;
  executor: JobExecutorKind;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string | null;
  providerConfigId?: string | null;
  modelKey?: string | null;
  batchId?: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface ModelItem {
  id: string;
  providerConfigId: string;
  key: string;
  label: string;
  modality: Modality;
  /** 原始 JSON 字符串（服务端不解析） */
  capabilityJson: string;
  enabled: boolean;
  sortOrder: number;
}

export interface ProviderItem {
  id: string;
  name: string;
  vendor: string;
  category: ProviderCategory;
  baseUrl: string;
  /** 服务端已脱敏 */
  apiKey: string;
  enabled: boolean;
  metaJson: string;
  createdAt: string;
  updatedAt: string;
  /** GET /admin/providers 返回时通常携带；缺省时用 useProviderModels 单独拉取 */
  models?: ModelItem[];
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  message?: string;
}

export interface ProviderUpsertBody {
  name?: string;
  vendor?: string;
  category?: ProviderCategory;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
}

export interface ModelUpsertBody {
  key?: string;
  label?: string;
  modality?: Modality;
  capability?: Record<string, unknown>;
  enabled?: boolean;
  sortOrder?: number;
}

/** ---------- Job ---------- */

export function useJobs(projectId: string) {
  return useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => api<JobItem[]>(`/projects/${projectId}/jobs`, { query: { limit: 50 } }),
    refetchInterval: 2000,
    enabled: !!projectId,
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api<JobItem>(`/jobs/${jobId}/cancel`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
}

export function useRetryJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api<JobItem>(`/jobs/${jobId}/retry`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
}

/** ---------- 厂商 ---------- */

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => api<ProviderItem[]>('/admin/providers'),
  });
}

export function useCreateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProviderUpsertBody) => api<ProviderItem>('/admin/providers', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}

export function useUpdateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ProviderUpsertBody }) =>
      api<ProviderItem>(`/admin/providers/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}

export function useDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<unknown>(`/admin/providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}

export function useTestProvider() {
  return useMutation({
    mutationFn: (id: string) => api<ProviderTestResult>(`/admin/providers/${id}/test`, { method: 'POST' }),
  });
}

/** ---------- 模型 ---------- */

/** GET /admin/providers 未带 models 时的兜底拉取 */
export function useProviderModels(providerId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['providers', providerId, 'models'],
    queryFn: () => api<ModelItem[]>(`/admin/providers/${providerId}/models`),
    enabled,
  });
}

export function useCreateModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ providerId, body }: { providerId: string; body: ModelUpsertBody }) =>
      api<ModelItem>(`/admin/providers/${providerId}/models`, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}

export function useUpdateModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ModelUpsertBody }) =>
      api<ModelItem>(`/admin/models/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}

export function useDeleteModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<unknown>(`/admin/models/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}
