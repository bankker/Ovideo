import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const TEMPLATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../prisma/test-template.db',
);

export interface TestDb {
  db: PrismaClient;
  cleanup(): Promise<void>;
}

/**
 * 每个测试文件调用：复制模板库到临时文件并返回独立 PrismaClient。
 * 模板库由 vitest globalSetup（global-setup.ts）在测试启动前生成。
 */
export async function createTestDb(): Promise<TestDb> {
  const tmpPath = path.join(os.tmpdir(), `ovideo-test-${crypto.randomUUID()}.db`);
  fs.copyFileSync(TEMPLATE, tmpPath);
  const db = new PrismaClient({ datasourceUrl: `file:${tmpPath.replace(/\\/g, '/')}` });
  return {
    db,
    async cleanup() {
      await db.$disconnect();
      try {
        fs.rmSync(tmpPath);
      } catch {
        /* Windows 句柄释放延迟，忽略 */
      }
    },
  };
}
