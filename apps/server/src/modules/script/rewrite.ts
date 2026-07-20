import { badRequest } from '../../lib/errors.js';
import type { TextGenFn } from './generate.js';

/**
 * 对话式改剧本正文：用户一句话指令 + 当前剧本全文 → 改写后的完整剧本。
 * 【铁律】本模块只产出结果，绝不落库——改写要不要采纳由用户在前端决定，
 * 采纳后走既有的 PATCH /api/script-drafts/:id（与 chat.ts 只出 patch 预览是同一条原则）。
 * 【为什么要整篇重出而不是出 diff】剧本是连续文本，局部替换很容易在前后文接缝处失配；
 * 让模型整篇重写、前端整篇替换，配合「撤销」入口，比拼接补丁可靠得多。
 */

/** prompt 中包裹剧本原文 / 用户指令的分隔符（与 generate.ts 同风格，便于排查模型输入） */
export const REWRITE_SCRIPT_BEGIN = '<<<当前剧本正文>>>';
export const REWRITE_SCRIPT_END = '<<<当前剧本正文结束>>>';
export const REWRITE_MESSAGE_BEGIN = '<<<用户修改指令>>>';
export const REWRITE_MESSAGE_END = '<<<用户修改指令结束>>>';

export interface BuildRewritePromptInput {
  /** 当前剧本稿正文全文 */
  script: string;
  /** 用户的一句话修改指令 */
  message: string;
  /** 项目级画风设定（Project.stylePrompt），有则并入约束保持全项目统一 */
  stylePrompt?: string;
}

export interface RewriteScriptResult {
  /** 一句话说明改了什么，用于对话气泡里让用户在采纳前看懂改动 */
  summary: string;
  /** 改写后的完整剧本正文 */
  script: string;
}

/** 选区改写：正文中的字符区间（UTF-16 code unit 下标，含 from 不含 to） */
export interface ScriptSelection {
  from: number;
  to: number;
}

export interface BuildSelectionRewritePromptInput {
  /** 剧本全文——即使只改一段也要整篇给模型，否则它不知道前后文与角色是谁 */
  fullScript: string;
  from: number;
  to: number;
  /** 用户针对这一段的修改指令 */
  message: string;
  stylePrompt?: string;
}

export interface RewriteSelectionResult {
  summary: string;
  /** 只是被选中那一段的改写结果，由前端拼回正文 */
  replacement: string;
}

/** 圈出待改写片段的标记：用醒目且不会出现在剧本里的形状，避免模型把它当正文抄回来 */
export const SELECTION_BEGIN = '<<<待改写片段开始>>>';
export const SELECTION_END = '<<<待改写片段结束>>>';

/**
 * 改写提示词。四条硬约束缺一不可：
 * 保持格式（下游三步生成靠场景标题行/「角色名：台词」拆镜，格式一乱分镜就散架）、
 * 角色名不得更改（角色名是全剧形象一致性的锚点，改名等于换人）、
 * 只改指令涉及部分（模型天然爱顺手润色，不禁止就会把用户没让改的段落也重写一遍）、
 * 严格 JSON 输出（前端要拿 summary 与 script 两段，混着解释文字就没法用）。
 */
export function buildRewritePrompt(input: BuildRewritePromptInput): string {
  const { script, message, stylePrompt } = input;
  return [
    '你是专业的漫剧（动画短剧）编剧。下面是一份已有的剧本正文，请严格按照用户的修改指令改写它。',
    '',
    '【保持格式】（硬规则，违反会导致后续自动拆分镜失败）',
    '1. 改写后的剧本必须沿用原有格式：场景标题独立成行，格式为「场景N：地点，时间。」（例："场景一：办公室内，白天。"）；',
    '2. 场景标题之后先写动作/环境描述（第三人称陈述句），再写对白；对白格式严格为「角色名：台词」，一行一句，冒号用中文全角「：」；',
    '3. 旁白写成对白形式，说话人一律写「旁白」；场景之间空一行分隔；',
    '4. 只输出剧本正文本身，不要开场白、点评、标题或编号列表。',
    '',
    '【角色名不得更改】（硬规则，角色名是全剧形象一致性的锚点）',
    '5. 原剧本中出现的角色名一律原样保留，不得改名、不得换成外号/职称/代词、不得翻译成英文或拼音——除非用户的指令明确要求改名；',
    '6. 确需新增角色时，新角色名同样要简短（不超过 6 个字）且全剧统一。',
    '',
    '【只改指令涉及的部分】',
    '7. 严格按用户指令改动，指令没有提到的段落、台词、场景一律原样保留，逐字照抄；',
    '8. 【严禁】顺手润色、精简或重排未被指令触及的内容——用户看到的是整篇替换，任何多余改动都是破坏；',
    '9. 篇幅与原剧本大致相当，除非指令明确要求加长或删减。',
    stylePrompt
      ? `10. 画面风格：本项目统一为「${stylePrompt}」，新增或改写的场景与人物设定需与该风格相符。`
      : null,
    '',
    '【当前剧本正文】',
    REWRITE_SCRIPT_BEGIN,
    script,
    REWRITE_SCRIPT_END,
    '',
    '【用户修改指令】',
    REWRITE_MESSAGE_BEGIN,
    message,
    REWRITE_MESSAGE_END,
    '',
    '【输出 JSON】（硬规则）',
    '只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。结构如下：',
    '{"summary":"一句话说明这次改了什么","script":"改写后的完整剧本正文（含全部未改动部分，换行用 \\n 转义）"}',
  ]
    // 用 null 标记"该条不存在"，避免把上下的空行分隔一起过滤掉（同 write.ts）
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * 选区改写提示词。与整篇改写的根本差别：整篇改写要模型「把没改的照抄回来」，
 * 而这里根本不让它输出未选中的部分——照抄这一步天然不会出错，
 * 用户手写的其余段落在物理上就不可能被模型顺手润色掉。
 * 四条硬规则：只输出这一段 / 保持行格式 / 角色名不得更改 / 严格 JSON 输出。
 */
export function buildSelectionRewritePrompt(input: BuildSelectionRewritePromptInput): string {
  const { fullScript, from, to, message, stylePrompt } = input;
  const selected = fullScript.slice(from, to);
  // 把标记就地插进全文：模型既看得到完整前后文，又能精确定位改哪一段
  const marked =
    fullScript.slice(0, from) + SELECTION_BEGIN + selected + SELECTION_END + fullScript.slice(to);

  return [
    '你是专业的漫剧（动画短剧）编剧。下面是一份完整剧本，其中被标记圈出的片段需要按用户指令改写。',
    '完整剧本只是给你看的上下文，用来了解前后文与角色关系。',
    '',
    '【只输出这一段】（硬规则，违反会导致改写结果无法拼回剧本）',
    `1. 只输出 ${SELECTION_BEGIN} 与 ${SELECTION_END} 之间那一段改写后的文本；`,
    '2. 【严禁】输出整篇剧本，【严禁】输出标记之外的任何一行——标记外的内容由用户自己掌管，你改不到也不该改；',
    `3. 【严禁】把 ${SELECTION_BEGIN}、${SELECTION_END} 这两个标记本身写进结果里；`,
    '4. 篇幅与原片段大致相当，除非用户指令明确要求加长或删减。',
    '',
    '【保持格式】（硬规则，下游要靠这个格式自动拆分镜）',
    '5. 场景标题独立成行，格式为「场景N：地点，时间。」（例："场景一：办公室内，白天。"）；',
    '6. 对白格式严格为「角色名：台词」，一行一句，冒号用中文全角「：」；旁白的说话人一律写「旁白」；',
    '7. 其余非空行是动作/环境描述，用第三人称陈述句；场景之间空一行分隔；',
    '8. 原片段是什么行型就还它什么行型：只改了一句台词就不要顺手把它拆成动作描述。',
    '',
    '【角色名不得更改】（硬规则，角色名是全剧形象一致性的锚点）',
    '9. 片段中出现的角色名一律原样保留，不得改名、不得换成外号/职称/代词、不得翻译成英文或拼音——除非用户指令明确要求改名；',
    '10. 确需新增角色时，新角色名同样要简短（不超过 6 个字）且与全剧其他角色名不重复。',
    stylePrompt
      ? `11. 画面风格：本项目统一为「${stylePrompt}」，改写后的场景与人物设定需与该风格相符。`
      : null,
    '',
    '【完整剧本（含片段标记）】',
    REWRITE_SCRIPT_BEGIN,
    marked,
    REWRITE_SCRIPT_END,
    '',
    '【待改写片段（即上面标记之间的原文）】',
    SELECTION_BEGIN,
    selected,
    SELECTION_END,
    '',
    '【用户修改指令】',
    REWRITE_MESSAGE_BEGIN,
    message,
    REWRITE_MESSAGE_END,
    '',
    '【输出 JSON】（硬规则）',
    '只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。结构如下：',
    '{"summary":"一句话说明这一段改了什么","replacement":"改写后的这一段文本（换行用 \\n 转义）"}',
  ]
    // 用 null 标记"该条不存在"，避免把上下的空行分隔一起过滤掉（同 buildRewritePrompt）
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** 剥掉 ```json 围栏后解析（与 generate.ts / chat.ts 同规则） */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw).trim();
  return JSON.parse(text);
}

/** 改写入参：带 selection 走选区改写，不带则与从前完全一致（整篇改写） */
export type RewriteInput = BuildRewritePromptInput & { selection?: ScriptSelection };

/**
 * 模型爱在结果首尾多带换行。直接把这种结果拼回正文，接缝处就会多出空行、
 * 甚至把「场景之间空一行」的分隔搞乱。做法是：去掉模型给的首尾空白，
 * 再把**原片段**的首尾空白原样接回去——用户选中时带了什么空白，拼回去就还是什么。
 */
function keepEdgeWhitespace(original: string, rewritten: string): string {
  const lead = original.match(/^\s*/)?.[0] ?? '';
  const trail = original.match(/\s*$/)?.[0] ?? '';
  return lead + rewritten.trim() + trail;
}

/**
 * 改写工厂。textGen 由集成阶段注入（显式指定模型 → 只用该模型；缺省 → 按需调度 + 失效转移）。
 * 两种模式共用同一套「解析 → 失败重试一次 → 仍失败给中文 400」的容错，
 * 差别只在提示词与取哪个字段。
 */
export function makeRewriteScript({ textGen }: { textGen: TextGenFn }) {
  return async function rewriteScript(
    input: RewriteInput,
  ): Promise<RewriteScriptResult | RewriteSelectionResult> {
    const { selection } = input;
    const prompt = selection
      ? buildSelectionRewritePrompt({
          fullScript: input.script,
          from: selection.from,
          to: selection.to,
          message: input.message,
          stylePrompt: input.stylePrompt,
        })
      : buildRewritePrompt(input);

    const attempt = async (): Promise<RewriteScriptResult | RewriteSelectionResult> => {
      const parsed = extractJson(await textGen(prompt)) as {
        summary?: unknown;
        script?: unknown;
        replacement?: unknown;
      };
      const summary = typeof parsed.summary === 'string' ? parsed.summary : '';

      if (selection) {
        const raw = typeof parsed.replacement === 'string' ? parsed.replacement : '';
        // 空片段同样按失败处理：拼回去等于静默删掉用户选中的内容
        if (!raw.trim()) throw new Error('改写结果缺少 replacement 片段');
        return {
          summary,
          replacement: keepEdgeWhitespace(input.script.slice(selection.from, selection.to), raw),
        };
      }

      const script = typeof parsed.script === 'string' ? parsed.script.trim() : '';
      // 空正文比解析失败更危险：它会让用户误采纳一篇空剧本，所以一并按失败处理
      if (!script) throw new Error('改写结果缺少剧本正文');
      return { summary, script };
    };

    try {
      return await attempt();
    } catch {
      // 结构化输出失败重试一次；第二次仍失败 → 400 让用户换个说法
      try {
        return await attempt();
      } catch {
        throw badRequest('AI 返回的改写结果无法解析，请换个说法重试');
      }
    }
  };
}
