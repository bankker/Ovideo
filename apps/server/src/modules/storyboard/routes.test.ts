import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Episode, Project, ScriptDraft } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { storyboardRoutes } from './routes.js';

let tdb: TestDb;
let app: FastifyInstance;
let project: Project;
let episode: Episode;
let draft: ScriptDraft;
const onStoryboardPatched = vi.fn(async () => {});

beforeAll(async () => {
  tdb = await createTestDb();
  app = Fastify();
  // 先注册错误处理器再挂路由：Fastify 子上下文只继承注册时已存在的 errorHandler
  registerErrorHandler(app);
  await app.register(storyboardRoutes, { db: tdb.db, hooks: { onStoryboardPatched } });
  await app.ready();
  project = await tdb.db.project.create({ data: { name: '项目' } });
  episode = await tdb.db.episode.create({ data: { projectId: project.id, title: '第一集' } });
  draft = await tdb.db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
});

afterAll(async () => {
  await app.close();
  await tdb.cleanup();
});

async function seedStoryboardV1() {
  const sb = await tdb.db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  const shot = await tdb.db.shot.create({
    data: { storyboardId: sb.id, sortOrder: 0, sourceText: '基底镜头' },
  });
  return { sb, shot };
}

describe('storyboard 路由', () => {
  it('POST apply-patch：以该分镜为基底产出新版本，默认 resolveTags 建标签，钩子被调', async () => {
    const { sb, shot } = await seedStoryboardV1();
    const res = await app.inject({
      method: 'POST',
      url: `/api/storyboards/${sb.id}/apply-patch`,
      payload: {
        source: 'chat',
        patch: [
          { op: 'update_shot', shotId: shot.id, fields: { imagePrompt: '改过的提示词' } },
          {
            op: 'add_shot',
            shot: {
              sourceText: '新镜头',
              tags: [{ name: '路由标签', type: 'SCENE' }],
              dialogue: [{ isNarrator: true, text: '旁白' }],
            },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.storyboard.version).toBe(2);
    expect(body.storyboard.episodeId).toBe(episode.id);
    expect(body.storyboard.scriptDraftId).toBe(draft.id);
    expect(body.changedShotIds.length).toBe(2);
    expect(body.removedShotAssetIds).toEqual([]);
    expect(onStoryboardPatched).toHaveBeenCalledTimes(1);

    // 默认 resolveTags 走 tag/service：标签落到项目
    const tag = await tdb.db.tag.findUnique({
      where: { projectId_name: { projectId: project.id, name: '路由标签' } },
    });
    expect(tag).not.toBeNull();
  });

  it('GET /api/episodes/:id/storyboards：版本倒序 + shots 计数', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/episodes/${episode.id}/storyboards` });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const versions = list.map((s: { version: number }) => s.version);
    expect(versions).toEqual([...versions].sort((a: number, b: number) => b - a));
    expect(list[0].shotCount).toBe(2); // v2 = 基底 1 镜 + 新增 1 镜

    const miss = await app.inject({ method: 'GET', url: '/api/episodes/nope/storyboards' });
    expect(miss.statusCode).toBe(404);
  });

  it('GET /api/storyboards/:id：镜头按序含 tags/dialogue/takes', async () => {
    const latest = await tdb.db.storyboard.findFirst({
      where: { episodeId: episode.id },
      orderBy: { version: 'desc' },
    });
    const res = await app.inject({ method: 'GET', url: `/api/storyboards/${latest?.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shots.map((s: { sourceText: string }) => s.sourceText)).toEqual([
      '基底镜头',
      '新镜头',
    ]);
    expect(body.shots[0].imagePrompt).toBe('改过的提示词');
    expect(body.shots[1].tags[0].tag.name).toBe('路由标签');
    expect(body.shots[1].dialogue[0].isNarrator).toBe(true);
    expect(Array.isArray(body.shots[0].takes)).toBe(true);

    const miss = await app.inject({ method: 'GET', url: '/api/storyboards/nope' });
    expect(miss.statusCode).toBe(404);
  });

  it('POST apply-patch：未知分镜 404，坏 body 400', async () => {
    const miss = await app.inject({
      method: 'POST',
      url: '/api/storyboards/nope/apply-patch',
      payload: { patch: [] },
    });
    expect(miss.statusCode).toBe(404);

    const sb = await tdb.db.storyboard.findFirst({ where: { episodeId: episode.id } });
    const bad = await app.inject({
      method: 'POST',
      url: `/api/storyboards/${sb?.id}/apply-patch`,
      payload: { patch: [{ op: 'no_such_op' }] },
    });
    expect(bad.statusCode).toBe(400);
  });
});
