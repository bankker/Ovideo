import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssetSource, AssetStatus, AssetType } from '@ovideo/shared';
import { api, apiUpload } from './client';

/** ---------- 响应实体类型（形状 = Prisma Asset 模型，日期为 ISO 字符串） ---------- */

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

export interface AssetLineage {
  asset: AssetEntity;
  /** 近祖先在前（BFS 层序） */
  ancestors: AssetEntity[];
  descendants: AssetEntity[];
}

/** ---------- 展示用中文映射（素材库/历史页共用） ---------- */

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  IMAGE: '图片',
  VIDEO: '视频',
  AUDIO: '音频',
  FRAME: '帧',
  VOICE_SAMPLE: '音色样本',
  FINAL: '成片',
};

export const ASSET_TYPE_COLOR: Record<AssetType, string> = {
  IMAGE: 'blue',
  VIDEO: 'purple',
  AUDIO: 'cyan',
  FRAME: 'geekblue',
  VOICE_SAMPLE: 'cyan',
  FINAL: 'gold',
};

export const ASSET_SOURCE_LABEL: Record<AssetSource, string> = {
  GENERATED: 'AI 生成',
  UPLOADED: '上传',
  EXTRACTED: '提取',
};

/** ---------- 查询 hooks ---------- */

export interface EpisodeAssetsFilter {
  type?: AssetType;
}

/** 本集素材（被本集 takes/bindings/dubbing 引用的资产） */
export function useEpisodeAssets(episodeId: string, filters: EpisodeAssetsFilter = {}) {
  return useQuery({
    queryKey: ['episode-assets', episodeId, filters],
    queryFn: () =>
      api<AssetEntity[]>(`/episodes/${episodeId}/assets`, { query: { type: filters.type } }),
    enabled: episodeId !== '',
  });
}

export interface ProjectAssetsFilter {
  type?: AssetType;
  /** 缺省服务端只返回 ACTIVE；回收站显式传 RECYCLED */
  status?: AssetStatus;
  source?: AssetSource;
}

/** 全部素材（项目级资产库） */
export function useProjectAssets(projectId: string, filters: ProjectAssetsFilter = {}) {
  return useQuery({
    queryKey: ['project-assets', projectId, filters],
    queryFn: () =>
      api<AssetEntity[]>(`/projects/${projectId}/assets`, {
        query: { type: filters.type, status: filters.status, source: filters.source },
      }),
    enabled: projectId !== '',
  });
}

export interface GeneratedAssetsFilter {
  type?: AssetType;
}

/** 生成历史（AI 生成产物流水） */
export function useGeneratedAssets(projectId: string, filters: GeneratedAssetsFilter = {}) {
  return useQuery({
    queryKey: ['generated-assets', projectId, filters],
    queryFn: () =>
      api<AssetEntity[]>(`/projects/${projectId}/assets/generated`, {
        query: { type: filters.type },
      }),
    enabled: projectId !== '',
  });
}

/** 资产血缘（ancestors/descendants 双向 BFS 结果） */
export function useAssetLineage(assetId: string | null) {
  return useQuery({
    queryKey: ['lineage', assetId ?? ''],
    queryFn: () => api<AssetLineage>(`/assets/${assetId}/lineage`),
    enabled: assetId !== null,
  });
}

/** ---------- 变更 hooks ---------- */

/** 失效所有资产列表缓存（上传/回收/恢复后调用） */
function invalidateAssetLists(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['episode-assets'] });
  void qc.invalidateQueries({ queryKey: ['project-assets'] });
  void qc.invalidateQueries({ queryKey: ['generated-assets'] });
}

export function useUploadAsset(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => apiUpload<AssetEntity>(`/projects/${projectId}/assets/upload`, file),
    onSuccess: () => invalidateAssetLists(qc),
  });
}

export function useRecycleAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assetId: string) => api<AssetEntity>(`/assets/${assetId}/recycle`, { method: 'POST' }),
    onSuccess: () => invalidateAssetLists(qc),
  });
}

export function useRestoreAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assetId: string) => api<AssetEntity>(`/assets/${assetId}/restore`, { method: 'POST' }),
    onSuccess: () => invalidateAssetLists(qc),
  });
}
