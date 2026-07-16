import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssetSource,
  AssetStatus,
  AssetType,
  CapabilityEntry,
  Modality,
  TagType,
} from '@ovideo/shared';
import { api, apiUpload } from './client';
import type { JobEntity } from './workflow-hooks';

/** ---------- 响应实体类型（形状 = Prisma 模型，日期为 ISO 字符串） ---------- */

export interface TagEntity {
  id: string;
  projectId: string;
  type: TagType;
  name: string;
  description: string;
  canonicalAssetId: string | null;
  createdAt: string;
}

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

/** 标签候选设计图（TagDesign & { asset }） */
export interface TagDesignEntity {
  id: string;
  tagId: string;
  assetId: string;
  createdAt: string;
  asset: AssetEntity;
}

export interface TagDesignsResponse {
  tag: TagEntity;
  designs: TagDesignEntity[];
}

export interface DesignUploadResult {
  asset: AssetEntity;
  design: { id: string; tagId: string; assetId: string; createdAt: string };
}

/** ---------- 素材页（resolved-bindings）实体 ---------- */

/** 来源层级：shot = 镜头级覆盖；tag = 标签级默认 */
/** shot=镜头级覆盖 > tag=标签级默认绑定 > design=默认设计图回落（未绑定时生成的实际取用） */
export type BindingLevel = 'shot' | 'tag' | 'design';

export interface ResolvedBindingCell {
  tagId: string;
  name: string;
  type: TagType;
  resolved: null | {
    assetId: string;
    uri: string;
    thumbUri: string | null;
    level: BindingLevel;
  };
}

export interface ResolvedBindingShotRow {
  shotId: string;
  sortOrder: number;
  /** 镜头生图提示词——前端据此计算每格"参考位状态"（@ 提及/自动策略） */
  imagePrompt: string;
  tags: ResolvedBindingCell[];
}

export interface ResolvedBindingsResponse {
  shots: ResolvedBindingShotRow[];
}

export interface BindingEntity {
  id: string;
  episodeId: string;
  tagId: string;
  /** null = 标签级默认；非 null = 镜头级覆盖 */
  shotId: string | null;
  shotKey: string;
  assetId: string;
  updatedAt: string;
}

/** PUT bindings 返回：binding=null 表示删除；affectedShotIds 为失效传播波及的镜头（服务端接入后返回） */
export interface PutBindingResult {
  binding: BindingEntity | null;
  affectedShotIds?: string[];
}

/**
 * queryKey 约定：
 * - 项目标签 ['tags', projectId]
 * - 标签候选设计图 ['designs', tagId]
 * - 解析绑定矩阵 ['resolved-bindings', storyboardId]
 * - 分集原始绑定行 ['bindings', episodeId]
 * - 模型能力 ['capabilities', modality]
 */

/** ---------- 标签 ---------- */

export function useProjectTags(projectId: string) {
  return useQuery({
    queryKey: ['tags', projectId],
    queryFn: () => api<TagEntity[]>(`/projects/${projectId}/tags`),
    enabled: projectId !== '',
  });
}

/** 疑似重复标签检测（LLM 语义判重，离线走启发式） */
export interface DuplicateTagGroup {
  type: string;
  tags: Array<{ id: string; name: string }>;
  suggestedName: string;
}

export function useCheckTagDuplicates(projectId: string) {
  return useMutation({
    mutationFn: () =>
      api<{ groups: DuplicateTagGroup[]; method: 'llm' | 'heuristic' }>(
        `/projects/${projectId}/tag-duplicates`,
      ),
  });
}

export function useMergeTags(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceTagId, targetTagId }: { sourceTagId: string; targetTagId: string }) =>
      api(`/tags/${sourceTagId}/merge`, { method: 'POST', body: { targetTagId } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tags', projectId] });
      void qc.invalidateQueries({ queryKey: ['designs'] });
      void qc.invalidateQueries({ queryKey: ['resolved-bindings'] });
      void qc.invalidateQueries({ queryKey: ['bindings'] });
      void qc.invalidateQueries({ queryKey: ['storyboard'] });
    },
  });
}

/** 更新标签（重命名/改描述/设默认参考） */
export function useUpdateTag(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tagId, ...body }: { tagId: string; name?: string; description?: string }) =>
      api<TagEntity>(`/tags/${tagId}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tags', projectId] });
      void qc.invalidateQueries({ queryKey: ['resolved-bindings'] });
      void qc.invalidateQueries({ queryKey: ['storyboard'] });
    },
  });
}

export function useCreateTag(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { type: TagType; name: string; description?: string }) =>
      api<TagEntity>(`/projects/${projectId}/tags`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tags', projectId] });
    },
  });
}

/** ---------- 标签候选设计图 ---------- */

export function useTagDesigns(tagId: string | null) {
  return useQuery({
    queryKey: ['designs', tagId ?? ''],
    queryFn: () => api<TagDesignsResponse>(`/tags/${tagId}/designs`),
    enabled: tagId !== null && tagId !== '',
  });
}

/** AI 生成候选设计图 → 返回 Job，由调用方轮询（useJob）并在 SUCCEEDED 后 invalidate designs */
export function useGenerateDesign() {
  return useMutation({
    mutationFn: ({
      tagId,
      prompt,
      modelConfigId,
    }: {
      tagId: string;
      prompt?: string;
      modelConfigId?: string;
    }) =>
      api<JobEntity>(`/tags/${tagId}/designs/generate`, {
        method: 'POST',
        body: { prompt, modelConfigId },
      }),
  });
}

export function useUploadDesign(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tagId, file }: { tagId: string; file: File }) =>
      apiUpload<DesignUploadResult>(`/tags/${tagId}/designs/upload`, file),
    onSuccess: (_result, { tagId }) => {
      void qc.invalidateQueries({ queryKey: ['designs', tagId] });
      // 首张上传自动 canonical，标签列表带 canonicalAssetId
      void qc.invalidateQueries({ queryKey: ['tags', projectId] });
    },
  });
}

/** 设为默认参考图（assetId 必须属于该标签的候选） */
export function useSetCanonical(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tagId, assetId }: { tagId: string; assetId: string }) =>
      api<TagEntity>(`/tags/${tagId}/canonical`, { method: 'POST', body: { assetId } }),
    onSuccess: (_result, { tagId }) => {
      void qc.invalidateQueries({ queryKey: ['designs', tagId] });
      void qc.invalidateQueries({ queryKey: ['tags', projectId] });
    },
  });
}

/** 解除候选关联（只删 TagDesign 行，不删资产；恰为 canonical 时服务端清空指针） */
export function useRemoveDesign(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ designId }: { designId: string; tagId: string }) =>
      api<{ tag: TagEntity }>(`/designs/${designId}`, { method: 'DELETE' }),
    onSuccess: (_result, { tagId }) => {
      void qc.invalidateQueries({ queryKey: ['designs', tagId] });
      void qc.invalidateQueries({ queryKey: ['tags', projectId] });
    },
  });
}

/** ---------- 模型能力（选模型 Select 数据源；空列表 = 隐藏选择器走 Mock） ---------- */

export function useCapabilities(modality: Modality) {
  return useQuery({
    queryKey: ['capabilities', modality],
    queryFn: () => api<CapabilityEntry[]>('/capabilities', { query: { modality } }),
    staleTime: 60_000,
  });
}

/** ---------- 素材页：解析矩阵 + 换绑 ---------- */

export function useResolvedBindings(storyboardId: string | null) {
  return useQuery({
    queryKey: ['resolved-bindings', storyboardId ?? ''],
    queryFn: () => api<ResolvedBindingsResponse>(`/storyboards/${storyboardId}/resolved-bindings`),
    enabled: storyboardId !== null,
  });
}

/** 分集原始绑定行（标签级默认 = shotId 为 null 的行） */
export function useEpisodeBindings(episodeId: string) {
  return useQuery({
    queryKey: ['bindings', episodeId],
    queryFn: () => api<BindingEntity[]>(`/episodes/${episodeId}/bindings`),
    enabled: episodeId !== '',
  });
}

/**
 * 写绑定：shotId 为 null = 标签级默认，非 null = 镜头级覆盖；assetId 为 null = 解除该级绑定。
 * 成功后失效 解析矩阵（前缀）与原始绑定行。
 */
export function usePutBinding(episodeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { tagId: string; shotId: string | null; assetId: string | null }) =>
      api<PutBindingResult>(`/episodes/${episodeId}/bindings`, { method: 'PUT', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['resolved-bindings'] });
      void qc.invalidateQueries({ queryKey: ['bindings', episodeId] });
    },
  });
}
