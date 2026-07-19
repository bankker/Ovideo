import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import type { VisionVerdict } from '../provider/adapters/vision-judge.js';
import {
  createAgentRun,
  parseRewrittenPrompt,
  readRounds,
  runKeyframeConverge,
  type AgentDeps,
  type AgentKeyframeGenArgs,
} from './service.js';

let t: TestDb;
let db: PrismaClient;
let projectId: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const project = await db.project.create({ data: { name: '收敛 agent 测试项目' } });
  projectId = project.id;
});

afterAll(async () => {
  await t.cleanup();
});

const ORIGINAL_PROMPT = '小猴子阿吉站在教室门口，阳光斜照';

async function seedShot() {
  const episode = await db.episode.create({ data: { projectId, title: '测试集' } });
  const draft = await db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
  const storyboard = await db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  const shot = await db.shot.create({
    data: {
      storyboardId: storyboard.id,
      sortOrder: 0,
      sourceText: '阿吉走进教室',
      imagePrompt: ORIGINAL_PROMPT,
    },
  });
  return { episode, storyboard, shot };
}

/** 造一条已存在的关键图 take（模拟 agent 启动前人已经抽过的图） */
async function seedTake(shotId: string) {
  const asset = await db.asset.create({
    data: {
      projectId,
      type: 'IMAGE',
      source: 'GENERATED',
      uri: `/storage/${projectId}/seed-${crypto.randomUUID()}.png`,
    },
  });
  return db.take.create({ data: { shotId, slot: 'KEYFRAME', assetId: asset.id } });
}

function verdict(v: Partial<VisionVerdict> & Pick<VisionVerdict, 'verdict'>): VisionVerdict {
  return {
    identityMatch: v.identityMatch ?? 50,
    promptMatch: v.promptMatch ?? 50,
    issues: v.issues ?? [],
    verdict: v.verdict,
  };
}

/**
 * 假的生成/评审/文本实现。
 * generateKeyframe 刻意复刻真实执行器的抽卡语义（新建 Asset+Take、首个 take 自动 selected），
 * 否则「人类优先」「永不删除」这两条铁律的用例就测不到真实行为。
 */
function makeFakeDeps(script: { verdicts: VisionVerdict[]; rewritten?: string; onJudge?: () => Promise<void> }) {
  const genCalls: AgentKeyframeGenArgs[] = [];
  const judgeCalls: Array<{ prompt: string; imagePath: string; refImagePaths: string[] }> = [];
  const textPrompts: string[] = [];
  let judged = 0;

  const deps: AgentDeps = {
    generateKeyframe: async (args) => {
      genCalls.push(args);
      const asset = await db.asset.create({
        data: {
          projectId: args.projectId,
          type: 'IMAGE',
          source: 'GENERATED',
          uri: `/storage/${args.projectId}/agent-${crypto.randomUUID()}.png`,
        },
      });
      const take = await db.take.create({
        data: { shotId: args.shotId, slot: 'KEYFRAME', assetId: asset.id },
      });
      const shot = await db.shot.findUnique({ where: { id: args.shotId } });
      if (!shot?.keyframeSelectedTakeId) {
        await db.shot.update({
          where: { id: args.shotId },
          data: { keyframeSelectedTakeId: take.id },
        });
      }
      return { takeId: take.id, assetUri: asset.uri };
    },
    judgeImage: async (args) => {
      judgeCalls.push({ prompt: args.prompt, imagePath: args.imagePath, refImagePaths: args.refImagePaths });
      await script.onJudge?.();
      return script.verdicts[Math.min(judged++, script.verdicts.length - 1)]!;
    },
    textGen: async ({ prompt }) => {
      textPrompts.push(prompt);
      return JSON.stringify({ prompt: script.rewritten ?? '改写后的提示词' });
    },
  };
  return { deps, genCalls, judgeCalls, textPrompts };
}

async function countTakes(shotId: string) {
  return db.take.count({ where: { shotId, slot: 'KEYFRAME' } });
}

describe('runKeyframeConverge 收敛循环', () => {
  it('首轮即 pass：只跑 1 轮，status=PASSED，finalTake 被选定为镜头关键图', async () => {
    const { shot } = await seedShot();
    const run = await createAgentRun(db, { projectId, shotId: shot.id, maxRounds: 3 });
    const { deps, genCalls } = makeFakeDeps({
      verdicts: [verdict({ verdict: 'pass', identityMatch: 88, promptMatch: 80 })],
    });

    const finished = await runKeyframeConverge(db, deps, { runId: run.id });

    expect(finished.status).toBe('PASSED');
    expect(genCalls).toHaveLength(1);
    const rounds = readRounds(finished);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.round).toBe(1);
    expect(rounds[0]!.verdict).toBe('pass');
    expect(rounds[0]!.promptUsed).toBe(ORIGINAL_PROMPT);
    expect(finished.finalTakeId).toBe(rounds[0]!.takeId);

    const fresh = await db.shot.findUnique({ where: { id: shot.id } });
    expect(fresh!.keyframeSelectedTakeId).toBe(finished.finalTakeId);
    expect(finished.humanOverride).toBe(false);
  });

  it('连续 retry 到轮次耗尽：status=NEEDS_HUMAN，rounds 长度=maxRounds，finalTake 取分数最高那轮', async () => {
    const { shot } = await seedShot();
    const run = await createAgentRun(db, { projectId, shotId: shot.id, maxRounds: 3 });
    // 综合分：100 / 130（最高）/ 120 —— 期望选中第 2 轮
    const { deps, genCalls } = makeFakeDeps({
      verdicts: [
        verdict({ verdict: 'retry', identityMatch: 50, promptMatch: 50 }),
        verdict({ verdict: 'retry', identityMatch: 70, promptMatch: 60 }),
        verdict({ verdict: 'retry', identityMatch: 40, promptMatch: 80 }),
      ],
    });

    const finished = await runKeyframeConverge(db, deps, { runId: run.id });

    expect(finished.status).toBe('NEEDS_HUMAN');
    expect(genCalls).toHaveLength(3);
    const rounds = readRounds(finished);
    expect(rounds).toHaveLength(3);
    expect(finished.finalTakeId).toBe(rounds[1]!.takeId);
    // 纯重抽：每轮都用原提示词，没有 promptOverride
    expect(genCalls.every((c) => c.promptOverride === undefined)).toBe(true);
    expect(rounds.every((r) => r.promptUsed === ORIGINAL_PROMPT)).toBe(true);

    const fresh = await db.shot.findUnique({ where: { id: shot.id } });
    expect(fresh!.keyframeSelectedTakeId).toBe(rounds[1]!.takeId);
  });

  it('fix_prompt：第 2 轮实际用改写后的提示词，且 Shot.imagePrompt 保持原值（铁律 5）', async () => {
    const { shot } = await seedShot();
    const run = await createAgentRun(db, { projectId, shotId: shot.id, maxRounds: 3 });
    const REWRITTEN = '阿吉（拟人化小猴子，棕色皮毛）站在教室门口，阳光斜照';
    const { deps, genCalls, textPrompts } = makeFakeDeps({
      verdicts: [
        verdict({ verdict: 'fix_prompt', identityMatch: 20, promptMatch: 70, issues: ['提示词把猴子角色描述成了人类'] }),
        verdict({ verdict: 'pass', identityMatch: 90, promptMatch: 85 }),
      ],
      rewritten: REWRITTEN,
    });

    const finished = await runKeyframeConverge(db, deps, { runId: run.id });

    expect(finished.status).toBe('PASSED');
    const rounds = readRounds(finished);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.suggestedPrompt).toBe(REWRITTEN);
    expect(rounds[1]!.promptUsed).toBe(REWRITTEN);
    // 第 1 轮走镜头原提示词（不传 override），第 2 轮才带改写结果
    expect(genCalls[0]!.promptOverride).toBeUndefined();
    expect(genCalls[1]!.promptOverride).toBe(REWRITTEN);
    // 改写指令里带上了评审问题与「不许翻译角色名」的约束
    expect(textPrompts[0]).toContain('提示词把猴子角色描述成了人类');
    expect(textPrompts[0]).toContain('严禁翻译');

    // 铁律 5：分镜数据是人的资产，agent 只能建议不能篡改
    const fresh = await db.shot.findUnique({ where: { id: shot.id } });
    expect(fresh!.imagePrompt).toBe(ORIGINAL_PROMPT);
  });

  it('提示词改写失败时降级为纯重抽，不炸整个运行', async () => {
    const { shot } = await seedShot();
    const run = await createAgentRun(db, { projectId, shotId: shot.id, maxRounds: 2 });
    const { deps, genCalls } = makeFakeDeps({
      verdicts: [verdict({ verdict: 'fix_prompt' }), verdict({ verdict: 'pass', identityMatch: 90, promptMatch: 90 })],
    });
    // 文本模型返回不可解析内容
    deps.textGen = async () => '模型今天不想输出 JSON';

    const finished = await runKeyframeConverge(db, deps, { runId: run.id });

    expect(finished.status).toBe('PASSED');
    const rounds = readRounds(finished);
    expect(rounds[0]!.suggestedPrompt).toBeUndefined();
    expect(rounds[0]!.action).toContain('改写失败');
    expect(genCalls[1]!.promptOverride).toBeUndefined();
  });

  it('人类优先：运行期间人手动改了选定 → 结束时不覆盖，humanOverride=true', async () => {
    const { shot } = await seedShot();
    // 基线：agent 启动前已有一张人选定的图
    const baseline = await seedTake(shot.id);
    await db.shot.update({ where: { id: shot.id }, data: { keyframeSelectedTakeId: baseline.id } });

    const run = await createAgentRun(db, { projectId, shotId: shot.id, maxRounds: 2 });
    let humanTakeId = '';
    const { deps } = makeFakeDeps({
      verdicts: [verdict({ verdict: 'retry' }), verdict({ verdict: 'pass', identityMatch: 95, promptMatch: 95 })],
      // 第 1 轮评审时，人在另一个页面手动选了自己的图
      onJudge: async () => {
        if (humanTakeId) return;
        const humanTake = await seedTake(shot.id);
        humanTakeId = humanTake.id;
        await db.shot.update({ where: { id: shot.id }, data: { keyframeSelectedTakeId: humanTake.id } });
      },
    });

    const finished = await runKeyframeConverge(db, deps, { runId: run.id });

    expect(finished.humanOverride).toBe(true);
    expect(finished.status).toBe('PASSED'); // 状态仍按评审结果记录
    const fresh = await db.shot.findUnique({ where: { id: shot.id } });
    expect(fresh!.keyframeSelectedTakeId).toBe(humanTakeId); // 人的选择没被覆盖
    const rounds = readRounds(finished);
    expect(rounds[rounds.length - 1]!.action).toContain('保留人工选择');
    // agent 的最佳候选仍然记录在案，人可随时改选
    expect(finished.finalTakeId).toBe(rounds[rounds.length - 1]!.takeId);
    expect(finished.finalTakeId).not.toBe(humanTakeId);
  });

  it('人类优先：人中途选中的是 agent 自己抽出的第 1 轮候选 → 同样不覆盖', async () => {
    const { shot } = await seedShot();
    const baseline = await seedTake(shot.id);
    await db.shot.update({ where: { id: shot.id }, data: { keyframeSelectedTakeId: baseline.id } });

    const run = await createAgentRun(db, { projectId, shotId: shot.id, maxRounds: 3 });
    let firstRoundTakeId = '';
    const { deps } = makeFakeDeps({
      verdicts: [
        verdict({ verdict: 'retry' }),
        verdict({ verdict: 'retry' }),
        verdict({ verdict: 'pass', identityMatch: 95, promptMatch: 95 }),
      ],
      // 第 2 轮评审时，人看中了第 1 轮抽出的那张（候选实时出现在抽卡列表里）
      onJudge: async () => {
        const takes = await db.take.findMany({
          where: { shotId: shot.id, slot: 'KEYFRAME' },
          orderBy: { createdAt: 'asc' },
        });
        const agentFirst = takes.find((t) => t.id !== baseline.id);
        if (!agentFirst || firstRoundTakeId) return;
        if (takes.length < 2) return;
        firstRoundTakeId = agentFirst.id;
        await db.shot.update({
          where: { id: shot.id },
          data: { keyframeSelectedTakeId: agentFirst.id },
        });
      },
    });

    const finished = await runKeyframeConverge(db, deps, { runId: run.id });

    expect(firstRoundTakeId).not.toBe('');
    expect(finished.humanOverride).toBe(true);
    const fresh = await db.shot.findUnique({ where: { id: shot.id } });
    expect(fresh!.keyframeSelectedTakeId).toBe(firstRoundTakeId); // 人选的那张没被第 3 轮覆盖
  });

  it('幂等守卫：非 RUNNING 的运行再次执行直接返回，不重复生图', async () => {
    const { shot } = await seedShot();
    const run = await createAgentRun(db, { projectId, shotId: shot.id, maxRounds: 2 });
    const { deps, genCalls } = makeFakeDeps({
      verdicts: [verdict({ verdict: 'pass', identityMatch: 90, promptMatch: 90 })],
    });
    await runKeyframeConverge(db, deps, { runId: run.id });
    const callsAfterFirst = genCalls.length;

    // Job 重试会再次调进来：不拦住就会从第 1 轮重跑，重复烧生图的钱
    const again = await runKeyframeConverge(db, deps, { runId: run.id });
    expect(genCalls.length).toBe(callsAfterFirst);
    expect(again.status).toBe('PASSED');
  });

  it('铁律 3：全过程 Take/Asset 只增不减', async () => {
    const { shot } = await seedShot();
    const baseline = await seedTake(shot.id);
    await db.shot.update({ where: { id: shot.id }, data: { keyframeSelectedTakeId: baseline.id } });
    const takesBefore = await countTakes(shot.id);
    const assetsBefore = await db.asset.count({ where: { projectId } });

    const run = await createAgentRun(db, { projectId, shotId: shot.id, maxRounds: 3 });
    const { deps } = makeFakeDeps({ verdicts: [verdict({ verdict: 'retry' })] });
    const finished = await runKeyframeConverge(db, deps, { runId: run.id });

    const rounds = readRounds(finished);
    expect(await countTakes(shot.id)).toBe(takesBefore + rounds.length);
    expect(await db.asset.count({ where: { projectId } })).toBe(assetsBefore + rounds.length);
    // 起始那条 take 还在，且每轮候选都能查到
    expect(await db.take.findUnique({ where: { id: baseline.id } })).not.toBeNull();
    for (const r of rounds) {
      expect(await db.take.findUnique({ where: { id: r.takeId } })).not.toBeNull();
    }
  });

  it('成本闸门：maxRounds 超过硬上限 5 时被夹到 5', async () => {
    const { shot } = await seedShot();
    const run = await createAgentRun(db, { projectId, shotId: shot.id, maxRounds: 99 });
    expect(run.maxRounds).toBe(5);
  });

  it('可停：关联 Job 已取消时不再开新一轮，status=CANCELED', async () => {
    const { shot } = await seedShot();
    const job = await db.job.create({
      data: { projectId, type: 'AGENT_KEYFRAME_CONVERGE', status: 'CANCELED', inputJson: '{}' },
    });
    const run = await db.agentRun.update({
      where: { id: (await createAgentRun(db, { projectId, shotId: shot.id })).id },
      data: { jobId: job.id },
    });
    const { deps, genCalls } = makeFakeDeps({ verdicts: [verdict({ verdict: 'pass' })] });

    const finished = await runKeyframeConverge(db, deps, { runId: run.id });

    expect(finished.status).toBe('CANCELED');
    expect(genCalls).toHaveLength(0); // 一分钱都没花
  });
});

describe('parseRewrittenPrompt', () => {
  it('解析 JSON 与 markdown 代码块包裹', () => {
    expect(parseRewrittenPrompt('{"prompt":"新的提示词"}')).toBe('新的提示词');
    expect(parseRewrittenPrompt('```json\n{"prompt":"围栏里的提示词"}\n```')).toBe('围栏里的提示词');
  });

  it('非法/空内容抛中文错误', () => {
    expect(() => parseRewrittenPrompt('不是 JSON')).toThrow(/提示词改写响应解析失败/);
    expect(() => parseRewrittenPrompt('{"prompt":"  "}')).toThrow(/提示词改写响应解析失败/);
  });
});
