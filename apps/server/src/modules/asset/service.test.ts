import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { AppError } from '../../lib/errors.js';
import {
  createAsset,
  listAssets,
  recycleAsset,
  restoreAsset,
  getLineage,
} from './service.js';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.cleanup();
});

async function mkProject(name: string) {
  return t.db.project.create({ data: { name } });
}

function mkAsset(projectId: string, over: Partial<Parameters<typeof createAsset>[1]> = {}) {
  return createAsset(t.db, {
    projectId,
    type: 'IMAGE',
    source: 'GENERATED',
    uri: `/storage/${projectId}/${Math.random().toString(36).slice(2)}.png`,
    ...over,
  });
}

describe('createAsset', () => {
  it('创建资产并写入 AssetParent 血缘行', async () => {
    const p = await mkProject('createAsset');
    const parent1 = await mkAsset(p.id);
    const parent2 = await mkAsset(p.id);
    const child = await mkAsset(p.id, {
      mime: 'image/png',
      sizeBytes: 42,
      width: 100,
      height: 200,
      meta: { prompt: '苏三回眸' },
      parentIds: [parent1.id, parent2.id],
    });

    expect(child.status).toBe('ACTIVE');
    expect(child.mime).toBe('image/png');
    expect(child.sizeBytes).toBe(42);
    expect(JSON.parse(child.metaJson)).toEqual({ prompt: '苏三回眸' });

    const rows = await t.db.assetParent.findMany({ where: { childId: child.id } });
    expect(new Set(rows.map((r) => r.parentId))).toEqual(new Set([parent1.id, parent2.id]));
  });

  it('非法 type / source 抛 400', async () => {
    const p = await mkProject('createAsset-bad');
    await expect(mkAsset(p.id, { type: 'GIF' })).rejects.toBeInstanceOf(AppError);
    await expect(mkAsset(p.id, { type: 'GIF' })).rejects.toHaveProperty('statusCode', 400);
    await expect(mkAsset(p.id, { source: 'STOLEN' })).rejects.toHaveProperty('statusCode', 400);
  });
});

describe('listAssets', () => {
  it('默认只返回 ACTIVE，可按 type / status 过滤', async () => {
    const p = await mkProject('listAssets');
    const img = await mkAsset(p.id, { type: 'IMAGE' });
    const vid = await mkAsset(p.id, { type: 'VIDEO' });
    const recycled = await mkAsset(p.id, { type: 'IMAGE' });
    await recycleAsset(t.db, recycled.id);

    const all = await listAssets(t.db, p.id);
    expect(new Set(all.map((a) => a.id))).toEqual(new Set([img.id, vid.id]));

    const images = await listAssets(t.db, p.id, { type: 'IMAGE' });
    expect(images.map((a) => a.id)).toEqual([img.id]);

    const bin = await listAssets(t.db, p.id, { status: 'RECYCLED' });
    expect(bin.map((a) => a.id)).toEqual([recycled.id]);
  });

  it('非法过滤值抛 400', async () => {
    const p = await mkProject('listAssets-bad');
    await expect(listAssets(t.db, p.id, { type: 'DOC' })).rejects.toHaveProperty('statusCode', 400);
    await expect(listAssets(t.db, p.id, { status: 'GONE' })).rejects.toHaveProperty('statusCode', 400);
  });
});

describe('recycleAsset / restoreAsset', () => {
  it('回收与恢复是幂等的状态切换', async () => {
    const p = await mkProject('recycle');
    const a = await mkAsset(p.id);

    const r1 = await recycleAsset(t.db, a.id);
    expect(r1.status).toBe('RECYCLED');
    const r2 = await recycleAsset(t.db, a.id); // 重复回收：幂等
    expect(r2.status).toBe('RECYCLED');

    const s1 = await restoreAsset(t.db, a.id);
    expect(s1.status).toBe('ACTIVE');
    const s2 = await restoreAsset(t.db, a.id); // 重复恢复：幂等
    expect(s2.status).toBe('ACTIVE');
  });

  it('资产不存在抛 404', async () => {
    await expect(recycleAsset(t.db, 'nope')).rejects.toHaveProperty('statusCode', 404);
    await expect(restoreAsset(t.db, 'nope')).rejects.toHaveProperty('statusCode', 404);
  });
});

describe('getLineage', () => {
  it('BFS 收集直接与间接祖先/后代，菱形分叉去重', async () => {
    // 菱形：A → B → C，A → D → C（C 的祖先里 A 只出现一次）
    const p = await mkProject('lineage');
    const a = await mkAsset(p.id);
    const b = await mkAsset(p.id, { parentIds: [a.id] });
    const d = await mkAsset(p.id, { parentIds: [a.id] });
    const c = await mkAsset(p.id, { parentIds: [b.id, d.id] });

    const cLineage = await getLineage(t.db, c.id);
    expect(cLineage.asset.id).toBe(c.id);
    expect(cLineage.ancestors).toHaveLength(3); // 去重后 B、D、A
    expect(new Set(cLineage.ancestors.map((x) => x.id))).toEqual(new Set([a.id, b.id, d.id]));
    // BFS 层序：间接祖先 A 排在直接祖先之后
    expect(cLineage.ancestors[2].id).toBe(a.id);
    expect(cLineage.descendants).toEqual([]);

    const aLineage = await getLineage(t.db, a.id);
    expect(aLineage.ancestors).toEqual([]);
    expect(aLineage.descendants).toHaveLength(3);
    expect(new Set(aLineage.descendants.map((x) => x.id))).toEqual(new Set([b.id, d.id, c.id]));
    expect(aLineage.descendants[2].id).toBe(c.id);

    const bLineage = await getLineage(t.db, b.id);
    expect(bLineage.ancestors.map((x) => x.id)).toEqual([a.id]);
    expect(bLineage.descendants.map((x) => x.id)).toEqual([c.id]);
  });

  it('资产不存在抛 404', async () => {
    await expect(getLineage(t.db, 'nope')).rejects.toHaveProperty('statusCode', 404);
  });
});
