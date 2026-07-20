// 剧本正文解析器。
//
// 剧本在库里始终是一段纯文本，结构化只是 UI 层的呈现方式。
// 因此本模块最硬的约束是「往返无损」：把解析出的场景块原样拼回去，
// 必须与原文逐字相同（含空行、行尾空格、首个场景标题之前的散文）。
// 做法是全程只按 '\n' 切分与拼接、绝不 trim 原始行——
// 任何"顺手规整一下格式"的好意都会在用户保存时静默改写他的稿子。
//
// 场景抬头的识别规则刻意与服务端 apps/server/src/modules/storyboard/scene-parse.ts
// 保持一致（同一份规则的前端副本，不跨端 import）：宁可少认，不可认错——
// 识别不出的字段一律留空，不编造。

export type ScriptLineKind = 'heading' | 'action' | 'dialogue' | 'narration' | 'blank';

export interface ScriptLine {
  kind: ScriptLineKind;
  /** 原始整行文本（不含换行符），拼接时原样使用 */
  raw: string;
  /** dialogue/narration 才有：说话人 */
  speaker?: string;
  /** dialogue/narration 才有：台词正文 */
  text?: string;
}

export interface ParsedScene {
  /** 0-based；展示为 S01 */
  index: number;
  /** 场景标题行解析结果；无标题行（首个场景之前的散文）时各字段为空串 */
  title: string;
  location: string;
  /** 'INT' | 'EXT' | '' */
  interiorExterior: string;
  timeOfDay: string;
  /** 该场景的全部行（含标题行本身） */
  lines: ScriptLine[];
  /** 该场景的原文（lines.raw 用 \n 拼接），编辑时以它为单位 */
  text: string;
  /** 出现的角色名（去重保序，不含旁白） */
  characters: string[];
  estimatedDurationMs: number;
  estimatedShotCount: number;
}

export interface ParsedScript {
  scenes: ParsedScene[];
  totalDurationMs: number;
  totalShotCount: number;
}

/* ---------------- 场景抬头识别（服务端 scene-parse.ts 的前端副本） ---------------- */

const CN_NUM = '[0-9０-９一二三四五六七八九十百零]';

/**
 * 抬头前缀：「场景一：」「场景 12.」「第三场：」「SCENE 4 -」等。
 * 「场景」后没有编号时强制要求冒号，否则「场景描述：一个人走过」会被误判成抬头。
 */
const HEADING_PREFIX = new RegExp(
  '^\\s*(?:' +
    `第\\s*${CN_NUM}+\\s*(?:场|幕)\\s*[:：.、\\-—]?` +
    '|' +
    `场景\\s*${CN_NUM}+\\s*[:：.、\\-—]?` +
    '|' +
    '场景\\s*[:：]' +
    '|' +
    'scene\\s*[0-9]*\\s*[:：.\\-—]' +
    ')\\s*',
  'i',
);

/** 时间词：长词优先（「傍晚」要先于「夜」匹配到） */
const TIME_WORDS = [
  '清晨',
  '凌晨',
  '早晨',
  '上午',
  '中午',
  '正午',
  '下午',
  '傍晚',
  '黄昏',
  '深夜',
  '夜晚',
  '白天',
  '日出',
  '日落',
  '夜',
];

/**
 * 内外景标记词。刻意不收「室内/室外」：中文地点名大量以「室」结尾
 * （办公室/会议室/教室），「办公室内」会被切成「办公」+室内，把地点名咬掉一个字。
 * 这类写法交给下面的 LOCATION_SUFFIX 规则处理。
 */
const INT_WORDS = ['内景', 'INT'];
const EXT_WORDS = ['外景', 'EXT'];

/** 「办公室内，白天」＝ 地点「办公室」+ 内景；去掉后缀后地点须仍有 ≥2 字 */
const LOCATION_SUFFIX = /^(.{2,}?)[内外]$/;

/** 抬头末尾的标点，解析后统一剥掉（只影响解析结果，不改原文） */
const TRAILING_PUNCT = /[。.；;，,、\s]+$/;

export interface ParsedSceneHeading {
  title: string;
  location: string;
  interiorExterior: string;
  timeOfDay: string;
}

/** 英文词（INT/EXT）要求词边界，避免 "INTERIOR DESIGN" 里的 INT 误命中 */
function containsWord(text: string, word: string): boolean {
  if (/^[A-Za-z]+$/.test(word)) {
    return new RegExp(`\\b${word}\\b`, 'i').test(text);
  }
  return text.includes(word);
}

function removeWord(text: string, word: string): string {
  if (/^[A-Za-z]+$/.test(word)) {
    return text.replace(new RegExp(`\\b${word}\\b`, 'ig'), ' ');
  }
  return text.split(word).join(' ');
}

/**
 * 解析一行场景抬头；不是抬头则返回 null。
 * 支持：「场景一：客户会议室，白天。」「第三场：内景 会议室 - 夜」「SCENE 4: 天台，黄昏」
 */
export function parseSceneHeading(line: string): ParsedSceneHeading | null {
  if (typeof line !== 'string') return null;
  const raw = line.replace(/\r/g, '').trim();
  if (raw.length === 0) return null;
  if (raw.includes('\n')) return null;

  const prefixMatch = HEADING_PREFIX.exec(raw);
  if (!prefixMatch) return null;

  // 前缀之后什么都没有（如单独一行「场景一：」）：认成抬头但字段全空，
  // 让调用方能据此断出新场景，而不是把它当正文
  let body = raw.slice(prefixMatch[0].length).trim();
  body = body.replace(TRAILING_PUNCT, '');
  if (body.length === 0) {
    return { title: '', location: '', interiorExterior: '', timeOfDay: '' };
  }

  let interiorExterior = '';
  for (const w of INT_WORDS) {
    if (containsWord(body, w)) {
      interiorExterior = 'INT';
      body = removeWord(body, w);
      break;
    }
  }
  if (interiorExterior === '') {
    for (const w of EXT_WORDS) {
      if (containsWord(body, w)) {
        interiorExterior = 'EXT';
        body = removeWord(body, w);
        break;
      }
    }
  }

  let timeOfDay = '';
  for (const w of TIME_WORDS) {
    if (body.includes(w)) {
      timeOfDay = w;
      body = removeWord(body, w);
      break;
    }
  }

  const segments = body
    .split(/[，,。.\-—－–|｜/／]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // 「办公室内」式后缀只对第一段（地点）判定：后面的段是时间/氛围描述
  if (interiorExterior === '' && segments.length > 0) {
    const m = LOCATION_SUFFIX.exec(segments[0]!);
    if (m) {
      interiorExterior = segments[0]!.endsWith('内') ? 'INT' : 'EXT';
      segments[0] = m[1]!;
    }
  }

  const title = segments.join(' ').trim();
  return { title, location: title, interiorExterior, timeOfDay };
}

/* ---------------- 行解析 ---------------- */

/** 旁白的说话人固定写法：它是"被读出来的字"，但不算角色 */
export const NARRATOR_NAME = '旁白';

/**
 * 对白行：`角色名：台词`（全角冒号）。
 * 角色名 ≤6 字且不含标点/空白——放宽到任意长度的话，
 * 「他转身，看着窗外：那句话还在耳边」这种动作行会被吞成对白。
 */
const DIALOGUE_RE = /^([^：:，,。.！!？?；;、"'“”‘’（）()\s]{1,6})：([\s\S]*)$/;

/** 半角冒号写法：能读懂意思，但服务端拆分镜不认——用于给出格式提示 */
const HALFWIDTH_DIALOGUE_RE = /^([^：:，,。.！!？?；;、"'“”‘’（）()\s]{1,12}):([\s\S]*)$/;

/** 全角冒号但角色名过长：同样不会被识别为对白 */
const LONG_SPEAKER_RE = /^([^：:，,。.！!？?；;、"'“”‘’（）()\s]{7,20})：([\s\S]*)$/;

/** 对白行的格式问题类型；null 表示这一行没问题（或压根不是想写对白） */
export type DialogueIssue = 'halfwidth-colon' | 'long-speaker';

/**
 * 检查某一行是否"看起来想写对白但写法不会被识别"。
 * 只在解析器判定该行不是 dialogue/narration 时才有意义，供编辑器打提示用。
 */
export function inspectDialogueIssue(raw: string): DialogueIssue | null {
  if (parseSceneHeading(raw) !== null) return null;
  // 与 parseLine 同样先剥掉行首缩进，否则缩进过的对白行会被判成"有问题"
  const body = raw.trimStart();
  if (DIALOGUE_RE.test(body)) return null;
  if (LONG_SPEAKER_RE.test(body)) return 'long-speaker';
  if (HALFWIDTH_DIALOGUE_RE.test(body)) return 'halfwidth-colon';
  return null;
}

/** 单行分类。raw 原样保留，任何字段都不改写它 */
function parseLine(raw: string): ScriptLine {
  if (raw.trim() === '') return { kind: 'blank', raw };
  if (parseSceneHeading(raw) !== null) return { kind: 'heading', raw };

  const m = DIALOGUE_RE.exec(raw.trimStart());
  if (m) {
    const speaker = m[1]!;
    const text = m[2]!;
    return {
      kind: speaker === NARRATOR_NAME ? 'narration' : 'dialogue',
      raw,
      speaker,
      text,
    };
  }

  return { kind: 'action', raw };
}

/* ---------------- 时长与镜头数估算 ---------------- */

/** 中文口播约每秒 4 字 → 每字 250ms（与右栏体检共用同一口径） */
const MS_PER_CHAR = 250;
/** 一条动作/环境行大致折算的画面时长 */
const MS_PER_ACTION_LINE = 1500;
const MIN_SCENE_MS = 3000;
const MAX_SCENE_MS = 30000;
/** 与服务端「单镜头 2000-8000ms 优先 4000」的约定一致 */
const MS_PER_SHOT = 4000;
const MIN_SHOT_COUNT = 1;
const MAX_SHOT_COUNT = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 场景预计时长：对白字数 × 250ms + 动作行数 × 1500ms，夹取在 3~30 秒 */
export function estimateSceneDurationMs(lines: ScriptLine[]): number {
  let spokenChars = 0;
  let actionLines = 0;
  for (const line of lines) {
    if (line.kind === 'dialogue' || line.kind === 'narration') {
      spokenChars += (line.text ?? '').trim().length;
    } else if (line.kind === 'action') {
      actionLines += 1;
    }
  }
  return clamp(spokenChars * MS_PER_CHAR + actionLines * MS_PER_ACTION_LINE, MIN_SCENE_MS, MAX_SCENE_MS);
}

/** 场景预计镜头数：clamp(round(时长 / 4000), 1, 5) */
export function estimateSceneShotCount(durationMs: number): number {
  return clamp(Math.round(durationMs / MS_PER_SHOT), MIN_SHOT_COUNT, MAX_SHOT_COUNT);
}

/** 毫秒 → 「18秒」/「1分12秒」，给导航与工具栏共用，避免两处口径漂移 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}分` : `${minutes}分${seconds}秒`;
}

/** 内外景枚举 → 中文展示；识别不出时返回空串，由调用方跳过该段 */
export function formatInteriorExterior(value: string): string {
  if (value === 'INT') return '内景';
  if (value === 'EXT') return '外景';
  return '';
}

/* ---------------- 主解析入口 ---------------- */

function buildScene(index: number, lines: ScriptLine[]): ParsedScene {
  const headingLine = lines[0]?.kind === 'heading' ? lines[0] : null;
  const heading = headingLine === null ? null : parseSceneHeading(headingLine.raw);

  const characters: string[] = [];
  for (const line of lines) {
    if (line.kind !== 'dialogue') continue;
    const speaker = line.speaker ?? '';
    if (speaker !== '' && !characters.includes(speaker)) characters.push(speaker);
  }

  const estimatedDurationMs = estimateSceneDurationMs(lines);
  return {
    index,
    title: heading?.title ?? '',
    location: heading?.location ?? '',
    interiorExterior: heading?.interiorExterior ?? '',
    timeOfDay: heading?.timeOfDay ?? '',
    lines,
    text: lines.map((l) => l.raw).join('\n'),
    characters,
    estimatedDurationMs,
    estimatedShotCount: estimateSceneShotCount(estimatedDurationMs),
  };
}

/**
 * 把剧本正文切成场景块。
 *
 * 分块规则：每遇到一行场景抬头就开一个新块；首个抬头之前的内容
 * （散文式剧本、前言、空行）自成 index=0 的无标题场景，绝不丢弃。
 * 空正文返回空场景列表（[].join('\n') === '' 同样满足往返无损）。
 */
export function parseScript(text: string): ParsedScript {
  if (text === '') {
    return { scenes: [], totalDurationMs: 0, totalShotCount: 0 };
  }

  // 只按 '\n' 切分：split/join 是严格互逆的，这是往返无损的地基
  const rawLines = text.split('\n');

  const groups: ScriptLine[][] = [];
  let current: ScriptLine[] | null = null;
  for (const raw of rawLines) {
    const line = parseLine(raw);
    if (line.kind === 'heading' || current === null) {
      current = [];
      groups.push(current);
    }
    current.push(line);
  }

  const scenes = groups.map((lines, index) => buildScene(index, lines));
  const totalDurationMs = scenes.reduce((sum, s) => sum + s.estimatedDurationMs, 0);
  const totalShotCount = scenes.reduce((sum, s) => sum + s.estimatedShotCount, 0);
  return { scenes, totalDurationMs, totalShotCount };
}

/**
 * 场景块回写：把某个场景的新文本替换回全文，其余部分逐字不动。
 * 越界或空正文时原样返回，调用方无需额外判空。
 */
export function replaceSceneText(
  fullText: string,
  sceneIndex: number,
  nextSceneText: string,
): string {
  const { scenes } = parseScript(fullText);
  if (sceneIndex < 0 || sceneIndex >= scenes.length) return fullText;
  const texts = scenes.map((s) => s.text);
  texts[sceneIndex] = nextSceneText;
  return texts.join('\n');
}
