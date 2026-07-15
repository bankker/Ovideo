import { useMutation } from '@tanstack/react-query';
import type { StoryboardPatch } from '@ovideo/shared';
import { api } from './client';

/** ---------- 对话修改（v2 §4：多轮对话产出 patch → diff 预览 → 确认应用） ---------- */

/** 单轮对话的服务端返回：结构化补丁 + 中文摘要 */
export interface ScriptChatResult {
  patch: StoryboardPatch;
  summary: string;
}

/**
 * 剧本对话修改：POST /api/script-drafts/:draftId/chat
 * body: { message, baseStoryboardId }（基于当前选中的分镜版本产出变更集）。
 * 返回的 patch 由调用方经 useApplyPatch(source='chat') 应用后落为新 Storyboard 版本。
 */
export function useScriptChat() {
  return useMutation({
    mutationFn: ({
      draftId,
      message,
      baseStoryboardId,
    }: {
      draftId: string;
      message: string;
      baseStoryboardId: string;
    }) =>
      api<ScriptChatResult>(`/script-drafts/${draftId}/chat`, {
        method: 'POST',
        body: { message, baseStoryboardId },
      }),
  });
}
