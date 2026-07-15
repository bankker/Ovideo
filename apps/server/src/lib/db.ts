import { PrismaClient } from '@prisma/client';

/** 进程单例。服务代码一律通过依赖注入接收 PrismaClient（测试传入独立临时库）。 */
export const db = new PrismaClient();
