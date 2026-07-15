import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** vitest 全局钩子：跑测试前生成一次干净的模板库，各测试文件各自复制使用 */
export default function setup() {
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  execSync('pnpm exec prisma db push --skip-generate --force-reset', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: 'file:./test-template.db' },
    stdio: 'pipe',
  });
}
