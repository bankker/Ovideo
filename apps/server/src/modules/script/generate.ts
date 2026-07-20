import type { PrismaClient, Tag } from '@prisma/client';
import { z } from 'zod';
import type { NewShotInput, StoryboardPatch } from '@ovideo/shared';
import {
  NewShotInputSchema,
  SHOT_SIZES,
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  TRANSITIONS,
  SHOT_DURATION_MIN_MS,
  SHOT_DURATION_MAX_MS,
} from '@ovideo/shared';
import { badRequest, notFound } from '../../lib/errors.js';
import { parseJson } from '../../lib/json.js';
import { findOrCreateTags } from '../tag/service.js';
import { applyPatch } from '../storyboard/service.js';

/** prompt 中包裹剧本原文的分隔符（mockTextGen 依赖它提取原文） */
export const SCRIPT_BEGIN = '<<<剧本原文>>>';
export const SCRIPT_END = '<<<剧本原文结束>>>';

/**
 * 影视语义取值域已迁到 @ovideo/shared（前端镜头检查器要用同一份取值）。
 * 这里保留转出口，既有的 `from './generate.js'` 导入无需改动。
 */
export { SHOT_SIZES, CAMERA_ANGLES, CAMERA_MOVEMENTS, TRANSITIONS };

/**
 * 单镜头时长区间同样迁到 @ovideo/shared（前端检查器与镜头表要用同一份边界），
 * 这里保留转出口，既有的 `from './generate.js'` 导入无需改动。
 */
export { SHOT_DURATION_MIN_MS, SHOT_DURATION_MAX_MS };
export const SHOT_DURATION_PREFERRED_MS = 4000;

/** 与 job 模块的 JobExecutor 结构兼容（不 import，按结构类型解耦） */
export interface StoryboardGeneratorCtx {
  db: PrismaClient;
  job: { inputJson: string };
  updateProgress: (p: number) => Promise<void>;
}

export type TextGenFn = (prompt: string) => Promise<string>;

/**
 * 展开后挂在每个镜头上的场景归属。
 * 同一次 patch 内 sceneKey 相同的镜头会被 applyPatch 归入同一个 Scene，
 * 所以这里的 sceneKey 只需在单次生成内唯一（用场景下标即可）。
 */
export interface GeneratedSceneRef {
  sceneKey: string;
  sortOrder: number;
  title?: string;
  location?: string;
  interiorExterior?: string;
  timeOfDay?: string;
  sourceText?: string;
}

/**
 * 带场景归属与影视语义的镜头输入。
 * 用交叉类型而不是直接改 NewShotInput，是为了让本文件在 shared 契约落地前后
 * 都能编译：字段全是可选，落地后交叉类型退化为 NewShotInput 本身。
 */
export type SceneAwareShotInput = NewShotInput & {
  sceneRef?: GeneratedSceneRef;
  shotSize?: string;
  cameraAngle?: string;
  cameraMovement?: string;
  composition?: string;
  transition?: string;
};

/**
 * 镜头层解析 schema。影视语义字段一律按自由字符串收（不用 z.enum），
 * 因为模型偶尔会输出"中近景"这类越界值——越界不该让整次生成失败，
 * 落库后由镜头检查器提示人工修正即可。
 */
const GeneratedShotSchema = NewShotInputSchema.extend({
  shotSize: z.string().default(''),
  cameraAngle: z.string().default(''),
  cameraMovement: z.string().default(''),
  composition: z.string().default(''),
  transition: z.string().default(''),
});

/** 场景层解析 schema */
const GeneratedSceneSchema = z.object({
  title: z.string().default(''),
  location: z.string().default(''),
  interiorExterior: z.string().default(''),
  timeOfDay: z.string().default(''),
  sourceText: z.string().default(''),
  // 允许空数组：模型偶尔吐一个没有镜头的场景，若因此整体解析失败会落到旧格式分支再抛错，
  // 一个空场景就葬送整次生成（钱也白花）。改为允许空、展开时跳过。
  shots: z.array(GeneratedShotSchema).default([]),
});

/** 新格式：场景 → 镜头两级 */
const SceneStoryboardSchema = z.object({
  scenes: z.array(GeneratedSceneSchema).min(1),
});

/** 旧格式：扁平镜头列表（老模型／降级路径） */
const FlatStoryboardSchema = z.object({
  shots: z.array(GeneratedShotSchema).min(1),
});

export function buildStoryboardPrompt(
  script: string,
  tags: Array<Pick<Tag, 'name' | 'type'>>,
  stylePrompt = '',
  /**
   * 导演要求：前端分镜规划向导拼出来的一段中文说明。
   * 【为什么放在通用规则之前】它是用户对这一集的具体决定（拆多少镜、什么节奏），
   * 而后面的 A/B/C 条是全系统通用底线。先读要求、再读底线，冲突时底线胜出——
   * 所以段落里明写了"与硬性约束冲突时以硬性约束为准"。
   * 缺省为空串时整段不出现，提示词与加这个参数之前逐字一致（向后兼容）。
   */
  directive = '',
): string {
  const byType = (type: string, label: string) => {
    const names = tags.filter((t) => t.type === type).map((t) => t.name);
    return `${label}：${names.length > 0 ? names.join('、') : '（无）'}`;
  };
  const directiveBlock = directive.trim()
    ? [
        '【导演要求（用户为这一集指定，请尽量遵守；与下面的硬性约束冲突时以硬性约束为准）】',
        directive.trim(),
        '',
      ]
    : [];
  return [
    '你是专业的漫剧分镜师。请将下面的剧本先拆分为「场景」，再在每个场景内部拆分为多个「镜头」。',
    '',
    ...directiveBlock,
    '【第一级：场景】',
    'A1. 同一时间、同一地点的连续剧情属于同一个场景；时间跳跃、地点转移、或明确的转场标记处必须切新场景。',
    'A2. 每个场景要填全：title（场景名，如「客户会议室」）、location（地点，通常与 title 同源）、'
      + 'interiorExterior（只能填 "INT" 内景 / "EXT" 外景）、timeOfDay（如「白天」「傍晚」「深夜」）、'
      + 'sourceText（该场景对应的剧本原文片段）。',
    'A3. 剧本里确实判断不出的字段留空字符串，【严禁编造】——宁可留空也不要猜一个内外景或时间。',
    '',
    '【第二级：镜头】',
    'B1. 每个场景必须拆成 2-5 个镜头；只有当该场景确实只有一个动作且总时长 ≤5 秒时，才允许只出 1 个镜头。',
    'B2. 拆镜依据（按优先级）：说话人切换（正反打）、动作节点、情绪转折、需要强调的细节（特写）。'
      + '典型的会议／对话场景应当是「中景交代关系 → 正反打对话 → 反应或细节特写」。',
    `B3. 单镜头时长：durationPlannedMs 必须落在 ${SHOT_DURATION_MIN_MS}~${SHOT_DURATION_MAX_MS} 毫秒之间，`
      + `优先靠近 ${SHOT_DURATION_PREFERRED_MS}。`
      + `理由：视频模型单次只能生成 5 秒或 10 秒的片段，超过 ${SHOT_DURATION_MAX_MS} 毫秒的镜头无法一次成片，`
      + '所以任何超时的镜头都必须继续拆分成两个以上镜头，而不是写一个长时长。',
    'B4. 一个场景内各镜头的时长之和，应与该场景的剧情体量相称（台词多、冲突强的场景镜头更多）。',
    'B5. 对白归属：一句台词只能出现在它被说出的那一个镜头里，【严禁】在多个镜头里重复同一句台词；'
      + '反应镜头、空镜、细节特写可以没有任何台词（dialogue 为空数组）。',
    '',
    '【每个镜头必须产出的影视语义（只能从给定取值中选一个，不得自创词汇）】',
    `C1. shotSize 景别：${SHOT_SIZES.join(' / ')}`,
    `C2. cameraAngle 角度：${CAMERA_ANGLES.join(' / ')}`,
    `C3. cameraMovement 运镜：${CAMERA_MOVEMENTS.join(' / ')}`,
    'C4. composition 构图：一句话描述画面里的人物位置与前后景关系'
      + '（例：「两人分坐会议桌两侧，前景放着未翻页的方案册」）。',
    `C5. transition 转场：${TRANSITIONS.join(' / ')}`,
    '',
    '【每个镜头还必须产出的四件套】标签（tags）、对白（dialogue）、生图提示词（imagePrompt）、视频提示词（videoPrompt）。',
    '标签命名（硬规则，标签是全剧形象一致性的锚点）：',
    '1. 标签名必须是简短稳定的名词，不超过 6 个字，禁止包含标点或整句描述；',
    '2. 同一地点全剧必须用同一个场景标签（如统一用「办公室」；时间与氛围如"白天/明亮"写进 imagePrompt，绝不写进标签名）；【严禁】把"同一/相同/还是/原"这类指代词写进标签名——"同一办公室"必须直接复用「办公室」标签；',
    '3. 角色标签用剧本中的真实姓名，同一角色全剧同名；',
    '4. imagePrompt/videoPrompt 中出场的角色、道具、场景一律写成 @标签名（例："@办公室 内，@小悟 趴在 @办公桌 前疯狂打字"）——@ 后必须是 tags 数组里一字不差的标签名，【原样中文，严禁翻译、拆字或音译】（"小悟"绝不能写成 small悟 / Little Wu / Xiaowu）；@标签名 之后紧跟一个空格再接其他文字；',
    stylePrompt
      ? `5. 画面风格：全剧统一为「${stylePrompt}」——imagePrompt 的风格描述必须与之一致，严禁偏离。`
      : '5. 画面风格：这是漫剧（动画短剧），imagePrompt 一律采用动漫/漫画风格（anime/manga style），严禁写 realistic style 或写实风格，除非剧本明确要求。',
    '6. 口型（动画式对口型）：有具名角色台词的镜头，videoPrompt 必须写明说话人处于说话状态（如"@小悟 正在说话，嘴部自然开合"）；纯旁白或无台词的镜头严禁写说话状态，嘴不能动。',
    '7. 旁白：剧本中说话人写作「旁白」的行，必须输出为 {"isNarrator":true,"text":"…"} 并省略 speaker；【严禁】把「旁白」当作角色写进 tags——它没有形象，不需要设计图，也不该驱动口型。',
    '项目已有标签词表如下，语义相同的角色/场景/道具必须复用下列同名标签，不得另造别名：',
    byType('CHARACTER', '角色'),
    byType('SCENE', '场景'),
    byType('PROP', '道具'),
    '只输出一个 JSON 对象，不要输出任何解释文字。结构如下：',
    '{"scenes":[{"title":"客户会议室","location":"客户会议室","interiorExterior":"INT","timeOfDay":"白天",'
      + '"sourceText":"该场景对应的剧本原文",'
      + '"shots":[{"sourceText":"该镜头对应的剧本片段","imagePrompt":"生图提示词","videoPrompt":"视频提示词",'
      + `"durationPlannedMs":${SHOT_DURATION_PREFERRED_MS},`
      + '"shotSize":"中景","cameraAngle":"平视","cameraMovement":"固定",'
      + '"composition":"两人分坐会议桌两侧，前景放着未翻页的方案册","transition":"切",'
      + '"tags":[{"name":"标签名","type":"CHARACTER|SCENE|PROP"}],'
      + '"dialogue":[{"speaker":"角色标签名（旁白则省略）","isNarrator":false,"text":"台词"}]}]}]}',
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
 * 把模型返回的结构展开为扁平镜头列表（applyPatch 的既有形态）。
 * 新格式走场景分组；旧格式（老模型/降级）按「每个镜头自成一个场景」处理，
 * 这样下游无需分支——展开后每个镜头一律带 sceneRef。
 */
export function flattenGeneratedStoryboard(raw: unknown): SceneAwareShotInput[] {
  const scened = SceneStoryboardSchema.safeParse(raw);
  if (scened.success) {
    return scened.data.scenes.flatMap((scene, sceneIndex) =>
      scene.shots.map((shot) => ({
        ...shot,
        sceneRef: {
          sceneKey: `scene-${sceneIndex}`,
          sortOrder: sceneIndex,
          title: scene.title,
          // 地点缺省时回落到场景名：契约里两者本就同源，这不是编造而是同一信息的复用
          location: scene.location || scene.title,
          interiorExterior: scene.interiorExterior,
          timeOfDay: scene.timeOfDay,
          sourceText: scene.sourceText,
        },
      })),
    );
  }

  // 向后兼容：旧的 {"shots":[...]}。每个镜头单独成场景，场景元数据只能留空——
  // 旧格式里根本没有地点/内外景信息，编造出来会污染后续的场景检查器。
  const flat = FlatStoryboardSchema.parse(raw);
  return flat.shots.map((shot, index) => ({
    ...shot,
    sceneRef: {
      sceneKey: `scene-${index}`,
      sortOrder: index,
      title: '',
      location: '',
      interiorExterior: '',
      timeOfDay: '',
      sourceText: shot.sourceText,
    },
  }));
}

/**
 * 三步生成的 Job 执行器工厂。textGen 由集成阶段注入
 * （API 执行走 openai-compatible 适配器，Mock 执行走 mockTextGen）。
 */
export function createStoryboardGenerator({ textGen }: { textGen: TextGenFn }) {
  return async function generateStoryboard(
    ctx: StoryboardGeneratorCtx,
  ): Promise<{ output: { storyboardId: string; shotCount: number; sceneCount: number } }> {
    const { db, job, updateProgress } = ctx;
    const input = parseJson<{ scriptDraftId?: string; directive?: string }>(job.inputJson, {});
    if (!input.scriptDraftId) throw badRequest('任务输入缺少 scriptDraftId');

    const draft = await db.scriptDraft.findUnique({
      where: { id: input.scriptDraftId },
      include: { episode: true },
    });
    if (!draft) throw notFound('剧本稿');
    const projectId = draft.episode.projectId;

    const existingTags = await db.tag.findMany({ where: { projectId } });
    const project = await db.project.findUnique({ where: { id: projectId } });
    const prompt = buildStoryboardPrompt(
      draft.content,
      existingTags,
      project?.stylePrompt ?? '',
      input.directive ?? '',
    );
    await updateProgress(10);

    const attempt = async (): Promise<SceneAwareShotInput[]> =>
      flattenGeneratedStoryboard(extractJson(await textGen(prompt)));
    let shots: SceneAwareShotInput[];
    try {
      shots = await attempt();
    } catch {
      // 结构化输出失败重试一次；第二次失败让错误自然抛出（Job 置 FAILED）
      shots = await attempt();
    }
    await updateProgress(60);

    // 三步生成的产出统一转为全 add_shot 的 patch，空基底应用 → 新版本
    const patch: StoryboardPatch = shots.map((shot) => ({
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

    const sceneCount = new Set(shots.map((s) => s.sceneRef?.sceneKey ?? '')).size;
    return { output: { storyboardId: storyboard.id, shotCount: shots.length, sceneCount } };
  };
}

/**
 * Mock 文本生成：从 prompt 的分隔符中提取剧本原文，
 * 按 空行 / 【场景 / 场景一二三… 切段——每段一个场景，
 * 段内再按台词行拆成多个镜头（最多 5 个），确定性输出。
 */
export async function mockTextGen(prompt: string): Promise<string> {
  const m = prompt.match(
    new RegExp(`${SCRIPT_BEGIN}\\n([\\s\\S]*?)\\n${SCRIPT_END}`),
  );
  const script = (m ? m[1] : prompt).trim();
  const segments = splitScript(script);
  const source = segments.length > 0 ? segments : ['（空白剧本）'];
  return JSON.stringify({ scenes: source.map(segmentToScene) });
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

type MockTag = { name: string; type: 'CHARACTER' | 'SCENE' | 'PROP' };
type MockDialogue = { speaker?: string; isNarrator: boolean; text: string };

/**
 * 把一段剧本变成一个场景。
 * 拆镜规则（mock 版，模拟真实模型的「说话人切换即切镜」）：一条台词一个镜头，
 * 超过 5 条时把台词均匀分组，保证镜头数落在提示词要求的 2-5 区间内。
 */
function segmentToScene(segment: string): {
  title: string;
  location: string;
  interiorExterior: string;
  timeOfDay: string;
  sourceText: string;
  shots: Array<{
    sourceText: string;
    imagePrompt: string;
    videoPrompt: string;
    durationPlannedMs: number;
    shotSize: string;
    cameraAngle: string;
    cameraMovement: string;
    composition: string;
    transition: string;
    tags: MockTag[];
    dialogue: MockDialogue[];
  }>;
} {
  const lines = segment
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let sceneName = '';
  // 每条台词连同它的原文行一起记录，后面按台词切镜时要把原文也带过去
  const beats: Array<{ text: string; dialogue: MockDialogue; character?: string }> = [];

  for (const line of lines) {
    const scene = line.match(/^【?场景[一二三四五六七八九十0-9]*[：:\s]*(.*?)】?$/);
    if (scene) {
      if (!sceneName) sceneName = (scene[1] ?? '').trim();
      continue;
    }
    const dlg = line.match(/^([^：:]{1,12})[：:]\s*(.+)$/);
    if (dlg) {
      const speaker = dlg[1].trim();
      if (speaker === '旁白') {
        beats.push({ text: line, dialogue: { isNarrator: true, text: dlg[2].trim() } });
      } else {
        beats.push({
          text: line,
          dialogue: { speaker, isNarrator: false, text: dlg[2].trim() },
          character: speaker,
        });
      }
    }
  }

  // 无台词的段落：整段一个镜头，配一条旁白（与旧行为一致）
  const groups: Array<typeof beats> =
    beats.length > 0
      ? groupEvenly(beats, 5)
      : [[{ text: segment, dialogue: { isNarrator: true, text: truncate(segment, 60) } }]];

  const shots = groups.map((group, index) => {
    const tags: MockTag[] = [];
    const seen = new Set<string>();
    const pushTag = (name: string, type: MockTag['type']) => {
      const key = `${type}:${name}`;
      if (name && !seen.has(key)) {
        seen.add(key);
        tags.push({ name, type });
      }
    };
    // 场景标签挂在场景内每一个镜头上：同一地点的镜头都要锚定同一个场景形象
    pushTag(sceneName, 'SCENE');
    for (const beat of group) if (beat.character) pushTag(beat.character, 'CHARACTER');

    const text = group.map((b) => b.text).join('\n');
    // 与真实 LLM 的提示词规则一致：出场标签以 @标签名 书写
    const mentionPrefix = tags.map((t) => `@${t.name} `).join('');
    const hasSpeaker = group.some((b) => b.character);
    return {
      sourceText: text,
      imagePrompt: `${mentionPrefix}漫画风格画面：${truncate(text, 50)}`,
      videoPrompt: hasSpeaker
        ? `@${group.find((b) => b.character)?.character} 正在说话，嘴部自然开合：${truncate(text, 40)}`
        : `镜头缓推，动态演绎：${truncate(text, 50)}`,
      durationPlannedMs: SHOT_DURATION_PREFERRED_MS,
      // 首镜中景交代关系，后续镜头近景推进——与提示词里的拆镜范式一致
      shotSize: index === 0 ? '中景' : '近景',
      cameraAngle: '平视',
      cameraMovement: '固定',
      composition: truncate(text, 30),
      transition: '切',
      tags,
      dialogue: group.map((b) => b.dialogue),
    };
  });

  return {
    title: sceneName,
    location: sceneName,
    // mock 无法从剧本可靠判断内外景与时间，按「宁可留空不编造」的规则留空
    interiorExterior: '',
    timeOfDay: '',
    sourceText: segment,
    shots,
  };
}

/** 把 items 均匀切成至多 maxGroups 组，保持原顺序 */
function groupEvenly<T>(items: T[], maxGroups: number): T[][] {
  const groupCount = Math.min(items.length, maxGroups);
  const groups: T[][] = Array.from({ length: groupCount }, () => []);
  items.forEach((item, i) => {
    // 向下取整分配：前几组可能比后几组多一个，但顺序不乱
    groups[Math.min(groupCount - 1, Math.floor((i * groupCount) / items.length))].push(item);
  });
  return groups;
}
