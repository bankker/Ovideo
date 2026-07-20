import type { PrismaClient, Project } from '@prisma/client';
import { notFound } from '../../lib/errors.js';

export async function listProjects(db: PrismaClient, archived?: boolean): Promise<Project[]> {
  return db.project.findMany({
    where: archived === undefined ? {} : { archived },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function createProject(
  db: PrismaClient,
  input: { name: string; description: string },
): Promise<Project> {
  return db.project.create({ data: input });
}

export async function getProject(db: PrismaClient, id: string): Promise<Project> {
  const project = await db.project.findUnique({ where: { id } });
  if (!project) throw notFound('项目');
  return project;
}

export async function updateProject(
  db: PrismaClient,
  id: string,
  input: { name?: string; description?: string; stylePrompt?: string; aspectRatio?: string; archived?: boolean },
): Promise<Project> {
  await getProject(db, id);
  return db.project.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.stylePrompt !== undefined && { stylePrompt: input.stylePrompt }),
      ...(input.aspectRatio !== undefined && { aspectRatio: input.aspectRatio }),
      ...(input.archived !== undefined && { archived: input.archived }),
    },
  });
}

/** 直接删除，子实体（分集/标签/资产/任务…）由 Prisma onDelete: Cascade 级联清理 */
export async function deleteProject(db: PrismaClient, id: string): Promise<void> {
  await getProject(db, id);
  await db.project.delete({ where: { id } });
}
