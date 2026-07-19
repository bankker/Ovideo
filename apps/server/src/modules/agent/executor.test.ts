import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { Job, PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { toJson } from '../../lib/json.js';
import { clearExecutors, getExecutor } from '../job/registry.js';
import { registerAgentExecutors } from './executor.js';
import { createAgentRun, readRounds, type AgentDeps } from './service.js';

let t: TestDb;
let db: PrismaClient;
let projectId: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const project = await db.project.create({ data: { name: '收敛 agent 执行器测试项目' } });
  projectId = project.id;
});

afterAll(async () => {
  await t.cleanup();
});

beforeEach(() => {
  clearExecutors();
});

async function seedShot() {
  const episode = await db.episode.create({ data: { projectId, title: '测试集' } });
  const draft = await db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
  const storyboard = await db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  return db.shot.create({
    data: { storyboardId: storyboard.id, sortOrder: 0, sourceText: '镜头文本', imagePrompt: '提示词' },
  });
}

function fakeDeps(verdictKind: 'pass' | 'retry'): AgentDeps {
  return {
    generateKeyframe: async ({ projectId: pid, shotId }) => {
      const asset = await db.asset.create({
        data: {
          projectId: pid,
          type: 'IMAGE',
          source: 'GENERATED',
          uri: `/storage/${pid}/${crypto.randomUUID()}.png`,
        },
      });
      const take = await db.take.create({ data: { shotId, slot: 'KEYFRAME', assetId: asset.id } });
      return { takeId: take.id, assetUri: asset.uri };
    },
    judgeImage: async () => ({
      identityMatch: verdictKind === 'pass' ? 90 : 40,
      promptMatch: verdictKind === 'pass' ? 85 : 40,
      issues: [],
      verdict: verdictKind,
    }),
    textGen: async () => JSON.stringify({ prompt: '改写后的提示词' }),
  };
}

/** 构造 Job 行与执行器 ctx（不起 worker，直接调用执行器本体，与 generation 测试同款） */
async function makeCtx(input: unknown) {
  const job: Job = await db.job.create({
    data: { projectId, type: 'AGENT_KEYFRAME_CONVERGE', status: 'RUNNING', inputJson: toJson(input) },
  });
  const progress: number[] = [];
  return {
    ctx: {
      db,
      job,
      updateProgress: async (p: number) => {
        progress.push(p);
      },
    },
    progress,
  };
}

describe('AGENT_KEYFRAME_CONVERGE 执行器', () => {
  it('注册到 AGENT_KEYFRAME_CONVERGE，驱动收敛循环并按轮次汇报进度', async () => {
    registerAgentExecutors(fakeDeps('retry'));
    const executor = getExecutor('AGENT_KEYFRAME_CONVERGE');
    expect(executor).toBeDefined();

    const shot = await seedShot();
    const run = await createAgentRun(db, { projectId, shotId: shot.id, maxRounds: 3 });
    const { ctx, progress } = await makeCtx({ runId: run.id });

    const result = await executor!(ctx);

    // 3 轮 → 每轮结束报 30/60/90（留最后 10% 给 worker 收尾置 100）
    expect(progress).toEqual([30, 60, 90]);
    const output = result.output as { status: string; finalTakeId: string | null };
    expect(output.status).toBe('NEEDS_HUMAN');
    const finished = await db.agentRun.findUnique({ where: { id: run.id } });
    expect(finished!.status).toBe('NEEDS_HUMAN');
    expect(readRounds(finished!)).toHaveLength(3);
    expect(output.finalTakeId).toBe(finished!.finalTakeId);
  });

  it('pass 时提前结束，进度只报到实际轮次', async () => {
    registerAgentExecutors(fakeDeps('pass'));
    const shot = await seedShot();
    const run = await createAgentRun(db, { projectId, shotId: shot.id, maxRounds: 3 });
    const { ctx, progress } = await makeCtx({ runId: run.id });

    await getExecutor('AGENT_KEYFRAME_CONVERGE')!(ctx);

    expect(progress).toEqual([30]);
    const finished = await db.agentRun.findUnique({ where: { id: run.id } });
    expect(finished!.status).toBe('PASSED');
  });

  it('生成失败：AgentRun 置 FAILED 并写中文原因，异常再抛给 worker', async () => {
    const deps = fakeDeps('pass');
    deps.generateKeyframe = async () => {
      throw new Error('未配置图像模型：请在管理后台启用图像厂商后重试');
    };
    registerAgentExecutors(deps);

    const shot = await seedShot();
    const run = await createAgentRun(db, { projectId, shotId: shot.id, maxRounds: 3 });
    const { ctx } = await makeCtx({ runId: run.id });

    await expect(getExecutor('AGENT_KEYFRAME_CONVERGE')!(ctx)).rejects.toThrow('未配置图像模型');

    const failed = await db.agentRun.findUnique({ where: { id: run.id } });
    expect(failed!.status).toBe('FAILED');
    expect(failed!.error).toContain('未配置图像模型');
    expect(failed!.finishedAt).not.toBeNull();
  });
});
