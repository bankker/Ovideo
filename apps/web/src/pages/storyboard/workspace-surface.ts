// 分镜工作台的"中性表面"。
//
// 工作台要的是中性灰白底 + 紫色只用于主操作，而全局默认模板是野兽派
// （黑粗边、0 圆角、硬阴影，选择器无作用域且满屏 !important）。
// 与其在每个组件上堆特异性去压它，不如让它压根不匹配：
// ThemeProvider 注入前已把模板 CSS 的每条规则前缀成 body:not(.surface-neutral)，
// 这里负责在工作台挂载期间把那个 class 挂到 body 上。

import { useEffect } from 'react';
import { theme as antdTheme, type ThemeConfig } from 'antd';
import { NEUTRAL_SURFACE_CLASS } from '../../theme/themes';

/**
 * 引用计数而不是直接增删：工作台内部可能同时存在多个消费者
 * （故事板视图 + 镜头表视图切换时会短暂并存），
 * 先卸载的那个不能把还活着的那个的表面掀掉。
 */
let mountedCount = 0;

/** 工作台挂载期间给 body 打上中性表面标记，卸载时还原 */
export function useNeutralSurface(): void {
  useEffect(() => {
    mountedCount += 1;
    document.body.classList.add(NEUTRAL_SURFACE_CLASS);
    return () => {
      mountedCount -= 1;
      if (mountedCount <= 0) {
        mountedCount = 0;
        document.body.classList.remove(NEUTRAL_SURFACE_CLASS);
      }
    };
  }, []);
}

/**
 * 中性表面下的设计取值。工作台所有组件从这里取，不要各自硬编码——
 * 这套值刻意不走 AntD token：token 是跟着模板变的，而工作台要的恰恰是"不跟着变"。
 */
export const SURFACE = {
  /** 画布底（最外层） */
  bg: '#f7f8fa',
  /** 卡片/面板底 */
  bgElevated: '#ffffff',
  /** 次级填充：分组头、未选中的分段控件 */
  bgSubtle: '#eef0f4',
  /** 缩略图占位、空态底 */
  bgPlaceholder: '#e6e9ef',

  border: '#e4e7ec',
  /** 需要更明确边界时（输入框、hover 卡片） */
  borderStrong: '#cdd2dc',

  text: '#1b1e25',
  textSecondary: '#5a6270',
  textTertiary: '#8d94a1',

  /** 主色紫：只用于主操作按钮、选中态、步骤指示，不做大面积铺底 */
  primary: '#6b57e0',
  primaryHover: '#7d6bea',
  /** 选中态浅填充 */
  primarySoft: '#f1eefc',
  primaryBorder: '#c6bcf5',

  success: '#3f9c53',
  warning: '#c77700',
  danger: '#d0453b',

  /** 间距一律 8 的倍数 */
  space: { xs: 8, sm: 16, md: 24, lg: 32 },
  /** 圆角 8-12 */
  radius: { sm: 8, md: 10, lg: 12 },

  /** 正文字号 */
  fontSize: 14,
  /** 卡片头/小标题字号 */
  fontSizeHeading: 16,
  /** 强调字重：中性表面用 600，不用野兽派那种 800 */
  fontWeightStrong: 600,

  /** 左侧场景导航固定宽 */
  railWidth: 220,
  /** 右侧镜头检查器展开宽 */
  inspectorWidth: 360,
} as const;

/**
 * 工作台根组件要再套一层 `<ConfigProvider theme={NEUTRAL_THEME}>`。
 *
 * scopeTemplateCss 只挡得住模板注入的全局 CSS；AntD 的 design token 走的是
 * ConfigProvider 而不是 CSS，屏蔽不掉。不套这层，工作台就是"中性底色 + 野兽派控件"
 * 的四不像：底是灰白的，按钮却是橙色直角 800 字重。
 *
 * 取值全部来自 SURFACE，这里不出现第二份色值/圆角/间距。
 *
 * 嵌套 ConfigProvider 的 theme 是「继承 + 覆盖」而不是替换，所以凡是任何模板
 * 设过的键，这里都必须显式给出中性值——漏一个就漏进来一个。
 * 这条对应关系由 workspace-surface.test.ts 的守卫测试盯着，
 * 将来给模板加 token 而忘了在这里还原会直接测试失败。
 */
export const NEUTRAL_THEME: ThemeConfig = {
  // 暗黑模板设了 darkAlgorithm，而算法同样是继承的，必须显式扳回亮色
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    colorPrimary: SURFACE.primary,
    colorPrimaryHover: SURFACE.primaryHover,
    colorPrimaryBg: SURFACE.primarySoft,
    colorPrimaryBorder: SURFACE.primaryBorder,
    colorInfo: SURFACE.primary,

    colorSuccess: SURFACE.success,
    colorWarning: SURFACE.warning,
    colorError: SURFACE.danger,

    colorText: SURFACE.text,
    colorTextSecondary: SURFACE.textSecondary,
    colorTextTertiary: SURFACE.textTertiary,

    colorBorder: SURFACE.borderStrong,
    colorBorderSecondary: SURFACE.border,

    colorBgLayout: SURFACE.bg,
    colorBgContainer: SURFACE.bgElevated,
    colorBgElevated: SURFACE.bgElevated,

    // 圆角只在 8-12 之间取，SM/XS 也压到 8：宁可统一，也不引入 SURFACE 之外的新数
    borderRadius: SURFACE.radius.sm,
    borderRadiusLG: SURFACE.radius.lg,
    borderRadiusSM: SURFACE.radius.sm,
    borderRadiusXS: SURFACE.radius.sm,

    fontSize: SURFACE.fontSize,
    fontWeightStrong: SURFACE.fontWeightStrong,

    padding: SURFACE.space.sm,
    paddingLG: SURFACE.space.md,
    paddingXS: SURFACE.space.xs,
    margin: SURFACE.space.sm,
    marginLG: SURFACE.space.md,
    marginXS: SURFACE.space.xs,
  },
  components: {
    // 各模板都改过 Layout 的头部底色（野兽派纯黑、玻璃半透明、新拟物灰），
    // 工作台的头部是白面板，三处底色一并钉死
    Layout: {
      headerBg: SURFACE.bgElevated,
      bodyBg: SURFACE.bg,
      siderBg: SURFACE.bgElevated,
      footerBg: SURFACE.bgElevated,
    },
    // 中性表面是扁平的，按钮不带任何投影（野兽派的硬阴影来自 CSS，token 这层单独还原）
    Button: { primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none' },
    Card: { headerFontSize: SURFACE.fontSizeHeading, headerBg: 'transparent' },
  },
};
