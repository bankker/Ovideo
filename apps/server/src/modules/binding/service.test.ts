import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { setBinding, listBindings, resolveBinding } from './service.js';

let t: TestDb;
let episodeId: string;
let tagId: string;
let otherTagId: string;
let shot1Id: string;
let shot2Id: string;
let asset1Id: string;
let asset2Id: string;
let asset3Id: string;

beforeAll(async () => {
  t = await createTestDb();
  const project = await t.db.project.create({ data: { name: '绑定测试' } });
  const episode = await t.db.episode.create({ data: { projectId: project.id, title: '第1集' } });
  episodeId = episode.id;

  const tag = await t.db.tag.create({
    data: { projectId: project.id, type: 'CHARACTER', name: '苏三' },
  });
  tagId = tag.id;
  const otherTag = await t.db.tag.create({
    data: { projectId: project.id, type: 'SCENE', name: '客栈' },
  });
  otherTagId = otherTag.id;

  const draft = await t.db.scriptDraft.create({
    data: { episodeId, title: '主剧本', isMain: true },
  });
  const storyboard = await t.db.storyboard.create({
    data: { episodeId, scriptDraftId: draft.id, version: 1 },
  });
  const shot1 = await t.db.shot.create({ data: { storyboardId: storyboard.id, sortOrder: 0 } });
  const shot2 = await t.db.shot.create({ data: { storyboardId: storyboard.id, sortOrder: 1 } });
  shot1Id = shot1.id;
  shot2Id = shot2.id;

  const mk = (n: number) =>
    t.db.asset.create({
      data: {
        projectId: project.id,
        type: 'IMAGE',
        source: 'GENERATED',
        uri: `/storage/${project.id}/${n}.png`,
      },
    });
  asset1Id = (await mk(1)).id;
  asset2Id = (await mk(2)).id;
  asset3Id = (await mk(3)).id;
});

afterAll(async () => {
  await t.cleanup();
});

describe('setBinding', () => {
  it('标签级绑定 upsert：同键重复写只保留一行，assetId 被覆盖', async () => {
    const b1 = await setBinding(t.db, { episodeId, tagId, shotId: null, assetId: asset1Id });
    expect(b1).not.toBeNull();
    expect(b1!.shotKey).toBe('');
    expect(b1!.shotId).toBeNull();

    const b2 = await setBinding(t.db, { episodeId, tagId, shotId: null, assetId: asset2Id });
    expect(b2!.assetId).toBe(asset2Id);

    const rows = await t.db.binding.findMany({ where: { episodeId, tagId, shotKey: '' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].assetId).toBe(asset2Id);
  });

  it('镜头级覆盖是独立的一行（shotKey = shotId）', async () => {
    const b = await setBinding(t.db, { episodeId, tagId, shotId: shot1Id, assetId: asset3Id });
    expect(b!.shotKey).toBe(shot1Id);
    expect(b!.shotId).toBe(shot1Id);

    const all = await listBindings(t.db, episodeId);
    expect(all).toHaveLength(2); // 标签级 1 行 + 镜头级 1 行
  });

  it('assetId = null 删除对应行，重复删除幂等', async () => {
    await setBinding(t.db, { episodeId, tagId: otherTagId, shotId: null, assetId: asset1Id });
    const removed = await setBinding(t.db, {
      episodeId,
      tagId: otherTagId,
      shotId: null,
      assetId: null,
    });
    expect(removed).toBeNull();
    expect(
      await t.db.binding.findMany({ where: { episodeId, tagId: otherTagId } }),
    ).toHaveLength(0);

    // 再删一次：不抛错
    await expect(
      setBinding(t.db, { episodeId, tagId: otherTagId, shotId: null, assetId: null }),
    ).resolves.toBeNull();
  });

  it('分集/标签/镜头/资产不存在 → 404', async () => {
    await expect(
      setBinding(t.db, { episodeId: 'nope', tagId, shotId: null, assetId: asset1Id }),
    ).rejects.toHaveProperty('statusCode', 404);
    await expect(
      setBinding(t.db, { episodeId, tagId: 'nope', shotId: null, assetId: asset1Id }),
    ).rejects.toHaveProperty('statusCode', 404);
    await expect(
      setBinding(t.db, { episodeId, tagId, shotId: 'nope', assetId: asset1Id }),
    ).rejects.toHaveProperty('statusCode', 404);
    await expect(
      setBinding(t.db, { episodeId, tagId, shotId: null, assetId: 'nope' }),
    ).rejects.toHaveProperty('statusCode', 404);
  });

  it('写入后调用 onBindingChanged 钩子（标签级 shotId 为 undefined，镜头级为 shotId）', async () => {
    const onBindingChanged = vi.fn().mockResolvedValue(undefined);
    // 不能用 toHaveBeenCalledWith 深比较 PrismaClient（代理对象会撑爆相等性遍历的调用栈），
    // 拆开断言：第一个参数比引用，其余比值。
    const lastCall = () => onBindingChanged.mock.calls.at(-1) as unknown[];

    await setBinding(
      t.db,
      { episodeId, tagId, shotId: null, assetId: asset1Id },
      { onBindingChanged },
    );
    expect(lastCall()[0]).toBe(t.db);
    expect(lastCall().slice(1)).toEqual([episodeId, tagId, undefined]);

    await setBinding(
      t.db,
      { episodeId, tagId, shotId: shot2Id, assetId: asset2Id },
      { onBindingChanged },
    );
    expect(lastCall().slice(1)).toEqual([episodeId, tagId, shot2Id]);
    expect(onBindingChanged).toHaveBeenCalledTimes(2);

    // 删除也算变更：触发钩子
    await setBinding(
      t.db,
      { episodeId, tagId, shotId: shot2Id, assetId: null },
      { onBindingChanged },
    );
    expect(onBindingChanged).toHaveBeenCalledTimes(3);

    // 空操作删除（行本就不存在）：不触发钩子
    await setBinding(
      t.db,
      { episodeId, tagId, shotId: shot2Id, assetId: null },
      { onBindingChanged },
    );
    expect(onBindingChanged).toHaveBeenCalledTimes(3);
  });
});

describe('resolveBinding（执行时实时解析，修旧系统 Bug6）', () => {
  it('镜头级覆盖 > 标签级默认；无覆盖回落标签级；均无返回 null', async () => {
    // 现状：tagId 标签级 = asset1（上个用例最后写入），shot1 镜头级 = asset3
    expect(await resolveBinding(t.db, episodeId, tagId, shot1Id)).toBe(asset3Id);
    expect(await resolveBinding(t.db, episodeId, tagId, shot2Id)).toBe(asset1Id);

    // 删除镜头级覆盖后回落到标签级
    await setBinding(t.db, { episodeId, tagId, shotId: shot1Id, assetId: null });
    expect(await resolveBinding(t.db, episodeId, tagId, shot1Id)).toBe(asset1Id);

    // 完全无绑定的标签
    expect(await resolveBinding(t.db, episodeId, otherTagId, shot1Id)).toBeNull();
  });

  it('换绑后立即解析到新资产（不存在旧值快照）', async () => {
    await setBinding(t.db, { episodeId, tagId, shotId: null, assetId: asset2Id });
    expect(await resolveBinding(t.db, episodeId, tagId, shot2Id)).toBe(asset2Id);
  });
});
