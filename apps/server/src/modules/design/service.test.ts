import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Project, Tag } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { createAsset } from '../asset/service.js';
import {
  DESIGN_PROMPT_MAX,
  attachDesign,
  buildDesignPrompt,
  listDesigns,
  removeDesign,
  setCanonical,
} from './service.js';

let t: TestDb;
let project: Project;
let seq = 0;

beforeAll(async () => {
  t = await createTestDb();
  project = await t.db.project.create({ data: { name: '设计模块项目' } });
});

afterAll(async () => {
  await t.cleanup();
});

async function makeTag(name: string): Promise<Tag> {
  return t.db.tag.create({
    data: { projectId: project.id, type: 'CHARACTER', name, description: `${name}的描述` },
  });
}

async function makeImage(projectId = project.id) {
  seq += 1;
  return createAsset(t.db, {
    projectId,
    type: 'IMAGE',
    source: 'UPLOADED',
    uri: `/storage/${projectId}/design-${seq}.png`,
  });
}

describe('buildDesignPrompt', () => {
  it('缺省用「标签名，描述」组装', () => {
    expect(buildDesignPrompt({ name: '林小雨', description: '高中女生，短发' })).toBe(
      '林小雨，高中女生，短发',
    );
  });

  it('描述为空时只用标签名（不带孤立分隔符）', () => {
    expect(buildDesignPrompt({ name: '教室', description: '' })).toBe('教室');
  });

  it('自定义 prompt 优先（去首尾空白）', () => {
    expect(buildDesignPrompt({ name: '林小雨', description: '描述' }, '  赛博朋克风格全身像  ')).toBe(
      '赛博朋克风格全身像',
    );
  });

  it('空白自定义 prompt 视为未提供，回落缺省', () => {
    expect(buildDesignPrompt({ name: '林小雨', description: '描述' }, '   ')).toBe('林小雨，描述');
  });

  it('超长 prompt 截断到上限', () => {
    const long = 'あ'.repeat(DESIGN_PROMPT_MAX + 100);
    const out = buildDesignPrompt({ name: '名', description: long });
    expect(out.length).toBe(DESIGN_PROMPT_MAX);
  });
});

describe('listDesigns', () => {
  it('标签不存在 → 404', async () => {
    await expect(listDesigns(t.db, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('按 createdAt desc 返回并 include asset', async () => {
    const tag = await makeTag('列表标签');
    const a1 = await makeImage();
    const a2 = await makeImage();
    // 显式 createdAt 保证排序确定性（同毫秒创建会打平）
    await t.db.tagDesign.create({
      data: { tagId: tag.id, assetId: a1.id, createdAt: new Date('2026-01-01T00:00:00Z') },
    });
    await t.db.tagDesign.create({
      data: { tagId: tag.id, assetId: a2.id, createdAt: new Date('2026-01-02T00:00:00Z') },
    });

    const { tag: got, designs } = await listDesigns(t.db, tag.id);
    expect(got.id).toBe(tag.id);
    expect(designs.map((d) => d.assetId)).toEqual([a2.id, a1.id]);
    expect(designs[0].asset.uri).toBe(a2.uri);
  });
});

describe('attachDesign', () => {
  it('首张设计图自动设为 canonical，后续不覆盖', async () => {
    const tag = await makeTag('首图标签');
    const a1 = await makeImage();
    const a2 = await makeImage();

    const first = await attachDesign(t.db, tag.id, a1.id);
    expect(first.design.tagId).toBe(tag.id);
    expect(first.tag.canonicalAssetId).toBe(a1.id);

    const second = await attachDesign(t.db, tag.id, a2.id);
    expect(second.tag.canonicalAssetId).toBe(a1.id); // 已有 canonical 不动
  });

  it('标签不存在 → 404；资产不存在或跨项目 → 400；重复关联 → 400', async () => {
    const tag = await makeTag('校验标签');
    const a = await makeImage();
    await expect(attachDesign(t.db, 'nope', a.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(attachDesign(t.db, tag.id, 'nope')).rejects.toMatchObject({ statusCode: 400 });

    const other = await t.db.project.create({ data: { name: '另一个项目' } });
    const foreign = await makeImage(other.id);
    await expect(attachDesign(t.db, tag.id, foreign.id)).rejects.toMatchObject({ statusCode: 400 });

    await attachDesign(t.db, tag.id, a.id);
    await expect(attachDesign(t.db, tag.id, a.id)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('setCanonical', () => {
  it('assetId 必须属于该标签的候选设计图，否则 400', async () => {
    const tag = await makeTag('默认图标签');
    const inDesigns = await makeImage();
    const outside = await makeImage();
    await attachDesign(t.db, tag.id, inDesigns.id);

    await expect(setCanonical(t.db, tag.id, outside.id)).rejects.toMatchObject({ statusCode: 400 });
    await expect(setCanonical(t.db, 'nope', inDesigns.id)).rejects.toMatchObject({ statusCode: 404 });

    const updated = await setCanonical(t.db, tag.id, inDesigns.id);
    expect(updated.canonicalAssetId).toBe(inDesigns.id);
  });
});

describe('removeDesign', () => {
  it('解除关联删 TagDesign 行；资产不动；恰是 canonical 则清空指针', async () => {
    const tag = await makeTag('解除标签');
    const a1 = await makeImage();
    const a2 = await makeImage();
    const { design: d1 } = await attachDesign(t.db, tag.id, a1.id); // 自动 canonical
    const { design: d2 } = await attachDesign(t.db, tag.id, a2.id);

    // 删非 canonical：指针不动
    const afterD2 = await removeDesign(t.db, d2.id);
    expect(afterD2.canonicalAssetId).toBe(a1.id);
    expect(await t.db.tagDesign.findUnique({ where: { id: d2.id } })).toBeNull();

    // 删 canonical：指针清空
    const afterD1 = await removeDesign(t.db, d1.id);
    expect(afterD1.canonicalAssetId).toBeNull();

    // 付费产物不物理删除：资产行完好且仍 ACTIVE
    const a1After = await t.db.asset.findUnique({ where: { id: a1.id } });
    expect(a1After?.status).toBe('ACTIVE');
  });

  it('设计图不存在 → 404', async () => {
    await expect(removeDesign(t.db, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});
