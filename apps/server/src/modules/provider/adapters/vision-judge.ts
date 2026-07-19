// 视觉评审适配器：让视觉模型对照角色设计图给关键图打分。
// 存在意义（真实踩坑）：猴子角色被画成人类、标签描述与设计图冲突导致形象漂移，
// 此前只能靠人逐张肉眼比对。这里把"比对"变成可复用的一次模型调用。
//
// 走 OpenAI 兼容 /chat/completions 的多模态 content 数组，与 openai-compatible.ts 同一套
// 错误处理风格（网络错误翻译成带 host 的中文提示）。
import fs from 'node:fs';
import path from 'node:path';
import type { GenModelCfg } from '../../generation/gens.js';

export interface VisionJudgeArgs {
  /** 待评审图的本地绝对路径 */
  imagePath: string;
  /** 角色/道具设计图（canonical）本地绝对路径 */
  refImagePaths: string[];
  /** 本轮使用的生图提示词 */
  prompt: string;
  modelCfg: GenModelCfg;
}

export interface VisionVerdict {
  identityMatch: number;
  promptMatch: number;
  issues: string[];
  verdict: 'pass' | 'retry' | 'fix_prompt';
}

/** 参考图上限：多参考图 token 成本线性上涨，且模型注意力有限，3 张足够锚定形象 */
export const MAX_REF_IMAGES = 3;

/** 判定阈值：两项都达标才放行（形象一致性要求更严——画错物种是硬伤，构图偏差可容忍） */
export const PASS_IDENTITY_MIN = 75;
export const PASS_PROMPT_MIN = 70;

function toDataUrl(filePath: string): string {
  const ext = path.extname(filePath).replace('.', '').toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const b64 = fs.readFileSync(filePath).toString('base64');
  return `data:image/${mime};base64,${b64}`;
}

/**
 * 评审提示词。刻意点名"动物/机器人被画成人类"这一类错误——通用提问下模型倾向给出
 * 客套的高分，必须把已知的失败模式写死进指令里才会真的扣分。
 */
function buildJudgePrompt(prompt: string, refCount: number): string {
  return [
    '你是漫剧美术总监，负责校验 AI 生成的分镜关键图是否可用。',
    refCount > 0
      ? `下面第 1 张是【待评审的关键图】，第 2 到第 ${refCount + 1} 张是【角色/道具设计图（参考基准）】。`
      : '下面第 1 张是【待评审的关键图】，本次没有提供参考设计图。',
    '',
    '【本次关键图使用的提示词】',
    prompt,
    '',
    '请完成两项判断：',
    '1. identityMatch（0-100）：对比参考图，判断画面中角色的「物种、体型、配色、服装、关键特征」是否一致。' +
      '把动物或机器人角色画成人类属于严重不一致，此项必须给 30 分以下。没有参考图时按提示词描述判断，并在 issues 中说明缺少参考。',
    '2. promptMatch（0-100）：判断画面内容（动作、构图、场景、镜头）是否符合上述提示词。',
    '',
    '另外：若发现【提示词的文字描述与参考图自相矛盾】（例如提示词把参考图里的动物角色描述成人、' +
      '或服装配色与设计图冲突），请在 issues 中明确指出矛盾点，并把 verdict 设为 "fix_prompt"。',
    '',
    'verdict 取值规则：',
    `- "pass"：identityMatch >= ${PASS_IDENTITY_MIN} 且 promptMatch >= ${PASS_PROMPT_MIN}；`,
    '- "fix_prompt"：问题源于提示词与参考图冲突或提示词描述有误，重抽也无法解决；',
    '- "retry"：问题只是本次生成的随机性偏差（构图、姿态、细节失误），重抽有机会解决。',
    '',
    'issues 用中文列出具体问题（无问题给空数组）。',
    '严格只输出如下 JSON，不要任何解释文字：',
    '{"identityMatch":0-100,"promptMatch":0-100,"issues":["..."],"verdict":"pass|retry|fix_prompt"}',
  ].join('\n');
}

/** 剥掉模型可能包裹的 markdown 代码块，取出最外层 JSON 对象 */
function extractJson(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) text = text.slice(start, end + 1);
  return text;
}

function clampScore(value: unknown, field: string): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`视觉评审响应解析失败：${field} 不是数字（收到 ${JSON.stringify(value)}）`);
  }
  return Math.max(0, Math.min(100, Math.round(num)));
}

/** 解析模型返回的评审 JSON；容错 markdown 包裹，字段缺失/越界给中文错误 */
export function parseVerdict(raw: string): VisionVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    throw new Error(`视觉评审响应解析失败（不是合法 JSON）：${raw.slice(0, 300)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`视觉评审响应解析失败（不是 JSON 对象）：${raw.slice(0, 300)}`);
  }
  const obj = parsed as Record<string, unknown>;

  const identityMatch = clampScore(obj.identityMatch, 'identityMatch');
  const promptMatch = clampScore(obj.promptMatch, 'promptMatch');
  const issues = Array.isArray(obj.issues)
    ? obj.issues.filter((i): i is string => typeof i === 'string')
    : [];
  const verdict = obj.verdict;
  if (verdict !== 'pass' && verdict !== 'retry' && verdict !== 'fix_prompt') {
    throw new Error(
      `视觉评审响应解析失败：verdict 取值非法（期望 pass/retry/fix_prompt，收到 ${JSON.stringify(verdict)}）`,
    );
  }

  // 阈值以代码为准：视觉模型常给出"分数很低却判 pass"的客套结论，
  // 照单全收会把劣质图直接设为选定——正是本功能要消灭的场景。
  // 分数不达标时强制改判：有具体问题走改写提示词，否则纯重抽。
  const scoresPass = identityMatch >= PASS_IDENTITY_MIN && promptMatch >= PASS_PROMPT_MIN;
  const finalVerdict =
    verdict === 'pass' && !scoresPass ? (issues.length > 0 ? 'fix_prompt' : 'retry') : verdict;

  return { identityMatch, promptMatch, issues, verdict: finalVerdict };
}

/**
 * 对照参考设计图评审一张关键图。
 * 待评审图放在参考图【之前】，与评审提示词里的"第 1 张"编号约定一致。
 */
export async function visionJudge(
  cfg: GenModelCfg,
  args: VisionJudgeArgs,
  opts?: { timeoutMs?: number },
): Promise<VisionVerdict> {
  const refs = args.refImagePaths.slice(0, MAX_REF_IMAGES);
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: buildJudgePrompt(args.prompt, refs.length) },
    { type: 'image_url', image_url: { url: toDataUrl(args.imagePath) } },
    ...refs.map((p) => ({ type: 'image_url', image_url: { url: toDataUrl(p) } })),
  ];

  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.modelKey,
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 90000),
    });
  } catch (err) {
    // undici 的 'fetch failed' 对用户无信息量，翻译为可行动的中文提示
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return cfg.baseUrl;
      }
    })();
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    throw new Error(
      isTimeout
        ? `视觉评审请求超时：${host} 无响应（图片较大时耗时更长，可重试）`
        : `网络不可达：无法连接 ${host}（国内直连国外服务通常需要代理，或检查网络）`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`视觉评审请求失败：HTTP ${res.status}，响应：${text.slice(0, 300)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`视觉评审响应结构异常（非 JSON）：${text.slice(0, 300)}`);
  }
  const message = (parsed as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
    ?.message?.content;
  if (typeof message !== 'string') {
    throw new Error(`视觉评审响应结构异常（缺 choices[0].message.content）：${text.slice(0, 300)}`);
  }
  return parseVerdict(message);
}
