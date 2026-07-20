import type { ChatMessage } from './types.js';

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ChatCompleteOptions {
  /** 要求模型输出 JSON（OpenAI response_format: json_object） */
  jsonMode?: boolean;
  timeoutMs?: number;
}

/**
 * OpenAI 兼容 /chat/completions 调用。
 * 非 2xx 或响应结构异常时抛错，错误信息带状态码与响应片段（截断，避免日志爆炸）。
 */
export async function chatComplete(
  cfg: OpenAiCompatibleConfig,
  messages: ChatMessage[],
  opts?: ChatCompleteOptions,
): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const payload: Record<string, unknown> = { model: cfg.model, messages };
  if (opts?.jsonMode) payload.response_format = { type: 'json_object' };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 60000),
    });
  } catch (err) {
    // undici 的 'fetch failed' 对用户无信息量，翻译为可行动的中文提示
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return cfg.baseUrl;
      }
    })();
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    const timeoutMs = opts?.timeoutMs ?? 60000;
    // 不足 1 秒的上限（测试里会用）四舍五入成 "0 秒" 就成了废话，改用毫秒表述
    const waited = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`;
    throw new Error(
      isTimeout
        ? // 超时 ≠ 连不上：TCP 握手成功、请求也发出去了，只是模型在限定时间内没答完。
          // 从前这里也劝人"检查代理"，于是排查方向被带偏——真正该调的是超时上限或换个模型。
          `请求超时：${host} 在 ${waited}内没有返回完整响应。` +
          `连接本身是通的，通常是这次生成的输出太长或模型太慢，而不是网络问题。`
        : `网络不可达：无法连接 ${host}（国内直连国外服务通常需要代理，或检查网络）`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LLM 请求失败：HTTP ${res.status}，响应：${text.slice(0, 300)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`LLM 响应结构异常（非 JSON）：${text.slice(0, 300)}`);
  }
  const content = (parsed as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
    ?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(`LLM 响应结构异常（缺 choices[0].message.content）：${text.slice(0, 300)}`);
  }
  return content;
}
