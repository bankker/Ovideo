import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { findDuplicateTagGroups, heuristicDuplicateGroups, normalizeTagName } from './duplicates.js';

let t: TestDb;
let db: PrismaClient;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => {
  await t.cleanup();
});

async function seedProjectTags(names: Array<[string, string]>) {
  const project = await db.project.create({ data: { name: `判重-${Math.random()}` } });
  const tags = [];
  for (const [name, type] of names) {
    tags.push(await db.tag.create({ data: { projectId: project.id, type, name } }));
  }
  return { project, tags };
}

describe('normalizeTagName', () => {
  it('去标点并剥指代前缀', () => {
    expect(normalizeTagName('办公室内，白天。')).toBe('办公室内白天');
    expect(normalizeTagName('同一办公室，明亮清新。')).toBe('办公室明亮清新');
    expect(normalizeTagName('相同的会议室')).toBe('会议室');
  });
});

describe('heuristicDuplicateGroups（离线兜底）', () => {
  it('抓出「办公室」系列拆裂标签，不误伤不同实体', async () => {
    const { tags } = await seedProjectTags([
      ['办公室内，白天。', 'SCENE'],
      ['同一办公室，明亮清新。', 'SCENE'],
      ['办公室内，片刻之后。', 'SCENE'],
      ['天台', 'SCENE'],
      ['小悟', 'CHARACTER'],
      ['小空', 'CHARACTER'],
    ]);
    const groups = heuristicDuplicateGroups(tags);
    expect(groups).toHaveLength(1);
    expect(groups[0].tags.map((x) => x.name).sort()).toEqual(
      ['办公室内，白天。', '同一办公室，明亮清新。', '办公室内，片刻之后。'].sort(),
    );
    // 「天台」「小悟」「小空」不在任何组
  });
});

describe('findDuplicateTagGroups（LLM 优先）', () => {
  it('LLM 返回的组求交集校验（幻觉名字被过滤，跨类型组被丢弃）', async () => {
    const { project } = await seedProjectTags([
      ['办公室内，白天。', 'SCENE'],
      ['同一办公室，明亮清新。', 'SCENE'],
      ['小悟', 'CHARACTER'],
    ]);
    const textGen = async () =>
      JSON.stringify({
        groups: [
          { names: ['办公室内，白天。', '同一办公室，明亮清新。', '幻觉标签'], suggestedName: '办公室' },
          { names: ['小悟', '办公室内，白天。'], suggestedName: '混合组应被丢弃' },
        ],
      });
    const { groups, method } = await findDuplicateTagGroups(db, project.id, textGen);
    expect(method).toBe('llm');
    expect(groups).toHaveLength(1);
    expect(groups[0].suggestedName).toBe('办公室');
    expect(groups[0].tags.map((x) => x.name)).toEqual(['办公室内，白天。', '同一办公室，明亮清新。']);
  });

  it('LLM 抛错/输出非法 → 自动退回启发式', async () => {
    const { project } = await seedProjectTags([
      ['办公室内，白天。', 'SCENE'],
      ['同一办公室，明亮清新。', 'SCENE'],
    ]);
    const bad = async () => 'not-json';
    const { groups, method } = await findDuplicateTagGroups(db, project.id, bad);
    expect(method).toBe('heuristic');
    expect(groups).toHaveLength(1);
  });
});
