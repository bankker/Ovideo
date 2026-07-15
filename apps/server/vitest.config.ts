import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globalSetup: ['./src/test/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // 各测试文件用独立 SQLite 临时库（见 src/test/testdb.ts），可安全并行
    pool: 'threads',
  },
});
