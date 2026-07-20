import { describe, expect, it } from 'vitest';
import {
  annotateMentions,
  buildElementIndex,
  parseMentions,
  splitLineByElements,
  type AnnotationElements,
} from './annotate-mentions';
import { parseScript } from './script-parse';

/** 造一份要素集合；只给名字，类型由桶决定（与真实 ScriptElements 结构兼容） */
function els(input: {
  characters?: string[];
  scenes?: string[];
  props?: string[];
}): AnnotationElements {
  return {
    characters: (input.characters ?? []).map((name) => ({ name })),
    scenes: (input.scenes ?? []).map((name) => ({ name })),
    props: (input.props ?? []).map((name) => ({ name })),
  };
}

describe('parseMentions', () => {
  it('解析 @名字 与 @!名字，force 区分开', () => {
    expect(parseMentions('@小美 走进 @!樱花树下')).toEqual([
      { name: '小美', force: false },
      { name: '樱花树下', force: true },
    ]);
  });

  it('名字在标点处终止', () => {
    expect(parseMentions('@小美，转身。')).toEqual([{ name: '小美', force: false }]);
    expect(parseMentions('（@钥匙）')).toEqual([{ name: '钥匙', force: false }]);
  });

  it('按名字去重，force 以首次出现为准', () => {
    expect(parseMentions('@小美 和 @小美')).toEqual([{ name: '小美', force: false }]);
    expect(parseMentions('@!天台 又见 @天台')).toEqual([{ name: '天台', force: true }]);
  });

  it('没有提及时返回空数组', () => {
    expect(parseMentions('小美走进办公室。')).toEqual([]);
    expect(parseMentions('')).toEqual([]);
  });
});

describe('buildElementIndex', () => {
  it('长名字在前，保证最长优先匹配', () => {
    const index = buildElementIndex(els({ characters: ['小美', '小美丽'] }));
    expect(index.map((e) => e.name)).toEqual(['小美丽', '小美']);
  });

  it('同名只保留优先级最高的一类（角色 > 场景 > 道具）', () => {
    const index = buildElementIndex(els({ characters: ['青'], scenes: ['青'], props: ['青'] }));
    expect(index).toEqual([{ name: '青', type: 'CHARACTER' }]);
  });
});

describe('splitLineByElements', () => {
  const index = buildElementIndex(els({ characters: ['小美'], scenes: ['天台'], props: ['钥匙'] }));

  it('片段拼回去必须逐字等于原行（高亮不能改一个字）', () => {
    const raws = [
      '小美站在天台上，手里攥着钥匙。',
      '@小美 站在 @!天台 上。',
      '这里没有任何要素。',
      '',
      '@',
      '@未知标签 出现在正文里',
    ];
    for (const raw of raws) {
      const segments = splitLineByElements(raw, index);
      expect(segments.map((s) => s.text).join('')).toBe(raw);
    }
  });

  it('每一段的 start 就是它在原行里的下标（caret 定位靠它）', () => {
    const raw = '小美站在天台上。';
    const segments = splitLineByElements(raw, index);
    for (const seg of segments) {
      expect(raw.slice(seg.start, seg.start + seg.text.length)).toBe(seg.text);
    }
    expect(segments.map((s) => [s.start, s.text])).toEqual([
      [0, '小美'],
      [2, '站在'],
      [4, '天台'],
      [6, '上。'],
    ]);
  });

  it('识别类型与是否已标注', () => {
    const segments = splitLineByElements('@小美 抬头看天台，@!天台 亮着灯，钥匙掉了。', index);
    const found = segments.filter((s) => s.element !== null).map((s) => s.element!);
    expect(found).toEqual([
      { name: '小美', type: 'CHARACTER', annotated: true, force: false },
      { name: '天台', type: 'SCENE', annotated: false, force: false },
      { name: '天台', type: 'SCENE', annotated: true, force: true },
      { name: '钥匙', type: 'PROP', annotated: false, force: false },
    ]);
  });

  it('历史写法「@小美踮起脚」按最长要素名前缀切开，剩下的回到普通文本', () => {
    const segments = splitLineByElements('@小美踮起脚', index);
    expect(segments.map((s) => s.text)).toEqual(['@小美', '踮起脚']);
    expect(segments[0]!.element).toEqual({
      name: '小美',
      type: 'CHARACTER',
      annotated: true,
      force: false,
    });
  });

  it('不认识的 @提及不高亮，也不吞掉字符', () => {
    const segments = splitLineByElements('@陌生人 走过', index);
    expect(segments.every((s) => s.element === null)).toBe(true);
    expect(segments.map((s) => s.text).join('')).toBe('@陌生人 走过');
  });

  it('单字要素名不参与裸匹配（否则「家」会咬进「家伙」）', () => {
    const single = buildElementIndex(els({ scenes: ['家'] }));
    const segments = splitLineByElements('这家伙回家了', single);
    expect(segments.every((s) => s.element === null)).toBe(true);
  });
});

describe('annotateMentions', () => {
  const elements = els({ characters: ['小美', '阿强'], scenes: ['天台'], props: ['钥匙'] });

  it('只给动作行加 @，对白行一个字都不动', () => {
    const text = ['场景一：天台，黄昏。', '小美走上天台。', '小美：阿强，钥匙给我。'].join('\n');
    const { text: next, added } = annotateMentions(text, elements);
    expect(next).toBe(
      ['场景一：天台，黄昏。', '@小美 走上@天台。', '小美：阿强，钥匙给我。'].join('\n'),
    );
    expect(added).toBe(2);
  });

  it('场景标题行不动（往抬头里插 @ 会让地点解析失效）', () => {
    const text = '场景一：天台，黄昏。';
    const { text: next, added } = annotateMentions(text, elements);
    expect(next).toBe(text);
    expect(added).toBe(0);
    // 抬头解析结果不受影响
    expect(parseScript(next).scenes[0]!.location).toBe('天台');
  });

  it('旁白行同样不动（它是被读出来的台词）', () => {
    const text = '旁白：小美走上天台。';
    expect(annotateMentions(text, elements).text).toBe(text);
  });

  it('已带 @ 或 @! 的不重复加', () => {
    const text = '@小美 打开门，@!天台 的灯亮着。';
    const { text: next, added } = annotateMentions(text, elements);
    expect(next).toBe(text);
    expect(added).toBe(0);
  });

  it('同一行内同一个名字只标第一次出现', () => {
    const { text: next, added } = annotateMentions('小美看着小美的影子。', elements);
    expect(next).toBe('@小美 看着小美的影子。');
    expect(added).toBe(1);
  });

  it('本行已有 @ 锚定时，同名的其它出现不再补 @', () => {
    const { text: next, added } = annotateMentions('门开了，@小美 回头看了小美一眼。', elements);
    expect(next).toBe('门开了，@小美 回头看了小美一眼。');
    expect(added).toBe(0);
  });

  it('名字后面紧跟正文时补一个空格，避免服务端把后半句吞进标签名', () => {
    const { text: next } = annotateMentions('小美踮脚跳跃。', elements);
    expect(next).toBe('@小美 踮脚跳跃。');
    // 补空格之后，服务端同款正则才能把名字切干净
    expect(parseMentions(next)).toEqual([{ name: '小美', force: false }]);
  });

  it('名字后面已经是标点或空白时不补空格', () => {
    expect(annotateMentions('小美，转身。', elements).text).toBe('@小美，转身。');
    expect(annotateMentions('小美 转身。', elements).text).toBe('@小美 转身。');
    expect(annotateMentions('钥匙', elements).text).toBe('@钥匙');
  });

  it('最长优先：不会把「小美丽」切成「@小美 丽」', () => {
    const withLonger = els({ characters: ['小美', '小美丽'] });
    const { text: next } = annotateMentions('小美丽转身。', withLonger);
    expect(next).toBe('@小美丽 转身。');
  });

  it('场景只加 @，绝不自作主张加 @!（强制发参考图必须由用户选）', () => {
    const { text: next } = annotateMentions('天台上风很大。', elements);
    expect(next).toBe('@天台 上风很大。');
    expect(next.includes('@!')).toBe(false);
  });

  it('没有要素时原样返回', () => {
    expect(annotateMentions('小美走上天台。', els({}))).toEqual({
      text: '小美走上天台。',
      added: 0,
      names: [],
    });
  });

  it('空正文与纯空行不炸', () => {
    expect(annotateMentions('', elements).text).toBe('');
    expect(annotateMentions('\n\n', elements).text).toBe('\n\n');
  });

  it('names 列出被标注过的要素（去重保序）', () => {
    const { names } = annotateMentions('小美走上天台。\n小美掏出钥匙。', elements);
    expect(names).toEqual(['小美', '天台', '钥匙']);
  });

  it('行结构与行数完全不变（只在行内插入 @）', () => {
    const text = ['场景一：天台，黄昏。', '', '小美走上天台。', '小美：给我钥匙。', ''].join('\n');
    const { text: next } = annotateMentions(text, elements);
    expect(next.split('\n').length).toBe(text.split('\n').length);
  });

  it('标注后再标注是幂等的（不会越标越多）', () => {
    const text = '小美走上天台，掏出钥匙。';
    const once = annotateMentions(text, elements).text;
    const twice = annotateMentions(once, elements);
    expect(twice.text).toBe(once);
    expect(twice.added).toBe(0);
  });

  it('标注不破坏场景切分：场景数与每场的标题保持不变', () => {
    const text = [
      '场景一：天台，黄昏。',
      '小美走上天台。',
      '场景二：客户机房，深夜。',
      '阿强蹲在机柜前，钥匙掉在地上。',
    ].join('\n');
    const before = parseScript(text);
    const after = parseScript(annotateMentions(text, elements).text);
    expect(after.scenes.length).toBe(before.scenes.length);
    expect(after.scenes.map((s) => s.location)).toEqual(before.scenes.map((s) => s.location));
    expect(after.scenes.map((s) => s.characters)).toEqual(before.scenes.map((s) => s.characters));
  });

  it('标注只增加 @ 与必要空格：剥掉这些字符后与原文逐字相同', () => {
    const text = ['场景一：天台，黄昏。', '小美走上天台，掏出钥匙。', '小美：阿强呢？'].join('\n');
    const { text: next } = annotateMentions(text, elements);
    // 把新加的 "@名字 " 还原成 "名字"，应当回到原文
    const restored = next.replace(/@(小美|天台|钥匙|阿强) ?/g, '$1');
    expect(restored).toBe(text);
  });
});
