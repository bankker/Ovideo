import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateProjectBody, CreateEpisodeBody } from '@ovideo/shared';
import { api } from './client';

/** ---------- 响应实体（与 Prisma 模型字段一致，日期为 ISO 字符串） ---------- */
export interface Project {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Episode {
  id: string;
  projectId: string;
  title: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** PATCH body（shared 仅导出 schema，此处按契约给出 TS 形状） */
export interface UpdateProjectInput {
  name?: string;
  description?: string;
  archived?: boolean;
}

export interface UpdateEpisodeInput {
  title?: string;
  sortOrder?: number;
}

/**
 * queryKey 约定：
 * - 项目列表 ['projects', { archived }]（前缀 ['projects']，invalidate 用前缀即可）
 * - 项目详情 ['project', id]
 * - 分集列表 ['episodes', projectId]
 */

/** ---------- 项目 ---------- */
export function useProjects(archived: boolean) {
  return useQuery({
    queryKey: ['projects', { archived }],
    queryFn: () =>
      api<Project[]>('/projects', { query: { archived: archived ? 1 : undefined } }),
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ['project', id],
    queryFn: () => api<Project>(`/projects/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectBody) =>
      api<Project>('/projects', { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateProjectInput }) =>
      api<Project>(`/projects/${id}`, { method: 'PATCH', body: data }),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project', variables.id] });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<unknown>(`/projects/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/** ---------- 分集 ---------- */
export function useEpisodes(projectId: string | undefined) {
  return useQuery({
    queryKey: ['episodes', projectId],
    queryFn: () => api<Episode[]>(`/projects/${projectId}/episodes`),
    enabled: Boolean(projectId),
  });
}

export function useCreateEpisode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, data }: { projectId: string; data: CreateEpisodeBody }) =>
      api<Episode>(`/projects/${projectId}/episodes`, { method: 'POST', body: data }),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['episodes', variables.projectId] });
    },
  });
}

export function useUpdateEpisode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; projectId: string; data: UpdateEpisodeInput }) =>
      api<Episode>(`/episodes/${id}`, { method: 'PATCH', body: data }),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['episodes', variables.projectId] });
    },
  });
}

export function useDeleteEpisode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; projectId: string }) =>
      api<unknown>(`/episodes/${id}`, { method: 'DELETE' }),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['episodes', variables.projectId] });
    },
  });
}
