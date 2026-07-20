import { theme as antdTheme, type ThemeConfig } from 'antd';

/**
 * 全局 UI 模板注册表。每个模板 = AntD token/算法配置 + 一段全局 CSS 覆写
 * （AntD token 管不到的质感细节——硬阴影、毛玻璃、双向浮雕——用 CSS 补）。
 */
export interface UiTemplate {
  key: string;
  label: string;
  /** 顶栏是否浅色（决定标题文字与菜单配色） */
  headerLight: boolean;
  antd: ThemeConfig;
  css: string;
}

export const UI_TEMPLATES: UiTemplate[] = [
  {
    key: 'brutalism',
    label: '野兽派',
    headerLight: false,
    antd: {
      token: {
        colorPrimary: '#ff4d00',
        colorInfo: '#ff4d00',
        colorText: '#111111',
        colorBorder: '#111111',
        colorBgLayout: '#f2ede3',
        borderRadius: 0,
        fontWeightStrong: 800,
      },
      components: {
        Layout: { headerBg: '#111111' },
        Button: { primaryShadow: 'none', defaultShadow: 'none' },
        Card: { headerFontSize: 16 },
      },
    },
    css: `
      body { background: #f2ede3; }
      .ant-card, .ant-modal-content, .ant-popover-inner, .ant-message-notice-content {
        border: 2px solid #111 !important; box-shadow: 5px 5px 0 #111 !important; border-radius: 0 !important;
      }
      .ant-card-head { border-bottom: 2px solid #111 !important; font-weight: 800; }
      .ant-btn { border: 2px solid #111 !important; box-shadow: 3px 3px 0 #111; border-radius: 0 !important; font-weight: 700; }
      .ant-btn:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 #111; }
      .ant-btn-primary { background: #ff4d00; color: #fff; }
      .ant-select-selector, .ant-input, .ant-input-affix-wrapper, textarea.ant-input, .ant-input-number {
        border: 2px solid #111 !important; border-radius: 0 !important;
      }
      .ant-segmented { border: 2px solid #111; border-radius: 0; background: #fff; }
      .ant-segmented-item-selected { border-radius: 0 !important; background: #ffde00 !important; color: #111 !important; font-weight: 800; }
      .ant-tag { border: 1.5px solid #111 !important; border-radius: 0 !important; font-weight: 700; }
      .ant-layout-header { border-bottom: 3px solid #ff4d00; }
      .ant-timeline-item-head { border-width: 3px; }
      .ant-select-dropdown, .ant-dropdown-menu { border: 2px solid #111 !important; border-radius: 0 !important; box-shadow: 4px 4px 0 #111 !important; }
      .ant-alert { border: 2px solid #111 !important; border-radius: 0 !important; }
      .ant-upload.ant-upload-select { border-radius: 0 !important; }
    `,
  },
  {
    key: 'classic',
    label: '经典简约',
    headerLight: false,
    antd: {},
    css: '',
  },
  {
    key: 'dark',
    label: '暗黑模式',
    headerLight: false,
    antd: {
      algorithm: antdTheme.darkAlgorithm,
      token: { colorPrimary: '#1668dc' },
    },
    css: `
      body { background: #141414; }
    `,
  },
  {
    key: 'glass',
    label: '玻璃拟态',
    headerLight: false,
    antd: {
      token: {
        colorPrimary: '#7c5cff',
        borderRadius: 14,
        colorBgContainer: 'rgba(255,255,255,0.62)',
        colorBgElevated: 'rgba(255,255,255,0.82)',
        colorBgLayout: 'transparent',
      },
      components: { Layout: { headerBg: 'rgba(18,16,44,0.55)' } },
    },
    css: `
      body {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 48%, #f093fb 100%);
        background-attachment: fixed;
      }
      .ant-layout { background: transparent !important; }
      .ant-layout-header { backdrop-filter: blur(14px); }
      .ant-card, .ant-modal-content, .ant-popover-inner {
        backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,0.55) !important;
        box-shadow: 0 8px 32px rgba(31,38,135,0.18) !important;
      }
      .ant-select-dropdown, .ant-dropdown-menu { backdrop-filter: blur(16px); }
    `,
  },
  {
    key: 'neumorphism',
    label: '新拟物',
    headerLight: true,
    antd: {
      token: {
        colorPrimary: '#5b7cfa',
        borderRadius: 14,
        colorBgLayout: '#e0e5ec',
        colorBgContainer: '#e0e5ec',
        colorBorder: '#e0e5ec',
      },
      components: { Layout: { headerBg: '#e0e5ec' } },
    },
    css: `
      body { background: #e0e5ec; }
      .ant-layout-header { box-shadow: 0 4px 12px #bcc3cf; }
      .ant-card, .ant-modal-content {
        border: none !important;
        box-shadow: 8px 8px 16px #bcc3cf, -8px -8px 16px #ffffff !important;
      }
      .ant-btn {
        border: none;
        box-shadow: 4px 4px 8px #bcc3cf, -4px -4px 8px #ffffff;
      }
      .ant-btn:active { box-shadow: inset 3px 3px 6px #bcc3cf, inset -3px -3px 6px #ffffff; }
      .ant-select-selector, .ant-input, .ant-input-affix-wrapper, textarea.ant-input {
        box-shadow: inset 3px 3px 6px #c8cfda, inset -3px -3px 6px #ffffff;
        border: none !important;
      }
    `,
  },
  {
    key: 'material',
    label: '质感设计',
    headerLight: false,
    antd: {
      token: {
        colorPrimary: '#6750a4',
        borderRadius: 10,
        colorBgLayout: '#fdf7ff',
      },
      components: { Layout: { headerBg: '#4a3d78' } },
    },
    css: `
      body { background: #fdf7ff; }
      .ant-card { box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.18) !important; border: none !important; }
      .ant-btn-primary { box-shadow: 0 2px 8px rgba(103,80,164,0.4); }
      .ant-modal-content { box-shadow: 0 8px 30px rgba(0,0,0,0.22) !important; }
    `,
  },
];

export const DEFAULT_TEMPLATE_KEY = 'brutalism';

export function getTemplate(key: string): UiTemplate {
  return UI_TEMPLATES.find((t) => t.key === key) ?? UI_TEMPLATES[0];
}

/**
 * 挂在 body 上的"中性表面"标记类。带上它的页面（分镜工作台）不吃任何模板 CSS。
 */
export const NEUTRAL_SURFACE_CLASS = 'surface-neutral';

/** 排除前缀：body 带 surface-neutral 时，所有模板规则都不匹配 */
export const NEUTRAL_SURFACE_EXCLUDE_PREFIX = `body:not(.${NEUTRAL_SURFACE_CLASS})`;

/**
 * 按顶层逗号切分选择器列表。
 *
 * 不能裸 split(',')：`:is(a, b)` / `:not(.a, .b)` 的参数里、以及 `[data-x="a,b"]`
 * 的字符串里都有逗号，裸切会把一条规则悄悄拆成两条语义完全不同的规则。
 * 所以跟踪 ()、[] 的深度和引号状态，只在深度 0 且不在引号里时切。
 */
function splitSelectorList(list: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];

    if (quote !== null) {
      buf += ch;
      if (ch === '\\' && i + 1 < list.length) {
        // 转义序列整体吞掉，否则 "a\"b" 里的 \" 会被误判成引号收尾
        buf += list[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }

  parts.push(buf);
  return parts;
}

/**
 * 给一段选择器列表加作用域前缀。
 *
 * 选择器本身就以 body 开头时不能再当后代选择器拼（`body:not(.x) body` 永远不匹配），
 * 必须把 :not() 直接焊到那个 body 上。
 */
function scopeSelectorList(selectors: string, prefix: string): string {
  return splitSelectorList(selectors)
    .map((raw) => {
      const sel = raw.trim();
      if (sel === '') return raw;
      // /^body\b/ 覆盖 `body`、`body.foo`、`body > x`；`bodyfoo` 这种自定义元素名不会误伤
      if (/^body(?![\w-])/.test(sel)) return prefix + sel.slice('body'.length);
      return `${prefix} ${sel}`;
    })
    .join(', ');
}

/**
 * 把模板 CSS 的每条顶层规则前缀成 `body:not(.surface-neutral) ...`，
 * 让工作台以"不匹配"而不是"特异性对轰"的方式摆脱模板。
 *
 * 前提：themes.ts 里的 CSS 目前不含任何 @media / @keyframes / @supports。
 * 本函数只做规则级前缀，管不了 @ 块内部的规则。这个前提由 scopeHead 里的
 * 开发期断言守住：一旦有人往模板里加了 @media，会当场炸出来而不是让模板
 * 从缺口漏进工作台、事后再花半天定位。真要支持时，把这里改成对 @ 块递归处理。
 */
export function scopeTemplateCss(css: string, prefix: string = NEUTRAL_SURFACE_EXCLUDE_PREFIX): string {
  let out = '';
  let head = ''; // 尚未遇到 '{' 的顶层文本：空白、注释、选择器列表
  let i = 0;

  while (i < css.length) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      head += css.slice(i, stop);
      i = stop;
      continue;
    }
    if (css[i] !== '{') {
      head += css[i];
      i += 1;
      continue;
    }

    // 吃掉整个规则体，按花括号配平，跳过体内注释里的假花括号
    let depth = 1;
    let j = i + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '/' && css[j + 1] === '*') {
        const end = css.indexOf('*/', j + 2);
        j = end === -1 ? css.length : end + 2;
        continue;
      }
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    }

    out += scopeHead(head, prefix) + css.slice(i, j);
    head = '';
    i = j;
  }

  return out + head;
}

/** 把 '{' 之前的那段文本拆成「前导空白/注释」和「选择器列表」，只给后者加前缀 */
function scopeHead(head: string, prefix: string): string {
  let lead = '';
  let rest = head;
  for (;;) {
    const ws = /^\s+/.exec(rest);
    if (ws) {
      lead += ws[0];
      rest = rest.slice(ws[0].length);
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      const stop = end === -1 ? rest.length : end + 2;
      lead += rest.slice(0, stop);
      rest = rest.slice(stop);
      continue;
    }
    break;
  }
  if (rest.trim() === '') return head;
  if (rest.startsWith('@')) {
    // 顶层 at-rule 是本函数的已知盲区：块内规则拿不到前缀，模板会从这里漏进工作台。
    // 生产环境仍原样放行（样式漏一点也好过整页白屏），但开发/测试期必须显式失败，
    // 逼加 CSS 的人先把 @ 块递归处理补上。
    // 本包 tsconfig 没引 vite/client，import.meta.env 未声明，就地窄化而不是全局补类型
    const dev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
    if (dev) {
      throw new Error(
        `[themes] 模板 CSS 里出现了顶层 at-rule（${rest.trim().split(/[\s{]/)[0]}），` +
          'scopeTemplateCss 无法给其块内规则加中性表面前缀。' +
          '请先让 scopeTemplateCss 支持 at-rule 递归，再往模板里加这段 CSS。',
      );
    }
    return head;
  }
  return `${lead}${scopeSelectorList(rest, prefix)} `;
}
