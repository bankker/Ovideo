import type { PrismaClient, Tag } from '@prisma/client';
import type { StoryboardPatch } from '@ovideo/shared';
import { GeneratedStoryboardSchema, type GeneratedStoryboard } from '@ovideo/shared';
import { badRequest, notFound } from '../../lib/errors.js';
import { parseJson } from '../../lib/json.js';
import { findOrCreateTags } from '../tag/service.js';
import { applyPatch } from '../storyboard/service.js';

/** prompt 中包裹剧本原文的分隔符（mockTextGen 依赖它提取原文） */
export const SCRIPT_BEGIN = '<<<剧本原文>>>';
export const SCRIPT_END = '<<<剧本原文结束>>>';

/** 与 job 模块的 JobExecutor 结构兼容（不 import，按结构类型解耦） */
export interface StoryboardGeneratorCtx {
  db: PrismaClient;
  job: { inputJson: string };
  updateProgress: (p: number) => Promise<void>;
}

export type TextGenFn = (prompt: string) => Promise<string>;

export function buildStoryboardPrompt(script: string, tags: Array<Pick<Tag, 'name' | 'type'>>): string {
  const byType = (type: string, label: string) => {
    const names = tags.filter((t) => t.type === type).map((t) => t.name);
    return `${label}：${names.length > 0 ? names.join('、') : '（无）'}`;
  };
  return [
    '你是专业的漫剧分镜师。请将下面的剧本拆分为分镜（镜头）列表。',
    '拆分策略（硬规则）：同场景无转场的连续剧情合并为一个镜头，每镜头约 10~15 秒（durationPlannedMs 取 10000~15000）；有转场处必须切镜头。',
    '每个镜头必须产出四件套：标签（tags）、对白（dialogue）、生图提示词（imagePrompt）、视频提示词（videoPrompt）。',
    '标签命名（硬规则，标签是全剧形象一致性的锚点）：',
    '1. 标签名必须是简短稳定的名词，不超过 6 个字，禁止包含标点或整句描述；',
    '2. 同一地点全剧必须用同一个场景标签（如统一用「办公室」；时间与氛围如"白天/明亮"写进 imagePrompt，绝不写进标签名）；',
    '3. 角色标签用剧本中的真实姓名，同一角色全剧同名；',
    '4. imagePrompt/videoPrompt 中出场的角色、道具、场景一律写成 @标签名（例："@办公室 内，@小悟 趴在 @办公桌 前疯狂打字"）——@ 后必须是 tags 数组里一字不差的标签名，【原样中文，严禁翻译、拆字或音译】（"小悟"绝不能写成 small悟 / Little Wu / Xiaowu）；@标签名 之后紧跟一个空格再接其他文字；',
    '5. 画面风格：这是漫剧（动画短剧），imagePrompt 一律采用动漫/漫画风格（anime/manga style），严禁写 realistic style 或写实风格，除非剧本明确要求。',
    '项目已有标签词表如下，语义相同的角色/场景/道具必须复用下列同名标签，不得另造别名：',
    byType('CHARACTER', '角色'),
    byType('SCENE', '场景'),
    byType('PROP', '道具'),
    '只输出一个 JSON 对象，不要输出任何解释文字。结构如下：',
    '{"shots":[{"sourceText":"该镜头对应的剧本原文片段","imagePrompt":"生图提示词","videoPrompt":"视频提示词","durationPlannedMs":12000,"tags":[{"name":"标签名","type":"CHARACTER|SCENE|PROP"}],"dialogue":[{"speaker":"角色标签名（旁白则省略）","isNarrator":false,"text":"台词"}]}]}',
    SCRIPT_BEGIN,
    script,
    SCRIPT_END,
  ].join('\n');
}

/** 剥掉 ```json 围栏后解析 */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw).trim();
  return JSON.parse(text);
}

/**
 * 三步生成的 Job 执行器工厂。textGen 由集成阶段注入
 * （API 执行走 openai-compatible 适配器，Mock 执行走 mockTextGen）。
 */
export function createStoryboardGenerator({ textGen }: { textGen: TextGenFn }) {
  return async function generateStoryboard(
    ctx: StoryboardGeneratorCtx,
  ): Promise<{ output: { storyboardId: string; shotCount: number } }> {
    const { db, job, updateProgress } = ctx;
    const input = parseJson<{ scriptDraftId?: string }>(job.inputJson, {});
    if (!input.scriptDraftId) throw badRequest('任务输入缺少 scriptDraftId');

    const draft = await db.scriptDraft.findUnique({
      where: { id: input.scriptDraftId },
      include: { episode: true },
    });
    if (!draft) throw notFound('剧本稿');
    const projectId = draft.episode.projectId;

    const existingTags = await db.tag.findMany({ where: { projectId } });
    const prompt = buildStoryboardPrompt(draft.content, existingTags);
    await updateProgress(10);

    const attempt = async (): Promise<GeneratedStoryboard> =>
      GeneratedStoryboardSchema.parse(extractJson(await textGen(prompt)));
    let generated: GeneratedStoryboard;
    try {
      generated = await attempt();
    } catch {
      // 结构化输出失败重试一次；第二次失败让错误自然抛出（Job 置 FAILED）
      generated = await attempt();
    }
    await updateProgress(60);

    // 三步生成的产出统一转为全 add_shot 的 patch，空基底应用 → 新版本
    const patch: StoryboardPatch = generated.shots.map((shot) => ({
      op: 'add_shot' as const,
      shot,
    }));
    const { storyboard } = await applyPatch(db, {
      episodeId: draft.episodeId,
      scriptDraftId: draft.id,
      baseStoryboardId: null,
      patch,
      source: 'generate',
      resolveTags: (tags) => findOrCreateTags(db, projectId, tags),
    });
    await updateProgress(95);

    return { output: { storyboardId: storyboard.id, shotCount: generated.shots.length } };
  };
}

/**
 * Mock 文本生成：从 prompt 的分隔符中提取剧本原文，
 * 按 空行 / 【场景 / 场景一二三… 切段，每段一个镜头，确定性输出。
 */
export async function mockTextGen(prompt: string): Promise<string> {
  const m = prompt.match(
    new RegExp(`${SCRIPT_BEGIN}\\n([\\s\\S]*?)\\n${SCRIPT_END}`),
  );
  const script = (m ? m[1] : prompt).trim();
  const segments = splitScript(script);
  const shots = segments.length > 0 ? segments.map(segmentToShot) : [segmentToShot('（空白剧本）')];
  return JSON.stringify({ shots });
}

function splitScript(script: string): string[] {
  const blocks = script.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  const segments: string[] = [];
  for (const block of blocks) {
    let current: string[] = [];
    for (const line of block.split('\n')) {
      // 场景标题行（【场景… / 场景一：…）开启新段
      if (/^\s*(【场景|场景[一二三四五六七八九十0-9])/.test(line) && current.some((l) => l.trim())) {
        segments.push(current.join('\n').trim());
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) segments.push(current.join('\n').trim());
  }
  return segments.filter((s) => s.length > 0);
}

function truncate(text: string, n: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > n ? `${single.slice(0, n)}…` : single;
}

function segmentToShot(segment: string): {
  sourceText: string;
  imagePrompt: string;
  videoPrompt: string;
  durationPlannedMs: number;
  tags: Array<{ name: string; type: 'CHARACTER' | 'SCENE' | 'PROP' }>;
  dialogue: Array<{ speaker?: string; isNarrator: boolean; text: string }>;
} {
  const lines = segment
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const tags: Array<{ name: string; type: 'CHARACTER' | 'SCENE' | 'PROP' }> = [];
  const seen = new Set<string>();
  const pushTag = (name: string, type: 'CHARACTER' | 'SCENE' | 'PROP') => {
    const key = `${type}:${name}`;
    if (name && !seen.has(key)) {
      seen.add(key);
      tags.push({ name, type });
    }
  };
  const dialogue: Array<{ speaker?: string; isNarrator: boolean; text: string }> = [];

  for (const line of lines) {
    const scene = line.match(/^【?场景[一二三四五六七八九十0-9]*[：:\s]*(.*?)】?$/);
    if (scene) {
      pushTag((scene[1] ?? '').trim(), 'SCENE');
      continue;
    }
    const dlg = line.match(/^([^：:]{1,12})[：:]\s*(.+)$/);
    if (dlg) {
      const speaker = dlg[1].trim();
      if (speaker === '旁白') {
        dialogue.push({ isNarrator: true, text: dlg[2].trim() });
      } else {
        dialogue.push({ speaker, isNarrator: false, text: dlg[2].trim() });
        pushTag(speaker, 'CHARACTER');
      }
    }
  }
  if (dialogue.length === 0) {
    dialogue.push({ isNarrator: true, text: truncate(segment, 60) });
  }
  // 与真实 LLM 的提示词规则一致：出场标签以 @标签名 书写（角色/道具锚定参考图，场景锚定文字）
  const mentionPrefix = tags.map((t) => `@${t.name} `).join('');
  return {
    sourceText: segment,
    imagePrompt: `${mentionPrefix}漫画风格画面：${truncate(segment, 50)}`,
    videoPrompt: `镜头缓推，动态演绎：${truncate(segment, 50)}`,
    durationPlannedMs: 12000,
    tags,
    dialogue,
  };
}
