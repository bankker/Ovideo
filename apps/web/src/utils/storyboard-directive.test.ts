import { describe, expect, it } from 'vitest';
import {
  averageShotSec,
  buildDirective,
  planOf,
  suggestShotCount,
  type DirectorSettings,
} from './storyboard-directive';

const BASE: DirectorSettings = {
  plan: 'steady',
  targetDurationSec: 45,
  pace: 'medium',
  shotCount: 12,
  camera: 'medium',
  priority: 'dialogue',
  autoEstablishing: true,
  autoReaction: true,
  aspectRatio: '9:16',
};

describe('suggestShotCount', () => {
  it('按方案的基准单镜长度换算：稳健叙事 5 秒 → 45 秒出 9 个镜头', () => {
    expect(suggestShotCount('steady', 45, 'medium')).toBe(9);
  });

  it('商业快剪更碎、动漫戏剧居中', () => {
    expect(suggestShotCount('commercial', 45, 'medium')).toBe(15);
    expect(suggestShotCount('anime', 45, 'medium')).toBe(11);
  });

  it('节奏放慢镜头变少、加快变多', () => {
    expect(suggestShotCount('steady', 60, 'slow')).toBeLessThan(
      suggestShotCount('steady', 60, 'medium'),
    );
    expect(suggestShotCount('steady', 60, 'fast')).toBeGreaterThan(
      suggestShotCount('steady', 60, 'medium'),
    );
  });

  it('时长为 0 也至少给 1 个镜头，不返回 0 或 NaN', () => {
    expect(suggestShotCount('steady', 0, 'medium')).toBe(1);
  });
});

describe('averageShotSec', () => {
  it('保留一位小数', () => {
    expect(averageShotSec(45, 12)).toBe(3.8);
  });

  it('镜头数为 0 时返回 0 而不是 Infinity', () => {
    expect(averageShotSec(45, 0)).toBe(0);
  });
});

describe('planOf', () => {
  it('未知 key 回落到第一个方案而不是抛错（弹窗不该因此白屏）', () => {
    expect(planOf('nope' as never).key).toBe('steady');
  });
});

describe('buildDirective', () => {
  it('把参数拼成一段可读的中文导演说明', () => {
    expect(buildDirective(BASE)).toBe(
      '拆镜风格：稳健叙事（中景与正反打为主，保证人物关系交代清楚，少用花哨景别）。' +
        '目标总时长约 45 秒，建议 12 个镜头，平均每镜约 3.8 秒。' +
        '整体节奏中等。运镜强度中等。优先保证对白完整，不要为了画面切碎台词。' +
        '在合适的位置自动补充空镜（交代环境的无人镜头）与人物反应镜头。' +
        '成片画面比例为 9:16，构图请按该比例设计。',
    );
  });

  it('两个自动开关都关掉时明确要求不要加戏', () => {
    const text = buildDirective({ ...BASE, autoEstablishing: false, autoReaction: false });
    expect(text).toContain('不要额外添加空镜或反应镜头');
    expect(text).not.toContain('自动补充');
  });

  it('只开一个开关时不出现"与"的空悬拼接', () => {
    expect(buildDirective({ ...BASE, autoReaction: false })).toContain(
      '自动补充空镜（交代环境的无人镜头）。',
    );
    expect(buildDirective({ ...BASE, autoEstablishing: false })).toContain(
      '自动补充人物反应镜头。',
    );
  });

  it('画面优先与运镜强弱都落成句子', () => {
    const text = buildDirective({ ...BASE, priority: 'visual', camera: 'strong', pace: 'fast' });
    expect(text).toContain('优先保证画面表现力');
    expect(text).toContain('运镜强度强（多用推拉摇跟）');
    expect(text).toContain('整体节奏偏快');
  });

  it('不指定画面比例时不拼那一句', () => {
    expect(buildDirective({ ...BASE, aspectRatio: '' })).not.toContain('画面比例');
  });
});
