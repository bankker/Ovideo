import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../test/testdb.js';
import { registerErrorHandler } from '../../lib/errors.js';
import { libraryRoutes } from './library-routes.js';

let t: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  t = await createTestDb();
  app = Fastify();
  // 错误处理器必须先于路由插件注册
  registerErrorHandler(app);
  await app.register(libraryRoutes, { db: t.db });
});

afterAll(async () => {
  await app.close();
  await t.cleanup();
});

async function makeAsset(
  db: PrismaClient,
  projectId: string,
  over: Partial<{ type: string; source: string; status: string }> = {},
) {
  return db.asset.create({
    data: {
      projectId,
      type: over.type ?? 'IMAGE',
      source: over.source ?? 'GENERATED',
      status: over.status ?? 'ACTIVE',
      uri: `/storage/${projectId}/${Math.random().toString(36).slice(2)}.bin`,
    },
  });
}

describe('GET /api/episodes/:id/assets（本集素材聚合）', () => {
  it('聚合 takes/bindings/dubbing/cuts 四路引用并去重，排除 RECYCLED 与本集未引用资产', async () => {
    const p = await t.db.project.create({ data: { name: '本集素材项目' } });
    const episode = await t.db.episode.create({ data: { projectId: p.id, title: '第1集' } });
    const draft = await t.db.scriptDraft.create({ data: { episodeId: episode.id, isMain: true } });
    const sb = await t.db.storyboard.create({
      data: { episodeId: episode.id, scriptDraftId: draft.id, version: 1 },
    });
    const shot = await t.db.shot.create({ data: { storyboardId: sb.id, sortOrder: 0 } });
    const tag = await t.db.tag.create({ data: { projectId: p.id, type: 'CHARACTER', name: '主角' } });

    // 1) take 引用 —— 同一资产同时被 binding 引用（验证去重）
    const shared = await makeAsset(t.db, p.id);
    await t.db.take.create({ data: { shotId: shot.id, slot: 'KEYFRAME', assetId: shared.id } });
    await t.db.binding.create({
      data: { episodeId: episode.id, tagId: tag.id, shotKey: '', assetId: shared.id },
    });
    // 2) 仅 binding 引用
    const bound = await makeAsset(t.db, p.id);
    await t.db.binding.create({
      data: { episodeId: episode.id, tagId: tag.id, shotId: shot.id, shotKey: shot.id, assetId: bound.id },
    });
    // 3) dubbing 引用
    const audio = await makeAsset(t.db, p.id, { type: 'AUDIO' });
    await t.db.dubbingLine.create({
      data: { shotId: shot.id, status: 'READY', audioAssetId: audio.id },
    });
    // 4) cut 产物引用
    const final = await makeAsset(t.db, p.id, { type: 'FINAL' });
    await t.db.cut.create({
      data: { episodeId: episode.id, version: 1, status: 'READY', outputAssetId: final.id },
    });
    // 被引用但已回收 → 不出现
    const recycled = await makeAsset(t.db, p.id, { status: 'RECYCLED' });
    await t.db.take.create({ data: { shotId: shot.id, slot: 'VIDEO', assetId: recycled.id } });
    // 项目里未被本集引用的资产 → 不出现
    await makeAsset(t.db, p.id);

    const res = await app.inject({ method: 'GET', url: `/api/episodes/${episode.id}/assets` });
    expect(res.statusCode).toBe(200);
    const ids = res.json().map((a: { id: string }) => a.id);
    expect(new Set(ids)).toEqual(new Set([shared.id, bound.id, audio.id, final.id]));
    // 去重：shared 只出现一次
    expect(ids.filter((id: string) => id === shared.id)).toHaveLength(1);
  });

  it('分集不存在 → 404；无引用 → 空数组', async () => {
    const res404 = await app.inject({ method: 'GET', url: '/api/episodes/nope/assets' });
    expect(res404.statusCode).toBe(404);

    const p = await t.db.project.create({ data: { name: '空分集项目' } });
    const episode = await t.db.episode.create({ data: { projectId: p.id, title: '空集' } });
    const res = await app.inject({ method: 'GET', url: `/api/episodes/${episode.id}/assets` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('GET /api/projects/:id/assets/generated（历史页数据源）', () => {
  it('只返回 GENERATED + ACTIVE，支持可选 type 过滤，createdAt desc', async () => {
    const p = await t.db.project.create({ data: { name: '历史页项目' } });
    const genImg = await makeAsset(t.db, p.id, { type: 'IMAGE', source: 'GENERATED' });
    const genVid = await makeAsset(t.db, p.id, { type: 'VIDEO', source: 'GENERATED' });
    await makeAsset(t.db, p.id, { source: 'UPLOADED' }); // 上传的不算
    await makeAsset(t.db, p.id, { source: 'GENERATED', status: 'RECYCLED' }); // 回收的不算

    const resAll = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/assets/generated` });
    expect(resAll.statusCode).toBe(200);
    expect(new Set(resAll.json().map((a: { id: string }) => a.id))).toEqual(
      new Set([genImg.id, genVid.id]),
    );

    const resVid = await app.inject({
      method: 'GET',
      url: `/api/projects/${p.id}/assets/generated?type=VIDEO`,
    });
    expect(resVid.json().map((a: { id: string }) => a.id)).toEqual([genVid.id]);

    const resBad = await app.inject({
      method: 'GET',
      url: `/api/projects/${p.id}/assets/generated?type=DOC`,
    });
    expect(resBad.statusCode).toBe(400);
  });
});
