import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { MAX_REF_IMAGES, parseVerdict, visionJudge } from './vision-judge.js';

const cfg = { baseUrl: 'https://ark.example.com/v3/', apiKey: 'sk-vision', modelKey: 'doubao-vision' };

let tmpDir: string;
const files: string[] = [];

/** 造一个内容可辨识的假 PNG（适配器只做 base64 编码，不解析像素） */
function makeImage(name: string, body: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, body);
  files.push(p);
  return p;
}

beforeAll(() => {
  tmpDir = path.join(os.tmpdir(), `ovideo-vision-${crypto.randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄释放延迟，忽略 */
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const goodJson = '{"identityMatch":88,"promptMatch":80,"issues":[],"verdict":"pass"}';

describe('visionJudge 请求体', () => {
  it('待评审图与参考图都以 data URL 进入 content 数组，待评审图在最前', async () => {
    const img = makeImage('shot.png', 'KEYFRAME_BYTES');
    const ref = makeImage('monkey.png', 'REF_BYTES');
    const fetchMock = vi.fn(async () => okResponse(goodJson));
    vi.stubGlobal('fetch', fetchMock);

    await visionJudge(cfg, { imagePath: img, refImagePaths: [ref], prompt: '小猴子在树上', modelCfg: cfg });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ark.example.com/v3/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-vision');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('doubao-vision');
    expect(body.response_format).toEqual({ type: 'json_object' });

    const content = body.messages[0].content as Array<Record<string, any>>;
    expect(content[0].type).toBe('text');
    // 评审提示词里必须带上本轮生图提示词，模型才能判 promptMatch
    expect(content[0].text).toContain('小猴子在树上');

    const images = content.filter((c) => c.type === 'image_url');
    expect(images).toHaveLength(2);
    // 顺序即编号约定：第 1 张待评审，其后为参考图
    expect(images[0].image_url.url).toBe(
      `data:image/png;base64,${Buffer.from('KEYFRAME_BYTES').toString('base64')}`,
    );
    expect(images[1].image_url.url).toBe(
      `data:image/png;base64,${Buffer.from('REF_BYTES').toString('base64')}`,
    );
  });

  it(`参考图最多取 ${MAX_REF_IMAGES} 张（控制 token）`, async () => {
    const img = makeImage('shot2.png', 'X');
    const refs = [1, 2, 3, 4, 5].map((i) => makeImage(`ref${i}.png`, `R${i}`));
    const fetchMock = vi.fn(async () => okResponse(goodJson));
    vi.stubGlobal('fetch', fetchMock);

    await visionJudge(cfg, { imagePath: img, refImagePaths: refs, prompt: 'p', modelCfg: cfg });

    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    const images = (body.messages[0].content as Array<Record<string, any>>).filter(
      (c) => c.type === 'image_url',
    );
    // 1 张待评审 + 最多 3 张参考
    expect(images).toHaveLength(MAX_REF_IMAGES + 1);
  });

  it('评审提示词点名"动物/机器人画成人类"的失败模式', async () => {
    const img = makeImage('shot3.png', 'X');
    const fetchMock = vi.fn(async () => okResponse(goodJson));
    vi.stubGlobal('fetch', fetchMock);

    await visionJudge(cfg, { imagePath: img, refImagePaths: [], prompt: 'p', modelCfg: cfg });
    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    const text = (body.messages[0].content as Array<Record<string, any>>)[0].text as string;
    expect(text).toContain('人类');
    expect(text).toContain('fix_prompt');
  });
});

describe('visionJudge 响应解析', () => {
  it('解析被 ```json 代码块包裹的响应', async () => {
    const img = makeImage('shot4.png', 'X');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okResponse(
          '```json\n{"identityMatch":42,"promptMatch":90,"issues":["猴子被画成了人类"],"verdict":"retry"}\n```',
        ),
      ),
    );

    const verdict = await visionJudge(cfg, {
      imagePath: img,
      refImagePaths: [],
      prompt: 'p',
      modelCfg: cfg,
    });
    expect(verdict).toEqual({
      identityMatch: 42,
      promptMatch: 90,
      issues: ['猴子被画成了人类'],
      verdict: 'retry',
    });
  });

  it('响应不是 JSON：抛中文错误', async () => {
    const img = makeImage('shot5.png', 'X');
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('这张图看起来还不错')));
    await expect(
      visionJudge(cfg, { imagePath: img, refImagePaths: [], prompt: 'p', modelCfg: cfg }),
    ).rejects.toThrow(/视觉评审响应解析失败/);
  });

  it('非 2xx：抛出含状态码与响应片段的中文错误', async () => {
    const img = makeImage('shot6.png', 'X');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota exceeded', { status: 429 })));
    await expect(
      visionJudge(cfg, { imagePath: img, refImagePaths: [], prompt: 'p', modelCfg: cfg }),
    ).rejects.toThrow(/视觉评审请求失败：HTTP 429.*quota exceeded/);
  });

  it('网络不可达：翻译成带 host 的中文提示', async () => {
    const img = makeImage('shot7.png', 'X');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(
      visionJudge(cfg, { imagePath: img, refImagePaths: [], prompt: 'p', modelCfg: cfg }),
    ).rejects.toThrow(/网络不可达：无法连接 ark\.example\.com/);
  });

  it('超时：翻译成带 host 的中文提示', async () => {
    const img = makeImage('shot8.png', 'X');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
          }),
      ),
    );
    await expect(
      visionJudge(
        cfg,
        { imagePath: img, refImagePaths: [], prompt: 'p', modelCfg: cfg },
        { timeoutMs: 30 },
      ),
    ).rejects.toThrow(/视觉评审请求超时：ark\.example\.com/);
  });
});

describe('parseVerdict', () => {
  it('裸 JSON 与前后带解释文字的 JSON 都能解析', () => {
    expect(parseVerdict(goodJson).verdict).toBe('pass');
    expect(
      parseVerdict(`好的，我的判断是：${goodJson} 以上。`).identityMatch,
    ).toBe(88);
  });

  it('分数越界被夹到 0-100，浮点取整', () => {
    const v = parseVerdict('{"identityMatch":120,"promptMatch":-5,"issues":[],"verdict":"pass"}');
    expect(v.identityMatch).toBe(100);
    expect(v.promptMatch).toBe(0);
    expect(parseVerdict('{"identityMatch":77.6,"promptMatch":70,"issues":[],"verdict":"pass"}').identityMatch).toBe(78);
  });

  it('verdict 取值非法：抛中文错误', () => {
    expect(() =>
      parseVerdict('{"identityMatch":80,"promptMatch":80,"issues":[],"verdict":"maybe"}'),
    ).toThrow(/verdict 取值非法/);
  });

  it('分数字段缺失：抛中文错误', () => {
    expect(() => parseVerdict('{"promptMatch":80,"issues":[],"verdict":"pass"}')).toThrow(
      /identityMatch 不是数字/,
    );
  });

  it('issues 非数组时退化为空数组（不因次要字段整体失败）', () => {
    expect(parseVerdict('{"identityMatch":80,"promptMatch":80,"issues":"无","verdict":"pass"}').issues).toEqual([]);
  });
});
