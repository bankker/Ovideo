import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Episode, Project } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { toJson } from '../../lib/json.js';
import {
  buildStoryboardPrompt,
  createStoryboardGenerator,
  flattenGeneratedStoryboard,
  mockTextGen,
  SHOT_DURATION_MAX_MS,
  SHOT_DURATION_MIN_MS,
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

describe('buildStoryboardPrompt', () => {
  const prompt = buildStoryboardPrompt(SCRIPT, []);

  it('要求两级结构与每场景 2-5 个镜头', () => {
    expect(prompt).toContain('"scenes"');
    expect(prompt).toContain('2-5 个镜头');
    expect(prompt).toContain('interiorExterior');
    expect(prompt).toContain('timeOfDay');
  });

  it('写明单镜头时长区间与「超时必须再拆」的理由', () => {
    expect(prompt).toContain(`${SHOT_DURATION_MIN_MS}~${SHOT_DURATION_MAX_MS} 毫秒`);
    expect(prompt).toContain('5 秒或 10 秒');
    expect(prompt).toContain(`超过 ${SHOT_DURATION_MAX_MS} 毫秒的镜头无法一次成片`);
  });

  it('给出景别/角度/运镜/转场的取值范围', () => {
    expect(prompt).toContain('远景 / 全景 / 中景 / 近景 / 特写');
    expect(prompt).toContain('平视 / 俯拍 / 仰拍 / 过肩');
    expect(prompt).toContain('固定 / 推 / 拉 / 摇 / 跟');
    expect(prompt).toContain('切 / 叠化 / 淡入淡出');
    expect(prompt).toContain('不得自创词汇');
  });

  it('要求对白不重复出现在多个镜头', () => {
    expect(prompt).toContain('严禁】在多个镜头里重复同一句台词');
  });

  it('保留既有的标签命名/@提及/画风/旁白/口型规则', () => {
    expect(prompt).toContain('不超过 6 个字');
    expect(prompt).toContain('@办公室 内，@小悟 趴在 @办公桌 前疯狂打字');
    expect(prompt).toContain('anime/manga style');
    expect(prompt).toContain('嘴部自然开合');
    expect(prompt).toContain('"isNarrator":true');
    expect(buildStoryboardPrompt(SCRIPT, [], '水墨风')).toContain('全剧统一为「水墨风」');
  });
});

describe('flattenGeneratedStoryboard', () => {
  it('新格式：两级结构展开为扁平镜头，sceneRef 按场景分组，影视语义透传', () => {
    const shots = flattenGeneratedStoryboard({
      scenes: [
        {
          title: '客户会议室',
          location: '客户会议室',
          interiorExterior: 'INT',
          timeOfDay: '白天',
          sourceText: '会议室里的原文',
          shots: [
            {
              sourceText: '甲开口',
              imagePrompt: 'a',
              videoPrompt: 'b',
              durationPlannedMs: 4000,
              shotSize: '中景',
              cameraAngle: '平视',
              cameraMovement: '固定',
              composition: '两人分坐会议桌两侧',
              transition: '切',
              tags: [{ name: '会议室', type: 'SCENE' }],
              dialogue: [{ speaker: '甲', isNarrator: false, text: '开始吧。' }],
            },
            {
              sourceText: '乙沉默',
              imagePrompt: 'c',
              videoPrompt: 'd',
              durationPlannedMs: 3000,
              shotSize: '特写',
              cameraAngle: '过肩',
              cameraMovement: '推',
              composition: '乙的手停在方案册上',
              transition: '叠化',
              tags: [],
              dialogue: [],
            },
          ],
        },
        {
          title: '楼下街道',
          location: '',
          interiorExterior: 'EXT',
          timeOfDay: '傍晚',
          sourceText: '街道原文',
          shots: [
            {
              sourceText: '甲走出大楼',
              imagePrompt: 'e',
              videoPrompt: 'f',
              durationPlannedMs: 5000,
              shotSize: '全景',
              cameraAngle: '俯拍',
              cameraMovement: '摇',
              composition: '甲穿过人流',
              transition: '切',
              tags: [],
              dialogue: [],
            },
          ],
        },
      ],
    });

    expect(shots.length).toBe(3);
    // 前两个镜头同属场景 0，第三个属场景 1
    expect(shots.map((s) => s.sceneRef?.sceneKey)).toEqual(['scene-0', 'scene-0', 'scene-1']);
    expect(shots.map((s) => s.sceneRef?.sortOrder)).toEqual([0, 0, 1]);
    expect(shots[0].sceneRef).toMatchObject({
      title: '客户会议室',
      location: '客户会议室',
      interiorExterior: 'INT',
      timeOfDay: '白天',
      sourceText: '会议室里的原文',
    });
    // location 缺省时回落到 title（两者同源），不编造别的地点
    expect(shots[2].sceneRef?.location).toBe('楼下街道');

    // 影视语义原样透传到镜头层
    expect(shots[1]).toMatchObject({
      shotSize: '特写',
      cameraAngle: '过肩',
      cameraMovement: '推',
      composition: '乙的手停在方案册上',
      transition: '叠化',
    });
    // 既有字段不受影响
    expect(shots[0].dialogue).toEqual([{ speaker: '甲', isNarrator: false, text: '开始吧。' }]);
    expect(shots[0].tags).toEqual([{ name: '会议室', type: 'SCENE' }]);
    expect(shots[1].dialogue).toEqual([]);
  });

  it('新格式：镜头缺影视语义字段时补空串，不报错', () => {
    const shots = flattenGeneratedStoryboard({
      scenes: [{ title: '天台', shots: [{ sourceText: 'x' }] }],
    });
    expect(shots[0]).toMatchObject({
      shotSize: '',
      cameraAngle: '',
      cameraMovement: '',
      composition: '',
      transition: '',
    });
    expect(shots[0].sceneRef).toMatchObject({ title: '天台', interiorExterior: '', timeOfDay: '' });
  });

  it('旧格式兼容：{"shots":[...]} 仍可解析，每个镜头自成一个场景且场景元数据留空', () => {
    const shots = flattenGeneratedStoryboard({
      shots: [
        { sourceText: '第一镜', imagePrompt: 'a', videoPrompt: 'b', durationPlannedMs: 12000 },
        { sourceText: '第二镜', imagePrompt: 'c', videoPrompt: 'd', durationPlannedMs: 9000 },
      ],
    });
    expect(shots.length).toBe(2);
    expect(shots.map((s) => s.sceneRef?.sceneKey)).toEqual(['scene-0', 'scene-1']);
    expect(shots.map((s) => s.sceneRef?.sortOrder)).toEqual([0, 1]);
    // 旧格式没有地点/内外景信息，宁可留空也不编造
    expect(shots[0].sceneRef).toMatchObject({
      title: '',
      location: '',
      interiorExterior: '',
      timeOfDay: '',
      sourceText: '第一镜',
    });
    // 旧格式的时长原样保留（不在解析层强行截断，交由后续检查器提示）
    expect(shots[0].durationPlannedMs).toBe(12000);
  });

  it('两种格式都不匹配时抛错', () => {
    expect(() => flattenGeneratedStoryboard({ foo: 1 })).toThrow();
    expect(() => flattenGeneratedStoryboard({ scenes: [] })).toThrow();
  });
});

describe('mockTextGen', () => {
  it('每段一个场景，段内按说话人切镜，输出可被展开', async () => {
    const prompt = buildStoryboardPrompt(SCRIPT, []);
    const raw = await mockTextGen(prompt);
    const parsed = JSON.parse(raw) as { scenes: unknown[] };
    expect(parsed.scenes.length).toBe(2);

    const shots = flattenGeneratedStoryboard(parsed);
    // 天台场景两句台词 → 两个镜头；教室场景一句旁白 → 一个镜头
    expect(shots.length).toBe(3);
    expect(shots.map((s) => s.sceneRef?.sceneKey)).toEqual(['scene-0', 'scene-0', 'scene-1']);
    expect(shots[0].sceneRef?.title).toBe('天台');
    expect(shots[2].sceneRef?.title).toBe('教室');

    // 台词只出现在它所属的那个镜头里，不重复
    expect(shots[0].dialogue).toEqual([{ speaker: '林凡', isNarrator: false, text: '你终于来了。' }]);
    expect(shots[1].dialogue).toEqual([{ speaker: '苏瑶', isNarrator: false, text: '我一直都在。' }]);
    expect(shots[2].dialogue).toEqual([{ isNarrator: true, text: '三年前的那个夏天。' }]);

    // 场景标签挂在场景内每个镜头上；角色标签只挂说话的那个镜头
    expect(shots[0].tags).toContainEqual({ name: '天台', type: 'SCENE' });
    expect(shots[1].tags).toContainEqual({ name: '天台', type: 'SCENE' });
    expect(shots[0].tags).toContainEqual({ name: '林凡', type: 'CHARACTER' });
    expect(shots[1].tags).toContainEqual({ name: '苏瑶', type: 'CHARACTER' });
    expect(shots[0].tags).not.toContainEqual({ name: '苏瑶', type: 'CHARACTER' });

    // 单镜头时长落在提示词要求的区间内
    for (const s of shots) {
      expect(s.durationPlannedMs).toBeGreaterThanOrEqual(SHOT_DURATION_MIN_MS);
      expect(s.durationPlannedMs).toBeLessThanOrEqual(SHOT_DURATION_MAX_MS);
    }
    // 影视语义字段有值
    expect(shots[0].shotSize).toBe('中景');
    expect(shots[1].shotSize).toBe('近景');
    expect(shots[0].transition).toBe('切');
    expect(shots.every((s) => s.cameraAngle && s.cameraMovement && s.composition)).toBe(true);
    expect(shots[0].imagePrompt.length).toBeGreaterThan(0);
    expect(shots[0].videoPrompt.length).toBeGreaterThan(0);
  });

  it('台词超过 5 条时最多切 5 个镜头', async () => {
    const long = ['【场景：走廊】', ...Array.from({ length: 9 }, (_, i) => `林凡：第${i}句。`)].join('\n');
    const shots = flattenGeneratedStoryboard(JSON.parse(await mockTextGen(buildStoryboardPrompt(long, []))));
    expect(shots.length).toBe(5);
    // 9 句台词一句不漏地分布在 5 个镜头里
    expect(shots.flatMap((s) => s.dialogue).length).toBe(9);
  });

  it('无对白的段落生成一条旁白；确定性输出', async () => {
    const prompt = buildStoryboardPrompt('夜色沉沉，城市灯火渐次熄灭。', []);
    const raw1 = await mockTextGen(prompt);
    const raw2 = await mockTextGen(prompt);
    expect(raw1).toBe(raw2);
    const shots = flattenGeneratedStoryboard(JSON.parse(raw1));
    expect(shots.length).toBe(1);
    expect(shots[0].dialogue).toEqual([
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

    expect(result.output.shotCount).toBe(3);
    expect(result.output.sceneCount).toBe(2);
    const storyboard = await tdb.db.storyboard.findUnique({
      where: { id: result.output.storyboardId },
      include: { shots: { orderBy: { sortOrder: 'asc' }, include: { tags: true } } },
    });
    expect(storyboard?.version).toBe(1);
    expect(storyboard?.scriptDraftId).toBe(draft.id);
    expect(storyboard?.shots.length).toBe(3);

    // 展开出的 sceneRef 真的落成了 Scene 行：两个场景，前两镜同场景、第三镜独立
    const scenes = await tdb.db.scene.findMany({
      where: { storyboardId: storyboard!.id },
      orderBy: { sortOrder: 'asc' },
    });
    expect(scenes.map((s) => s.title)).toEqual(['天台', '教室']);
    expect(storyboard?.shots.map((s) => s.sceneId)).toEqual([
      scenes[0].id,
      scenes[0].id,
      scenes[1].id,
    ]);

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
    expect(result.output.shotCount).toBe(3);
  });

  it('模型只返回旧的扁平 shots 时照样建出分镜（降级兼容）', async () => {
    const ep = await tdb.db.episode.create({ data: { projectId: project.id, title: '旧格式集' } });
    const draft = await tdb.db.scriptDraft.create({ data: { episodeId: ep.id, content: SCRIPT } });
    const legacy = JSON.stringify({
      shots: [
        {
          sourceText: '天台对话',
          imagePrompt: '@天台 漫画风格',
          videoPrompt: '缓推',
          durationPlannedMs: 12000,
          tags: [{ name: '天台', type: 'SCENE' }],
          dialogue: [{ speaker: '林凡', isNarrator: false, text: '你终于来了。' }],
        },
      ],
    });
    const generator = createStoryboardGenerator({ textGen: async () => legacy });
    const result = await generator({
      db: tdb.db,
      job: { inputJson: toJson({ scriptDraftId: draft.id }) },
      updateProgress: async () => {},
    });
    expect(result.output.shotCount).toBe(1);
    expect(result.output.sceneCount).toBe(1);
    const storyboard = await tdb.db.storyboard.findUnique({
      where: { id: result.output.storyboardId },
      include: { shots: true },
    });
    expect(storyboard?.shots.length).toBe(1);
    expect(storyboard?.shots[0].durationPlannedMs).toBe(12000);
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
