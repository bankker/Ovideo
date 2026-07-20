// 场景标题行解析。
// 存量剧本（以及 LLM 产出的剧本正文）用「场景一：客户会议室，白天。」这类中文抬头标记一场戏，
// 回填脚本要靠它把存量 Shot.sourceText 还原成 Scene 的结构化字段；
// 后续生成链路也会复用它校验模型输出的场景抬头。
// 设计原则：宁可少认，不可认错——解析不出就返回 null，由调用方退化到"首行前 20 字作 title"，
// 因为把正文误当标题会污染整个场景列表，而 title 缺失只是展示不好看。

export interface ParsedSceneHeading {
  /** 场景名，如"客户会议室" */
  title: string;
  /** 地点。多数中文剧本抬头里地点与场景名同源，故与 title 取同值 */
  location: string;
  /** "INT" | "EXT" | ""（标题里没写内外景时留空，不猜） */
  interiorExterior: string;
  /** "白天" | "傍晚" | "深夜" | ""（未出现则留空） */
  timeOfDay: string;
}

/**
 * 抬头前缀：「场景一：」「场景 12.」「第三场：」「SCENE 4 -」等；
 * 序号本身不入库（Scene.sortOrder 才是权威，正文里的编号常与实际顺序不符）。
 * 「场景」后没有编号时强制要求冒号，否则「场景描述：一个人走过」会被误判成抬头。
 */
const CN_NUM = '[0-9０-９一二三四五六七八九十百零]';
const HEADING_PREFIX = new RegExp(
  '^\\s*(?:' +
    // 第三场： / 第 12 幕.
    `第\\s*${CN_NUM}+\\s*(?:场|幕)\\s*[:：.、\\-—]?` +
    '|' +
    // 场景一： / 场景12.
    `场景\\s*${CN_NUM}+\\s*[:：.、\\-—]?` +
    '|' +
    // 场景： —— 无编号时必须带冒号
    '场景\\s*[:：]' +
    '|' +
    // SCENE 4: / SCENE:
    'scene\\s*[0-9]*\\s*[:：.\\-—]' +
    ')\\s*',
  'i',
);

/** 时间词：按出现顺序匹配，长词优先（"傍晚"要先于"晚"匹配到） */
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
 * 内外景标记词 → 归一化枚举。
 * 刻意不收「室内/室外」：中文地点名大量以「室」结尾（办公室/会议室/教室/实验室），
 * 「办公室内」会被切成「办公」+室内，把地点名咬掉一个字——标题是用户可见的，
 * 认错比认不出代价大得多。这类写法交给下面的「地点+内/外」后缀规则处理。
 */
const INT_WORDS = ['内景', 'INT'];
const EXT_WORDS = ['外景', 'EXT'];

/**
 * 中文剧本常见写法「办公室内，白天」＝ 地点「办公室」+ 内景。
 * 仅当「内/外」结尾、且去掉它后地点仍有 ≥2 字时才认（否则「室内」这种孤立标记会被拆坏）。
 */
const LOCATION_SUFFIX = /^(.{2,}?)[内外]$/;

/** 抬头末尾的标点（中文句号/英文句号/分号等），解析后统一剥掉 */
const TRAILING_PUNCT = /[。.；;，,、\s]+$/;

/**
 * 解析一行场景抬头。
 * 支持：「场景一：客户会议室，白天。」「场景二：华为作战室，傍晚。」
 *      「第三场：内景 会议室 - 夜」「SCENE 4: 天台，黄昏」
 * 不是抬头（没有「场景/第N场/SCENE」前缀）时返回 null。
 */
export function parseSceneHeading(line: string): ParsedSceneHeading | null {
  if (typeof line !== 'string') return null;
  const raw = line.replace(/\r/g, '').trim();
  if (raw.length === 0) return null;
  // 多行输入不是"一行抬头"，拒绝（调用方应自己切行）
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

  // ---- 内外景：出现在任意位置都算，识别后从正文剔除 ----
  let interiorExterior = '';
  for (const w of INT_WORDS) {
    if (containsWord(body, w)) {
      interiorExterior = 'INT';
      body = removeWord(body, w);
      break;
    }
  }
  if (!interiorExterior) {
    for (const w of EXT_WORDS) {
      if (containsWord(body, w)) {
        interiorExterior = 'EXT';
        body = removeWord(body, w);
        break;
      }
    }
  }

  // ---- 时间：同样任意位置，长词优先（TIME_WORDS 已按此排序）----
  let timeOfDay = '';
  for (const w of TIME_WORDS) {
    if (body.includes(w)) {
      timeOfDay = w;
      body = removeWord(body, w);
      break;
    }
  }

  // ---- 剩下的就是场景名：按标点切段，剥掉空白 ----
  const segments = body
    .split(/[，,。.\-—－–|｜/／]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // 「办公室内」式后缀只对第一段（地点）判定：后面的段是时间/氛围描述，
  // 它们碰巧以「内/外」结尾不代表内外景。显式标记已出现时不覆盖剧本原意。
  if (!interiorExterior && segments.length > 0) {
    const m = LOCATION_SUFFIX.exec(segments[0]!);
    if (m) {
      interiorExterior = segments[0]!.endsWith('内') ? 'INT' : 'EXT';
      segments[0] = m[1]!;
    }
  }

  const title = segments.join(' ').trim();
  return { title, location: title, interiorExterior, timeOfDay };
}

/** 英文词（INT/EXT）要求词边界，避免 "INTERIOR DESIGN" 里的 INT 或中文词里的误命中 */
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

/** 解析不出抬头时的兜底标题：首行前 20 字（回填脚本与生成链路共用，保证展示口径一致） */
export function fallbackSceneTitle(sourceText: string): string {
  const firstLine = (sourceText ?? '').split('\n')[0]?.trim() ?? '';
  return firstLine.slice(0, 20);
}
