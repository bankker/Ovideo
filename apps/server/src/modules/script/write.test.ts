import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Episode, Project } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { toJson } from '../../lib/json.js';
import { buildScriptPrompt, makeGenerateScript } from './write.js';

let tdb: TestDb;
let project: Project;
let episode: Episode;

const SCRIPT = [
  '场景一：办公室内，白天。',
  '小悟趴在堆满报表的办公桌前，蓬头垢面。',
  '小悟：唉，客户信息还没录入。',
  '',
  '场景二：茶水间内，傍晚。',
  '小空歪头看着小悟。',
  '小空：要不要试试新工具？',
].join('\n');

beforeAll(async () => {
  tdb = await createTestDb();
  project = await tdb.db.project.create({ data: { name: '项目' } });
  episode = await tdb.db.episode.create({ data: { projectId: project.id, title: '第一集' } });
});

afterAll(async () => {
  await tdb.cleanup();
});

describe('buildScriptPrompt', () => {
  it('把目标时长翻译成字数与场景数约束', () => {
    const prompt = buildScriptPrompt({ brief: '一只社恐的猫去上班', durationSec: 60 });
    expect(prompt).toContain('一只社恐的猫去上班');
    expect(prompt).toContain('目标成片时长约 60 秒');
    // 60 秒 × 每秒 4 字 = 240 字；60 / 12 = 5 个场景
    expect(prompt).toContain('约 240 字');
    expect(prompt).toContain('场景数约 5 个');
  });

  it('场景数夹取在 2~12：极短与极长时长都不退化', () => {
    expect(buildScriptPrompt({ brief: 'x', durationSec: 15 })).toContain('场景数约 2 个');
    expect(buildScriptPrompt({ brief: 'x', durationSec: 600 })).toContain('场景数约 12 个');
  });

  it('写死下游三步生成依赖的格式：场景标题行、角色名：台词、角色名统一', () => {
    const prompt = buildScriptPrompt({ brief: '职场小故事', durationSec: 60 });
    expect(prompt).toContain('「场景N：地点，时间。」');
    expect(prompt).toContain('「角色名：台词」');
    expect(prompt).toContain('全剧统一');
    // 无 Mock 前提下仍要防模型跑偏成英文名（角色名是形象一致性锚点）
    expect(prompt).toContain('【严禁】把角色名写成英文或拼音');
    // 纯正文，不能带解释或围栏，否则落库后编辑器里全是噪声
    expect(prompt).toContain('markdown 代码块');
  });

  it('项目画风与用户风格补充都并入提示词；缺省时不出现空条目', () => {
    const withStyle = buildScriptPrompt({
      brief: '职场小故事',
      durationSec: 60,
      style: '轻松幽默，面向职场新人',
      stylePrompt: '日系赛璐璐动画风',
    });
    expect(withStyle).toContain('日系赛璐璐动画风');
    expect(withStyle).toContain('轻松幽默，面向职场新人');

    const plain = buildScriptPrompt({ brief: '职场小故事', durationSec: 60 });
    expect(plain).not.toContain('画面风格：本项目统一为');
    expect(plain).not.toContain('风格与受众补充要求');
  });
});

describe('makeGenerateScript', () => {
  it('生成的正文写回草稿 content，并汇报调用前后进度', async () => {
    const draft = await tdb.db.scriptDraft.create({
      data: { episodeId: episode.id, title: '一只社恐的猫', content: '' },
    });
    const textGen = vi.fn(async () => SCRIPT);
    const updateProgress = vi.fn(async () => {});

    const result = await makeGenerateScript({ textGen })({
      db: tdb.db,
      job: { inputJson: toJson({ draftId: draft.id, brief: '一只社恐的猫去上班', durationSec: 60 }) },
      updateProgress,
    });

    expect(result.output.draftId).toBe(draft.id);
    const after = await tdb.db.scriptDraft.findUnique({ where: { id: draft.id } });
    expect(after?.content).toBe(SCRIPT);
    expect(updateProgress).toHaveBeenCalledWith(20);
    expect(updateProgress).toHaveBeenCalledWith(90);
  });

  it('项目画风注入提示词', async () => {
    await tdb.db.project.update({
      where: { id: project.id },
      data: { stylePrompt: '厚涂国漫风' },
    });
    const draft = await tdb.db.scriptDraft.create({
      data: { episodeId: episode.id, content: '' },
    });
    const textGen = vi.fn<(prompt: string) => Promise<string>>().mockResolvedValue(SCRIPT);
    await makeGenerateScript({ textGen })({
      db: tdb.db,
      job: { inputJson: toJson({ draftId: draft.id, brief: '创意', durationSec: 60 }) },
      updateProgress: async () => {},
    });
    expect(textGen.mock.calls[0][0]).toContain('厚涂国漫风');
    await tdb.db.project.update({ where: { id: project.id }, data: { stylePrompt: '' } });
  });

  it('模型套了 ``` 围栏时剥掉再落库', async () => {
    const draft = await tdb.db.scriptDraft.create({
      data: { episodeId: episode.id, content: '' },
    });
    const textGen = vi.fn(async () => '```\n' + SCRIPT + '\n```');
    await makeGenerateScript({ textGen })({
      db: tdb.db,
      job: { inputJson: toJson({ draftId: draft.id, brief: '创意', durationSec: 60 }) },
      updateProgress: async () => {},
    });
    const after = await tdb.db.scriptDraft.findUnique({ where: { id: draft.id } });
    expect(after?.content).toBe(SCRIPT);
  });

  it('textGen 抛错时任务失败，但草稿一行不删（付费产物零删除）', async () => {
    const draft = await tdb.db.scriptDraft.create({
      data: { episodeId: episode.id, title: '会失败的一稿', content: '' },
    });
    const textGen = vi.fn(async () => {
      throw new Error('厂商 500');
    });

    await expect(
      makeGenerateScript({ textGen })({
        db: tdb.db,
        job: { inputJson: toJson({ draftId: draft.id, brief: '创意', durationSec: 60 }) },
        updateProgress: async () => {},
      }),
    ).rejects.toThrow('厂商 500');

    const after = await tdb.db.scriptDraft.findUnique({ where: { id: draft.id } });
    expect(after).not.toBeNull();
    expect(after?.title).toBe('会失败的一稿');
  });

  it('模型返回空文本 → 明确报错，不写入空内容', async () => {
    const draft = await tdb.db.scriptDraft.create({
      data: { episodeId: episode.id, content: '旧内容' },
    });
    await expect(
      makeGenerateScript({ textGen: async () => '   ' })({
        db: tdb.db,
        job: { inputJson: toJson({ draftId: draft.id, brief: '创意', durationSec: 60 }) },
        updateProgress: async () => {},
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const after = await tdb.db.scriptDraft.findUnique({ where: { id: draft.id } });
    expect(after?.content).toBe('旧内容');
  });

  it('缺 draftId / 草稿不存在 → 报错', async () => {
    const gen = makeGenerateScript({ textGen: async () => SCRIPT });
    await expect(
      gen({ db: tdb.db, job: { inputJson: '{}' }, updateProgress: async () => {} }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      gen({
        db: tdb.db,
        job: { inputJson: toJson({ draftId: 'nope', brief: '创意' }) },
        updateProgress: async () => {},
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
