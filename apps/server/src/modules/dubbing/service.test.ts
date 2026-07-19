import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { listDubbingLines, syncDubbingLines, updateDubbingLine } from './service.js';

let t: TestDb;
let db: PrismaClient;

// 固定夹具：1 项目 / 1 标签(沈娘) / 1 分集 / 1 分镜 / 2 镜头
let projectId: string;
let tagId: string;
let shot1Id: string;
let shot2Id: string;
let d1Id: string; // shot1 说话人行
let d2Id: string; // shot1 旁白行

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const project = await db.project.create({ data: { name: '配音服务测试' } });
  projectId = project.id;
  const tag = await db.tag.create({
    data: { projectId, type: 'CHARACTER', name: '沈娘' },
  });
  tagId = tag.id;
  const episode = await db.episode.create({ data: { projectId, title: '第1集' } });
  const draft = await db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
  const storyboard = await db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  const shot1 = await db.shot.create({ data: { storyboardId: storyboard.id, sortOrder: 0 } });
  shot1Id = shot1.id;
  const shot2 = await db.shot.create({ data: { storyboardId: storyboard.id, sortOrder: 1 } });
  shot2Id = shot2.id;
  // 注意：故意先建 sortOrder=1 的旁白行、再建 sortOrder=0 的说话人行，验证返回按对白 sortOrder 排序
  d2Id = (
    await db.dialogueLine.create({
      data: { shotId: shot1Id, isNarrator: true, text: '夜色渐深。', sortOrder: 1 },
    })
  ).id;
  d1Id = (
    await db.dialogueLine.create({
      data: { shotId: shot1Id, speakerTagId: tagId, text: '你来了。', sortOrder: 0 },
    })
  ).id;
  await db.dialogueLine.create({
    data: { shotId: shot2Id, speakerTagId: tagId, text: '走吧。', sortOrder: 0 },
  });
});

afterAll(async () => {
  await t.cleanup();
});

describe('syncDubbingLines', () => {
  it('首次同步：每条对白建一行，说话人行自动创建 VoiceProfile，旁白行留空', async () => {
    const lines = await syncDubbingLines(db, shot1Id);
    expect(lines).toHaveLength(2);
    // 按对白 sortOrder 排序
    expect(lines[0].dialogueLineId).toBe(d1Id);
    expect(lines[1].dialogueLineId).toBe(d2Id);
    // 说话人行：VoiceProfile 自动创建并关联（名字 = 说话人标签名）
    expect(lines[0].voiceProfile?.tagId).toBe(tagId);
    expect(lines[0].voiceProfile?.name).toBe('沈娘');
    // 旁白行：voiceProfileId 留空
    expect(lines[1].voiceProfileId).toBeNull();
    // include 形状：dialogueLine 展开、audioAsset 未生成为 null
    expect(lines[0].dialogueLine?.text).toBe('你来了。');
    expect(lines[0].audioAsset).toBeNull();
    expect(await db.voiceProfile.count({ where: { projectId } })).toBe(1);
  });

  it('幂等：重复同步不新增行、不重复建 VoiceProfile', async () => {
    const lines = await syncDubbingLines(db, shot1Id);
    expect(lines).toHaveLength(2);
    expect(await db.dubbingLine.count({ where: { shotId: shot1Id } })).toBe(2);
    expect(await db.voiceProfile.count({ where: { projectId } })).toBe(1);
  });

  it('跨镜头复用：shot2 同步复用同一说话人的既有 VoiceProfile', async () => {
    const lines = await syncDubbingLines(db, shot2Id);
    expect(lines).toHaveLength(1);
    const profile = await db.voiceProfile.findFirst({ where: { projectId, tagId } });
    expect(lines[0].voiceProfileId).toBe(profile?.id);
    expect(await db.voiceProfile.count({ where: { projectId } })).toBe(1);
  });

  it('镜头不存在 → 404', async () => {
    await expect(syncDubbingLines(db, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('updateDubbingLine', () => {
  it('speed 改动：speed 更新且 status 回 PENDING，已有音频资产保留（付费产物不删）', async () => {
    const line = (await listDubbingLines(db, shot1Id))[0];
    // 先模拟"已生成完成"的行
    const audio = await db.asset.create({
      data: { projectId, type: 'AUDIO', source: 'GENERATED', uri: `/storage/${projectId}/a.wav` },
    });
    await db.dubbingLine.update({
      where: { id: line.id },
      data: { status: 'READY', audioAssetId: audio.id, durationMs: 1200 },
    });

    const updated = await updateDubbingLine(db, line.id, { speed: 1.5 });
    expect(updated.speed).toBe(1.5);
    expect(updated.status).toBe('PENDING');
    expect(updated.audioAssetId).toBe(audio.id); // 旧音频保留，只标记需重新生成
  });

  it('speed 与当前值相同：空操作，状态不回退', async () => {
    const line = (await listDubbingLines(db, shot1Id))[0];
    await db.dubbingLine.update({ where: { id: line.id }, data: { status: 'READY' } });
    const updated = await updateDubbingLine(db, line.id, { speed: 1.5 });
    expect(updated.status).toBe('READY');
  });

  it('改 text：改写来源对白、行打回 PENDING、旧音频保留', async () => {
    const line = (await listDubbingLines(db, shot1Id))[0];
    const audio = await db.asset.create({
      data: { projectId, type: 'AUDIO', source: 'GENERATED', uri: `/storage/${projectId}/t.wav` },
    });
    await db.dubbingLine.update({
      where: { id: line.id },
      data: { status: 'READY', audioAssetId: audio.id, durationMs: 1500 },
    });

    const updated = await updateDubbingLine(db, line.id, { text: '  改后的台词  ' });
    expect(updated.dialogueLine?.text).toBe('改后的台词'); // 首尾空白被裁掉
    expect(updated.status).toBe('PENDING');
    expect(updated.audioAssetId).toBe(audio.id); // 旧音频保留，只标记需重新生成
    // 来源对白确实被改写（分镜页看到的也是新文案）
    const dialogue = await db.dialogueLine.findUnique({ where: { id: line.dialogueLineId! } });
    expect(dialogue?.text).toBe('改后的台词');
  });

  it('text 与当前对白相同：空操作，状态不回退', async () => {
    const line = (await listDubbingLines(db, shot1Id))[0];
    await db.dubbingLine.update({ where: { id: line.id }, data: { status: 'READY' } });
    const same = line.dialogueLine!.text;
    const updated = await updateDubbingLine(db, line.id, { text: same });
    expect(updated.status).toBe('READY');
  });

  it('text 为空白 → 400；无对白来源的自由行改 text → 400', async () => {
    const line = (await listDubbingLines(db, shot1Id))[0];
    await expect(updateDubbingLine(db, line.id, { text: '   ' })).rejects.toMatchObject({
      statusCode: 400,
    });
    const free = await db.dubbingLine.create({ data: { shotId: shot1Id } });
    await expect(updateDubbingLine(db, free.id, { text: '随便' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('配音行不存在 → 404', async () => {
    await expect(updateDubbingLine(db, 'nope', { speed: 1 })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
