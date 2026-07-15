import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { JobExecutorKind, JobType } from '@ovideo/shared';
import {
  CreateScriptDraftBodySchema,
  GenerateStoryboardBodySchema,
  UpdateScriptDraftBodySchema,
} from '@ovideo/shared';
import { notFound } from '../../lib/errors.js';
import { createDraft, listDrafts, updateDraft, type ScriptHooks } from './service.js';

/** 任务入队函数：由集成阶段注入 job 模块的 enqueueJob，保持模块解耦 */
export type EnqueueFn = (input: {
  projectId: string;
  type: JobType;
  executor: JobExecutorKind;
  inputPayload: Record<string, unknown>;
}) => Promise<unknown>;

export interface ScriptRoutesOptions {
  db: PrismaClient;
  enqueue: EnqueueFn;
  hooks?: ScriptHooks;
}

export const scriptRoutes: FastifyPluginAsync<ScriptRoutesOptions> = async (app, opts) => {
  const { db, enqueue, hooks } = opts;

  app.get('/api/episodes/:id/script-drafts', async (req) => {
    const { id } = req.params as { id: string };
    return listDrafts(db, id);
  });

  app.post('/api/episodes/:id/script-drafts', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CreateScriptDraftBodySchema.parse(req.body ?? {});
    reply.code(201);
    return createDraft(db, id, body);
  });

  app.patch('/api/script-drafts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = UpdateScriptDraftBodySchema.parse(req.body ?? {});
    return updateDraft(db, id, body, hooks);
  });

  app.post('/api/script-drafts/:id/generate-storyboard', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = GenerateStoryboardBodySchema.parse(req.body ?? {});
    const draft = await db.scriptDraft.findUnique({
      where: { id },
      include: { episode: true },
    });
    if (!draft) throw notFound('剧本稿');
    const job = await enqueue({
      projectId: draft.episode.projectId,
      type: 'GENERATE_STORYBOARD',
      // 指定了模型 → 走真实 API；未指定 → Mock 执行器（无 key 也能全流程跑通）
      executor: body.modelConfigId ? 'API' : 'MOCK',
      inputPayload: {
        scriptDraftId: draft.id,
        ...(body.modelConfigId ? { modelConfigId: body.modelConfigId } : {}),
      },
    });
    reply.code(202);
    return job;
  });
};
