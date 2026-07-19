import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Job, PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { parseJson } from '../../lib/json.js';
import type { EnqueueJobInput } from '../job/service.js';
import { generationRoutes } from './routes.js';

let t: TestDb;
let db: PrismaClient;
let app: FastifyInstance;
let projectId: string;

const enqueue = vi.fn(async (input: EnqueueJobInput) => ({ id: `job-${crypto.randomUUID()}`, ...input }) as unknown as Job);

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const project = await db.project.create({ data: { name: '生成路由测试项目' } });
  projectId = project.id;

  app = Fastify();
  // 与 app.ts 集成顺序一致：错误处理器先于路由注册（否则 zod 错误变 500）
  registerErrorHandler(app);
  await app.register(generationRoutes, { db, enqueue });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

beforeEach(() => {
  enqueue.mockClear();
});

async function seedShot(shotData: Record<string, unknown> = {}) {
  const episode = await db.episode.create({ data: { projectId, title: '测试集' } });
  const draft = await db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
  const storyboard = await db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  const shot = await db.shot.create({
    data: { storyboardId: storyboard.id, sortOrder: 0, sourceText: '镜头文本', ...shotData },
  });
  return { episode, storyboard, shot };
}

async function makeAsset(type = 'IMAGE') {
  return db.asset.create({
    data: { projectId, type, source: 'UPLOADED', uri: `/storage/${projectId}/${crypto.randomUUID()}.png` },
  });
}

describe('POST /api/shots/:id/generate-keyframe', () => {
  it('202 入队 GENERATE_IMAGE；无 modelConfigId（执行时自动调度真实模型）', async () => {
    const { shot } = await seedShot();
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/generate-keyframe`,
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const arg = enqueue.mock.calls[0]![0];
    expect(arg.projectId).toBe(projectId);
    expect(arg.type).toBe('GENERATE_IMAGE');
    expect(arg.executor).toBe('API');
    expect(arg.inputPayload).toEqual({ kind: 'keyframe', shotId: shot.id, modelConfigId: undefined });
  });

  it('带 modelConfigId 走 API 执行器', async () => {
    const { shot } = await seedShot();
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/generate-keyframe`,
      payload: { modelConfigId: 'mc-1' },
    });
    expect(res.statusCode).toBe(202);
    const arg = enqueue.mock.calls[0]![0];
    expect(arg.executor).toBe('API');
    expect(arg.inputPayload).toEqual({ kind: 'keyframe', shotId: shot.id, modelConfigId: 'mc-1' });
  });

  it('镜头不存在 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/shots/no-such/generate-keyframe',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('POST /api/shots/:id/generate-video', () => {
  it('无选定关键图 400 提前拦截，不入队', async () => {
    const { shot } = await seedShot();
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/generate-video`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('请先生成并选定关键图');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('有选定关键图 202 入队 GENERATE_VIDEO', async () => {
    const { shot } = await seedShot();
    const asset = await makeAsset();
    const take = await db.take.create({ data: { shotId: shot.id, slot: 'KEYFRAME', assetId: asset.id } });
    await db.shot.update({ where: { id: shot.id }, data: { keyframeSelectedTakeId: take.id } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/generate-video`,
      payload: { modelConfigId: 'mc-2' },
    });
    expect(res.statusCode).toBe(202);
    const arg = enqueue.mock.calls[0]![0];
    expect(arg.type).toBe('GENERATE_VIDEO');
    expect(arg.executor).toBe('API');
    expect(arg.inputPayload).toEqual({ shotId: shot.id, modelConfigId: 'mc-2' });
  });
});

describe('POST /api/shots/:id/select-take', () => {
  it('切换 KEYFRAME selected 指针并触发失效传播（video 标 stale）', async () => {
    const { shot } = await seedShot();
    const a1 = await makeAsset();
    const a2 = await makeAsset();
    const take1 = await db.take.create({ data: { shotId: shot.id, slot: 'KEYFRAME', assetId: a1.id } });
    const take2 = await db.take.create({ data: { shotId: shot.id, slot: 'KEYFRAME', assetId: a2.id } });
    await db.shot.update({ where: { id: shot.id }, data: { keyframeSelectedTakeId: take1.id } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/select-take`,
      payload: { slot: 'KEYFRAME', takeId: take2.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { keyframeSelectedTakeId: string; videoStale: boolean; staleReasonsJson: string };
    expect(body.keyframeSelectedTakeId).toBe(take2.id);
    expect(body.videoStale).toBe(true);
    const reasons = parseJson<Array<{ source: string }>>(body.staleReasonsJson, []);
    expect(reasons.some((r) => r.source === 'take_selected')).toBe(true);
  });

  it('切换 VIDEO selected 指针（仅溯源，不标 stale）', async () => {
    const { shot } = await seedShot();
    const a = await makeAsset('VIDEO');
    const take = await db.take.create({ data: { shotId: shot.id, slot: 'VIDEO', assetId: a.id } });
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/select-take`,
      payload: { slot: 'VIDEO', takeId: take.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { videoSelectedTakeId: string; videoStale: boolean };
    expect(body.videoSelectedTakeId).toBe(take.id);
    expect(body.videoStale).toBe(false);
  });

  it('槽位不匹配 400；take 不属于该镜头 400；take 不存在 404；非法 slot 400', async () => {
    const { shot } = await seedShot();
    const { shot: otherShot } = await seedShot();
    const a = await makeAsset();
    const keyframeTake = await db.take.create({ data: { shotId: shot.id, slot: 'KEYFRAME', assetId: a.id } });
    const foreignTake = await db.take.create({ data: { shotId: otherShot.id, slot: 'KEYFRAME', assetId: a.id } });

    const mismatch = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/select-take`,
      payload: { slot: 'VIDEO', takeId: keyframeTake.id },
    });
    expect(mismatch.statusCode).toBe(400);
    expect((mismatch.json() as { error: string }).error).toContain('槽位不匹配');

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/select-take`,
      payload: { slot: 'KEYFRAME', takeId: foreignTake.id },
    });
    expect(foreign.statusCode).toBe(400);
    expect((foreign.json() as { error: string }).error).toContain('不属于该镜头');

    const missing = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/select-take`,
      payload: { slot: 'KEYFRAME', takeId: 'no-such-take' },
    });
    expect(missing.statusCode).toBe(404);

    const badSlot = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/select-take`,
      payload: { slot: 'WHAT', takeId: keyframeTake.id },
    });
    expect(badSlot.statusCode).toBe(400);
  });
});

describe('POST /api/shots/:id/clear-stale', () => {
  it('消除对应槽位 stale 并留溯源记录', async () => {
    const { shot } = await seedShot({ videoStale: true });
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/clear-stale`,
      payload: { slot: 'VIDEO', mode: 'ignored' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { videoStale: boolean; staleReasonsJson: string };
    expect(body.videoStale).toBe(false);
    const reasons = parseJson<Array<{ source: string }>>(body.staleReasonsJson, []);
    expect(reasons.some((r) => r.source === 'clear:ignored')).toBe(true);
  });

  it('非法 mode 400', async () => {
    const { shot } = await seedShot();
    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${shot.id}/clear-stale`,
      payload: { slot: 'VIDEO', mode: 'whatever' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/episodes/:id/stale-shots', () => {
  it('仅返回最新版本分镜中 stale 的镜头', async () => {
    const { episode, storyboard, shot } = await seedShot({ keyframeStale: true });
    await db.shot.create({
      data: { storyboardId: storyboard.id, sortOrder: 1, sourceText: '干净镜头' },
    });
    const res = await app.inject({ method: 'GET', url: `/api/episodes/${episode.id}/stale-shots` });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string }>;
    expect(list.map((s) => s.id)).toEqual([shot.id]);
  });

  it('分集不存在 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/episodes/no-such/stale-shots' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/storyboards/:id/resolved-bindings', () => {
  it('每镜头每标签给出解析结果与来源层级（镜头覆盖 > 标签默认，未绑定为 null）', async () => {
    const { episode, storyboard, shot } = await seedShot();
    const suffix = crypto.randomUUID();
    const tagDefault = await db.tag.create({ data: { projectId, type: 'CHARACTER', name: `默认绑-${suffix}` } });
    const tagOverride = await db.tag.create({ data: { projectId, type: 'SCENE', name: `覆盖绑-${suffix}` } });
    const tagUnbound = await db.tag.create({ data: { projectId, type: 'PROP', name: `未绑-${suffix}` } });
    for (const tag of [tagDefault, tagOverride, tagUnbound]) {
      await db.shotTag.create({ data: { shotId: shot.id, tagId: tag.id } });
    }
    const assetA = await makeAsset();
    const assetB = await db.asset.create({
      data: {
        projectId,
        type: 'IMAGE',
        source: 'UPLOADED',
        uri: `/storage/${projectId}/b.png`,
        thumbUri: `/storage/${projectId}/b-thumb.png`,
      },
    });
    await db.binding.create({
      data: { episodeId: episode.id, tagId: tagDefault.id, shotId: null, shotKey: '', assetId: assetA.id },
    });
    // tagOverride：标签级默认绑 assetA，但镜头级覆盖绑 assetB → 应解析出 assetB / level=shot
    await db.binding.create({
      data: { episodeId: episode.id, tagId: tagOverride.id, shotId: null, shotKey: '', assetId: assetA.id },
    });
    await db.binding.create({
      data: { episodeId: episode.id, tagId: tagOverride.id, shotId: shot.id, shotKey: shot.id, assetId: assetB.id },
    });

    const res = await app.inject({ method: 'GET', url: `/api/storyboards/${storyboard.id}/resolved-bindings` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      shots: Array<{
        shotId: string;
        sortOrder: number;
        tags: Array<{
          tagId: string;
          name: string;
          type: string;
          resolved: null | { assetId: string; uri: string; thumbUri: string | null; level: string };
        }>;
      }>;
    };
    expect(body.shots).toHaveLength(1);
    expect(body.shots[0]!.shotId).toBe(shot.id);
    const byTag = new Map(body.shots[0]!.tags.map((c) => [c.tagId, c]));

    const cellDefault = byTag.get(tagDefault.id)!;
    expect(cellDefault.resolved).toEqual({ assetId: assetA.id, uri: assetA.uri, thumbUri: null, level: 'tag' });
    expect(cellDefault.name).toContain('默认绑');
    expect(cellDefault.type).toBe('CHARACTER');

    const cellOverride = byTag.get(tagOverride.id)!;
    expect(cellOverride.resolved).toEqual({
      assetId: assetB.id,
      uri: assetB.uri,
      thumbUri: assetB.thumbUri,
      level: 'shot',
    });

    expect(byTag.get(tagUnbound.id)!.resolved).toBeNull();
  });

  it('分镜不存在 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/storyboards/no-such/resolved-bindings' });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * 造一个"同一逻辑镜头跨两个分镜版本"的场景：v1 的旧行与 v2 的当前行共享 lineageId。
 * 这正是缺陷现场——用户在 v1 上抽的卡落在旧行，v2 里看不见。
 */
async function seedLineage() {
  const episode = await db.episode.create({ data: { projectId, title: '跨版本测试集' } });
  const draft = await db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
  const sb1 = await db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
  });
  const oldShot = await db.shot.create({
    data: { storyboardId: sb1.id, sortOrder: 0, sourceText: '镜头' },
  });
  await db.shot.update({ where: { id: oldShot.id }, data: { lineageId: oldShot.id } });
  const sb2 = await db.storyboard.create({
    data: { episodeId: episode.id, scriptDraftId: draft.id, version: 2 },
  });
  const currentShot = await db.shot.create({
    data: { storyboardId: sb2.id, sortOrder: 0, sourceText: '镜头', lineageId: oldShot.id },
  });
  return { episode, oldShot, currentShot };
}

/** createdAt 显式给定：SQLite 毫秒精度下连续插入可能同刻，倒序断言需要确定的先后 */
async function makeKeyframeTake(shotId: string, assetId: string, createdAt: Date, jobId?: string) {
  return db.take.create({ data: { shotId, slot: 'KEYFRAME', assetId, jobId, createdAt } });
}

describe('GET /api/shots/:id/keyframe-takes', () => {
  it('合并 lineage 内所有版本的关键图，按时间倒序，标记 isCurrentShot / isSelected', async () => {
    const { oldShot, currentShot } = await seedLineage();
    const assetOld = await makeAsset();
    const assetNew = await makeAsset();
    const takeOld = await makeKeyframeTake(oldShot.id, assetOld.id, new Date('2026-01-01T00:00:00Z'));
    const takeNew = await makeKeyframeTake(
      currentShot.id,
      assetNew.id,
      new Date('2026-02-01T00:00:00Z'),
    );
    await db.shot.update({
      where: { id: currentShot.id },
      data: { keyframeSelectedTakeId: takeNew.id },
    });

    const res = await app.inject({ method: 'GET', url: `/api/shots/${currentShot.id}/keyframe-takes` });
    expect(res.statusCode).toBe(200);
    const { takes } = res.json() as { takes: Array<Record<string, unknown>> };

    expect(takes).toHaveLength(2);
    expect(takes[0]).toMatchObject({
      takeId: takeNew.id,
      assetId: assetNew.id,
      uri: assetNew.uri,
      storyboardVersion: 2,
      isCurrentShot: true,
      isSelected: true,
    });
    // 旧版本上抽的卡照样列出来——这就是"图不见了"的修复点
    expect(takes[1]).toMatchObject({
      takeId: takeOld.id,
      assetId: assetOld.id,
      storyboardVersion: 1,
      isCurrentShot: false,
      isSelected: false,
    });
  });

  it('同一资产在多个版本各有 take 行时只回一条，且代表条落在当前 shot 上', async () => {
    const { oldShot, currentShot } = await seedLineage();
    const asset = await makeAsset();
    await makeKeyframeTake(oldShot.id, asset.id, new Date('2026-01-01T00:00:00Z'));
    // 复制版本时产生的同资产新行（createdAt 更晚）
    const copied = await makeKeyframeTake(currentShot.id, asset.id, new Date('2026-01-02T00:00:00Z'));

    const res = await app.inject({ method: 'GET', url: `/api/shots/${currentShot.id}/keyframe-takes` });
    const { takes } = res.json() as { takes: Array<Record<string, unknown>> };
    expect(takes).toHaveLength(1);
    expect(takes[0]).toMatchObject({ takeId: copied.id, isCurrentShot: true });
  });

  it('lineageId 为空的存量镜头退化为只看自身', async () => {
    const { shot } = await seedShot();
    const asset = await makeAsset();
    const take = await makeKeyframeTake(shot.id, asset.id, new Date('2026-03-01T00:00:00Z'));
    const res = await app.inject({ method: 'GET', url: `/api/shots/${shot.id}/keyframe-takes` });
    const { takes } = res.json() as { takes: Array<{ takeId: string }> };
    expect(takes.map((t) => t.takeId)).toEqual([take.id]);
  });

  it('镜头不存在 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/shots/no-such/keyframe-takes' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/shots/:id/adopt-keyframe', () => {
  it('取用历史版本关键图：当前 shot 新增 take 并选定，旧 take 原样保留', async () => {
    const { oldShot, currentShot } = await seedLineage();
    const asset = await makeAsset();
    const oldTake = await makeKeyframeTake(
      oldShot.id,
      asset.id,
      new Date('2026-01-01T00:00:00Z'),
      'job-历史',
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${currentShot.id}/adopt-keyframe`,
      payload: { assetId: asset.id },
    });
    expect(res.statusCode).toBe(200);
    const { takeId } = res.json() as { takeId: string };

    const take = await db.take.findUniqueOrThrow({ where: { id: takeId } });
    expect(take.shotId).toBe(currentShot.id);
    expect(take.assetId).toBe(asset.id);
    expect(take.slot).toBe('KEYFRAME');
    expect(take.jobId).toBe('job-历史'); // 沿用来源 take 的溯源

    const after = await db.shot.findUniqueOrThrow({ where: { id: currentShot.id } });
    expect(after.keyframeSelectedTakeId).toBe(takeId);
    // 铁律：付费产物永不物理删除
    expect(await db.take.findUnique({ where: { id: oldTake.id } })).not.toBeNull();
  });

  it('重复取用同一资产不重复建 take', async () => {
    const { oldShot, currentShot } = await seedLineage();
    const asset = await makeAsset();
    await makeKeyframeTake(oldShot.id, asset.id, new Date('2026-01-01T00:00:00Z'));

    const first = await app.inject({
      method: 'POST',
      url: `/api/shots/${currentShot.id}/adopt-keyframe`,
      payload: { assetId: asset.id },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/shots/${currentShot.id}/adopt-keyframe`,
      payload: { assetId: asset.id },
    });
    expect((second.json() as { takeId: string }).takeId).toBe(
      (first.json() as { takeId: string }).takeId,
    );
    expect(await db.take.count({ where: { shotId: currentShot.id } })).toBe(1);
  });

  it('非本 lineage 的资产 400', async () => {
    const { currentShot } = await seedLineage();
    const { shot: strangerShot } = await seedShot();
    const asset = await makeAsset();
    await makeKeyframeTake(strangerShot.id, asset.id, new Date('2026-01-01T00:00:00Z'));

    const res = await app.inject({
      method: 'POST',
      url: `/api/shots/${currentShot.id}/adopt-keyframe`,
      payload: { assetId: asset.id },
    });
    expect(res.statusCode).toBe(400);
  });

  it('镜头不存在 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/shots/no-such/adopt-keyframe',
      payload: { assetId: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});
