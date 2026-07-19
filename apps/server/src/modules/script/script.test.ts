import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
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
  await app.register(multipart);
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

/** 手拼 multipart 请求体（fastify inject 支持 payload + headers） */
function multipartPayload(filename: string, contentType: string, data: Buffer) {
  const boundary = '----ovideo-test-boundary';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, data, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('script-drafts/generate 路由（一句话生成剧本）', () => {
  it('202 返回 draft+job；先落空草稿再入队，maxAttempts=1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/script-drafts/generate`,
      payload: { brief: '一只社恐的猫第一天去上班，闹出一堆笑话', durationSec: 90 },
    });
    expect(res.statusCode).toBe(202);
    const { draft, job } = res.json();
    expect(job.id).toBe('job-1');
    // 空内容先落库：任务还没跑完用户就能在左栏看到这一稿
    expect(draft.content).toBe('');
    const stored = await tdb.db.scriptDraft.findUnique({ where: { id: draft.id } });
    expect(stored).not.toBeNull();

    expect(enqueue).toHaveBeenCalledWith({
      projectId: project.id,
      type: 'GENERATE_SCRIPT',
      executor: 'API',
      inputPayload: {
        draftId: draft.id,
        brief: '一只社恐的猫第一天去上班，闹出一堆笑话',
        durationSec: 90,
      },
      // 花钱的任务不自动重试
      maxAttempts: 1,
    });
  });

  it('标题取 brief 前 20 字，超长加省略号', async () => {
    const long = '甲'.repeat(50);
    const res = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/script-drafts/generate`,
      payload: { brief: long },
    });
    expect(res.json().draft.title).toBe('甲'.repeat(20) + '…');

    const short = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/script-drafts/generate`,
      payload: { brief: '短创意' },
    });
    expect(short.json().draft.title).toBe('短创意');
  });

  it('durationSec 缺省 60；style 与 modelConfigId 透传', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/script-drafts/generate`,
      payload: { brief: '创意', style: '轻松幽默', modelConfigId: 'model-9' },
    });
    expect(res.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        inputPayload: expect.objectContaining({
          durationSec: 60,
          style: '轻松幽默',
          modelConfigId: 'model-9',
        }),
      }),
    );
  });

  it('brief 为空 → 400 且不入队、不建草稿', async () => {
    const before = await tdb.db.scriptDraft.count({ where: { episodeId: episode.id } });
    const res = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/script-drafts/generate`,
      payload: { brief: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await tdb.db.scriptDraft.count({ where: { episodeId: episode.id } })).toBe(before);
  });

  it('durationSec 越界 → 400；未知分集 → 404 且不入队', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/script-drafts/generate`,
      payload: { brief: '创意', durationSec: 5 },
    });
    expect(bad.statusCode).toBe(400);

    const miss = await app.inject({
      method: 'POST',
      url: '/api/episodes/nope/script-drafts/generate',
      payload: { brief: '创意' },
    });
    expect(miss.statusCode).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('script-drafts/import 路由（上传纯文本导入）', () => {
  it('.txt 上传 201，content 为文件文本，title 去掉扩展名', async () => {
    const text = '场景一：办公室内，白天。\n小悟：我又要加班了。';
    const { payload, headers } = multipartPayload('我的剧本.txt', 'text/plain', Buffer.from(text, 'utf-8'));
    const res = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/script-drafts/import`,
      payload,
      headers,
    });
    expect(res.statusCode).toBe(201);
    const draft = res.json();
    expect(draft.title).toBe('我的剧本');
    expect(draft.content).toBe(text);
  });

  it('.md 走扩展名兜底（浏览器常报 octet-stream）', async () => {
    const { payload, headers } = multipartPayload(
      'outline.md',
      'application/octet-stream',
      Buffer.from('# 大纲', 'utf-8'),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/script-drafts/import`,
      payload,
      headers,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().title).toBe('outline');
  });

  it('超过 512KB → 400', async () => {
    const big = Buffer.alloc(512 * 1024 + 1, 0x61);
    const { payload, headers } = multipartPayload('big.txt', 'text/plain', big);
    const res = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/script-drafts/import`,
      payload,
      headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('512KB');
  });

  it('非文本类型 → 400 并指路另存为纯文本', async () => {
    const { payload, headers } = multipartPayload('script.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('PK'));
    const res = await app.inject({
      method: 'POST',
      url: `/api/episodes/${episode.id}/script-drafts/import`,
      payload,
      headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('纯文本');
  });

  it('未知分集 → 404', async () => {
    const { payload, headers } = multipartPayload('a.txt', 'text/plain', Buffer.from('x'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/episodes/nope/script-drafts/import',
      payload,
      headers,
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
