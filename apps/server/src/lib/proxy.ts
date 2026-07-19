/**
 * 出站代理接线：让服务端进程的全局 fetch 遵循 HTTP_PROXY / HTTPS_PROXY / NO_PROXY。
 *
 * 【为什么需要】Node 的全局 fetch（undici）默认**忽略**代理环境变量。因此在「直连厂商
 * 不通、只能走本地代理」的机器上，所有模型调用（openai-compatible / openai-image /
 * ark-video / dashscope-tts / vision-judge）都会以「网络不可达」失败。
 *
 * 【为什么不用 NODE_USE_ENV_PROXY=1】实测（Node v24.15.0）该开关必须在**进程启动前**
 * 就位：在 index.ts 顶部写 `process.env.NODE_USE_ENV_PROXY = '1'` 时 undici 早已完成
 * 初始化，代理不生效。要让它生效就得改启动脚本注入环境变量，而本项目在 Windows 上开发，
 * `FOO=1 cmd` 语法在 cmd 下不通用，得额外引入 cross-env，且 `pnpm dev` / `pnpm start`
 * 两条路径都要各自维护。改用 undici 的 setGlobalDispatcher 则完全在进程内完成，
 * 两条启动路径共用同一段代码，且能读到 dotenv 从 .env 里加载的变量。
 *
 * 【不破坏无代理环境】未配置任何代理变量时不安装任何 dispatcher，保持 Node 默认直连。
 */
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';

/** 解析结果：按目标协议分别给出代理地址，并带上「来自哪个环境变量」用于启动日志 */
export interface ProxySettings {
  /** http:// 目标使用的代理，未配置为 null */
  httpProxy: string | null;
  /** https:// 目标使用的代理，未配置为 null */
  httpsProxy: string | null;
  /** httpProxy 来自哪个环境变量名 */
  httpProxySource: string | null;
  /** httpsProxy 来自哪个环境变量名 */
  httpProxySourceForHttps: string | null;
  /** NO_PROXY 规则（已规范化：小写、去空、去空白） */
  noProxy: string[];
  /** noProxy 来自哪个环境变量名 */
  noProxySource: string | null;
}

export type EnvLike = Record<string, string | undefined>;

/**
 * 取第一个「非空白」的环境变量，并返回其变量名。
 * 小写优先于大写：与 curl / undici EnvHttpProxyAgent 的既有约定一致。
 */
function pickEnv(env: EnvLike, names: readonly string[]): { value: string; source: string } | null {
  for (const name of names) {
    const raw = env[name];
    if (typeof raw === 'string' && raw.trim() !== '') {
      return { value: raw.trim(), source: name };
    }
  }
  return null;
}

/**
 * 补全裸地址的协议：`127.0.0.1:7890` → `http://127.0.0.1:7890`。
 * 返回 null 表示这个值根本不是个能用的 URL（脏配置不应让整个服务起不来）。
 */
function normalizeProxyUrl(value: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 解析 NO_PROXY：逗号或空白分隔，小写化，丢掉空项 */
function parseNoProxy(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

/**
 * 从环境变量解析出站代理配置。纯函数，便于单测。
 *
 * 优先级：https_proxy > HTTPS_PROXY > http_proxy > HTTP_PROXY（用于 https 目标）。
 * 只配了 HTTP_PROXY 的机器很常见（Windows 尤其），此时 https 目标回落到它，
 * 否则「配了代理却依然连不上厂商」会非常反直觉。
 */
export function resolveProxySettings(env: EnvLike): ProxySettings {
  const http = pickEnv(env, ['http_proxy', 'HTTP_PROXY']);
  const https = pickEnv(env, ['https_proxy', 'HTTPS_PROXY']) ?? http;
  const noProxy = pickEnv(env, ['no_proxy', 'NO_PROXY']);

  const httpUrl = http ? normalizeProxyUrl(http.value) : null;
  const httpsUrl = https ? normalizeProxyUrl(https.value) : null;

  return {
    httpProxy: httpUrl,
    httpsProxy: httpsUrl,
    httpProxySource: httpUrl ? (http?.source ?? null) : null,
    httpProxySourceForHttps: httpsUrl ? (https?.source ?? null) : null,
    noProxy: noProxy ? parseNoProxy(noProxy.value) : [],
    noProxySource: noProxy ? noProxy.source : null,
  };
}

/** 去掉 IPv6 字面量的方括号：`[::1]` → `::1` */
function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** 目标 URL 的实际端口（URL.port 在默认端口时是空串） */
function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

/**
 * 判断某个目标是否应当**绕过**代理。
 *
 * 支持的 NO_PROXY 写法：
 * - `*`                  —— 全部绕过
 * - `localhost`          —— 精确匹配主机名
 * - `.local` / `local`   —— 后缀匹配（`a.local` 命中；带前导点时不匹配裸 `local`）
 * - `127.0.0.1`、`::1`   —— IP 字面量（目标写作 `[::1]` 也能命中）
 * - `example.com:8080`   —— 带端口，仅该端口绕过
 *
 * 【为什么必须有】前端调后端、worker 调自身走的都是 localhost / 127.0.0.1，
 * 把它们塞进代理会直接打断本地回环。
 */
export function shouldBypassProxy(target: string | URL, noProxy: readonly string[]): boolean {
  let url: URL;
  try {
    url = typeof target === 'string' ? new URL(target) : target;
  } catch {
    return false;
  }
  const host = stripBrackets(url.hostname).toLowerCase();
  if (host === '') return false;
  const port = effectivePort(url);

  for (const raw of noProxy) {
    const entry = raw.toLowerCase();
    if (entry === '*') return true;

    // 拆出可选的 :port 后缀。注意别把 IPv6 字面量（含多个冒号）里的冒号当端口分隔符。
    let pattern = entry;
    let wantPort: string | null = null;
    const colon = entry.lastIndexOf(':');
    if (colon > 0 && !entry.includes('::') && /^\d+$/.test(entry.slice(colon + 1))) {
      pattern = entry.slice(0, colon);
      wantPort = entry.slice(colon + 1);
    }
    pattern = stripBrackets(pattern);
    if (pattern === '') continue;
    if (wantPort !== null && wantPort !== port) continue;

    if (pattern.startsWith('.')) {
      // 前导点 = 纯后缀匹配：`.local` 命中 `a.local`，但不命中裸 `local`
      if (host.endsWith(pattern)) return true;
    } else if (host === pattern || host.endsWith(`.${pattern}`)) {
      return true;
    }
  }
  return false;
}

/**
 * 按目标 origin 在「代理」与「直连」之间路由的 dispatcher。
 *
 * 这里只做**选路**，HTTP 本身仍交给 undici 的 ProxyAgent / Agent，
 * 不自行实现任何协议细节。
 */
class ProxyRoutingDispatcher extends Dispatcher {
  readonly #direct = new Agent();
  readonly #agents = new Map<string, ProxyAgent>();
  readonly #settings: ProxySettings;

  constructor(settings: ProxySettings) {
    super();
    this.#settings = settings;
  }

  #agentFor(origin: string | URL | undefined): Dispatcher {
    if (!origin) return this.#direct;
    let url: URL;
    try {
      url = typeof origin === 'string' ? new URL(origin) : origin;
    } catch {
      return this.#direct;
    }
    if (shouldBypassProxy(url, this.#settings.noProxy)) return this.#direct;

    const proxyUrl = url.protocol === 'https:' ? this.#settings.httpsProxy : this.#settings.httpProxy;
    if (!proxyUrl) return this.#direct;

    let agent = this.#agents.get(proxyUrl);
    if (!agent) {
      agent = new ProxyAgent(proxyUrl);
      this.#agents.set(proxyUrl, agent);
    }
    return agent;
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return this.#agentFor(opts.origin).dispatch(opts, handler);
  }

  /** 关闭所有下游 agent。重载签名与 undici Dispatcher 保持一致（含 callback 形式） */
  close(): Promise<void>;
  close(callback: () => void): void;
  close(callback?: () => void): Promise<void> | void {
    const all = Promise.all([
      this.#direct.close(),
      ...[...this.#agents.values()].map((a) => a.close()),
    ]).then(() => undefined);
    if (callback) {
      all.then(callback, callback);
      return;
    }
    return all;
  }

  destroy(): Promise<void>;
  destroy(err: Error | null): Promise<void>;
  destroy(callback: () => void): void;
  destroy(err: Error | null, callback: () => void): void;
  destroy(
    errOrCallback?: Error | null | (() => void),
    maybeCallback?: () => void,
  ): Promise<void> | void {
    const err = typeof errOrCallback === 'function' ? null : (errOrCallback ?? null);
    const callback = typeof errOrCallback === 'function' ? errOrCallback : maybeCallback;
    const all = Promise.all([
      this.#direct.destroy(err),
      ...[...this.#agents.values()].map((a) => a.destroy(err)),
    ]).then(() => undefined);
    if (callback) {
      all.then(callback, callback);
      return;
    }
    return all;
  }
}

/** 日志里隐去代理地址中的账号密码，避免把凭据写进控制台 */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '';
    }
    // URL.toString() 会给无路径的地址补一个尾部 '/'，日志里去掉更像用户写的原值
    return url.toString().replace(/\/$/, '');
  } catch {
    return proxyUrl;
  }
}

/** 组装启动时那一行中文日志（纯函数，便于单测） */
export function describeProxySettings(settings: ProxySettings): string {
  const { httpProxy, httpsProxy, httpProxySource, httpProxySourceForHttps } = settings;
  if (!httpProxy && !httpsProxy) return '[ovideo-server] 出站代理：未配置（直连）';

  const parts: string[] = [];
  if (httpsProxy && httpProxy && httpsProxy === httpProxy) {
    parts.push(`${redactProxyUrl(httpsProxy)}（来自 ${httpProxySourceForHttps ?? httpProxySource}）`);
  } else {
    if (httpsProxy) parts.push(`https → ${redactProxyUrl(httpsProxy)}（来自 ${httpProxySourceForHttps}）`);
    if (httpProxy) parts.push(`http → ${redactProxyUrl(httpProxy)}（来自 ${httpProxySource}）`);
  }
  let line = `[ovideo-server] 出站代理：${parts.join('，')}`;
  if (settings.noProxy.length > 0) {
    line += `；不走代理（${settings.noProxySource}）：${settings.noProxy.join(', ')}`;
  } else {
    line += '；未设置 NO_PROXY —— 建议至少加上 localhost,127.0.0.1';
  }
  return line;
}

export interface InstallOutboundProxyOptions {
  env?: EnvLike;
  log?: (message: string) => void;
}

/**
 * 安装全局出站代理策略，并打印一行中文说明。
 * 必须在任何 fetch 之前调用（见 index.ts）。
 *
 * @returns 实际生效的配置；未配置代理时返回的 settings 里两个 proxy 均为 null 且不安装 dispatcher。
 */
export function installOutboundProxy(opts: InstallOutboundProxyOptions = {}): ProxySettings {
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const settings = resolveProxySettings(env);

  // 没配代理就什么都不做：保持 Node 默认直连，绝不因为引入代理支持而改变无代理环境的行为
  if (settings.httpProxy || settings.httpsProxy) {
    setGlobalDispatcher(new ProxyRoutingDispatcher(settings));
  }
  log(describeProxySettings(settings));
  return settings;
}
