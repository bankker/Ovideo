import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { CreateTagBodySchema, UpdateTagBodySchema } from '@ovideo/shared';
import { notFound } from '../../lib/errors.js';
import { createTag, listTags, updateTag } from './service.js';
import { mergeTags } from './merge.js';
import { findDuplicateTagGroups, type TextGenFn } from './duplicates.js';

const MergeBodySchema = z.object({ targetTagId: z.string().min(1) });

export interface TagRoutesOptions {
  db: PrismaClient;
  /** 重复标签语义判重用的文本生成（集成阶段注入；缺省走启发式兜底） */
  dedupTextGen?: TextGenFn;
}

export const tagRoutes: FastifyPluginAsync<TagRoutesOptions> = async (app, { db, dedupTextGen }) => {
  /** 合并标签：source(:id) 的全部引用重指到 targetTagId，源标签删除 */
  app.post('/api/tags/:id/merge', async (req) => {
    const { id } = req.params as { id: string };
    const { targetTagId } = MergeBodySchema.parse(req.body);
    return mergeTags(db, id, targetTagId);
  });

  /** 疑似重复标签检测（「同一办公室」vs「办公室」这类拆裂提前抓出来） */
  app.get('/api/projects/:id/tag-duplicates', async (req) => {
    const { id } = req.params as { id: string };
    const project = await db.project.findUnique({ where: { id } });
    if (!project) throw notFound('项目');
    return findDuplicateTagGroups(db, id, dedupTextGen ?? null);
  });

  app.get('/api/projects/:id/tags', async (req) => {
    const { id } = req.params as { id: string };
    const project = await db.project.findUnique({ where: { id } });
    if (!project) throw notFound('项目');
    return listTags(db, id);
  });

  app.post('/api/projects/:id/tags', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CreateTagBodySchema.parse(req.body);
    const project = await db.project.findUnique({ where: { id } });
    if (!project) throw notFound('项目');
    reply.code(201);
    return createTag(db, id, body);
  });

  app.patch('/api/tags/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = UpdateTagBodySchema.parse(req.body ?? {});
    return updateTag(db, id, body);
  });
};
