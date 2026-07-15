import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** apps/server/storage —— 本地存储根（生产换 OSS 时替换本模块实现即可） */
export const STORAGE_ROOT = path.resolve(__dirname, '../../storage');

export interface SavedFile {
  uri: string;
  absPath: string;
  sizeBytes: number;
}

/** 保存 Buffer，返回可被 @fastify/static 以 /storage/ 前缀服务的 uri */
export function saveBuffer(projectId: string, ext: string, buf: Buffer): SavedFile {
  const dir = path.join(STORAGE_ROOT, projectId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomUUID()}.${ext.replace(/^\./, '')}`;
  const absPath = path.join(dir, name);
  fs.writeFileSync(absPath, buf);
  return { uri: `/storage/${projectId}/${name}`, absPath, sizeBytes: buf.length };
}

/** 为生成类任务预分配输出文件路径（FFmpeg/适配器直接写盘，避免中转 Buffer） */
export function allocFilePath(projectId: string, ext: string): SavedFile {
  const dir = path.join(STORAGE_ROOT, projectId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomUUID()}.${ext.replace(/^\./, '')}`;
  const absPath = path.join(dir, name);
  return { uri: `/storage/${projectId}/${name}`, absPath, sizeBytes: 0 };
}

export function uriToAbsPath(uri: string): string {
  const rel = uri.replace(/^\/storage\//, '');
  return path.join(STORAGE_ROOT, rel);
}

export function fileSize(absPath: string): number {
  try {
    return fs.statSync(absPath).size;
  } catch {
    return 0;
  }
}
