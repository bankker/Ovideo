import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Episode, Project, ScriptDraft } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import {
  buildRewritePrompt,
  buildSelectionRewritePrompt,
  makeRewriteScript,
  REWRITE_MESSAGE_BEGIN,
  REWRITE_SCRIPT_BEGIN,
  SELECTION_BEGIN,
  SELECTION_END,
} from './rewrite.js';
import { scriptRoutes, type ScriptRewriteFn } from './routes.js';

const SCRIPT = ['场景一：办公室内，白天。', '林凡盯着屏幕。', '林凡：又要加班了。'].join('\n');

describe('buildRewritePrompt', () => {
  it('四条硬约束齐备：保持格式 / 角色名不得更改 / 只改指令涉及部分 / 输出 JSON', () => {
    const prompt = buildRewritePrompt({ script: SCRIPT, message: '把结尾改得更有冲击力' });

    // 保持格式：场景标题行与「角色名：台词」是下游三步生成的拆镜依据
    expect(prompt).toContain('【保持格式】');
    expect(prompt).toContain('场景N：地点，时间。');
    expect(prompt).toContain('角色名：台词');
    // 角色名不得更改
    expect(prompt).toContain('【角色名不得更改】');
    expect(prompt).toContain('除非用户的指令明确要求改名');
    // 只改指令涉及的部分
    expect(prompt).toContain('【只改指令涉及的部分】');
    expect(prompt).toContain('指令没有提到的段落、台词、场景一律原样保留');
    expect(prompt).toContain('严禁');
    // 输出 JSON（且明确禁止 markdown 代码块）
    expect(prompt).toContain('【输出 JSON】');
    expect(prompt).toContain('{"summary":"一句话说明这次改了什么"');
    expect(prompt).toContain('不要 markdown 代码块');
  });

  it('剧本原文与用户指令都被分隔符包裹送入', () => {
    const prompt = buildRewritePrompt({ script: SCRIPT, message: '加一个反转' });
    expect(prompt).toContain(`${REWRITE_SCRIPT_BEGIN}\n${SCRIPT}`);
    expect(prompt).toContain(`${REWRITE_MESSAGE_BEGIN}\n加一个反转`);
  });

  it('有 stylePrompt 时并入风格约束；缺省时不出现该条', () => {
    const withStyle = buildRewritePrompt({
      script: SCRIPT,
      message: '加一个反转',
      stylePrompt: '赛博朋克水墨',
    });
    expect(withStyle).toContain('画面风格：本项目统一为「赛博朋克水墨」');

    const without = buildRewritePrompt({ script: SCRIPT, message: '加一个反转' });
    expect(without).not.toContain('画面风格');
  });
});

describe('makeRewriteScript', () => {
  const reply = (summary: string, script: string) =>
    async () => JSON.stringify({ summary, script });

  it('正常返回 { summary, script }', async () => {
    const rewrite = makeRewriteScript({ textGen: reply('结尾加了反转', `${SCRIPT}\n林凡：辞了。`) });
    await expect(rewrite({ script: SCRIPT, message: '加一个反转' })).resolves.toEqual({
      summary: '结尾加了反转',
      script: `${SCRIPT}\n林凡：辞了。`,
    });
  });

  it('模型套了 ```json 围栏也能解析', async () => {
    const rewrite = makeRewriteScript({
      textGen: async () => '```json\n{"summary":"改了结尾","script":"场景一：办公室内，白天。"}\n```',
    });
    await expect(rewrite({ script: SCRIPT, message: 'x' })).resolves.toEqual({
      summary: '改了结尾',
      script: '场景一：办公室内，白天。',
    });
  });

  it('非法 JSON → 重试一次后抛 400 中文错误', async () => {
    const textGen = vi.fn(async () => '我帮你改好啦～');
    await expect(
      makeRewriteScript({ textGen })({ script: SCRIPT, message: 'x' }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'AI 返回的改写结果无法解析，请换个说法重试' });
    expect(textGen).toHaveBeenCalledTimes(2);
  });

  it('script 字段缺失或为空 → 同样按解析失败处理（空正文不能让用户误采纳）', async () => {
    await expect(
      makeRewriteScript({ textGen: async () => '{"summary":"改好了"}' })({
        script: SCRIPT,
        message: 'x',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      makeRewriteScript({ textGen: reply('改好了', '   ') })({ script: SCRIPT, message: 'x' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('POST /api/script-drafts/:id/rewrite 路由', () => {
  let tdb: TestDb;
  let project: Project;
  let episode: Episode;
  let draft: ScriptDraft;
  let emptyDraft: ScriptDraft;
  let app: FastifyInstance;

  const fakeRewrite = vi.fn<ScriptRewriteFn>(async () => ({
    summary: '结尾加了反转',
    script: '场景一：办公室内，白天。\n林凡：辞了。',
  }));

  beforeAll(async () => {
    tdb = await createTestDb();
    project = await tdb.db.project.create({ data: { name: '项目', stylePrompt: '赛博朋克水墨' } });
    episode = await tdb.db.episode.create({ data: { projectId: project.id, title: '第一集' } });
    draft = await tdb.db.scriptDraft.create({
      data: { episodeId: episode.id, isMain: true, content: SCRIPT },
    });
    emptyDraft = await tdb.db.scriptDraft.create({
      data: { episodeId: episode.id, title: '空稿', content: '   \n ' },
    });

    app = Fastify();
    // 先注册错误处理器再挂路由：Fastify 子上下文只继承注册时已存在的 errorHandler
    registerErrorHandler(app);
    await app.register(scriptRoutes, {
      db: tdb.db,
      enqueue: async () => ({}),
      rewrite: fakeRewrite,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await tdb.cleanup();
  });

  it('合法请求 → 200 返回 { summary, script }，且把正文与项目画风一并传给 rewrite', async () => {
    fakeRewrite.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: `/api/script-drafts/${draft.id}/rewrite`,
      payload: { message: '加一个反转' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      summary: '结尾加了反转',
      script: '场景一：办公室内，白天。\n林凡：辞了。',
    });
    expect(fakeRewrite).toHaveBeenCalledWith({
      script: SCRIPT,
      message: '加一个反转',
      stylePrompt: '赛博朋克水墨',
      modelConfigId: undefined,
    });
  });

  it('【服务端不写库】改写成功后草稿 content 一字未变', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/script-drafts/${draft.id}/rewrite`,
      payload: { message: '把结尾改得更有冲击力' },
    });
    expect(res.statusCode).toBe(200);
    const after = await tdb.db.scriptDraft.findUnique({ where: { id: draft.id } });
    expect(after?.content).toBe(SCRIPT);
  });

  it('剧本稿不存在 → 404，不调 rewrite', async () => {
    fakeRewrite.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: '/api/script-drafts/nope/rewrite',
      payload: { message: '加一个反转' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('剧本稿 不存在');
    expect(fakeRewrite).not.toHaveBeenCalled();
  });

  it('正文为空（含纯空白）→ 400 指路先生成或粘贴，不调 rewrite', async () => {
    fakeRewrite.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: `/api/script-drafts/${emptyDraft.id}/rewrite`,
      payload: { message: '加一个反转' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('该剧本稿还没有内容，请先生成或粘贴剧本再用对话修改');
    expect(fakeRewrite).not.toHaveBeenCalled();
  });

  it('message 为空或超 1000 字 → 400 参数校验失败', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: `/api/script-drafts/${draft.id}/rewrite`,
      payload: { message: '' },
    });
    expect(empty.statusCode).toBe(400);

    const tooLong = await app.inject({
      method: 'POST',
      url: `/api/script-drafts/${draft.id}/rewrite`,
      payload: { message: 'a'.repeat(1001) },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('模型返回非法 JSON → 400 中文错误，且草稿 content 不受影响', async () => {
    const bad = Fastify();
    registerErrorHandler(bad);
    await bad.register(scriptRoutes, {
      db: tdb.db,
      enqueue: async () => ({}),
      rewrite: makeRewriteScript({ textGen: async () => '好的，我这就帮你改～' }),
    });
    await bad.ready();

    const res = await bad.inject({
      method: 'POST',
      url: `/api/script-drafts/${draft.id}/rewrite`,
      payload: { message: '加一个反转' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('AI 返回的改写结果无法解析，请换个说法重试');
    const after = await tdb.db.scriptDraft.findUnique({ where: { id: draft.id } });
    expect(after?.content).toBe(SCRIPT);
    await bad.close();
  });

  it('未注入 rewrite → 501「对话改剧本功能未配置」', async () => {
    const bare = Fastify();
    registerErrorHandler(bare);
    await bare.register(scriptRoutes, { db: tdb.db, enqueue: async () => ({}) });
    await bare.ready();
    const res = await bare.inject({
      method: 'POST',
      url: `/api/script-drafts/${draft.id}/rewrite`,
      payload: { message: '加一个反转' },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('对话改剧本功能未配置');
    await bare.close();
  });
});
