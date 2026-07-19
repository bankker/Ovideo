import { describe, it, expect } from 'vitest';
import {
  resolveProxySettings,
  shouldBypassProxy,
  describeProxySettings,
  redactProxyUrl,
  installOutboundProxy,
  type EnvLike,
} from './proxy.js';

/* 这些用例全部是纯函数断言：不发任何真实网络请求。 */

describe('resolveProxySettings：环境变量解析', () => {
  it('未配置任何代理变量时全为 null（保持直连）', () => {
    const s = resolveProxySettings({});
    expect(s.httpProxy).toBeNull();
    expect(s.httpsProxy).toBeNull();
    expect(s.noProxy).toEqual([]);
    expect(s.noProxySource).toBeNull();
  });

  it('识别大写 HTTP_PROXY / HTTPS_PROXY 并记录来源', () => {
    const s = resolveProxySettings({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    });
    expect(s.httpProxy).toBe('http://127.0.0.1:7890/');
    expect(s.httpsProxy).toBe('http://127.0.0.1:7890/');
    expect(s.httpProxySource).toBe('HTTP_PROXY');
    expect(s.httpProxySourceForHttps).toBe('HTTPS_PROXY');
  });

  it('识别小写 http_proxy / https_proxy', () => {
    const s = resolveProxySettings({
      http_proxy: 'http://10.0.0.1:8080',
      https_proxy: 'http://10.0.0.2:8080',
    });
    expect(s.httpProxy).toBe('http://10.0.0.1:8080/');
    expect(s.httpsProxy).toBe('http://10.0.0.2:8080/');
    expect(s.httpProxySource).toBe('http_proxy');
    expect(s.httpProxySourceForHttps).toBe('https_proxy');
  });

  it('大小写同时存在时小写优先（与 curl / undici 约定一致）', () => {
    const s = resolveProxySettings({
      http_proxy: 'http://lower:1111',
      HTTP_PROXY: 'http://upper:2222',
      no_proxy: 'lower.example',
      NO_PROXY: 'upper.example',
    });
    expect(s.httpProxy).toBe('http://lower:1111/');
    expect(s.httpProxySource).toBe('http_proxy');
    expect(s.noProxy).toEqual(['lower.example']);
    expect(s.noProxySource).toBe('no_proxy');
  });

  it('只配了 HTTP_PROXY 时 https 目标回落到它（Windows 上很常见的配法）', () => {
    const s = resolveProxySettings({ HTTP_PROXY: 'http://127.0.0.1:7890' });
    expect(s.httpsProxy).toBe('http://127.0.0.1:7890/');
    expect(s.httpProxySourceForHttps).toBe('HTTP_PROXY');
  });

  it('只配了 HTTPS_PROXY 时 http 目标不被代理（不做反向回落）', () => {
    const s = resolveProxySettings({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
    expect(s.httpsProxy).toBe('http://127.0.0.1:7890/');
    expect(s.httpProxy).toBeNull();
  });

  it('空串 / 纯空白视为未配置', () => {
    const s = resolveProxySettings({ HTTP_PROXY: '', HTTPS_PROXY: '   ' });
    expect(s.httpProxy).toBeNull();
    expect(s.httpsProxy).toBeNull();
  });

  it('裸 host:port 自动补 http:// 协议', () => {
    const s = resolveProxySettings({ HTTP_PROXY: '127.0.0.1:7890' });
    expect(s.httpProxy).toBe('http://127.0.0.1:7890/');
  });

  it('两侧空白被裁剪', () => {
    const s = resolveProxySettings({ HTTP_PROXY: '  http://127.0.0.1:7890  ' });
    expect(s.httpProxy).toBe('http://127.0.0.1:7890/');
  });

  it('无法解析的脏值降级为 null 而不是抛错（不能让服务起不来）', () => {
    const s = resolveProxySettings({ HTTP_PROXY: 'http://', HTTPS_PROXY: 'ftp://x:1' });
    expect(s.httpProxy).toBeNull();
    expect(s.httpsProxy).toBeNull();
  });

  it('NO_PROXY 按逗号切分、小写化、丢空项', () => {
    const s = resolveProxySettings({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost, 127.0.0.1 ,, ::1, .LOCAL ',
    });
    expect(s.noProxy).toEqual(['localhost', '127.0.0.1', '::1', '.local']);
  });
});

describe('shouldBypassProxy：NO_PROXY 绕过判定', () => {
  // 用户机器上的真实配置
  const REAL: readonly string[] = ['localhost', '127.0.0.1', '::1', '.local'];

  it('localhost 绕过代理（否则前端调后端会坏）', () => {
    expect(shouldBypassProxy('http://localhost:8787/api/health', REAL)).toBe(true);
  });

  it('127.0.0.1 任意端口绕过代理（worker 调自身）', () => {
    expect(shouldBypassProxy('http://127.0.0.1:8787/api/jobs', REAL)).toBe(true);
    expect(shouldBypassProxy('http://127.0.0.1:5173/', REAL)).toBe(true);
  });

  it('IPv6 回环 [::1] 绕过代理（方括号需被剥掉）', () => {
    expect(shouldBypassProxy('http://[::1]:8787/', REAL)).toBe(true);
  });

  it('.local 后缀匹配子域', () => {
    expect(shouldBypassProxy('http://nas.local/', REAL)).toBe(true);
    expect(shouldBypassProxy('http://a.b.local/', REAL)).toBe(true);
  });

  it('前导点规则不匹配裸标签本身', () => {
    expect(shouldBypassProxy('http://local/', ['.local'])).toBe(false);
  });

  it('不带前导点的条目同时匹配自身与子域', () => {
    expect(shouldBypassProxy('http://local/', ['local'])).toBe(true);
    expect(shouldBypassProxy('http://nas.local/', ['local'])).toBe(true);
  });

  it('厂商域名不被绕过 —— 必须真的走代理', () => {
    expect(shouldBypassProxy('https://ark.cn-beijing.volces.com/api/v3/models', REAL)).toBe(false);
    expect(shouldBypassProxy('https://dashscope.aliyuncs.com/api/v1/x', REAL)).toBe(false);
  });

  it('不做子串误判：localhost.evil.com 不应绕过', () => {
    expect(shouldBypassProxy('https://localhost.evil.com/', REAL)).toBe(false);
  });

  it('不做后缀误判：notlocalhost 不应绕过', () => {
    expect(shouldBypassProxy('http://notlocalhost/', REAL)).toBe(false);
  });

  it('主机名大小写不敏感', () => {
    expect(shouldBypassProxy('http://LOCALHOST:8787/', REAL)).toBe(true);
    expect(shouldBypassProxy('http://NAS.LOCAL/', REAL)).toBe(true);
  });

  it('条目自身大小写不敏感', () => {
    expect(shouldBypassProxy('http://localhost/', ['LOCALHOST'])).toBe(true);
  });

  it('* 表示全部绕过', () => {
    expect(shouldBypassProxy('https://ark.cn-beijing.volces.com/', ['*'])).toBe(true);
  });

  it('空 NO_PROXY 时谁都不绕过', () => {
    expect(shouldBypassProxy('http://localhost:8787/', [])).toBe(false);
  });

  it('带端口的条目只对该端口生效', () => {
    expect(shouldBypassProxy('http://example.com:8080/', ['example.com:8080'])).toBe(true);
    expect(shouldBypassProxy('http://example.com:9090/', ['example.com:8080'])).toBe(false);
  });

  it('带端口条目对默认端口按协议推断（http→80, https→443）', () => {
    expect(shouldBypassProxy('http://example.com/', ['example.com:80'])).toBe(true);
    expect(shouldBypassProxy('https://example.com/', ['example.com:443'])).toBe(true);
    expect(shouldBypassProxy('https://example.com/', ['example.com:80'])).toBe(false);
  });

  it('非法 URL 不抛错，按不绕过处理', () => {
    expect(shouldBypassProxy('not a url', REAL)).toBe(false);
  });

  it('接受 URL 对象入参', () => {
    expect(shouldBypassProxy(new URL('http://localhost:8787/'), REAL)).toBe(true);
  });
});

describe('describeProxySettings：启动日志文案', () => {
  it('未配置时明确说是直连', () => {
    expect(describeProxySettings(resolveProxySettings({}))).toBe(
      '[ovideo-server] 出站代理：未配置（直连）',
    );
  });

  it('http/https 同址时合并成一条，并列出 NO_PROXY', () => {
    const line = describeProxySettings(
      resolveProxySettings({
        HTTP_PROXY: 'http://127.0.0.1:7890',
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        NO_PROXY: 'localhost,127.0.0.1,::1,.local',
      }),
    );
    expect(line).toContain('http://127.0.0.1:7890');
    expect(line).toContain('来自 HTTPS_PROXY');
    expect(line).toContain('localhost, 127.0.0.1, ::1, .local');
  });

  it('http/https 不同址时分别列出', () => {
    const line = describeProxySettings(
      resolveProxySettings({ http_proxy: 'http://a:1', https_proxy: 'http://b:2' }),
    );
    expect(line).toContain('https → http://b:2');
    expect(line).toContain('http → http://a:1');
  });

  it('配了代理却没配 NO_PROXY 时给出提醒（否则本地回环会被打断）', () => {
    const line = describeProxySettings(resolveProxySettings({ HTTP_PROXY: 'http://127.0.0.1:7890' }));
    expect(line).toContain('未设置 NO_PROXY');
  });

  it('不把代理凭据打进日志', () => {
    const line = describeProxySettings(
      resolveProxySettings({ HTTP_PROXY: 'http://alice:s3cret@127.0.0.1:7890' }),
    );
    expect(line).not.toContain('s3cret');
    expect(line).not.toContain('alice');
  });
});

describe('redactProxyUrl', () => {
  it('隐去账号密码', () => {
    expect(redactProxyUrl('http://alice:s3cret@127.0.0.1:7890')).toBe('http://***@127.0.0.1:7890');
  });
  it('无凭据时保持原样（不留尾部斜杠）', () => {
    expect(redactProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
  });
});

describe('installOutboundProxy', () => {
  it('无代理环境下不安装 dispatcher，且日志说明是直连', () => {
    const logs: string[] = [];
    const before = globalThis[Symbol.for('undici.globalDispatcher.2') as never];
    const settings = installOutboundProxy({ env: {}, log: (m) => logs.push(m) });
    expect(settings.httpProxy).toBeNull();
    expect(logs).toEqual(['[ovideo-server] 出站代理：未配置（直连）']);
    // 未配置代理时绝不改动全局 dispatcher
    expect(globalThis[Symbol.for('undici.globalDispatcher.2') as never]).toBe(before);
  });

  it('传入的 env 优先于 process.env（便于测试与嵌入）', () => {
    const logs: string[] = [];
    const env: EnvLike = { HTTP_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost' };
    // 这条会真的换掉全局 dispatcher，用完必须还原，否则会污染同一 worker 里的其它测试
    const key = Symbol.for('undici.globalDispatcher.2') as never;
    const before = globalThis[key];
    try {
      const settings = installOutboundProxy({ env, log: (m) => logs.push(m) });
      expect(settings.httpProxy).toBe('http://127.0.0.1:7890/');
      expect(logs[0]).toContain('出站代理：http://127.0.0.1:7890');
    } finally {
      globalThis[key] = before;
    }
  });
});
