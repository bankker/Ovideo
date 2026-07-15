import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, type TestDb } from '../../../test/testdb.js';
import { STORAGE_ROOT, uriToAbsPath } from '../../../lib/storage.js';
import { enqueueJob, claimNextJob } from '../service.js';
import { getExecutor, clearExecutors } from '../registry.js';
import { registerMockMediaExecutors } from './mock-media.js';

let t: TestDb;
let db: PrismaClient;
let projectId: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const project = await db.project.create({ data: { name: 'Mock 媒体执行器测试' } });
  projectId = project.id;
  clearExecutors();
  registerMockMediaExecutors();
});

afterAll(async () => {
  await t.cleanup();
  // 清掉测试产生的占位文件目录
  fs.rmSync(path.join(STORAGE_ROOT, projectId), { recursive: true, force: true });
});

describe('registerMockMediaExecutors', () => {
  it('注册了三个生成类型的执行器', () => {
    expect(getExecutor('GENERATE_IMAGE')).toBeTypeOf('function');
    expect(getExecutor('GENERATE_VIDEO')).toBeTypeOf('function');
    expect(getExecutor('GENERATE_TTS')).toBeTypeOf('function');
  });

  it('GENERATE_IMAGE：FFmpeg 产真实占位图，Asset 落库且文件存在', async () => {
    await enqueueJob(db, {
      projectId,
      type: 'GENERATE_IMAGE',
      inputPayload: { color: 'tomato' },
    });
    const job = await claimNextJob(db);
    expect(job).not.toBeNull();

    const progress: number[] = [];
    const exec = getExecutor('GENERATE_IMAGE')!;
    const result = await exec({
      db,
      job: job!,
      updateProgress: async (p) => {
        progress.push(p);
      },
    });

    expect(result.outputAssetIds).toHaveLength(1);
    expect(progress.length).toBeGreaterThan(0);

    const asset = await db.asset.findUnique({ where: { id: result.outputAssetIds![0]! } });
    expect(asset).not.toBeNull();
    expect(asset?.type).toBe('IMAGE');
    expect(asset?.source).toBe('GENERATED');
    expect(asset?.jobId).toBe(job!.id);
    expect(asset?.projectId).toBe(projectId);
    expect(asset?.sizeBytes).toBeGreaterThan(0);

    const absPath = uriToAbsPath(asset!.uri);
    expect(fs.existsSync(absPath)).toBe(true);
    expect(fs.statSync(absPath).size).toBeGreaterThan(0);
  }, 30000);
});
