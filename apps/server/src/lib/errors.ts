import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const notFound = (what: string) => new AppError(404, `${what} 不存在`);
export const badRequest = (msg: string) => new AppError(400, msg);
export const conflict = (msg: string) => new AppError(409, msg);

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: '参数校验失败', issues: err.issues });
    }
    app.log.error(err);
    const message = err instanceof Error ? err.message : '服务器内部错误';
    return reply.status(500).send({ error: message });
  });
}
