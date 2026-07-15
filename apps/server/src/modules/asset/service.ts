import type { Asset, PrismaClient } from '@prisma/client';
import { AssetTypeSchema, AssetSourceSchema, AssetStatusSchema } from '@ovideo/shared';
import { badRequest, notFound } from '../../lib/errors.js';
import { toJson } from '../../lib/json.js';

export interface CreateAssetInput {
  projectId: string;
  type: string;
  source: string;
  uri: string;
  mime?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  meta?: Record<string, unknown>;
  jobId?: string;
  parentIds?: string[];
}

/** 创建资产并落 AssetParent 血缘行（v2 §1：lineage = parents + jobId） */
export async function createAsset(db: PrismaClient, input: CreateAssetInput): Promise<Asset> {
  const type = AssetTypeSchema.safeParse(input.type);
  if (!type.success) throw badRequest(`非法的资产类型：${input.type}`);
  const source = AssetSourceSchema.safeParse(input.source);
  if (!source.success) throw badRequest(`非法的资产来源：${input.source}`);
  const parentIds = [...new Set(input.parentIds ?? [])];

  return db.$transaction(async (tx) => {
    const asset = await tx.asset.create({
      data: {
        projectId: input.projectId,
        type: type.data,
        source: source.data,
        uri: input.uri,
        mime: input.mime ?? '',
        sizeBytes: input.sizeBytes ?? 0,
        width: input.width ?? null,
        height: input.height ?? null,
        durationMs: input.durationMs ?? null,
        metaJson: toJson(input.meta ?? {}),
        jobId: input.jobId ?? null,
      },
    });
    if (parentIds.length > 0) {
      await tx.assetParent.createMany({
        data: parentIds.map((parentId) => ({ childId: asset.id, parentId })),
      });
    }
    return asset;
  });
}

export interface ListAssetsFilter {
  type?: string;
  /** 缺省只看 ACTIVE（回收站需显式传 RECYCLED） */
  status?: string;
}

export async function listAssets(
  db: PrismaClient,
  projectId: string,
  filter: ListAssetsFilter = {},
): Promise<Asset[]> {
  const status = AssetStatusSchema.safeParse(filter.status ?? 'ACTIVE');
  if (!status.success) throw badRequest(`非法的资产状态：${filter.status}`);
  const where: { projectId: string; status: string; type?: string } = {
    projectId,
    status: status.data,
  };
  if (filter.type !== undefined) {
    const type = AssetTypeSchema.safeParse(filter.type);
    if (!type.success) throw badRequest(`非法的资产类型：${filter.type}`);
    where.type = type.data;
  }
  return db.asset.findMany({ where, orderBy: { createdAt: 'desc' } });
}

export async function recycleAsset(db: PrismaClient, assetId: string): Promise<Asset> {
  return switchStatus(db, assetId, 'RECYCLED');
}

export async function restoreAsset(db: PrismaClient, assetId: string): Promise<Asset> {
  return switchStatus(db, assetId, 'ACTIVE');
}

async function switchStatus(db: PrismaClient, assetId: string, status: string): Promise<Asset> {
  const asset = await db.asset.findUnique({ where: { id: assetId } });
  if (!asset) throw notFound('资产');
  if (asset.status === status) return asset; // 重复回收/恢复：幂等
  return db.asset.update({ where: { id: assetId }, data: { status } });
}

export interface AssetLineage {
  asset: Asset;
  /** BFS 层序（近祖先在前），含直接与间接，去重 */
  ancestors: Asset[];
  descendants: Asset[];
}

/** 血缘查询：沿 AssetParent 双向 BFS，深度不限，visited 去重（也天然防环） */
export async function getLineage(db: PrismaClient, assetId: string): Promise<AssetLineage> {
  const asset = await db.asset.findUnique({ where: { id: assetId } });
  if (!asset) throw notFound('资产');
  const [ancestorIds, descendantIds] = await Promise.all([
    bfsCollect(db, assetId, 'ancestors'),
    bfsCollect(db, assetId, 'descendants'),
  ]);
  const [ancestors, descendants] = await Promise.all([
    fetchInOrder(db, ancestorIds),
    fetchInOrder(db, descendantIds),
  ]);
  return { asset, ancestors, descendants };
}

async function bfsCollect(
  db: PrismaClient,
  startId: string,
  direction: 'ancestors' | 'descendants',
): Promise<string[]> {
  const visited = new Set<string>([startId]);
  const order: string[] = [];
  let frontier = [startId];
  while (frontier.length > 0) {
    const rows =
      direction === 'ancestors'
        ? await db.assetParent.findMany({ where: { childId: { in: frontier } } })
        : await db.assetParent.findMany({ where: { parentId: { in: frontier } } });
    const next: string[] = [];
    for (const row of rows) {
      const id = direction === 'ancestors' ? row.parentId : row.childId;
      if (!visited.has(id)) {
        visited.add(id);
        order.push(id);
        next.push(id);
      }
    }
    frontier = next;
  }
  return order;
}

/** findMany 不保序：按 BFS 顺序重排 */
async function fetchInOrder(db: PrismaClient, ids: string[]): Promise<Asset[]> {
  if (ids.length === 0) return [];
  const assets = await db.asset.findMany({ where: { id: { in: ids } } });
  const byId = new Map(assets.map((a) => [a.id, a]));
  return ids.flatMap((id) => {
    const a = byId.get(id);
    return a ? [a] : [];
  });
}
