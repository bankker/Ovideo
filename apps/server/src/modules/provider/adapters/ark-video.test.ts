import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { arkVideoGenerate, mapSeedanceDurationS } from './ark-video.js';

const cfg = { baseUrl: 'https://ark.example/api/v3', apiKey: 'test-key', model: 'doubao-seedance-1-0-pro' };

afterEach(() => vi.unstubAllGlobals());

const tmpOut = () => path.join(os.tmpdir(), `ark-video-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);

describe('mapSeedanceDurationS', () => {
  it('≤7s 映射 5s，其余映射 10s', () => {
    expect(mapSeedanceDurationS(4000)).toBe(5);
    expect(mapSeedanceDurationS(7000)).toBe(5);
    expect(mapSeedanceDurationS(7100)).toBe(10);
    expect(mapSeedanceDurationS(15000)).toBe(10);
  });
});

describe('arkVideoGenerate', () => {
  it('创建任务 → 轮询至 succeeded → 下载产物；首帧以 base64 data URL 上送', async () => {
    const framePath = path.join(os.tmpdir(), `frame-${Date.now()}.png`);
    fs.writeFileSync(framePath, Buffer.from('fakepng'));
    const outPath = tmpOut();

    let createBody: Record<string, unknown> | null = null;
    let pollCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/contents/generations/tasks') && init?.method === 'POST') {
          createBody = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ id: 'cgt-123' }), { status: 200 });
        }
        if (u.endsWith('/tasks/cgt-123')) {
          pollCount += 1;
          return new Response(
            JSON.stringify(
              pollCount < 2
                ? { status: 'running' }
                : { status: 'succeeded', content: { video_url: 'https://cdn.example/video.mp4' } },
            ),
            { status: 200 },
          );
        }
        if (u === 'https://cdn.example/video.mp4') {
          return new Response(Buffer.from('fakevideo'), { status: 200 });
        }
        throw new Error(`意外请求：${u}`);
      }),
    );

    const progress: number[] = [];
    await arkVideoGenerate(cfg, {
      prompt: '镜头缓推',
      firstFramePath: framePath,
      durationMs: 12000,
      outPath,
      pollIntervalMs: 5,
      onProgress: (p) => {
        progress.push(p);
      },
    });

    expect(fs.readFileSync(outPath).toString()).toBe('fakevideo');
    const body = createBody!;
    expect(body.model).toBe(cfg.model);
    const content = body.content as Array<Record<string, unknown>>;
    expect((content[0].text as string)).toContain('--duration 10'); // 12s → 10s 档
    expect((content[0].text as string)).toContain('--resolution 720p');
    const img = content[1].image_url as { url: string };
    expect(img.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(content[1].role).toBe('first_frame');
    expect(progress.length).toBeGreaterThan(0);
    fs.rmSync(framePath);
    fs.rmSync(outPath);
  });

  it('任务 failed → 抛出带服务端错误信息的中文错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).endsWith('/contents/generations/tasks') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'cgt-bad' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ status: 'failed', error: { message: '内容审核未通过' } }),
          { status: 200 },
        );
      }),
    );
    await expect(
      arkVideoGenerate(cfg, { prompt: 'x', firstFramePath: null, durationMs: 5000, outPath: tmpOut(), pollIntervalMs: 5 }),
    ).rejects.toThrow(/视频生成失败：内容审核未通过/);
  });

  it('创建任务 404（模型未开通）→ 错误带响应片段', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'InvalidEndpointOrModel.NotFound' } }), { status: 404 })),
    );
    await expect(
      arkVideoGenerate(cfg, { prompt: 'x', firstFramePath: null, durationMs: 5000, outPath: tmpOut(), pollIntervalMs: 5 }),
    ).rejects.toThrow(/视频任务创建失败：HTTP 404/);
  });

  it('总超时 → 抛超时错误并附任务 id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).endsWith('/contents/generations/tasks') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'cgt-slow' }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: 'running' }), { status: 200 });
      }),
    );
    await expect(
      arkVideoGenerate(cfg, {
        prompt: 'x',
        firstFramePath: null,
        durationMs: 5000,
        outPath: tmpOut(),
        pollIntervalMs: 5,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/视频生成超时/);
  });
});
