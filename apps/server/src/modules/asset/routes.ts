import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';
import { saveBuffer } from '../../lib/storage.js';
import {
  createAsset,
  listAssets,
  recycleAsset,
  restoreAsset,
  getLineage,
} from './service.js';

export interface AssetRoutesOptions {
  db: PrismaClient;
}

export const assetRoutes: FastifyPluginAsync<AssetRoutesOptions> = async (app, { db }) => {
  app.get('/api/projects/:projectId/assets', async (req) => {
    const { projectId } = req.params as { projectId: string };
    const { type, status } = req.query as { type?: string; status?: string };
    return listAssets(db, projectId, { type, status });
  });

  // 上传即入项目资产库（v2 §1：source = UPLOADED，各处引用同一条记录）
  app.post('/api/projects/:projectId/assets/upload', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) throw notFound('项目');

    const file = await req.file();
    if (!file) throw badRequest('缺少上传文件');
    const buf = await file.toBuffer();
    const type = assetTypeFromMime(file.mimetype);
    const saved = saveBuffer(projectId, extFrom(file.filename, file.mimetype), buf);

    const asset = await createAsset(db, {
      projectId,
      type,
      source: 'UPLOADED',
      uri: saved.uri,
      mime: file.mimetype,
      sizeBytes: saved.sizeBytes,
      meta: { originalName: file.filename },
    });
    return reply.code(201).send(asset);
  });

  app.post('/api/assets/:id/recycle', async (req) => {
    const { id } = req.params as { id: string };
    return recycleAsset(db, id);
  });

  app.post('/api/assets/:id/restore', async (req) => {
    const { id } = req.params as { id: string };
    return restoreAsset(db, id);
  });

  app.get('/api/assets/:id/lineage', async (req) => {
    const { id } = req.params as { id: string };
    return getLineage(db, id);
  });
};

function assetTypeFromMime(mime: string): 'IMAGE' | 'VIDEO' | 'AUDIO' {
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('audio/')) return 'AUDIO';
  throw badRequest(`不支持的上传文件类型：${mime}`);
}

/** 扩展名优先取原文件名，无扩展名时回退 mime 子类型 */
function extFrom(filename: string | undefined, mime: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename ?? '');
  if (m) return m[1].toLowerCase();
  const sub = mime.split('/')[1];
  return sub || 'bin';
}
