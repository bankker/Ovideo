import { describe, it, expect } from 'vitest';
import { hashStr, colorForPrompt, MOCK_COLORS } from './gens.js';

describe('gens 纯函数', () => {
  it('hashStr 确定性且非负', () => {
    expect(hashStr('男主走进教室')).toBe(hashStr('男主走进教室'));
    expect(hashStr('abc')).toBeGreaterThanOrEqual(0);
    expect(hashStr('')).toBe(0);
  });

  it('colorForPrompt 稳定取色且落在 16 色盘内；只看前 32 字', () => {
    const c = colorForPrompt('同一个提示词');
    expect(c).toBe(colorForPrompt('同一个提示词'));
    expect(MOCK_COLORS).toContain(c);
    const long = 'x'.repeat(32);
    expect(colorForPrompt(long + '后缀A')).toBe(colorForPrompt(long + '后缀B'));
  });
});
