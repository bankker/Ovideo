import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { EnqueueFn } from '../script/routes.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { saveBuffer } from '../../lib/storage.js';
import { createAsset } from '../asset/service.js';
import {
  attachDesign,
  buildDesignPrompt,
  listDesigns,
  removeDesign,
  setCanonical,
} from './service.js';

const GenerateDesignBodySchema = z.object({
  /** 指定图像模型 → API 执行器；缺省 → Mock（无 key 也能跑通） */
  modelConfigId: z.string().optional(),
  /** 自定义 prompt；缺省由「标签名，描述」组装 */
  prompt: z.string().optional(),
});

const SetCanonicalBodySchema = z.object({
  assetId: z.string().min(1),
});

export interface DesignRoutesOptions {
  db: PrismaClient;
  enqueue: EnqueueFn;
}

export const designRoutes: FastifyPluginAsync<DesignRoutesOptions> = async (app, { db, enqueue }) => {
  // 候选设计图列表（含资产实体，新的在前）
  app.get('/api/tags/:id/designs', async (req) => {
    const { id } = req.params as { id: string };
    return listDesigns(db, id);
  });

  // AI 生成一张候选设计图：入队 GENERATE_IMAGE，由 generation 模块的执行器消费。
  // inputPayload.kind = 'design' 是跨模块契约（generation 按 kind 分派），不可更改。
  app.post('/api/tags/:id/designs/generate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = GenerateDesignBodySchema.parse(req.body ?? {});
    const tag = await db.tag.findUnique({ where: { id } });
    if (!tag) throw notFound('标签');
    const prompt = buildDesignPrompt(tag, body.prompt);
    const job = await enqueue({
      projectId: tag.projectId,
      type: 'GENERATE_IMAGE',
      executor: 'API',
      inputPayload: {
        kind: 'design',
        tagId: tag.id,
        prompt,
        ...(body.modelConfigId ? { modelConfigId: body.modelConfigId } : {}),
      },
    });
    reply.code(202);
    return job;
  });

  // 上传候选设计图：落盘 → IMAGE+UPLOADED 资产 → TagDesign 关联（首张自动 canonical）
  app.post('/api/tags/:id/designs/upload', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tag = await db.tag.findUnique({ where: { id } });
    if (!tag) throw notFound('标签');

    const file = await req.file();
    if (!file) throw badRequest('缺少上传文件');
    if (!file.mimetype.startsWith('image/')) {
      throw badRequest(`设计图仅支持图片文件（收到 ${file.mimetype}）`);
    }
    const buf = await file.toBuffer();
    const saved = saveBuffer(tag.projectId, extFrom(file.filename, file.mimetype), buf);

    const asset = await createAsset(db, {
      projectId: tag.projectId,
      type: 'IMAGE',
      source: 'UPLOADED',
      uri: saved.uri,
      mime: file.mimetype,
      sizeBytes: saved.sizeBytes,
      meta: { originalName: file.filename, tagId: tag.id },
    });
    const { design } = await attachDesign(db, tag.id, asset.id);
    return reply.code(201).send({ design, asset });
  });

  // 设为默认参考图（asset 必须已在候选列表中）
  app.post('/api/tags/:id/canonical', async (req) => {
    const { id } = req.params as { id: string };
    const body = SetCanonicalBodySchema.parse(req.body ?? {});
    return setCanonical(db, id, body.assetId);
  });

  // 解除候选关联（资产不动；恰是 canonical 则清空指针）
  app.delete('/api/designs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const tag = await removeDesign(db, id);
    return { ok: true, tag };
  });
};

/** 扩展名优先取原文件名，无扩展名时回退 mime 子类型 */
function extFrom(filename: string | undefined, mime: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename ?? '');
  if (m) return m[1].toLowerCase();
  const sub = mime.split('/')[1];
  return sub || 'bin';
}
