// 素材库扩展路由（不改动 M1 asset 模块）：
// - GET /api/episodes/:id/assets      本集素材 = 被本集 takes / bindings / dubbing / cuts 引用的资产
// - GET /api/projects/:id/assets/generated?type=   历史页数据源：source=GENERATED 过滤 + 可选类型
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { AssetTypeSchema } from '@ovideo/shared';
import { badRequest, notFound } from '../../lib/errors.js';

export interface LibraryRoutesOptions {
  db: PrismaClient;
}

export const libraryRoutes: FastifyPluginAsync<LibraryRoutesOptions> = async (app, { db }) => {
  app.get('/api/episodes/:id/assets', async (req) => {
    const { id } = req.params as { id: string };
    const episode = await db.episode.findUnique({ where: { id } });
    if (!episode) throw notFound('分集');

    // 四路引用来源并行收集，Set 去重（同一资产可能既被 take 又被 binding 引用）
    const [takes, bindings, dubbingLines, cuts] = await Promise.all([
      db.take.findMany({
        where: { shot: { storyboard: { episodeId: id } } },
        select: { assetId: true },
      }),
      db.binding.findMany({ where: { episodeId: id }, select: { assetId: true } }),
      db.dubbingLine.findMany({
        where: { shot: { storyboard: { episodeId: id } }, audioAssetId: { not: null } },
        select: { audioAssetId: true },
      }),
      db.cut.findMany({
        where: { episodeId: id, outputAssetId: { not: null } },
        select: { outputAssetId: true },
      }),
    ]);

    const ids = new Set<string>();
    for (const t of takes) ids.add(t.assetId);
    for (const b of bindings) ids.add(b.assetId);
    for (const d of dubbingLines) if (d.audioAssetId) ids.add(d.audioAssetId);
    for (const c of cuts) if (c.outputAssetId) ids.add(c.outputAssetId);
    if (ids.size === 0) return [];

    return db.asset.findMany({
      where: { id: { in: [...ids] }, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
  });

  app.get('/api/projects/:id/assets/generated', async (req) => {
    const { id } = req.params as { id: string };
    const { type } = req.query as { type?: string };
    const where: { projectId: string; source: string; status: string; type?: string } = {
      projectId: id,
      source: 'GENERATED',
      status: 'ACTIVE',
    };
    if (type !== undefined) {
      const parsed = AssetTypeSchema.safeParse(type);
      if (!parsed.success) throw badRequest(`非法的资产类型：${type}`);
      where.type = parsed.data;
    }
    return db.asset.findMany({ where, orderBy: { createdAt: 'desc' } });
  });
};
