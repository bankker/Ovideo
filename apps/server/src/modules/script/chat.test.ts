import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Episode, Project, ScriptDraft, Shot, Storyboard, Tag } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { createScriptChat, mockChatGen } from './chat.js';
import { scriptRoutes, type ScriptChatFn } from './routes.js';

let tdb: TestDb;
let project: Project;
let episode: Episode;
let draft: ScriptDraft;
let storyboard: Storyboard;
let shots: Shot[];
let tagLinfan: Tag;

beforeAll(async () => {
  tdb = await createTestDb();
  project = await tdb.db.project.create({ data: { name: '项目' } });
  episode = await tdb.db.episode.create({ data: { projectId: project.id, title: '第一集' } });
  draft = await tdb.db.scriptDraft.create({
    data: { episodeId: episode.id, isMain: true, content: '剧本全文' },
  });
  tagLinfan = await tdb.db.tag.create({
    data: { projectId: project.id, type: 'CHARACTER', name: '林凡' },
  });
  await tdb.db.tag.create({ data: { projectId: project.id, type: 'SCENE', name: '天台' } });

  // 基底分镜：3 个镜头（时长 12000/9000/5000，第 1 镜带标签与对白）
  storyboard = await tdb.db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  const shotData = [
    { sourceText: '林凡站在天台边缘。', durationPlannedMs: 12000 },
    { sourceText: '苏瑶推门而入。', durationPlannedMs: 9000 },
    { sourceText: '两人相视无言。', durationPlannedMs: 5000 },
  ];
  shots = [];
  for (let i = 0; i < shotData.length; i += 1) {
    shots.push(
      await tdb.db.shot.create({
        data: {
          storyboardId: storyboard.id,
          sortOrder: i,
          sourceText: shotData[i].sourceText,
          imagePrompt: `画面${i + 1}`,
          videoPrompt: `运镜${i + 1}`,
          durationPlannedMs: shotData[i].durationPlannedMs,
          ...(i === 0
            ? {
                tags: { create: [{ tagId: tagLinfan.id }] },
                dialogue: {
                  create: [
                    { speakerTagId: tagLinfan.id, isNarrator: false, text: '你来了。', sortOrder: 0 },
                  ],
                },
              }
            : {}),
        },
      }),
    );
  }
});

afterAll(async () => {
  await tdb.cleanup();
});

const chatWith = (message: string) =>
  createScriptChat({ textGen: mockChatGen })(tdb.db, {
    scriptDraftId: draft.id,
    baseStoryboardId: storyboard.id,
    message,
  });

describe('mockChatGen 经 createScriptChat（确定性规则）', () => {
  it('「改成 2 个镜头」：尾部多余镜头 remove，保留的最后一镜合并文本、时长相加', async () => {
    const { patch, summary } = await chatWith('改成 2 个镜头');
    expect(summary.length).toBeGreaterThan(0);
    expect(patch).toEqual([
      { op: 'remove_shot', shotId: shots[2].id },
      {
        op: 'update_shot',
        shotId: shots[1].id,
        fields: {
          sourceText: '苏瑶推门而入。\n两人相视无言。',
          // 9000+5000=14000，未触及 15000 上限 → 原样相加
          durationPlannedMs: 14000,
        },
      },
    ]);
  });

  it('「合并成 1 个」：删 2 个镜头、全部文本并入第 1 镜、时长相加封顶 15000', async () => {
    const { patch } = await chatWith('把这些镜头合并成 1 个');
    expect(patch).toEqual([
      { op: 'remove_shot', shotId: shots[1].id },
      { op: 'remove_shot', shotId: shots[2].id },
      {
        op: 'update_shot',
        shotId: shots[0].id,
        fields: {
          sourceText: '林凡站在天台边缘。\n苏瑶推门而入。\n两人相视无言。',
          // 12000+9000+5000=26000 → 封顶 15000
          durationPlannedMs: 15000,
        },
      },
    ]);
  });

  it('「改成 5 个镜头」：目标数大于当前数 → add_shot 空镜头补足', async () => {
    const { patch } = await chatWith('改成 5 个镜头');
    expect(patch).toHaveLength(2);
    for (const op of patch) {
      expect(op.op).toBe('add_shot');
      if (op.op === 'add_shot') {
        expect(op.shot.sourceText).toBe('');
        expect(op.shot.durationPlannedMs).toBe(12000);
      }
    }
  });

  it('「删除第 2 个镜头」：remove_shot 对应真实 id；序号越界则空 patch', async () => {
    const { patch } = await chatWith('删除第 2 个镜头');
    expect(patch).toEqual([{ op: 'remove_shot', shotId: shots[1].id }]);

    const miss = await chatWith('删除第 9 个镜头');
    expect(miss.patch).toEqual([]);
    expect(miss.summary).toContain('不存在');
  });

  it('「第 N 个镜头改成 …」：update_shot 改写 sourceText', async () => {
    const { patch } = await chatWith('把第 1 个镜头改成 林凡转身离开天台');
    expect(patch).toEqual([
      { op: 'update_shot', shotId: shots[0].id, fields: { sourceText: '林凡转身离开天台' } },
    ]);
  });

  it('不认识的指令 → 空 patch + 引导话术；全程不产生新分镜版本（只预览不应用）', async () => {
    const { patch, summary } = await chatWith('今天天气怎么样');
    expect(patch).toEqual([]);
    expect(summary).toContain('未能理解');
    // 铁律：对话只出 patch 预览，不落库
    expect(await tdb.db.storyboard.count({ where: { episodeId: episode.id } })).toBe(1);
    expect(await tdb.db.shot.count({ where: { storyboardId: storyboard.id } })).toBe(3);
  });
});

describe('createScriptChat 协议校验与重试', () => {
  it('第一次输出非法、第二次合法（带 ```json 围栏）→ 重试成功', async () => {
    const valid = JSON.stringify({
      summary: '删了一个镜头',
      patch: [{ op: 'remove_shot', shotId: shots[2].id }],
    });
    const textGen = vi
      .fn<(prompt: string) => Promise<string>>()
      .mockResolvedValueOnce('好的，我来帮你改～')
      .mockResolvedValueOnce('```json\n' + valid + '\n```');
    const chat = createScriptChat({ textGen });
    const result = await chat(tdb.db, {
      scriptDraftId: draft.id,
      baseStoryboardId: storyboard.id,
      message: '随便改改',
    });
    expect(textGen).toHaveBeenCalledTimes(2);
    expect(result.summary).toBe('删了一个镜头');
    expect(result.patch).toEqual([{ op: 'remove_shot', shotId: shots[2].id }]);
  });

  it('两次都不符合 patch 协议 → 400「AI 返回的修改指令无法解析，请换个说法」', async () => {
    // 合法 JSON 但 patch 不符合 StoryboardPatchOp 协议 → Schema 校验失败
    const textGen = vi.fn(async () => JSON.stringify({ summary: 'x', patch: [{ op: '重写全部' }] }));
    const chat = createScriptChat({ textGen });
    await expect(
      chat(tdb.db, {
        scriptDraftId: draft.id,
        baseStoryboardId: storyboard.id,
        message: '重写',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'AI 返回的修改指令无法解析，请换个说法',
    });
    expect(textGen).toHaveBeenCalledTimes(2);
  });

  it('剧本稿/基底分镜不存在 → 404；分镜不属于该剧本稿的分集 → 400', async () => {
    const chat = createScriptChat({ textGen: mockChatGen });
    await expect(
      chat(tdb.db, { scriptDraftId: 'nope', baseStoryboardId: storyboard.id, message: 'x' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      chat(tdb.db, { scriptDraftId: draft.id, baseStoryboardId: 'nope', message: 'x' }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const otherEp = await tdb.db.episode.create({ data: { projectId: project.id, title: '第二集' } });
    const otherDraft = await tdb.db.scriptDraft.create({ data: { episodeId: otherEp.id } });
    await expect(
      chat(tdb.db, { scriptDraftId: otherDraft.id, baseStoryboardId: storyboard.id, message: 'x' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('POST /api/script-drafts/:id/chat 路由', () => {
  let app: FastifyInstance;
  const fakeChat = vi.fn<ScriptChatFn>(async () => ({
    patch: [{ op: 'remove_shot', shotId: 'shot-x' }],
    summary: '删了一个镜头',
  }));

  beforeAll(async () => {
    app = Fastify();
    // 先注册错误处理器再挂路由：Fastify 子上下文只继承注册时已存在的 errorHandler
    registerErrorHandler(app);
    await app.register(scriptRoutes, {
      db: tdb.db,
      enqueue: async () => ({}),
      chat: fakeChat,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('合法请求 → 200 透传 { patch, summary }，chat 收到正确参数', async () => {
    fakeChat.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: `/api/script-drafts/${draft.id}/chat`,
      payload: { message: '删除第 1 个镜头', baseStoryboardId: storyboard.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      patch: [{ op: 'remove_shot', shotId: 'shot-x' }],
      summary: '删了一个镜头',
    });
    expect(fakeChat).toHaveBeenCalledTimes(1);
    expect(fakeChat).toHaveBeenCalledWith(expect.anything(), {
      scriptDraftId: draft.id,
      baseStoryboardId: storyboard.id,
      message: '删除第 1 个镜头',
    });
  });

  it('剧本稿/基底分镜不存在 → 404；分镜不属于该剧本稿分集 → 400，均不调 chat', async () => {
    fakeChat.mockClear();
    const missDraft = await app.inject({
      method: 'POST',
      url: '/api/script-drafts/nope/chat',
      payload: { message: 'x', baseStoryboardId: storyboard.id },
    });
    expect(missDraft.statusCode).toBe(404);

    const missSb = await app.inject({
      method: 'POST',
      url: `/api/script-drafts/${draft.id}/chat`,
      payload: { message: 'x', baseStoryboardId: 'nope' },
    });
    expect(missSb.statusCode).toBe(404);

    const otherEp = await tdb.db.episode.create({
      data: { projectId: project.id, title: '第三集' },
    });
    const otherDraft = await tdb.db.scriptDraft.create({ data: { episodeId: otherEp.id } });
    const wrongEp = await app.inject({
      method: 'POST',
      url: `/api/script-drafts/${otherDraft.id}/chat`,
      payload: { message: 'x', baseStoryboardId: storyboard.id },
    });
    expect(wrongEp.statusCode).toBe(400);
    expect(fakeChat).not.toHaveBeenCalled();
  });

  it('message 为空或超 2000 字 → 400 参数校验失败', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: `/api/script-drafts/${draft.id}/chat`,
      payload: { message: '', baseStoryboardId: storyboard.id },
    });
    expect(empty.statusCode).toBe(400);

    const tooLong = await app.inject({
      method: 'POST',
      url: `/api/script-drafts/${draft.id}/chat`,
      payload: { message: 'a'.repeat(2001), baseStoryboardId: storyboard.id },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('未注入 chat → 501「对话功能未配置」', async () => {
    const bare = Fastify();
    registerErrorHandler(bare);
    await bare.register(scriptRoutes, { db: tdb.db, enqueue: async () => ({}) });
    await bare.ready();
    const res = await bare.inject({
      method: 'POST',
      url: `/api/script-drafts/${draft.id}/chat`,
      payload: { message: '删除第 1 个镜头', baseStoryboardId: storyboard.id },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('对话功能未配置');
    await bare.close();
  });
});
