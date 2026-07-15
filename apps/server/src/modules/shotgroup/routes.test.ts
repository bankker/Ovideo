// ShotGroup 路由测试：POST /api/shots/:id/split-group + GET /api/storyboards/:id/groups。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Episode, Project, ScriptDraft } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { shotGroupRoutes } from './routes.js';

let tdb: TestDb;
let app: FastifyInstance;
let project: Project;
let episode: Episode;
let draft: ScriptDraft;
const onGroupSplit = vi.fn(async () => {});

beforeAll(async () => {
  tdb = await createTestDb();
  app = Fastify();
  // 先注册错误处理器再挂路由：Fastify 子上下文只继承注册时已存在的 errorHandler
  registerErrorHandler(app);
  await app.register(shotGroupRoutes, { db: tdb.db, hooks: { onGroupSplit } });
  await app.ready();
  project = await tdb.db.project.create({ data: { name: '衔接组路由项目' } });
  episode = await tdb.db.episode.create({ data: { projectId: project.id, title: '第一集' } });
  draft = await tdb.db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
});

afterAll(async () => {
  await app.close();
  await tdb.cleanup();
});

/** 每次 seed 用独立分集：避免 (episodeId, version) 唯一约束 + 拆分产生的新版本互相干扰 */
async function seedStoryboardWithShot(durationPlannedMs: number) {
  const ep = await tdb.db.episode.create({ data: { projectId: project.id, title: '独立分集' } });
  const dr = await tdb.db.scriptDraft.create({ data: { episodeId: ep.id, isMain: true } });
  const sb = await tdb.db.storyboard.create({
    data: { episodeId: ep.id, scriptDraftId: dr.id, version: 1 },
  });
  const shot = await tdb.db.shot.create({
    data: { storyboardId: sb.id, sortOrder: 0, sourceText: '镜头', durationPlannedMs },
  });
  return { sb, shot, ep };
}

describe('POST /api/shots/:id/split-group', () => {
  it('缺省 maxSegmentMs=15000：拆分产生新版本，返回 storyboard + groupShotIds，钩子被调', async () => {
    const { shot, ep } = await seedStoryboardWithShot(32000);
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/split-group`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.storyboard.episodeId).toBe(ep.id);
    expect(body.storyboard.version).toBe(2);
    expect(body.groupShotIds).toHaveLength(3);
    expect(onGroupSplit).toHaveBeenCalledTimes(1);

    // 新版本里段字段落库正确
    const segs = await tdb.db.shot.findMany({
      where: { storyboardId: body.storyboard.id },
      orderBy: { sortOrder: 'asc' },
    });
    expect(segs.map((s) => s.id)).toEqual(body.groupShotIds);
    expect(segs.map((s) => s.groupIndex)).toEqual([0, 1, 2]);
    expect(segs.every((s) => s.groupId === shot.id)).toBe(true);
  });

  it('body.maxSegmentMs 生效', async () => {
    const { shot } = await seedStoryboardWithShot(20000);
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/split-group`,
      payload: { maxSegmentMs: 5000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().groupShotIds).toHaveLength(4);
  });

  it('时长未超上限 → 400 固定文案', async () => {
    const { shot } = await seedStoryboardWithShot(12000);
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/split-group`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('该镜头时长未超过单段上限，无需拆分');
  });

  it('镜头不存在 → 404；非法 maxSegmentMs → 400（zod）', async () => {
    const notFoundRes = await app.inject({
      method: 'POST',
      url: '/api/shots/no-such-shot/split-group',
      payload: {},
    });
    expect(notFoundRes.statusCode).toBe(404);

    const { shot } = await seedStoryboardWithShot(32000);
    const badRes = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/split-group`,
      payload: { maxSegmentMs: -1 },
    });
    expect(badRes.statusCode).toBe(400);
  });
});

describe('GET /api/storyboards/:id/groups', () => {
  it('返回按 groupIndex 排序的组链；无组镜头不出现', async () => {
    const sb = await tdb.db.storyboard.create({
      data: { episodeId: episode.id, scriptDraftId: draft.id, version: 99 },
    });
    await tdb.db.shot.create({ data: { storyboardId: sb.id, sortOrder: 0 } }); // 无组
    const b1 = await tdb.db.shot.create({
      data: { storyboardId: sb.id, sortOrder: 2, groupId: 'gB', groupIndex: 1 },
    });
    const b0 = await tdb.db.shot.create({
      data: { storyboardId: sb.id, sortOrder: 1, groupId: 'gB', groupIndex: 0 },
    });

    const res = await app.inject({ method: 'GET', url: `/api/storyboards/${sb.id}/groups` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ groups: [{ groupId: 'gB', shotIds: [b0.id, b1.id] }] });
  });

  it('分镜不存在 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/storyboards/no-such-sb/groups' });
    expect(res.statusCode).toBe(404);
  });
});
