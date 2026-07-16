import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { mergeTags } from './merge.js';

let t: TestDb;
let db: PrismaClient;
let projectId: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  projectId = (await db.project.create({ data: { name: '合并测试' } })).id;
});
afterAll(async () => {
  await t.cleanup();
});

async function seedScaffold() {
  const episode = await db.episode.create({ data: { projectId, title: '集' } });
  const draft = await db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
  const sb = await db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  const shot = await db.shot.create({ data: { storyboardId: sb.id, sortOrder: 0 } });
  return { episode, shot };
}

const mkAsset = () =>
  db.asset.create({
    data: { projectId, type: 'IMAGE', source: 'UPLOADED', uri: `/storage/${projectId}/${Math.random()}.png` },
  });

describe('mergeTags', () => {
  it('全量重指：镜头标签/绑定/设计图/对白说话人/角色声音；目标缺省时继承 canonical 与描述；源标签删除', async () => {
    const { episode, shot } = await seedScaffold();
    const assetA = await mkAsset();
    const assetB = await mkAsset();
    const source = await db.tag.create({
      data: { projectId, type: 'SCENE', name: '同一办公室，明亮清新。', description: '现代办公室', canonicalAssetId: assetA.id },
    });
    const target = await db.tag.create({ data: { projectId, type: 'SCENE', name: '办公室' } });

    await db.shotTag.create({ data: { shotId: shot.id, tagId: source.id } });
    await db.binding.create({
      data: { episodeId: episode.id, tagId: source.id, shotId: null, shotKey: '', assetId: assetB.id },
    });
    await db.tagDesign.create({ data: { tagId: source.id, assetId: assetA.id } });
    const dlg = await db.dialogueLine.create({
      data: { shotId: shot.id, speakerTagId: source.id, isNarrator: false, text: '台词', sortOrder: 0 },
    });
    const vp = await db.voiceProfile.create({ data: { projectId, tagId: source.id, name: '声音' } });

    // 提示词里引用了源标签名 → 合并后应改写为目标名
    await db.shot.update({
      where: { id: shot.id },
      data: { imagePrompt: '@同一办公室，明亮清新。 内，@小悟 靠坐椅背' },
    });

    const result = await mergeTags(db, source.id, target.id);
    expect(result.moved).toEqual({
      shotTags: 1,
      bindings: 1,
      designs: 1,
      dialogueSpeakers: 1,
      voiceProfiles: 1,
      promptRewrites: 1,
    });
    const rewritten = await db.shot.findUnique({ where: { id: shot.id } });
    expect(rewritten!.imagePrompt).toBe('@办公室 内，@小悟 靠坐椅背');
    expect(result.target.canonicalAssetId).toBe(assetA.id); // 继承
    expect(result.target.description).toBe('现代办公室');

    expect(await db.tag.findUnique({ where: { id: source.id } })).toBeNull();
    expect((await db.shotTag.findMany({ where: { shotId: shot.id } }))[0].tagId).toBe(target.id);
    expect((await db.binding.findFirst({ where: { episodeId: episode.id } }))!.tagId).toBe(target.id);
    expect((await db.tagDesign.findFirst({ where: { assetId: assetA.id } }))!.tagId).toBe(target.id);
    expect((await db.dialogueLine.findUnique({ where: { id: dlg.id } }))!.speakerTagId).toBe(target.id);
    expect((await db.voiceProfile.findUnique({ where: { id: vp.id } }))!.tagId).toBe(target.id);
  });

  it('冲突处理：目标同镜头/同绑定键/同设计资产已存在时删源不重复；目标已有 canonical 不被覆盖', async () => {
    const { episode, shot } = await seedScaffold();
    const assetShared = await mkAsset();
    const assetTargetCanon = await mkAsset();
    const assetSourceCanon = await mkAsset();
    const source = await db.tag.create({
      data: { projectId, type: 'CHARACTER', name: '男主甲', canonicalAssetId: assetSourceCanon.id },
    });
    const target = await db.tag.create({
      data: { projectId, type: 'CHARACTER', name: '男主', canonicalAssetId: assetTargetCanon.id },
    });
    // 两边都挂同一镜头、同一绑定键、同一设计资产
    await db.shotTag.createMany({
      data: [
        { shotId: shot.id, tagId: source.id },
        { shotId: shot.id, tagId: target.id },
      ],
    });
    await db.binding.create({
      data: { episodeId: episode.id, tagId: source.id, shotKey: '', assetId: assetShared.id },
    });
    await db.binding.create({
      data: { episodeId: episode.id, tagId: target.id, shotKey: '', assetId: assetTargetCanon.id },
    });
    await db.tagDesign.createMany({
      data: [
        { tagId: source.id, assetId: assetShared.id },
        { tagId: target.id, assetId: assetShared.id },
      ],
    });

    const result = await mergeTags(db, source.id, target.id);
    expect(result.moved.shotTags).toBe(0); // 冲突全部走"保留目标、删源"
    expect(result.moved.bindings).toBe(0);
    expect(result.moved.designs).toBe(0);
    expect(result.target.canonicalAssetId).toBe(assetTargetCanon.id); // 不覆盖
    // 目标侧数据完好、无重复
    expect(await db.shotTag.count({ where: { shotId: shot.id } })).toBe(1);
    expect(await db.binding.count({ where: { episodeId: episode.id, tagId: target.id } })).toBe(1);
    expect(await db.tagDesign.count({ where: { tagId: target.id, assetId: assetShared.id } })).toBe(1);
  });

  it('校验：合并到自身 400；类型不同 400；跨项目 400', async () => {
    const a = await db.tag.create({ data: { projectId, type: 'SCENE', name: `S-${Math.random()}` } });
    const b = await db.tag.create({ data: { projectId, type: 'CHARACTER', name: `C-${Math.random()}` } });
    await expect(mergeTags(db, a.id, a.id)).rejects.toMatchObject({ statusCode: 400 });
    await expect(mergeTags(db, a.id, b.id)).rejects.toMatchObject({ statusCode: 400 });
    const otherProject = await db.project.create({ data: { name: '另一项目' } });
    const c = await db.tag.create({ data: { projectId: otherProject.id, type: 'SCENE', name: '外部场景' } });
    await expect(mergeTags(db, a.id, c.id)).rejects.toMatchObject({ statusCode: 400 });
  });
});
