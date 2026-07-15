import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { dubbingRoutes } from './routes.js';

let t: TestDb;
let app: FastifyInstance;

let projectId: string;
let tagId: string;
let storyboardId: string;
let shot1Id: string;
let shot2Id: string;

// 入队 mock：返回带自增 id 的假 Job，供 202 响应断言
let jobSeq = 0;
const enqueue = vi.fn(async (input: Record<string, unknown>) => ({
  id: `job-${++jobSeq}`,
  status: 'QUEUED',
  type: input.type,
  batchId: input.batchId ?? null,
}));

beforeAll(async () => {
  t = await createTestDb();
  const project = await t.db.project.create({ data: { name: '配音路由测试' } });
  projectId = project.id;
  tagId = (
    await t.db.tag.create({ data: { projectId, type: 'CHARACTER', name: '阿箬' } })
  ).id;
  const episode = await t.db.episode.create({ data: { projectId, title: '第1集' } });
  const draft = await t.db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
  const storyboard = await t.db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  storyboardId = storyboard.id;
  const shot1 = await t.db.shot.create({ data: { storyboardId, sortOrder: 0 } });
  shot1Id = shot1.id;
  const shot2 = await t.db.shot.create({ data: { storyboardId, sortOrder: 1 } });
  shot2Id = shot2.id;
  await t.db.dialogueLine.create({
    data: { shotId: shot1Id, speakerTagId: tagId, text: '你来了。', sortOrder: 0 },
  });
  await t.db.dialogueLine.create({
    data: { shotId: shot1Id, isNarrator: true, text: '夜色渐深。', sortOrder: 1 },
  });
  await t.db.dialogueLine.create({
    data: { shotId: shot2Id, speakerTagId: tagId, text: '走吧。', sortOrder: 0 },
  });

  app = Fastify();
  // 错误处理器必须先于路由插件注册（否则 zod 校验错误 400 会变 500）
  registerErrorHandler(app);
  await app.register(dubbingRoutes, { db: t.db, enqueue });
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

describe('POST /api/shots/:id/sync-dubbing', () => {
  it('首次同步：按对白建行、自动建 VoiceProfile、旁白行留空，返回全部行', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/shots/${shot1Id}/sync-dubbing` });
    expect(res.statusCode).toBe(200);
    const lines = res.json();
    expect(lines).toHaveLength(2);
    expect(lines[0].dialogueLine.text).toBe('你来了。');
    expect(lines[0].voiceProfile.tagId).toBe(tagId);
    expect(lines[0].voiceProfile.name).toBe('阿箬');
    expect(lines[1].dialogueLine.isNarrator).toBe(true);
    expect(lines[1].voiceProfileId).toBeNull();
    expect(await t.db.voiceProfile.count({ where: { projectId } })).toBe(1);
  });

  it('幂等：重复同步不重复建行/建档案', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/shots/${shot1Id}/sync-dubbing` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    expect(await t.db.dubbingLine.count({ where: { shotId: shot1Id } })).toBe(2);
    expect(await t.db.voiceProfile.count({ where: { projectId } })).toBe(1);
  });

  it('镜头不存在 → 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/shots/nope/sync-dubbing' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/shots/:id/dubbing', () => {
  it('返回行列表（含 include，按对白 sortOrder）', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/shots/${shot1Id}/dubbing` });
    expect(res.statusCode).toBe(200);
    const lines = res.json();
    expect(lines).toHaveLength(2);
    expect(lines[0].dialogueLine.sortOrder).toBe(0);
    expect(lines[1].dialogueLine.sortOrder).toBe(1);
  });

  it('镜头不存在 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/shots/nope/dubbing' });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/dubbing-lines/:id', () => {
  it('speed 改动 → speed 更新且 status 回 PENDING', async () => {
    const line = await t.db.dubbingLine.findFirstOrThrow({ where: { shotId: shot1Id } });
    await t.db.dubbingLine.update({ where: { id: line.id }, data: { status: 'READY' } });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/dubbing-lines/${line.id}`,
      payload: { speed: 1.5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().speed).toBe(1.5);
    expect(res.json().status).toBe('PENDING');
  });

  it('带对白来源的行改 text → 400', async () => {
    const line = await t.db.dubbingLine.findFirstOrThrow({ where: { shotId: shot1Id } });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/dubbing-lines/${line.id}`,
      payload: { text: '私改台词' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('对白');
  });

  it('speed 越界（>2）→ 400；配音行不存在 → 404', async () => {
    const line = await t.db.dubbingLine.findFirstOrThrow({ where: { shotId: shot1Id } });
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/dubbing-lines/${line.id}`,
      payload: { speed: 2.5 },
    });
    expect(bad.statusCode).toBe(400);

    const gone = await app.inject({
      method: 'PATCH',
      url: '/api/dubbing-lines/nope',
      payload: { speed: 1 },
    });
    expect(gone.statusCode).toBe(404);
  });
});

describe('POST /api/dubbing-lines/:id/generate', () => {
  it('202 入队 GENERATE_TTS（input.kind=dubbing 跨模块契约），行置 GENERATING', async () => {
    enqueue.mockClear();
    const line = await t.db.dubbingLine.findFirstOrThrow({
      where: { shotId: shot1Id, dialogueLine: { sortOrder: 0 } },
    });
    const res = await app.inject({ method: 'POST', url: `/api/dubbing-lines/${line.id}/generate` });
    expect(res.statusCode).toBe(202);
    expect(res.json().id).toMatch(/^job-/);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const input = enqueue.mock.calls[0][0] as Record<string, unknown>;
    expect(input.projectId).toBe(projectId);
    expect(input.type).toBe('GENERATE_TTS');
    expect(input.executor).toBe('MOCK');
    expect(input.inputPayload).toEqual({ kind: 'dubbing', dubbingLineId: line.id });

    const after = await t.db.dubbingLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(after.status).toBe('GENERATING');
  });

  it('配音行不存在 → 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/dubbing-lines/nope/generate' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/storyboards/:id/dubbing/generate-all', () => {
  it('先同步全部镜头，再对 status != READY 的行批量入队并共享 batchId', async () => {
    // shot1 行1 置 READY → 应被跳过；shot2 从未同步过 → 验证 generate-all 内部先做同步
    const readyLine = await t.db.dubbingLine.findFirstOrThrow({
      where: { shotId: shot1Id, dialogueLine: { sortOrder: 0 } },
    });
    await t.db.dubbingLine.update({ where: { id: readyLine.id }, data: { status: 'READY' } });
    expect(await t.db.dubbingLine.count({ where: { shotId: shot2Id } })).toBe(0);

    enqueue.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: `/api/storyboards/${storyboardId}/dubbing/generate-all`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // shot1 旁白行 + shot2 新同步行 = 2；READY 行被跳过
    expect(body.enqueued).toBe(2);
    expect(body.batchId).toMatch(new RegExp(`^dub-${storyboardId}-\\d+$`));

    expect(enqueue).toHaveBeenCalledTimes(2);
    const inputs = enqueue.mock.calls.map((c) => c[0] as Record<string, unknown>);
    for (const input of inputs) {
      expect(input.type).toBe('GENERATE_TTS');
      expect(input.executor).toBe('MOCK');
      expect(input.batchId).toBe(body.batchId); // 共享同一 batchId
      expect((input.inputPayload as Record<string, unknown>).kind).toBe('dubbing');
    }

    // shot2 的行确实由 generate-all 同步出来并进入 GENERATING
    const shot2Lines = await t.db.dubbingLine.findMany({ where: { shotId: shot2Id } });
    expect(shot2Lines).toHaveLength(1);
    expect(shot2Lines[0].status).toBe('GENERATING');
    // READY 行不被打扰
    const untouched = await t.db.dubbingLine.findUniqueOrThrow({ where: { id: readyLine.id } });
    expect(untouched.status).toBe('READY');
  });

  it('分镜不存在 → 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/storyboards/nope/dubbing/generate-all' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/shots/:id/duration', () => {
  it('返回计划/锁定时长与各行时长状态', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/shots/${shot1Id}/duration` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.durationPlannedMs).toBe(12000); // schema 默认值
    expect(body.durationLockedMs).toBeNull();
    expect(body.lines).toHaveLength(2);
    for (const line of body.lines) {
      expect(line).toHaveProperty('id');
      expect(line).toHaveProperty('durationMs');
      expect(line).toHaveProperty('status');
    }
  });

  it('镜头不存在 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/shots/nope/duration' });
    expect(res.statusCode).toBe(404);
  });
});
