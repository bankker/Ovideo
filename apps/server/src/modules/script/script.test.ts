import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Episode, Project } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { scriptRoutes } from './routes.js';

let tdb: TestDb;
let app: FastifyInstance;
let project: Project;
let episode: Episode;

const onScriptDraftChanged = vi.fn(async () => {});
const enqueue = vi.fn(async (input: unknown) => ({ id: 'job-1', status: 'QUEUED', input }));

beforeAll(async () => {
  tdb = await createTestDb();
  app = Fastify();
  // 先注册错误处理器再挂路由：Fastify 子上下文只继承注册时已存在的 errorHandler
  registerErrorHandler(app);
  await app.register(scriptRoutes, { db: tdb.db, enqueue, hooks: { onScriptDraftChanged } });
  await app.ready();
  project = await tdb.db.project.create({ data: { name: '项目' } });
  episode = await tdb.db.episode.create({ data: { projectId: project.id, title: '第一集' } });
});

beforeEach(() => {
  onScriptDraftChanged.mockClear();
  enqueue.mockClear();
});

afterAll(async () => {
  await app.close();
  await tdb.cleanup();
});

describe('script-draft 路由', () => {
  it('本集第一稿自动 isMain，第二稿不是', async () => {
    const r1 = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/script-drafts`,
      payload: { title: '初稿', content: '内容一' },
    });
    expect(r1.statusCode).toBe(201);
    expect(r1.json().isMain).toBe(true);

    const r2 = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/script-drafts`,
      payload: { title: '二稿' },
    });
    expect(r2.json().isMain).toBe(false);
  });

  it('GET 列表主剧本在前；未知分集 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/episodes/${episode.id}/script-drafts` });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list.length).toBe(2);
    expect(list[0].isMain).toBe(true);

    const miss = await app.inject({ method: 'GET', url: '/api/episodes/nope/script-drafts' });
    expect(miss.statusCode).toBe(404);
  });

  it('PATCH setMain=true 事务内先清后设，全集恰一个主剧本', async () => {
    const drafts = await tdb.db.scriptDraft.findMany({
      where: { episodeId: episode.id },
      orderBy: { createdAt: 'asc' },
    });
    const second = drafts.find((d) => !d.isMain);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/script-drafts/${second?.id}`,
      payload: { setMain: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isMain).toBe(true);

    const mains = await tdb.db.scriptDraft.findMany({
      where: { episodeId: episode.id, isMain: true },
    });
    expect(mains.map((d) => d.id)).toEqual([second?.id]);
    // setMain 不动内容 → 不触发失效钩子
    expect(onScriptDraftChanged).not.toHaveBeenCalled();
  });

  it('content 变更触发 onScriptDraftChanged；同值或仅改标题不触发', async () => {
    const d = await tdb.db.scriptDraft.create({
      data: { episodeId: episode.id, content: '旧内容' },
    });

    await app.inject({
      method: 'PATCH',
      url: `/api/script-drafts/${d.id}`,
      payload: { title: '只改标题' },
    });
    expect(onScriptDraftChanged).not.toHaveBeenCalled();

    await app.inject({
      method: 'PATCH',
      url: `/api/script-drafts/${d.id}`,
      payload: { content: '旧内容' },
    });
    expect(onScriptDraftChanged).not.toHaveBeenCalled();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/script-drafts/${d.id}`,
      payload: { content: '新内容' },
    });
    expect(res.statusCode).toBe(200);
    expect(onScriptDraftChanged).toHaveBeenCalledTimes(1);
    expect(onScriptDraftChanged).toHaveBeenCalledWith(expect.anything(), d.id);
  });

  it('PATCH 未知剧本稿 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/script-drafts/nope',
      payload: { content: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('generate-storyboard 路由', () => {
  it('无 modelConfigId → 入队（执行时自动调度）并返回 job', async () => {
    const d = await tdb.db.scriptDraft.create({
      data: { episodeId: episode.id, content: '剧本全文' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/script-drafts/${d.id}/generate-storyboard`,
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().id).toBe('job-1');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      projectId: project.id,
      type: 'GENERATE_STORYBOARD',
      executor: 'API',
      inputPayload: { scriptDraftId: d.id },
    });
  });

  it('带 modelConfigId → API 执行器且透传到 inputPayload', async () => {
    const d = await tdb.db.scriptDraft.create({
      data: { episodeId: episode.id, content: '剧本全文' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/script-drafts/${d.id}/generate-storyboard`,
      payload: { modelConfigId: 'model-9' },
    });
    expect(res.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledWith({
      projectId: project.id,
      type: 'GENERATE_STORYBOARD',
      executor: 'API',
      inputPayload: { scriptDraftId: d.id, modelConfigId: 'model-9' },
    });
  });

  it('未知剧本稿 404 且不入队', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/script-drafts/nope/generate-storyboard',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
