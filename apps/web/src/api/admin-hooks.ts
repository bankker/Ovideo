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

/** 平台预置模板中的模型条目（GET /admin/provider-presets） */
export interface ProviderPresetModel {
  key: string;
  label: string;
  modality: Modality;
  /** 推荐模型：新增厂商第二步默认勾选 */
  recommended?: boolean;
  /** 灰字注释（如"视频适配器 M3 接入后可用"）；带 note 的默认不勾选 */
  note?: string;
  capability?: Record<string, unknown>;
}

export interface ProviderPreset {
  id: string;
  name: string;
  vendor: string;
  baseUrl: string;
  /** 平台说明（选中预置后展示） */
  note?: string;
  models: ProviderPresetModel[];
}

/** POST /admin/providers/:id/discover-models 返回的模型条目 */
export interface DiscoveredModel {
  key: string;
  label: string;
  modality: Modality;
  /** 该厂商下已存在同 key 模型（置灰不可选） */
  exists: boolean;
}

/** POST /admin/providers/:id/models/batch 的单条模型 */
export interface BatchModelInput {
  key: string;
  label?: string;
  modality: Modality;
  capability?: Record<string, unknown>;
}

export interface BatchModelsResult {
  created: number;
  skipped: number;
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

/** 贴 key 一键接入：识别平台 → 建/更新厂商 → 导入预置模型 → 连通测试 */
export interface AutoConfigKeyResult {
  matched: boolean;
  platform?: { id: string; name: string };
  providerId?: string;
  action?: 'created' | 'updated';
  imported?: { created: number; skipped: number };
  test?: ProviderTestResult;
  message: string;
  probed?: Array<{ platform: string; status: string }>;
}

export function useAutoConfigKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (apiKey: string) =>
      // 注意：api() 内部会 JSON.stringify，这里必须传对象（传字符串会双重序列化导致服务端 400）
      api<AutoConfigKeyResult>('/admin/auto-config-key', {
        method: 'POST',
        body: { apiKey },
      }),
    onSuccess: (r) => {
      if (r.matched) void qc.invalidateQueries({ queryKey: ['providers'] });
    },
  });
}

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

/** ---------- 平台预置 / 模型自动发现 / 批量导入 ---------- */

/** 平台预置模板列表（新增厂商弹窗用；enabled 控制仅弹窗打开时拉取） */
export function useProviderPresets(enabled = true) {
  return useQuery({
    queryKey: ['provider-presets'],
    queryFn: async () => (await api<{ presets: ProviderPreset[] }>('/admin/provider-presets')).presets,
    enabled,
    staleTime: 5 * 60_000, // 预置模板基本不变，5 分钟内不重复拉取
  });
}

/** 调厂商 /models 接口自动发现模型（服务端代理，502 错误文案透传） */
export function useDiscoverModels() {
  return useMutation({
    mutationFn: async (providerId: string) =>
      (await api<{ models: DiscoveredModel[] }>(`/admin/providers/${providerId}/discover-models`, { method: 'POST' }))
        .models,
  });
}

/** 批量导入模型（同 key 已存在的服务端跳过，返回 created/skipped 计数） */
export function useBatchCreateModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ providerId, models }: { providerId: string; models: BatchModelInput[] }) =>
      api<BatchModelsResult>(`/admin/providers/${providerId}/models/batch`, { method: 'POST', body: { models } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });
}
