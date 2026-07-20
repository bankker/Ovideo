import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiUpload } from './client';
import type { JobEntity, ScriptDraft } from './workflow-hooks';

/** ---------- 从想法生成剧本（对标 AI Studio：一句话 → 剧本稿） ---------- */

/** 生成请求：brief 必填，其余走服务端默认值 */
export interface GenerateScriptDraftInput {
  brief: string;
  /** 目标成片时长（秒），15..600，缺省 60 */
  durationSec?: number;
  /** 风格与受众补充，≤200 */
  style?: string;
  /** 文本模型；不传走自动调度 */
  modelConfigId?: string;
}

/**
 * 服务端先落一条空内容草稿再入队 Job，所以这里同时拿到 draft 和 job：
 * draft 用于立刻选中（用户能看见"正在写的那一稿"），job 用于轮询进度。
 */
export interface GenerateScriptDraftResult {
  draft: ScriptDraft;
  job: JobEntity;
}

export function useGenerateScriptDraft(episodeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GenerateScriptDraftInput) =>
      api<GenerateScriptDraftResult>(`/episodes/${episodeId}/script-drafts/generate`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      // 空稿此刻已存在，先让左栏列表把它显示出来，避免"点了没反应"的错觉
      void qc.invalidateQueries({ queryKey: ['script-drafts', episodeId] });
    },
  });
}

/** ---------- 对话改剧本正文（文稿 + 对话并置的写侧能力） ---------- */

/** 改写结果：一句话摘要 + 改写后的完整正文（服务端不写库） */
export interface RewriteScriptResult {
  summary: string;
  script: string;
}

export interface RewriteScriptInput {
  draftId: string;
  /** 用户的修改指令，1..1000 */
  message: string;
  /** 文本模型；不传走自动调度 */
  modelConfigId?: string;
}

/**
 * 对话改剧本：POST /api/script-drafts/:id/rewrite
 * 刻意不做 invalidate——服务端只返回改写结果、不落库，
 * 缓存要等用户在气泡里点「采纳」、走 useUpdateScriptDraft 之后才该变。
 * 这样"模型说了什么"与"草稿变成了什么"始终是两件可分辨的事，撤销才有意义。
 */
export function useRewriteScript() {
  return useMutation({
    mutationFn: ({ draftId, message, modelConfigId }: RewriteScriptInput) =>
      api<RewriteScriptResult>(`/script-drafts/${draftId}/rewrite`, {
        method: 'POST',
        body: { message, ...(modelConfigId !== undefined ? { modelConfigId } : {}) },
      }),
  });
}

/** 上传 .txt / .md 纯文本导入为剧本稿（multipart，字段名 file） */
export function useImportScriptDraft(episodeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) =>
      apiUpload<ScriptDraft>(`/episodes/${episodeId}/script-drafts/import`, file),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['script-drafts', episodeId] });
    },
  });
}
