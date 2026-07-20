import { describe, expect, it } from 'vitest';
import { scopeTemplateCss, UI_TEMPLATES } from './themes';

const P = 'body:not(.surface-neutral)';

describe('scopeTemplateCss', () => {
  it('给单条规则加前缀', () => {
    expect(scopeTemplateCss('.ant-card { border: 2px solid #111; }')).toBe(
      `${P} .ant-card { border: 2px solid #111; }`,
    );
  });

  it('逗号分隔的多选择器逐条加前缀', () => {
    expect(scopeTemplateCss('.a, .b .c,\n.d { color: red; }')).toBe(
      `${P} .a, ${P} .b .c, ${P} .d { color: red; }`,
    );
  });

  it('选择器本身以 body 开头时把 :not 焊上去，而不是拼成永不匹配的后代选择器', () => {
    expect(scopeTemplateCss('body { background: #f2ede3; }')).toBe(
      `${P} { background: #f2ede3; }`,
    );
    expect(scopeTemplateCss('body.dark .x { color: red; }')).toBe(
      `${P}.dark .x { color: red; }`,
    );
  });

  it('规则体里的嵌套花括号不会被当成规则结束', () => {
    const css = '.a { background: image-set("x" 1x); grid-template-areas: "a"; }';
    expect(scopeTemplateCss(css)).toBe(`${P} ${css}`);
    // 真嵌套（CSS 原生嵌套）整块跟着外层走，内层不重复加前缀
    expect(scopeTemplateCss('.a { color: red; & .b { color: blue; } }')).toBe(
      `${P} .a { color: red; & .b { color: blue; } }`,
    );
  });

  it('注释原样保留，且注释里的花括号/逗号不影响拆分', () => {
    expect(scopeTemplateCss('/* 头部 */\n.a { color: red; }')).toBe(
      `/* 头部 */\n${P} .a { color: red; }`,
    );
    expect(scopeTemplateCss('.a { /* } 假结束 , */ color: red; }')).toBe(
      `${P} .a { /* } 假结束 , */ color: red; }`,
    );
  });

  it('空规则、空字符串、纯空白都不炸', () => {
    expect(scopeTemplateCss('.a {}')).toBe(`${P} .a {}`);
    expect(scopeTemplateCss('')).toBe('');
    expect(scopeTemplateCss('   \n  ')).toBe('   \n  ');
  });

  it('前提守卫：模板 CSS 里一旦出现 @ 规则，本函数的规则级前缀就不再够用', () => {
    for (const t of UI_TEMPLATES) {
      expect(t.css).not.toContain('@');
    }
  });

  it('伪类函数参数里的逗号不是选择器分隔符', () => {
    expect(scopeTemplateCss(':is(a, b) .x { color: red; }')).toBe(
      `${P} :is(a, b) .x { color: red; }`,
    );
    expect(scopeTemplateCss(':not(.a, .b) span { color: red; }')).toBe(
      `${P} :not(.a, .b) span { color: red; }`,
    );
    expect(scopeTemplateCss(':where(.a, .b), .c { color: red; }')).toBe(
      `${P} :where(.a, .b), ${P} .c { color: red; }`,
    );
  });

  it('属性选择器字符串里的逗号不是选择器分隔符', () => {
    expect(scopeTemplateCss('[data-x="a,b"] { color: red; }')).toBe(
      `${P} [data-x="a,b"] { color: red; }`,
    );
    // 转义引号不能被当成字符串收尾，否则后面的逗号会被误切
    expect(scopeTemplateCss('[data-x="a\\",b"] .y { color: red; }')).toBe(
      `${P} [data-x="a\\",b"] .y { color: red; }`,
    );
    expect(scopeTemplateCss("[data-x='a,b'], .c { color: red; }")).toBe(
      `${P} [data-x='a,b'], ${P} .c { color: red; }`,
    );
  });

  it('body 开头的选择器带上括号参数时仍然把 :not 焊在 body 上', () => {
    expect(scopeTemplateCss('body:has(.a, .b) .x { color: red; }')).toBe(
      `${P}:has(.a, .b) .x { color: red; }`,
    );
  });

  it('前提守卫：顶层 at-rule 在开发期直接报错，而不是静默放行', () => {
    expect(() => scopeTemplateCss('@media (min-width: 600px) { .a { color: red; } }')).toThrow(
      /at-rule/,
    );
    expect(() => scopeTemplateCss('.a { color: red; }\n@supports (d: grid) { .b { color: red; } }'))
      .toThrow(/at-rule/);
  });

  it('野兽派模板整段转换后不再有裸的顶层选择器', () => {
    const scoped = scopeTemplateCss(UI_TEMPLATES[0].css);
    // 野兽派 CSS 无嵌套，按 '}' 切开后每个含 '{' 的片段都是一条完整规则，选择器部分必须带前缀
    const rules = scoped.split('}').filter((piece) => piece.includes('{'));
    expect(rules.length).toBeGreaterThan(10);
    for (const rule of rules) {
      expect(rule.slice(0, rule.indexOf('{'))).toContain(P);
    }
  });
});
