import { describe, expect, it } from 'vitest';
import { UI_TEMPLATES } from '../../theme/themes';
import { NEUTRAL_THEME, SURFACE } from './workspace-surface';

describe('NEUTRAL_THEME', () => {
  it('覆盖了所有模板设过的 token —— 嵌套 ConfigProvider 是继承+覆盖，漏一个键就漏进来一个野兽派取值', () => {
    const templateTokens = new Set<string>();
    for (const t of UI_TEMPLATES) {
      for (const key of Object.keys(t.antd.token ?? {})) templateTokens.add(key);
    }
    // 有实际被覆盖的 token 才谈得上守卫，防止将来模板结构变了测试变成空转
    expect(templateTokens.size).toBeGreaterThan(0);

    const neutralTokens = Object.keys(NEUTRAL_THEME.token ?? {});
    for (const key of templateTokens) expect(neutralTokens).toContain(key);
  });

  it('覆盖了所有模板设过的 components 级键（Layout.headerBg / Button.primaryShadow / Card.headerFontSize 等）', () => {
    const templateKeys = new Set<string>();
    for (const t of UI_TEMPLATES) {
      for (const [comp, cfg] of Object.entries(t.antd.components ?? {})) {
        for (const key of Object.keys(cfg as object)) templateKeys.add(`${comp}.${key}`);
      }
    }
    expect(templateKeys.size).toBeGreaterThan(0);

    const neutral = (NEUTRAL_THEME.components ?? {}) as Record<string, Record<string, unknown>>;
    for (const path of templateKeys) {
      const [comp, key] = path.split('.');
      expect(neutral[comp], `NEUTRAL_THEME 缺少组件 ${comp} 的还原`).toBeDefined();
      expect(Object.keys(neutral[comp])).toContain(key);
    }
  });

  it('模板设过 algorithm 时必须显式扳回，否则暗黑模板会继承进工作台', () => {
    const anyTemplateSetsAlgorithm = UI_TEMPLATES.some((t) => t.antd.algorithm !== undefined);
    expect(anyTemplateSetsAlgorithm).toBe(true);
    expect(NEUTRAL_THEME.algorithm).toBeDefined();
  });

  it('token 取值与 SURFACE 同源，不存在第二份色值', () => {
    expect(NEUTRAL_THEME.token?.colorPrimary).toBe(SURFACE.primary);
    expect(NEUTRAL_THEME.token?.colorBgLayout).toBe(SURFACE.bg);
    expect(NEUTRAL_THEME.token?.borderRadius).toBe(SURFACE.radius.sm);
    expect(NEUTRAL_THEME.token?.borderRadiusLG).toBe(SURFACE.radius.lg);
    expect(NEUTRAL_THEME.components?.Layout?.headerBg).toBe(SURFACE.bgElevated);
  });

  it('圆角落在 8-12 区间内', () => {
    const radii = [
      NEUTRAL_THEME.token?.borderRadius,
      NEUTRAL_THEME.token?.borderRadiusSM,
      NEUTRAL_THEME.token?.borderRadiusLG,
      NEUTRAL_THEME.token?.borderRadiusXS,
    ];
    for (const r of radii) {
      expect(r).toBeGreaterThanOrEqual(8);
      expect(r).toBeLessThanOrEqual(12);
    }
  });
});
