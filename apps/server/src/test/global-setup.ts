import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本次 vitest 运行专属的模板库路径（按 PID 隔离，允许多个 vitest 进程并行互不干扰） */
export function templateDbPath(): string {
  return path.join(os.tmpdir(), `ovideo-test-template-${process.pid}.db`);
}

/**
 * vitest 全局钩子：跑测试前生成一次干净的模板库，各测试文件各自复制使用。
 * 用 migrate deploy（应用已提交迁移）而非 db push --force-reset：
 * 前者是生产安全命令；重置语义靠"先删文件"实现（路径 PID 唯一，防 PID 复用残留）。
 */
export default function setup() {
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dbPath = templateDbPath();
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  const url = `file:${dbPath.replace(/\\/g, '/')}`;
  execSync('pnpm exec prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
