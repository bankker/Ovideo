import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Episode, Project } from '@prisma/client';
import { GeneratedStoryboardSchema } from '@ovideo/shared';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { toJson } from '../../lib/json.js';
import {
  buildStoryboardPrompt,
  createStoryboardGenerator,
  mockTextGen,
} from './generate.js';

let tdb: TestDb;
let project: Project;
let episode: Episode;

const SCRIPT = [
  '【场景：天台】',
  '林凡：你终于来了。',
  '苏瑶：我一直都在。',
  '',
  '场景二：教室',
  '旁白：三年前的那个夏天。',
].join('\n');

beforeAll(async () => {
  tdb = await createTestDb();
  project = await tdb.db.project.create({ data: { name: '项目' } });
  episode = await tdb.db.episode.create({ data: { projectId: project.id, title: '第一集' } });
});

afterAll(async () => {
  await tdb.cleanup();
});

describe('mockTextGen', () => {
  it('按场景/空行切段，识别台词与旁白，输出符合 GeneratedStoryboardSchema', async () => {
    const prompt = buildStoryboardPrompt(SCRIPT, []);
    const raw = await mockTextGen(prompt);
    const parsed = GeneratedStoryboardSchema.parse(JSON.parse(raw));

    expect(parsed.shots.length).toBe(2);
    const [s1, s2] = parsed.shots;

    expect(s1.durationPlannedMs).toBe(12000);
    expect(s1.sourceText).toContain('林凡：你终于来了。');
    expect(s1.imagePrompt.length).toBeGreaterThan(0);
    expect(s1.videoPrompt.length).toBeGreaterThan(0);
    expect(s1.tags).toContainEqual({ name: '天台', type: 'SCENE' });
    expect(s1.tags).toContainEqual({ name: '林凡', type: 'CHARACTER' });
    expect(s1.tags).toContainEqual({ name: '苏瑶', type: 'CHARACTER' });
    expect(s1.dialogue).toEqual([
      { speaker: '林凡', isNarrator: false, text: '你终于来了。' },
      { speaker: '苏瑶', isNarrator: false, text: '我一直都在。' },
    ]);

    expect(s2.tags).toContainEqual({ name: '教室', type: 'SCENE' });
    expect(s2.dialogue[0].isNarrator).toBe(true);
    expect(s2.dialogue[0].text).toBe('三年前的那个夏天。');
  });

  it('无对白的段落生成一条旁白；确定性输出', async () => {
    const prompt = buildStoryboardPrompt('夜色沉沉，城市灯火渐次熄灭。', []);
    const raw1 = await mockTextGen(prompt);
    const raw2 = await mockTextGen(prompt);
    expect(raw1).toBe(raw2);
    const parsed = GeneratedStoryboardSchema.parse(JSON.parse(raw1));
    expect(parsed.shots.length).toBe(1);
    expect(parsed.shots[0].dialogue).toEqual([
      { isNarrator: true, text: '夜色沉沉，城市灯火渐次熄灭。' },
    ]);
  });
});

describe('createStoryboardGenerator', () => {
  it('mockTextGen 走通：建 v1 分镜、tags 复用不重复建、汇报进度', async () => {
    // 预置同名标签：生成时必须复用而不是新建
    const existing = await tdb.db.tag.create({
      data: { projectId: project.id, type: 'CHARACTER', name: '林凡' },
    });
    const draft = await tdb.db.scriptDraft.create({
      data: { episodeId: episode.id, isMain: true, content: SCRIPT },
    });

    const generator = createStoryboardGenerator({ textGen: mockTextGen });
    const updateProgress = vi.fn(async () => {});
    const result = await generator({
      db: tdb.db,
      job: { inputJson: toJson({ scriptDraftId: draft.id }) },
      updateProgress,
    });

    expect(result.output.shotCount).toBe(2);
    const storyboard = await tdb.db.storyboard.findUnique({
      where: { id: result.output.storyboardId },
      include: { shots: { orderBy: { sortOrder: 'asc' }, include: { tags: true } } },
    });
    expect(storyboard?.version).toBe(1);
    expect(storyboard?.scriptDraftId).toBe(draft.id);
    expect(storyboard?.shots.length).toBe(2);

    // 同名标签复用：项目里仍只有一个「林凡」，且镜头挂的就是它
    const linfanTags = await tdb.db.tag.findMany({
      where: { projectId: project.id, name: '林凡' },
    });
    expect(linfanTags.length).toBe(1);
    expect(storyboard?.shots[0].tags.map((t) => t.tagId)).toContain(existing.id);
    // 新标签（苏瑶/天台/教室）已建
    expect(
      await tdb.db.tag.count({ where: { projectId: project.id, name: '苏瑶' } }),
    ).toBe(1);

    expect(updateProgress).toHaveBeenCalled();
  });

  it('首次输出非法 JSON 时重试一次成功（含 ```json 围栏剥离）', async () => {
    const draft = await tdb.db.scriptDraft.create({
      data: { episodeId: episode.id, content: SCRIPT },
    });
    const valid = await mockTextGen(buildStoryboardPrompt(SCRIPT, []));
    const textGen = vi
      .fn<(prompt: string) => Promise<string>>()
      .mockResolvedValueOnce('抱歉，我给你讲个故事吧')
      .mockResolvedValueOnce('```json\n' + valid + '\n```');

    const generator = createStoryboardGenerator({ textGen });
    const result = await generator({
      db: tdb.db,
      job: { inputJson: toJson({ scriptDraftId: draft.id }) },
      updateProgress: async () => {},
    });
    expect(textGen).toHaveBeenCalledTimes(2);
    expect(result.output.shotCount).toBe(2);
  });

  it('连续两次失败抛错，不产生分镜', async () => {
    const ep = await tdb.db.episode.create({ data: { projectId: project.id, title: '失败集' } });
    const draft = await tdb.db.scriptDraft.create({ data: { episodeId: ep.id, content: 'x' } });
    const textGen = vi.fn(async () => '不是 JSON');
    const generator = createStoryboardGenerator({ textGen });

    await expect(
      generator({
        db: tdb.db,
        job: { inputJson: toJson({ scriptDraftId: draft.id }) },
        updateProgress: async () => {},
      }),
    ).rejects.toThrow();
    expect(textGen).toHaveBeenCalledTimes(2);
    expect(await tdb.db.storyboard.count({ where: { episodeId: ep.id } })).toBe(0);
  });

  it('缺 scriptDraftId / 剧本稿不存在 → 报错', async () => {
    const generator = createStoryboardGenerator({ textGen: mockTextGen });
    await expect(
      generator({ db: tdb.db, job: { inputJson: '{}' }, updateProgress: async () => {} }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      generator({
        db: tdb.db,
        job: { inputJson: toJson({ scriptDraftId: 'nope' }) },
        updateProgress: async () => {},
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
