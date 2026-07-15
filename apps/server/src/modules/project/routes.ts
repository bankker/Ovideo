import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { CreateProjectBodySchema, UpdateProjectBodySchema } from '@ovideo/shared';
import {
  listProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
} from './service.js';

export interface ProjectRoutesOptions {
  db: PrismaClient;
}

export const projectRoutes: FastifyPluginAsync<ProjectRoutesOptions> = async (app, { db }) => {
  app.get('/api/projects', async (req) => {
    const { archived } = req.query as { archived?: string };
    // archived=true / archived=false 过滤；缺省返回全部
    const filter = archived === 'true' ? true : archived === 'false' ? false : undefined;
    return listProjects(db, filter);
  });

  app.post('/api/projects', async (req, reply) => {
    const body = CreateProjectBodySchema.parse(req.body);
    reply.code(201);
    return createProject(db, body);
  });

  app.get('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getProject(db, id);
  });

  app.patch('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = UpdateProjectBodySchema.parse(req.body ?? {});
    return updateProject(db, id, body);
  });

  app.delete('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    await deleteProject(db, id);
    return { ok: true };
  });
};
