import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Job, PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import type { EnqueueJobInput } from '../job/service.js';
import { agentRoutes } from './routes.js';

let t: TestDb;
let db: PrismaClient;
let app: FastifyInstance;
let projectId: string;

const enqueue = vi.fn(
  async (input: EnqueueJobInput) => ({ id: `job-${crypto.randomUUID()}`, ...input }) as unknown as Job,
);

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const project = await db.project.create({ data: { name: '收敛 agent 路由测试项目' } });
  projectId = project.id;

  app = Fastify();
  // 与 app.ts 集成顺序一致：错误处理器先于路由注册（否则 zod 错误变 500）
  registerErrorHandler(app);
  await app.register(agentRoutes, { db, enqueue });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

beforeEach(() => {
  enqueue.mockClear();
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

describe('POST /api/shots/:id/agent/keyframe-converge', () => {
  it('202 建 AgentRun 并入队 AGENT_KEYFRAME_CONVERGE，run.jobId 回填', async () => {
    const shot = await seedShot();
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/agent/keyframe-converge`,
      payload: {},
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.run.shotId).toBe(shot.id);
    expect(body.run.kind).toBe('KEYFRAME_CONVERGE');
    expect(body.run.status).toBe('RUNNING');
    expect(body.run.maxRounds).toBe(3); // 默认轮次
    expect(body.run.roundsJson).toBe('[]');
    expect(body.run.jobId).toBe(body.job.id);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const arg = enqueue.mock.calls[0]![0];
    expect(arg.type).toBe('AGENT_KEYFRAME_CONVERGE');
    expect(arg.executor).toBe('API');
    expect(arg.projectId).toBe(projectId);
    expect((arg.inputPayload as { runId: string }).runId).toBe(body.run.id);
  });

  it('透传 maxRounds 与模型选择', async () => {
    const shot = await seedShot();
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/agent/keyframe-converge`,
      payload: { maxRounds: 5, modelConfigId: 'img-1', visionModelConfigId: 'vis-1' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().run.maxRounds).toBe(5);
    const payload = enqueue.mock.calls[0]![0].inputPayload as Record<string, string>;
    expect(payload.modelConfigId).toBe('img-1');
    expect(payload.visionModelConfigId).toBe('vis-1');
  });

  it('成本闸门：maxRounds 超过硬上限 5 直接 400', async () => {
    const shot = await seedShot();
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/agent/keyframe-converge`,
      payload: { maxRounds: 6 },
    });
    expect(res.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('镜头不存在 → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/shots/not-exist/agent/keyframe-converge',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('该镜头已有 RUNNING 的运行 → 400，且不重复入队', async () => {
    const shot = await seedShot();
    const first = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/agent/keyframe-converge`,
      payload: {},
    });
    expect(first.statusCode).toBe(202);
    enqueue.mockClear();

    const second = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/agent/keyframe-converge`,
      payload: {},
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('该镜头已有正在运行的自动收敛任务');
    expect(enqueue).not.toHaveBeenCalled();
    expect(await db.agentRun.count({ where: { shotId: shot.id } })).toBe(1);
  });

  it('上一次运行已结束（非 RUNNING）时可再次发起', async () => {
    const shot = await seedShot();
    await db.agentRun.create({
      data: { projectId, shotId: shot.id, kind: 'KEYFRAME_CONVERGE', status: 'NEEDS_HUMAN' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/agent/keyframe-converge`,
      payload: {},
    });
    expect(res.statusCode).toBe(202);
  });
});

describe('GET /api/shots/:id/agent-runs', () => {
  it('按新到旧返回该镜头的运行记录，roundsJson 原样为字符串', async () => {
    const shot = await seedShot();
    const older = await db.agentRun.create({
      data: {
        projectId,
        shotId: shot.id,
        kind: 'KEYFRAME_CONVERGE',
        status: 'PASSED',
        roundsJson: '[{"round":1}]',
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const newer = await db.agentRun.create({
      data: { projectId, shotId: shot.id, kind: 'KEYFRAME_CONVERGE', status: 'NEEDS_HUMAN' },
    });

    const res = await app.inject({ method: 'GET', url: `/api/shots/${shot.id}/agent-runs` });
    expect(res.statusCode).toBe(200);
    const runs = res.json().runs as Array<{ id: string; roundsJson: string }>;
    expect(runs.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(typeof runs[1]!.roundsJson).toBe('string');
    expect(runs[1]!.roundsJson).toBe('[{"round":1}]');
  });

  it('镜头不存在 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/shots/not-exist/agent-runs' });
    expect(res.statusCode).toBe(404);
  });
});
