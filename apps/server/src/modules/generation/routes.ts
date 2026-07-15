// 镜头产物路由（M2 S1）：生成关键图/视频入队、选定 take、消除 stale、待重生成面板、素材页解析矩阵。
import type { FastifyPluginAsync } from 'fastify';
import type { Job, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { TakeSlotSchema } from '@ovideo/shared';
import { badRequest, notFound } from '../../lib/errors.js';
import type { EnqueueJobInput } from '../job/service.js';
import { resolveBinding } from '../binding/service.js';
import { clearStale, getStaleShots, onTakeSelected } from '../stale/service.js';

const GenerateBodySchema = z.object({
  modelConfigId: z.string().optional(),
});

const SelectTakeBodySchema = z.object({
  slot: TakeSlotSchema,
  takeId: z.string(),
});

const ClearStaleBodySchema = z.object({
  slot: TakeSlotSchema,
  mode: z.enum(['regenerated', 'ignored']),
});

export interface GenerationRoutesOptions {
  db: PrismaClient;
  /** 入队函数（集成阶段注入 job 模块的 enqueueJob 绑定 db 的偏函数） */
  enqueue: (input: EnqueueJobInput) => Promise<Job>;
}

/** 素材页解析矩阵的单元格 */
export interface ResolvedBindingCell {
  tagId: string;
  name: string;
  type: string;
  resolved: null | { assetId: string; uri: string; thumbUri: string | null; level: 'shot' | 'tag' };
}

export const generationRoutes: FastifyPluginAsync<GenerationRoutesOptions> = async (app, opts) => {
  const { db, enqueue } = opts;

  /** 读镜头并带出 projectId（入队需要）；不存在抛 404 */
  async function loadShotWithProject(shotId: string) {
    const shot = await db.shot.findUnique({
      where: { id: shotId },
      include: { storyboard: { include: { episode: true } } },
    });
    if (!shot) throw notFound('镜头');
    return { shot, projectId: shot.storyboard.episode.projectId };
  }

  app.post<{ Params: { id: string } }>('/api/shots/:id/generate-keyframe', async (req, reply) => {
    const { modelConfigId } = GenerateBodySchema.parse(req.body ?? {});
    const { shot, projectId } = await loadShotWithProject(req.params.id);
    const job = await enqueue({
      projectId,
      type: 'GENERATE_IMAGE',
      executor: modelConfigId ? 'API' : 'MOCK',
      inputPayload: { kind: 'keyframe', shotId: shot.id, modelConfigId },
    });
    reply.code(202);
    return job;
  });

  app.post<{ Params: { id: string } }>('/api/shots/:id/generate-video', async (req, reply) => {
    const { modelConfigId } = GenerateBodySchema.parse(req.body ?? {});
    const { shot, projectId } = await loadShotWithProject(req.params.id);
    // 提前拦截（执行器内还会兜底校验）：
    // 衔接组段 >0 的首帧来自上一段尾帧（v2 §5），校验上一段已选定视频；其余镜头校验选定关键图
    if (shot.groupId && (shot.groupIndex ?? 0) > 0) {
      const prev = await db.shot.findFirst({
        where: { storyboardId: shot.storyboardId, groupId: shot.groupId, groupIndex: (shot.groupIndex ?? 0) - 1 },
      });
      if (!prev?.videoSelectedTakeId) throw badRequest('衔接组需按顺序生成：请先完成上一段');
    } else if (!shot.keyframeSelectedTakeId) {
      throw badRequest('请先生成并选定关键图');
    }
    const job = await enqueue({
      projectId,
      type: 'GENERATE_VIDEO',
      executor: modelConfigId ? 'API' : 'MOCK',
      inputPayload: { shotId: shot.id, modelConfigId },
    });
    reply.code(202);
    return job;
  });

  app.post<{ Params: { id: string } }>('/api/shots/:id/select-take', async (req) => {
    const { slot, takeId } = SelectTakeBodySchema.parse(req.body);
    const shot = await db.shot.findUnique({ where: { id: req.params.id } });
    if (!shot) throw notFound('镜头');
    const take = await db.take.findUnique({ where: { id: takeId } });
    if (!take) throw notFound('take');
    if (take.shotId !== shot.id) throw badRequest('take 不属于该镜头');
    if (take.slot !== slot) throw badRequest(`take 槽位不匹配：期望 ${slot}，实际 ${take.slot}`);

    await db.shot.update({
      where: { id: shot.id },
      data: slot === 'KEYFRAME' ? { keyframeSelectedTakeId: take.id } : { videoSelectedTakeId: take.id },
    });
    // 失效传播（§2.2 行6/7）：换关键图 → video 标 stale；换视频 → 仅溯源记录
    await onTakeSelected(db, shot.id, slot);
    return db.shot.findUnique({ where: { id: shot.id } });
  });

  app.post<{ Params: { id: string } }>('/api/shots/:id/clear-stale', async (req) => {
    const { slot, mode } = ClearStaleBodySchema.parse(req.body);
    const shot = await db.shot.findUnique({ where: { id: req.params.id } });
    if (!shot) throw notFound('镜头');
    await clearStale(db, shot.id, slot, mode);
    return db.shot.findUnique({ where: { id: shot.id } });
  });

  app.get<{ Params: { id: string } }>('/api/episodes/:id/stale-shots', async (req) => {
    const episode = await db.episode.findUnique({ where: { id: req.params.id } });
    if (!episode) throw notFound('分集');
    return getStaleShots(db, episode.id);
  });

  // 素材页数据源：镜头 × 标签矩阵，每格 = 实时解析结果 + 来源层级（镜头覆盖 > 标签默认）
  app.get<{ Params: { id: string } }>('/api/storyboards/:id/resolved-bindings', async (req) => {
    const storyboard = await db.storyboard.findUnique({
      where: { id: req.params.id },
      include: {
        shots: {
          orderBy: { sortOrder: 'asc' },
          include: { tags: { include: { tag: true } } },
        },
      },
    });
    if (!storyboard) throw notFound('分镜');
    const episodeId = storyboard.episodeId;

    // 先算每格的 (assetId, level)，再批量取资产补 uri/thumbUri
    const cells: Array<{ shotId: string; tagId: string; assetId: string | null; level: 'shot' | 'tag' }> = [];
    for (const shot of storyboard.shots) {
      for (const st of shot.tags) {
        const shotLevel = await db.binding.findUnique({
          where: { episodeId_tagId_shotKey: { episodeId, tagId: st.tagId, shotKey: shot.id } },
        });
        if (shotLevel) {
          cells.push({ shotId: shot.id, tagId: st.tagId, assetId: shotLevel.assetId, level: 'shot' });
        } else {
          const assetId = await resolveBinding(db, episodeId, st.tagId, shot.id);
          cells.push({ shotId: shot.id, tagId: st.tagId, assetId, level: 'tag' });
        }
      }
    }
    const assetIds = [...new Set(cells.map((c) => c.assetId).filter((id): id is string => !!id))];
    const assets = await db.asset.findMany({ where: { id: { in: assetIds } } });
    const assetById = new Map(assets.map((a) => [a.id, a]));
    const cellByKey = new Map(cells.map((c) => [`${c.shotId}:${c.tagId}`, c]));

    return {
      shots: storyboard.shots.map((shot) => ({
        shotId: shot.id,
        sortOrder: shot.sortOrder,
        tags: shot.tags.map((st): ResolvedBindingCell => {
          const cell = cellByKey.get(`${shot.id}:${st.tagId}`);
          const asset = cell?.assetId ? assetById.get(cell.assetId) : undefined;
          return {
            tagId: st.tagId,
            name: st.tag.name,
            type: st.tag.type,
            resolved:
              cell?.assetId && asset
                ? { assetId: asset.id, uri: asset.uri, thumbUri: asset.thumbUri, level: cell.level }
                : null,
          };
        }),
      })),
    };
  });
};
