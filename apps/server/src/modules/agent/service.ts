// 关键图自动收敛 agent（核心循环）。
// 存在意义（真实踩坑）：猴子角色被画成人类、标签描述与设计图冲突导致形象漂移，
// 此前只能靠人逐张肉眼比对再重抽。这里把「抽 → 看 → 判 → 再抽」自动跑完。
//
// 【双线并存铁律】agent 是核心管线的旁路，不是特权路径：
// - 生成只调用既有关键图生成能力（依赖注入），不为 agent 新增执行器分支；
// - agent 自身状态一律落 AgentRun 新表，核心表（Shot/Take/Asset）只以「人类同样的方式」被写入；
// - 每轮候选都是正常 Take，人随时可在既有抽卡 UI 里改选，全程不删任何 Take/Asset；
// - 提示词改写只在本次运行内生效（走 promptOverride），绝不写回 Shot.imagePrompt——分镜数据是人的资产。
import fs from 'node:fs';
import type { AgentRun, PrismaClient } from '@prisma/client';
import { notFound } from '../../lib/errors.js';
import { parseJson, toJson } from '../../lib/json.js';
import { uriToAbsPath } from '../../lib/storage.js';
import { resolveBinding } from '../binding/service.js';
import { onTakeSelected } from '../stale/service.js';
import type { VisionVerdict } from '../provider/adapters/vision-judge.js';

export const AGENT_KIND_KEYFRAME_CONVERGE = 'KEYFRAME_CONVERGE';

/** 轮次默认值与硬上限（成本闸门：一轮 = 一次真实生图 + 一次视觉评审） */
export const DEFAULT_MAX_ROUNDS = 3;
export const MAX_ROUNDS_HARD_LIMIT = 5;

/** 送评审的参考图上限（与 vision-judge 的 MAX_REF_IMAGES 一致：多图稀释注意力且线性涨 token） */
export const MAX_JUDGE_REFS = 3;

/** 每轮记录（roundsJson 的元素形状，前端按此渲染，勿随意改字段名） */
export interface AgentRound {
  round: number;
  takeId: string;
  assetUri: string;
  identityMatch: number;
  promptMatch: number;
  issues: string[];
  verdict: 'pass' | 'retry' | 'fix_prompt';
  action: string;
  promptUsed: string;
  suggestedPrompt?: string;
}

/* ---------------- 依赖注入（照 generation 模块 GenerationGens 的风格） ---------------- */

export interface AgentKeyframeGenArgs {
  db: PrismaClient;
  projectId: string;
  shotId: string;
  /** 图像模型；缺省由接线处按调度器选队首 */
  modelConfigId?: string;
  /** 本轮改写后的提示词；缺省 = 用镜头上原本的 imagePrompt（纯重抽） */
  promptOverride?: string;
}

/** 产出一张新关键图候选：必须走既有关键图生成能力，返回的 take 与人工抽卡产物完全同形 */
export type AgentKeyframeGen = (args: AgentKeyframeGenArgs) => Promise<{ takeId: string; assetUri: string }>;

export type AgentVisionJudge = (args: {
  db: PrismaClient;
  imagePath: string;
  refImagePaths: string[];
  prompt: string;
  visionModelConfigId?: string;
}) => Promise<VisionVerdict>;

/** 文本模型通道（jsonMode），用于提示词改写建议 */
export type AgentTextGen = (args: { db: PrismaClient; prompt: string }) => Promise<string>;

export interface AgentDeps {
  generateKeyframe: AgentKeyframeGen;
  judgeImage: AgentVisionJudge;
  textGen: AgentTextGen;
}

/* ---------------- 提示词改写 ---------------- */

/**
 * 改写指令。要求写死在中文提示词里：只消除与参考图冲突的描述，叙事内容与角色名不许动——
 * 否则模型会顺手「优化」剧情或把角色名译成英文，人再采纳建议时就踩雷了。
 */
export function buildRewritePrompt(currentPrompt: string, issues: string[], refNotes: string[]): string {
  return [
    '你是漫剧分镜提示词校对员。下面这条关键图提示词生成出的画面，与角色/道具设计图不一致。',
    '',
    '【当前提示词】',
    currentPrompt,
    '',
    '【参考设计图（形象基准，不可违背）】',
    refNotes.length > 0 ? refNotes.map((n, i) => `${i + 1}. ${n}`).join('\n') : '（本镜头没有可用的设计图）',
    '',
    '【视觉评审发现的问题】',
    issues.length > 0 ? issues.map((s, i) => `${i + 1}. ${s}`).join('\n') : '（评审未给出具体问题）',
    '',
    '改写要求：',
    '1. 保留镜头的叙事内容（人物动作、情绪、场景、镜头语言、画面节奏），不得改变剧情；',
    '2. 只修正与参考设计图冲突的描述——例如把与设计图不符的「白衬衫黑领带」改成设计图里的实际服装，' +
      '把被误写成人类的动物/机器人角色改回其真实物种与形态；',
    '3. 严禁翻译或改写角色名，角色名一律原样保留；',
    '4. 不要新增设计图里没有的形象设定，也不要堆砌无关的画质词。',
    '',
    '严格只输出如下 JSON，不要任何解释文字：',
    '{"prompt":"改写后的完整提示词"}',
  ].join('\n');
}

/** 解析改写响应；容错 markdown 代码块包裹。解析不出可用提示词时抛中文错误（调用方降级为纯重抽） */
export function parseRewrittenPrompt(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) text = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`提示词改写响应解析失败（不是合法 JSON）：${raw.slice(0, 200)}`);
  }
  const prompt = (parsed as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error(`提示词改写响应解析失败（缺少非空的 prompt 字段）：${raw.slice(0, 200)}`);
  }
  return prompt.trim();
}

/* ---------------- 运行记录读写 ---------------- */

export interface CreateAgentRunInput {
  projectId: string;
  shotId: string;
  maxRounds?: number;
}

export async function createAgentRun(db: PrismaClient, input: CreateAgentRunInput): Promise<AgentRun> {
  const maxRounds = Math.min(
    MAX_ROUNDS_HARD_LIMIT,
    Math.max(1, Math.round(input.maxRounds ?? DEFAULT_MAX_ROUNDS)),
  );
  return db.agentRun.create({
    data: {
      projectId: input.projectId,
      shotId: input.shotId,
      kind: AGENT_KIND_KEYFRAME_CONVERGE,
      status: 'RUNNING',
      maxRounds,
    },
  });
}

/** 该镜头是否已有在跑的收敛任务（路由据此拒绝重复发起） */
export async function findRunningRun(db: PrismaClient, shotId: string): Promise<AgentRun | null> {
  return db.agentRun.findFirst({ where: { shotId, status: 'RUNNING' } });
}

export async function listAgentRuns(db: PrismaClient, shotId: string): Promise<AgentRun[]> {
  return db.agentRun.findMany({ where: { shotId }, orderBy: { createdAt: 'desc' } });
}

/** 失败落库（中文原因）；已进终态的运行不覆盖 */
export async function failAgentRun(db: PrismaClient, runId: string, error: string): Promise<void> {
  const run = await db.agentRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== 'RUNNING') return;
  await db.agentRun.update({
    where: { id: runId },
    data: { status: 'FAILED', error: error.slice(0, 1000), finishedAt: new Date() },
  });
}

export function readRounds(run: Pick<AgentRun, 'roundsJson'>): AgentRound[] {
  return parseJson<AgentRound[]>(run.roundsJson, []);
}

/* ---------------- 参考图解析 ---------------- */

/** 标签类型中文名与参考优先级：角色/道具锚定形象，场景只在纯空镜时才有参考价值 */
const TAG_TYPE_LABEL: Record<string, string> = { CHARACTER: '角色', SCENE: '场景', PROP: '道具' };
const TAG_TYPE_ORDER: Record<string, number> = { CHARACTER: 0, PROP: 1, SCENE: 2 };

/**
 * 取本镜头的形象基准图（送视觉模型对照）。
 * 只读不写：绑定按「镜头级覆盖 > 标签级默认 > 默认设计图」实时解析，与生成时的取用一致。
 * 角色/道具优先，全无角色参考（空镜）时才退而用场景图；文件不存在的资产直接跳过，
 * 免得整轮评审因为一张丢失的图而炸掉。
 */
export async function resolveJudgeRefs(
  db: PrismaClient,
  shotId: string,
  episodeId: string,
): Promise<{ paths: string[]; notes: string[] }> {
  const shotTags = await db.shotTag.findMany({ where: { shotId }, include: { tag: true } });
  const ordered = [...shotTags].sort(
    (a, b) => (TAG_TYPE_ORDER[a.tag.type] ?? 9) - (TAG_TYPE_ORDER[b.tag.type] ?? 9),
  );
  const characterFirst = ordered.filter((st) => st.tag.type !== 'SCENE');
  const chosen = characterFirst.length > 0 ? characterFirst : ordered;

  const paths: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const st of chosen) {
    if (paths.length >= MAX_JUDGE_REFS) break;
    // 复用既有解析（镜头级覆盖 > 标签级默认），未绑定回落默认设计图 —— 与生成时取用的图完全一致，
    // 否则「评审用的基准图」和「生成用的参考图」会是两张，评分就不可信了
    const assetId = (await resolveBinding(db, episodeId, st.tagId, shotId)) ?? st.tag.canonicalAssetId;
    if (!assetId || seen.has(assetId)) continue;
    seen.add(assetId);
    const asset = await db.asset.findUnique({ where: { id: assetId } });
    if (!asset) continue;
    const absPath = uriToAbsPath(asset.uri);
    if (!fs.existsSync(absPath)) continue;
    paths.push(absPath);
    const desc = st.tag.description ? `，${st.tag.description.slice(0, 60)}` : '';
    notes.push(`${st.tag.name}（${TAG_TYPE_LABEL[st.tag.type] ?? st.tag.type}${desc}）`);
  }
  return { paths, notes };
}

/* ---------------- 收敛循环 ---------------- */

export interface RunConvergeOptions {
  runId: string;
  modelConfigId?: string;
  visionModelConfigId?: string;
  updateProgress?: (percent: number) => Promise<void> | void;
}

/** 综合分：形象一致性 + 画面符合度，用于轮次耗尽时挑「历史最好的一轮」 */
function scoreOf(r: AgentRound): number {
  return r.identityMatch + r.promptMatch;
}

/**
 * 跑完一次收敛：最多 maxRounds 轮「生成 → 评审 → 决策」。
 * pass 立即收工；轮次耗尽仍不达标 → NEEDS_HUMAN，并把历史最高分那轮作为 finalTake 交还人工。
 * 成本闸门：全程只生成图像，绝不触发视频生成。
 */
/**
 * 启动恢复：进程重启会遗留 RUNNING 的运行记录。不清扫的话 findRunningRun 会一直认为
 * 该镜头有任务在跑，用户永远发不起新的收敛（永久卡死）。与 Job 的启动恢复同一策略：
 * 标记失败并说明原因，不自动重跑（生图可能已计费）。
 */
export async function recoverStaleAgentRuns(db: PrismaClient): Promise<number> {
  const r = await db.agentRun.updateMany({
    where: { status: 'RUNNING' },
    data: {
      status: 'FAILED',
      error: '服务重启导致自动收敛中断；已抽出的候选图全部保留，可重新发起',
      finishedAt: new Date(),
    },
  });
  return r.count;
}

export async function runKeyframeConverge(
  db: PrismaClient,
  deps: AgentDeps,
  opts: RunConvergeOptions,
): Promise<AgentRun> {
  const run = await db.agentRun.findUnique({ where: { id: opts.runId } });
  if (!run) throw notFound('自动收敛运行记录');
  // 幂等守卫：Job 失败重试会再次调进来，若不拦住会从第 1 轮重跑（重复烧生图的钱），
  // 还会把已终态的运行复活成 PASSED。非 RUNNING 一律直接返回。
  if (run.status !== 'RUNNING') return run;

  const shot = await db.shot.findUnique({
    where: { id: run.shotId },
    include: { storyboard: true },
  });
  if (!shot) throw notFound('镜头');

  // 人类优先的判定基线：系统留下的选定状态（每轮生成后更新，见循环内说明）
  let expectedSelectedTakeId = shot.keyframeSelectedTakeId;
  const originalPrompt = shot.imagePrompt || shot.sourceText;
  const refs = await resolveJudgeRefs(db, shot.id, shot.storyboard.episodeId);

  const rounds: AgentRound[] = [];
  /** 下一轮改用的提示词；始终只作为 promptOverride 传下去，绝不写回 Shot.imagePrompt */
  let nextPromptOverride: string | undefined;
  let passed = false;

  for (let round = 1; round <= run.maxRounds; round++) {
    // 可停：运行本身是 Job，用户取消后不再烧下一轮的钱
    if (run.jobId) {
      const job = await db.job.findUnique({ where: { id: run.jobId } });
      if (job?.status === 'CANCELED') {
        return db.agentRun.update({
          where: { id: run.id },
          data: { status: 'CANCELED', roundsJson: toJson(rounds), finishedAt: new Date() },
        });
      }
    }

    const promptUsed = nextPromptOverride ?? originalPrompt;
    const beforeGen = await db.shot.findUnique({ where: { id: shot.id } });
    const gen = await deps.generateKeyframe({
      db,
      projectId: run.projectId,
      shotId: shot.id,
      modelConfigId: opts.modelConfigId,
      promptOverride: nextPromptOverride,
    });

    // 生成管线只在"镜头此前完全没有选定"时自动选中首个 take（既有抽卡语义）。
    // 只有这种系统自身造成的变化才推进基线；人的改动绝不吸收，
    // 否则收官时就分辨不出"当前选定"到底是系统留下的还是人手动改的。
    if (beforeGen?.keyframeSelectedTakeId == null) {
      const afterGen = await db.shot.findUnique({ where: { id: shot.id } });
      if (afterGen?.keyframeSelectedTakeId === gen.takeId) {
        expectedSelectedTakeId = gen.takeId;
      }
    }

    const verdict = await deps.judgeImage({
      db,
      imagePath: uriToAbsPath(gen.assetUri),
      refImagePaths: refs.paths,
      prompt: promptUsed,
      visionModelConfigId: opts.visionModelConfigId,
    });

    const record: AgentRound = {
      round,
      takeId: gen.takeId,
      assetUri: gen.assetUri,
      identityMatch: verdict.identityMatch,
      promptMatch: verdict.promptMatch,
      issues: verdict.issues,
      verdict: verdict.verdict,
      action: '',
      promptUsed,
    };

    if (verdict.verdict === 'pass') {
      record.action = `第 ${round} 轮评审通过（形象一致性 ${verdict.identityMatch}／画面符合度 ${verdict.promptMatch}），收敛结束`;
      passed = true;
    } else if (round >= run.maxRounds) {
      record.action = `第 ${round} 轮仍未达标（形象一致性 ${verdict.identityMatch}／画面符合度 ${verdict.promptMatch}），轮次已用尽，交还人工确认`;
    } else if (verdict.verdict === 'fix_prompt') {
      // 提示词与参考图冲突，重抽也解决不了 —— 让文本模型给出改写建议，下一轮用它重抽。
      // 改写失败不炸整个运行：降级为纯重抽，并在 action 里留痕。
      try {
        const raw = await deps.textGen({
          db,
          prompt: buildRewritePrompt(promptUsed, verdict.issues, refs.notes),
        });
        const suggested = parseRewrittenPrompt(raw);
        record.suggestedPrompt = suggested;
        nextPromptOverride = suggested;
        record.action = `第 ${round} 轮判定为提示词与参考图冲突，已改写提示词后进入下一轮重抽（改写仅本次运行生效，镜头提示词未修改）`;
      } catch (err) {
        record.action =
          `第 ${round} 轮判定为提示词与参考图冲突，但提示词改写失败（${err instanceof Error ? err.message : String(err)}），` +
          '下一轮沿用原提示词直接重抽';
      }
    } else {
      record.action = `第 ${round} 轮判定为随机性偏差（形象一致性 ${verdict.identityMatch}／画面符合度 ${verdict.promptMatch}），沿用原提示词重抽`;
    }

    rounds.push(record);
    // 每轮落库：中途失败/取消也留下完整轨迹，前端可实时看到进度
    await db.agentRun.update({ where: { id: run.id }, data: { roundsJson: toJson(rounds) } });
    await opts.updateProgress?.(Math.round((round / run.maxRounds) * 90));
    if (passed) break;
  }

  // 收官：pass 用最后一轮，否则挑历史最高分（同分取更早的一轮，先抽出来的先用）
  const finalRound = passed
    ? rounds[rounds.length - 1]
    : rounds.reduce<AgentRound | undefined>((best, r) => (!best || scoreOf(r) > scoreOf(best) ? r : best), undefined);

  // 人类优先：结束前重读镜头。与"系统留下的状态"比对——不等即人手动改过，
  // 哪怕他选的正是 agent 某一轮抽出的图（候选实时出现在抽卡列表里，人完全可能
  // 中途看中第 1 轮那张）。此时一律尊重人的选择，只把候选留在列表里。
  const fresh = await db.shot.findUnique({ where: { id: shot.id } });
  const current = fresh?.keyframeSelectedTakeId ?? null;
  const humanOverride = current !== expectedSelectedTakeId;

  if (humanOverride) {
    const last = rounds[rounds.length - 1];
    if (last) {
      last.action += '；检测到人工已选定，保留人工选择（本次候选全部保留，可在关键图列表中随时改选）';
    }
  } else if (finalRound && current !== finalRound.takeId) {
    // 与人手动点选走同一条路径：写 selected 指针 + 既有失效传播（换首帧 → 视频标 stale）
    await db.shot.update({
      where: { id: shot.id },
      data: { keyframeSelectedTakeId: finalRound.takeId },
    });
    await onTakeSelected(db, shot.id, 'KEYFRAME');
  }

  return db.agentRun.update({
    where: { id: run.id },
    data: {
      status: passed ? 'PASSED' : 'NEEDS_HUMAN',
      roundsJson: toJson(rounds),
      finalTakeId: finalRound?.takeId ?? null,
      humanOverride,
      finishedAt: new Date(),
    },
  });
}
