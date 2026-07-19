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
  /** 图像输出尺寸（如 '1024x1792'，见前端比例映射） */
  size: z.string().optional(),
  /** 视频输出分辨率（'480p'|'720p'|'1080p'） */
  resolution: z.string().optional(),
});

const SelectTakeBodySchema = z.object({
  slot: TakeSlotSchema,
  takeId: z.string(),
});

const ClearStaleBodySchema = z.object({
  slot: TakeSlotSchema,
  mode: z.enum(['regenerated', 'ignored']),
});

const AdoptKeyframeBodySchema = z.object({
  assetId: z.string(),
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
  resolved: null | {
    assetId: string;
    uri: string;
    thumbUri: string | null;
    /** shot=镜头级覆盖 > tag=标签级默认绑定 > design=默认设计图回落（与生成实际取用一致） */
    level: 'shot' | 'tag' | 'design';
  };
}

/** 关键图选择器的一条候选：同一逻辑镜头在任意分镜版本里抽过的图 */
export interface KeyframeTakeItem {
  takeId: string;
  assetId: string;
  uri: string;
  thumbUri: string | null;
  createdAt: string;
  storyboardVersion: number;
  /** 该 take 是否就挂在当前这个 shot 行上（前端据此区分"本版本已有"与"历史版本可取用"） */
  isCurrentShot: boolean;
  isSelected: boolean;
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
    const { modelConfigId, size } = GenerateBodySchema.parse(req.body ?? {});
    const { shot, projectId } = await loadShotWithProject(req.params.id);
    const job = await enqueue({
      projectId,
      type: 'GENERATE_IMAGE',
      executor: 'API',
      inputPayload: { kind: 'keyframe', shotId: shot.id, modelConfigId, size },
    });
    reply.code(202);
    return job;
  });

  app.post<{ Params: { id: string } }>('/api/shots/:id/generate-video', async (req, reply) => {
    const { modelConfigId, resolution } = GenerateBodySchema.parse(req.body ?? {});
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
      executor: 'API',
      inputPayload: { shotId: shot.id, modelConfigId, resolution },
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

  /**
   * 取同一逻辑镜头（lineage）在所有分镜版本里的全部 KEYFRAME take。
   * 分镜是版本化的：applyPatch 只在"建新版本那一刻"复制 take，此后用户若在旧版本上继续抽卡，
   * 新 take 就落在旧行上、在更新的版本里再也看不到。按 lineage 横向查回来即可修复。
   * lineageId 为空（回填脚本未覆盖到的存量行）时退化为只看当前 shot，不至于报错。
   */
  async function loadLineageKeyframeTakes(shot: { id: string; lineageId: string | null }) {
    const shotIds = shot.lineageId
      ? (await db.shot.findMany({ where: { lineageId: shot.lineageId }, select: { id: true } })).map(
          (s) => s.id,
        )
      : [shot.id];
    return db.take.findMany({
      where: { shotId: { in: shotIds }, slot: 'KEYFRAME' },
      include: { asset: true, shot: { include: { storyboard: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  app.get<{ Params: { id: string } }>('/api/shots/:id/keyframe-takes', async (req) => {
    const shot = await db.shot.findUnique({ where: { id: req.params.id } });
    if (!shot) throw notFound('镜头');
    const takes = await loadLineageKeyframeTakes(shot);

    // 同一张图在多个版本里都有 take 行（复制产生），只回一条。
    // 代表条优先级：当前选定的那条 > 挂在当前 shot 上的 > 其他版本的。
    // 选定条若被挤掉，前端 isSelected 全为 false，金框会凭空消失。
    const rank = (t: (typeof takes)[number]) =>
      t.id === shot.keyframeSelectedTakeId ? 2 : t.shotId === shot.id ? 1 : 0;
    const byAsset = new Map<string, (typeof takes)[number]>();
    for (const take of takes) {
      const kept = byAsset.get(take.assetId);
      if (!kept || rank(take) > rank(kept)) byAsset.set(take.assetId, take);
    }

    const items: KeyframeTakeItem[] = [...byAsset.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((take) => ({
        takeId: take.id,
        assetId: take.assetId,
        uri: take.asset.uri,
        thumbUri: take.asset.thumbUri,
        createdAt: take.createdAt.toISOString(),
        storyboardVersion: take.shot.storyboard.version,
        isCurrentShot: take.shotId === shot.id,
        isSelected: take.id === shot.keyframeSelectedTakeId,
      }));
    return { takes: items };
  });

  // 把历史版本抽过的关键图"取用"为当前镜头的首帧：在当前 shot 行补一条指向同资产的 take 并选定它。
  // 不动任何既有 take —— 付费产物永不删除，历史版本保持可回滚。
  app.post<{ Params: { id: string } }>('/api/shots/:id/adopt-keyframe', async (req) => {
    const { assetId } = AdoptKeyframeBodySchema.parse(req.body);
    const shot = await db.shot.findUnique({ where: { id: req.params.id } });
    if (!shot) throw notFound('镜头');

    const takes = await loadLineageKeyframeTakes(shot);
    const source = takes.find((t) => t.assetId === assetId);
    if (!source) throw badRequest('该关键图不属于本镜头的历史版本');

    // 当前行可能已被复制过同一张图，复用它而非重复建行
    const existing = takes.find((t) => t.assetId === assetId && t.shotId === shot.id);
    const take =
      existing ??
      (await db.take.create({
        data: { shotId: shot.id, slot: 'KEYFRAME', assetId, jobId: source.jobId },
      }));

    if (shot.keyframeSelectedTakeId !== take.id) {
      await db.shot.update({ where: { id: shot.id }, data: { keyframeSelectedTakeId: take.id } });
      // 与手动选定走同一套失效传播：首帧换了，据旧首帧生成的视频即失效。
      // 反复取用同一张时不进这里，避免凭空把视频标脏。
      await onTakeSelected(db, shot.id, 'KEYFRAME');
    }
    return { takeId: take.id };
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

    // 先算每格的 (assetId, level)，再批量取资产补 uri/thumbUri。
    // 层级：镜头覆盖(shot) > 标签默认绑定(tag) > 默认设计图(design)——与关键图生成的实际取用逻辑一致
    const cells: Array<{
      shotId: string;
      tagId: string;
      assetId: string | null;
      level: 'shot' | 'tag' | 'design';
    }> = [];
    for (const shot of storyboard.shots) {
      for (const st of shot.tags) {
        const shotLevel = await db.binding.findUnique({
          where: { episodeId_tagId_shotKey: { episodeId, tagId: st.tagId, shotKey: shot.id } },
        });
        if (shotLevel) {
          cells.push({ shotId: shot.id, tagId: st.tagId, assetId: shotLevel.assetId, level: 'shot' });
        } else {
          const assetId = await resolveBinding(db, episodeId, st.tagId, shot.id);
          if (assetId) {
            cells.push({ shotId: shot.id, tagId: st.tagId, assetId, level: 'tag' });
          } else {
            // 未绑定 → 回落默认设计图（生成时的实际行为）
            cells.push({
              shotId: shot.id,
              tagId: st.tagId,
              assetId: st.tag.canonicalAssetId,
              level: 'design',
            });
          }
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
        // 前端据此计算每格的"参考位状态"（@ 提及/自动策略），与生成逻辑同一套规则
        imagePrompt: shot.imagePrompt,
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
