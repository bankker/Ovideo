// 正文里的 @ 要素标注：识别、切段、自动补标。
//
// 【为什么标注要单独一层】剧本正文此前没有任何 @，要素只能由模型在拆分镜时临场推断，
// 用户在剧本阶段既确定不了、也控制不了「这一场用哪张参考图」。
// 给正文补上 @ 之后，要素就成了用户写下的事实，而不是模型的猜测。
//
// 本模块同时供两处使用，且**必须**只有一份匹配规则：
//   1) 编辑器预览态的要素高亮（splitLineByElements）
//   2) 工具栏的「标注要素」动作（annotateMentions）
// 两者一旦分家，就会出现"高亮说这里有个角色，标注却不给它加 @"的鬼故事。
//
// @ 的语义与服务端 apps/server/src/modules/generation/executors.ts 的 parseMentions 一致：
// @角色 / @道具 = 名字锚定 + 参考图必发；@场景 = 仅文字锚定；@!场景 = 强制发参考图。

import { parseScript } from './script-parse';

export type ElementNameType = 'CHARACTER' | 'SCENE' | 'PROP';

/**
 * 要素来源。刻意只要求每项有 name、按三个桶分组——类型从桶推出来，
 * 不读元素自身的 type 字段。这样 script-elements.ts 的要素结构怎么演进，
 * 这里都不用跟着改（结构化类型天然兼容）。
 */
export interface AnnotationElements {
  characters: ReadonlyArray<{ name: string }>;
  scenes: ReadonlyArray<{ name: string }>;
  props: ReadonlyArray<{ name: string }>;
}

export interface Mention {
  name: string;
  /** @! 前缀：强制作为参考图（对场景标签生效） */
  force: boolean;
}

/**
 * 与服务端 MENTION_RE 逐字一致：名字一直吃到空白或常见标点为止。
 * 【这条规则的后果很重要】中文正文里「@小美踮起脚」会被整体当成标签名，
 * 服务端随即报「标签不存在」。所以自动标注在名字后面没有分隔符时必须补一个空格，
 * 这也正是既有 imagePrompt 写成 `@小美 踮脚跳跃` 的原因。
 */
const MENTION_RE = /@(!?)([^\s@!，。；、,;.!？?！:：()（）【】\[\]"'`]+)/g;
/** 同一条规则的锚定版，用于从某个下标开始试匹配一处提及 */
const MENTION_AT_RE = /^@(!?)([^\s@!，。；、,;.!？?！:：()（）【】\[\]"'`]+)/;
/** 提及名的终止字符：出现它才说明服务端能把名字切干净 */
const DELIMITER_RE = /[\s@!，。；、,;.!？?！:：()（）【】\[\]"'`]/;

/** 解析正文里的 @提及（含 @! 强制前缀）；保持出现顺序、按名字去重（force 以首次为准） */
export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const name = (m[2] ?? '').trim();
    if (name !== '' && !out.some((x) => x.name === name)) {
      out.push({ name, force: m[1] === '!' });
    }
  }
  return out;
}

/* ---------------- 要素索引 ---------------- */

export interface ElementIndexEntry {
  name: string;
  type: ElementNameType;
}

/**
 * 裸名字（没有 @ 打头）参与匹配的最短长度。
 * 【为什么是 2】中文没有词边界，单字名几乎必然是别的词的一部分——
 * 场景叫「家」就会把「家伙」咬成「@家 伙」。显式写了 @ 的单字名不受此限。
 */
const MIN_BARE_NAME_LEN = 2;

/**
 * 三个桶摊平成一张匹配表：长名字在前（最长优先，避免「小美」把「小美丽」切错），
 * 同名只保留优先级最高的一类（角色 > 场景 > 道具），否则一个名字会被两种颜色抢。
 */
export function buildElementIndex(elements: AnnotationElements): ElementIndexEntry[] {
  const seen = new Set<string>();
  const out: ElementIndexEntry[] = [];
  const push = (type: ElementNameType, list: ReadonlyArray<{ name: string }>) => {
    for (const e of list) {
      const name = e.name.trim();
      if (name === '' || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, type });
    }
  };
  push('CHARACTER', elements.characters);
  push('SCENE', elements.scenes);
  push('PROP', elements.props);
  return out.sort((a, b) => b.name.length - a.name.length);
}

/* ---------------- 行内切段 ---------------- */

export interface LineSegment {
  /** 该片段在原始行内的起始下标；高亮渲染时直接当 data-line-base 用 */
  start: number;
  /** 片段原文（含可能的 @ / @! 前缀），逐字来自原行 */
  text: string;
  /** null = 普通文本 */
  element: {
    name: string;
    type: ElementNameType;
    /** 该处出现自带 @ 前缀 */
    annotated: boolean;
    /** @! 强制前缀 */
    force: boolean;
  } | null;
}

/** 在 raw 的 pos 处试着匹配一个要素名（最长优先）；index 必须已按长度倒序 */
function matchNameAt(raw: string, pos: number, index: ElementIndexEntry[]): ElementIndexEntry | null {
  for (const entry of index) {
    if (entry.name.length < MIN_BARE_NAME_LEN) continue;
    if (raw.startsWith(entry.name, pos)) return entry;
  }
  return null;
}

/**
 * 把一行切成「普通文本 / 要素」交替的片段。
 *
 * 三条易被忽略的处理：
 * - 已有的 @提及整体成段（含 @ 与 @!），绝不会被再套一层 @；
 * - 历史正文里「@小美踮起脚」这种没有分隔符的写法，按最长要素名前缀切出「@小美」，
 *   剩下的「踮起脚」回到普通文本——不然它既高亮不出来，也永远修不好；
 * - 每段都带 start 下标，调用方渲染时必须原样透传给 data-line-base，
 *   否则只读视图的点击落点会错位（光标会落到行首）。
 */
export function splitLineByElements(raw: string, index: ElementIndexEntry[]): LineSegment[] {
  const segments: LineSegment[] = [];
  let plainStart = 0;
  let plain = '';

  const flushPlain = () => {
    if (plain === '') return;
    segments.push({ start: plainStart, text: plain, element: null });
    plain = '';
  };
  const pushElement = (start: number, text: string, seg: NonNullable<LineSegment['element']>) => {
    flushPlain();
    segments.push({ start, text, element: seg });
    plainStart = start + text.length;
  };

  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '@') {
      const m = MENTION_AT_RE.exec(raw.slice(i));
      const captured = m?.[2] ?? '';
      if (captured !== '') {
        const force = m![1] === '!';
        const prefixLen = force ? 2 : 1;
        // 优先按整个捕获名认；认不出再退到"捕获名以某个要素名开头"
        const exact = index.find((e) => e.name === captured);
        const partial = exact ?? index.find((e) => captured.startsWith(e.name));
        if (partial !== undefined) {
          pushElement(i, raw.slice(i, i + prefixLen + partial.name.length), {
            name: partial.name,
            type: partial.type,
            annotated: true,
            force,
          });
          i += prefixLen + partial.name.length;
          continue;
        }
      }
      // 不是任何已知要素的提及：当普通文本处理，不猜、不高亮
      if (plain === '') plainStart = i;
      plain += raw[i];
      i += 1;
      continue;
    }

    const hit = matchNameAt(raw, i, index);
    if (hit !== null) {
      pushElement(i, hit.name, { name: hit.name, type: hit.type, annotated: false, force: false });
      i += hit.name.length;
      continue;
    }

    if (plain === '') plainStart = i;
    plain += raw[i];
    i += 1;
  }
  flushPlain();
  return segments;
}

/* ---------------- 自动标注 ---------------- */

export interface AnnotateResult {
  text: string;
  /** 新加的 @ 条数 */
  added: number;
  /** 被加了 @ 的要素名（去重保序）；工具栏的确认弹窗要按名字告诉用户改了什么 */
  names: string[];
}

/**
 * 给正文里已识别的要素名加上 @；已带 @ / @! 的不重复加。
 *
 * 只动动作/环境行，这是硬规则：
 * - **对白行整行不碰**。台词里出现人名是角色在称呼别人，加 @ 会把称呼变成画面引用，
 *   污染台词本身；行首的「角色名：」是说话人标记，同样不是画面里的引用。
 * - **场景标题行不碰**。抬头有自己的解析规则（parseSceneHeading），
 *   往里插 @ 会让地点名解析出错，整场的地点直接丢失。
 *
 * 场景名只加 `@`（仅文字锚定），不加 `@!`——强制发参考图会挤占参考位、稀释角色形象，
 * 该由用户显式选择，不能替他决定。
 */
export function annotateMentions(fullText: string, elements: AnnotationElements): AnnotateResult {
  const index = buildElementIndex(elements);
  if (index.length === 0) return { text: fullText, added: 0, names: [] };

  // 借解析器拿每一行的类型。lines 摊平后逐字等于 fullText.split('\n')，
  // 因此按同样的顺序 join('\n') 回去必然与原文对齐（往返无损的地基）。
  const lines = parseScript(fullText).scenes.flatMap((s) => s.lines);

  let added = 0;
  const names: string[] = [];

  const nextLines = lines.map((line) => {
    if (line.kind !== 'action') return line.raw;

    const segments = splitLineByElements(line.raw, index);
    // 本行里已经带 @ 的名字视为"已锚定"，不再给同名的其它出现补 @——
    // 一行里同一个名字反复 @ 只会让正文难读，锚定一次就够了
    const used = new Set<string>();
    for (const s of segments) {
      if (s.element !== null && s.element.annotated) used.add(s.element.name);
    }

    let out = '';
    for (const seg of segments) {
      if (seg.element === null || seg.element.annotated || used.has(seg.element.name)) {
        out += seg.text;
        continue;
      }
      used.add(seg.element.name);
      added += 1;
      if (!names.includes(seg.element.name)) names.push(seg.element.name);
      out += `@${seg.text}`;
      // 名字后面紧跟正文时补一个空格：否则服务端 MENTION_RE 会把后半句一起吞进标签名
      const after = line.raw[seg.start + seg.text.length];
      if (after !== undefined && !DELIMITER_RE.test(after)) out += ' ';
    }
    return out;
  });

  return { text: nextLines.join('\n'), added, names };
}
