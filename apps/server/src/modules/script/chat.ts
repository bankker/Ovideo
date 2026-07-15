import type { PrismaClient } from '@prisma/client';
import type { StoryboardPatch } from '@ovideo/shared';
import { StoryboardPatchSchema } from '@ovideo/shared';
import { badRequest, notFound } from '../../lib/errors.js';

/**
 * 对话式剧本修改（v2 §4）：用户一句话指令 → LLM 产出 StoryboardPatch 变更集。
 * 【铁律】本模块只返回 patch 预览，绝不落库——diff 预览由前端展示，
 * 用户点「应用」后另行走 storyboard 的 applyPatch（v2 §4.3）。
 */

/** prompt 中包裹当前分镜 JSON / 用户指令的分隔符（mockChatGen 依赖它们提取内容） */
export const CHAT_SHOTS_BEGIN = '<<<当前分镜JSON>>>';
export const CHAT_SHOTS_END = '<<<当前分镜JSON结束>>>';
export const CHAT_MESSAGE_BEGIN = '<<<用户指令>>>';
export const CHAT_MESSAGE_END = '<<<用户指令结束>>>';

export type ChatTextGenFn = (prompt: string) => Promise<string>;

export interface ScriptChatInput {
  scriptDraftId: string;
  baseStoryboardId: string;
  message: string;
}

export interface ScriptChatResult {
  /** 针对基底分镜的变更集（仅预览，未应用） */
  patch: StoryboardPatch;
  /** LLM 的一句话说明：改了什么 */
  summary: string;
}

/** 送入 prompt 的紧凑镜头 JSON（长字段截断，控制上下文体积） */
interface CompactShot {
  id: string;
  sourceText: string;
  imagePrompt: string;
  videoPrompt: string;
  durationPlannedMs: number;
  tags: Array<{ name: string; type: string }>;
  dialogue: Array<{ speaker?: string; isNarrator: boolean; text: string }>;
}

function truncate(text: string, n: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > n ? `${single.slice(0, n)}…` : single;
}

/** 剥掉 ```json 围栏后解析（与 generate.ts 同规则） */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw).trim();
  return JSON.parse(text);
}

export function buildChatPrompt(
  shots: CompactShot[],
  tags: Array<{ name: string; type: string }>,
  message: string,
): string {
  const byType = (type: string, label: string) => {
    const names = tags.filter((t) => t.type === type).map((t) => t.name);
    return `${label}：${names.length > 0 ? names.join('、') : '（无）'}`;
  };
  return [
    '你是分镜编辑助手。根据用户指令对当前分镜做最小变更，只输出 JSON，不要输出任何解释文字。',
    '当前分镜（紧凑 JSON，按镜头顺序，长文本已截断）：',
    CHAT_SHOTS_BEGIN,
    JSON.stringify(shots),
    CHAT_SHOTS_END,
    '项目已有标签词表如下，语义相同的角色/场景/道具必须复用下列同名标签，不得另造别名：',
    byType('CHARACTER', '角色'),
    byType('SCENE', '场景'),
    byType('PROP', '道具'),
    '用户指令：',
    CHAT_MESSAGE_BEGIN,
    message,
    CHAT_MESSAGE_END,
    '输出格式（严格遵守）：只输出一个 JSON 对象 {"summary":"一句话说明改了什么","patch":[...]}。',
    'patch 是操作数组，每个元素必须是下列四种之一：',
    '{"op":"add_shot","afterShotId":"插入到该镜头之后（null 或省略 = 追加到末尾）","shot":{"sourceText":"","imagePrompt":"","videoPrompt":"","durationPlannedMs":12000,"tags":[{"name":"标签名","type":"CHARACTER|SCENE|PROP"}],"dialogue":[{"speaker":"角色标签名（旁白则省略）","isNarrator":false,"text":"台词"}]}}',
    '{"op":"update_shot","shotId":"镜头id","fields":{只写要改的字段，结构同 shot}}',
    '{"op":"remove_shot","shotId":"镜头id"}',
    '{"op":"reorder","shotIds":["全量镜头 id 的新顺序"]}',
    'shotId / afterShotId / shotIds 必须使用上面「当前分镜」里的真实 id；未被指令触及的镜头不要输出任何操作。',
  ].join('\n');
}

/**
 * 对话式修改工厂。textGen 由集成阶段注入
 * （API 执行走 openai-compatible 适配器，Mock/演示走 mockChatGen）。
 */
export function createScriptChat({ textGen }: { textGen: ChatTextGenFn }) {
  return async function scriptChat(
    db: PrismaClient,
    input: ScriptChatInput,
  ): Promise<ScriptChatResult> {
    const draft = await db.scriptDraft.findUnique({
      where: { id: input.scriptDraftId },
      include: { episode: true },
    });
    if (!draft) throw notFound('剧本稿');

    const storyboard = await db.storyboard.findUnique({
      where: { id: input.baseStoryboardId },
      include: {
        shots: {
          orderBy: { sortOrder: 'asc' },
          include: {
            tags: { include: { tag: true } },
            dialogue: { orderBy: { sortOrder: 'asc' } },
          },
        },
      },
    });
    if (!storyboard) throw notFound('基底分镜');
    if (storyboard.episodeId !== draft.episodeId) throw badRequest('基底分镜不属于该剧本稿的分集');

    // 标签词表注入（v2 §4.2）：每轮对话携带项目现有标签清单，要求 LLM 复用
    const projectTags = await db.tag.findMany({
      where: { projectId: draft.episode.projectId },
      orderBy: { createdAt: 'asc' },
    });
    const tagNameById = new Map(projectTags.map((t) => [t.id, t.name]));

    const compact: CompactShot[] = storyboard.shots.map((s) => ({
      id: s.id,
      sourceText: truncate(s.sourceText, 120),
      imagePrompt: truncate(s.imagePrompt, 80),
      videoPrompt: truncate(s.videoPrompt, 80),
      durationPlannedMs: s.durationPlannedMs,
      tags: s.tags.map((st) => ({ name: st.tag.name, type: st.tag.type })),
      dialogue: s.dialogue.map((d) => {
        const speaker = d.speakerTagId ? tagNameById.get(d.speakerTagId) : undefined;
        return { ...(speaker ? { speaker } : {}), isNarrator: d.isNarrator, text: d.text };
      }),
    }));

    const prompt = buildChatPrompt(
      compact,
      projectTags.map((t) => ({ name: t.name, type: t.type })),
      input.message,
    );

    const attempt = async (): Promise<ScriptChatResult> => {
      const parsed = extractJson(await textGen(prompt)) as { summary?: unknown; patch?: unknown };
      return {
        patch: StoryboardPatchSchema.parse(parsed.patch),
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      };
    };
    try {
      return await attempt();
    } catch {
      // 结构化输出失败重试一次；第二次仍失败 → 400 让用户换个说法
      try {
        return await attempt();
      } catch {
        throw badRequest('AI 返回的修改指令无法解析，请换个说法');
      }
    }
  };
}

// ---------------- Mock 实现（无 key 也能演示对话式修改） ----------------

/** mockChatGen 从 prompt 里提取出的镜头骨架 */
interface PromptShot {
  id: string;
  sourceText: string;
  durationPlannedMs: number;
}

function extractBetween(prompt: string, begin: string, end: string): string | null {
  const m = prompt.match(new RegExp(`${begin}\\n([\\s\\S]*?)\\n${end}`));
  return m ? m[1] : null;
}

function extractShots(prompt: string): PromptShot[] {
  const raw = extractBetween(prompt, CHAT_SHOTS_BEGIN, CHAT_SHOTS_END);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .filter((s) => typeof s.id === 'string')
      .map((s) => ({
        id: s.id as string,
        sourceText: typeof s.sourceText === 'string' ? s.sourceText : '',
        durationPlannedMs:
          typeof s.durationPlannedMs === 'number' && s.durationPlannedMs > 0
            ? Math.floor(s.durationPlannedMs)
            : 12000,
      }));
  } catch {
    return [];
  }
}

const EMPTY_SHOT = {
  sourceText: '',
  imagePrompt: '',
  videoPrompt: '',
  durationPlannedMs: 12000,
  tags: [] as Array<{ name: string; type: string }>,
  dialogue: [] as Array<{ isNarrator: boolean; text: string }>,
};

/**
 * Mock 对话生成：从 prompt 分隔符中提取当前分镜与用户指令，
 * 按确定性规则处理常见指令，返回 { summary, patch } 的 JSON 字符串。
 */
export async function mockChatGen(prompt: string): Promise<string> {
  const shots = extractShots(prompt);
  const message = (extractBetween(prompt, CHAT_MESSAGE_BEGIN, CHAT_MESSAGE_END) ?? '').trim();
  const reply = (summary: string, patch: unknown[]) => JSON.stringify({ summary, patch });
  const outOfRange = (n: number) =>
    reply(`第 ${n} 个镜头不存在（当前共 ${shots.length} 个镜头）`, []);

  // 规则一：改成 N 个镜头 / 合并成 N 个
  const count = message.match(/改成\s*(\d+)\s*个镜头|合并.*(\d+)/);
  if (count) {
    const target = Number(count[1] ?? count[2]);
    if (target >= 1 && shots.length > 0) {
      if (target < shots.length) {
        // 从尾部删多余镜头，其 sourceText 合并进保留的最后一个，时长相加（上限 15000）
        const kept = shots[target - 1];
        const removed = shots.slice(target);
        const mergedText = [kept.sourceText, ...removed.map((s) => s.sourceText)]
          .filter((t) => t.length > 0)
          .join('\n');
        const mergedDuration = Math.min(
          15000,
          removed.reduce((sum, s) => sum + s.durationPlannedMs, kept.durationPlannedMs),
        );
        return reply(`已把 ${shots.length} 个镜头合并为 ${target} 个`, [
          ...removed.map((s) => ({ op: 'remove_shot', shotId: s.id })),
          {
            op: 'update_shot',
            shotId: kept.id,
            fields: { sourceText: mergedText, durationPlannedMs: mergedDuration },
          },
        ]);
      }
      if (target === shots.length) {
        return reply(`当前已经是 ${target} 个镜头，无需修改`, []);
      }
      // target > 当前数：追加空镜头补足
      const patch = Array.from({ length: target - shots.length }, () => ({
        op: 'add_shot',
        shot: { ...EMPTY_SHOT },
      }));
      return reply(`已追加 ${target - shots.length} 个空镜头，补足到 ${target} 个`, patch);
    }
  }

  // 规则二：删除第 N 个镜头
  const del = message.match(/删除.*第\s*(\d+)\s*个?镜头|删掉.*镜头\s*(\d+)/);
  if (del) {
    const n = Number(del[1] ?? del[2]);
    if (n < 1 || n > shots.length) return outOfRange(n);
    return reply(`已删除第 ${n} 个镜头`, [{ op: 'remove_shot', shotId: shots[n - 1].id }]);
  }

  // 规则三：第 N 个镜头改成/改为 <新文本>
  const rewrite = message.match(/第\s*(\d+)\s*个?镜头.*(?:改成|改为)(.+)/);
  if (rewrite) {
    const n = Number(rewrite[1]);
    const text = rewrite[2].trim();
    if (n < 1 || n > shots.length) return outOfRange(n);
    if (text.length > 0) {
      return reply(`已把第 ${n} 个镜头的内容改为「${truncate(text, 20)}」`, [
        { op: 'update_shot', shotId: shots[n - 1].id, fields: { sourceText: text } },
      ]);
    }
  }

  return reply('未能理解指令，请尝试如「改成 3 个镜头」「删除第 2 个镜头」', []);
}
