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
