import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatComplete } from './openai-compatible.js';
import type { ChatMessage } from './types.js';

const cfg = { baseUrl: 'https://llm.example.com/v1/', apiKey: 'sk-test-key', model: 'gpt-x' };
const messages: ChatMessage[] = [{ role: 'user', content: 'ping' }];

function okResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chatComplete', () => {
  it('成功：POST 到去尾斜杠的 /chat/completions，带 Bearer 头，返回 content', async () => {
    const fetchMock = vi.fn(async () => okResponse('pong'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatComplete(cfg, messages);
    expect(result).toBe('pong');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test-key');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-x');
    expect(body.messages).toEqual(messages);
    expect(body.response_format).toBeUndefined();
  });

  it('jsonMode：请求体带 response_format json_object', async () => {
    const fetchMock = vi.fn(async () => okResponse('{"a":1}'));
    vi.stubGlobal('fetch', fetchMock);

    await chatComplete(cfg, messages, { jsonMode: true });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('非 2xx：抛出含状态码与响应片段的错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream boom', { status: 502 })),
    );

    await expect(chatComplete(cfg, messages)).rejects.toThrow(/502/);
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream boom', { status: 502 })),
    );
    await expect(chatComplete(cfg, messages)).rejects.toThrow(/upstream boom/);
  });

  it('结构异常：2xx 但缺 choices[0].message.content 时抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })),
    );
    await expect(chatComplete(cfg, messages)).rejects.toThrow(/结构异常/);
  });

  it('响应不是 JSON：抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    await expect(chatComplete(cfg, messages)).rejects.toThrow();
  });

  it('超时：timeoutMs 到期后以 TimeoutError 拒绝', async () => {
    // 模拟一个永不返回、但尊重 AbortSignal 的 fetch
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
          }),
      ),
    );

    // 超时被翻译为可行动的中文提示（含主机名与实际等待时长），不再裸抛 TimeoutError。
    // 措辞必须把超时与"连不上"区分开：从前统一劝人检查代理，会把排查方向带偏——
    // 握手明明成功了，该调的是超时上限或换个更快的模型。
    await expect(chatComplete(cfg, messages, { timeoutMs: 30 })).rejects.toThrow(
      /请求超时：llm\.example\.com 在 30 毫秒内没有返回完整响应。连接本身是通的/,
    );
  });
});
