import { describe, expect, it } from 'vitest';
import {
  estimateSceneDurationMs,
  formatDuration,
  inspectDialogueIssue,
  parseScript,
  parseSceneHeading,
  replaceSceneText,
} from './script-parse';

/**
 * 往返无损是本模块最重要的正确性要求：结构化展示只是 UI 层，
 * 用户保存时写回库里的必须是他自己那一份字节。
 * 下面这组样本刻意覆盖各种"看起来可以顺手规整一下"的脏格式。
 */
const ROUND_TRIP_SAMPLES: Array<{ name: string; text: string }> = [
  {
    name: '标准多场景剧本',
    text: [
      '场景一：客户会议室，白天。',
      '玻璃幕墙外高楼林立。小陈盯着屏幕皱眉。',
      '小陈：这方案……太泛了。',
      '旁白：铁三角，从不单打。',
      '',
      '场景二：华为作战室，傍晚。',
      '老王把白板推到中央。',
      '老王：那就重来。',
    ].join('\n'),
  },
  {
    name: '首个场景标题之前有散文',
    text: [
      '本片改编自真实项目复盘。',
      '人物：小陈、老王。',
      '',
      '场景一：客户会议室，白天。',
      '小陈：这方案……太泛了。',
    ].join('\n'),
  },
  {
    name: '连续空行',
    text: '场景一：天台，黄昏。\n\n\n\n小陈：风真大。\n\n\n',
  },
  {
    name: '没有任何场景标题的纯散文',
    text: '一个人走在雨里。\n他没有回头。\n\n结束。',
  },
  {
    name: '行尾有空格与制表符',
    text: '场景一：客户会议室，白天。  \n小陈：这方案太泛了。\t\n动作行带尾随空格   ',
  },
  {
    name: '最后一行没有换行符',
    text: '场景一：客户会议室，白天。\n小陈：好。',
  },
  {
    name: '正文以换行结尾（尾部空行必须保留）',
    text: '场景一：客户会议室，白天。\n小陈：好。\n',
  },
  {
    name: '正文以空行开头',
    text: '\n\n场景一：客户会议室，白天。\n小陈：好。',
  },
  { name: '空正文', text: '' },
  { name: '只有一个换行符', text: '\n' },
  { name: '只有空白字符', text: '   ' },
];

describe('parseScript 往返无损', () => {
  for (const sample of ROUND_TRIP_SAMPLES) {
    it(`${sample.name}：scenes 拼回后与原文逐字相同`, () => {
      const { scenes } = parseScript(sample.text);
      expect(scenes.map((s) => s.text).join('\n')).toBe(sample.text);
    });
  }

  it('每个场景的 lines.raw 拼回后等于该场景的 text', () => {
    for (const sample of ROUND_TRIP_SAMPLES) {
      for (const scene of parseScript(sample.text).scenes) {
        expect(scene.lines.map((l) => l.raw).join('\n')).toBe(scene.text);
      }
    }
  });
});

describe('replaceSceneText', () => {
  const text = [
    '前言：这是一段散文。',
    '',
    '场景一：客户会议室，白天。',
    '小陈：这方案太泛了。',
    '',
    '场景二：天台，黄昏。',
    '老王：重来。',
  ].join('\n');

  it('替换中间场景时其余部分逐字不动', () => {
    // 场景块的 text 含块尾那一行空行（它是场景之间的间隔），替换时要一并带上
    const next = replaceSceneText(text, 1, '场景一：客户会议室，白天。\n小陈：我改。\n');
    expect(next).toBe(
      ['前言：这是一段散文。', '', '场景一：客户会议室，白天。', '小陈：我改。', '', '场景二：天台，黄昏。', '老王：重来。'].join(
        '\n',
      ),
    );
  });

  it('替换成完全相同的文本时全文不变', () => {
    const parsed = parseScript(text);
    for (const scene of parsed.scenes) {
      expect(replaceSceneText(text, scene.index, scene.text)).toBe(text);
    }
  });

  it('替换首个无标题场景（散文前言）也不影响后续场景', () => {
    const next = replaceSceneText(text, 0, '前言：改过了。\n');
    expect(next.startsWith('前言：改过了。\n\n场景一：')).toBe(true);
    expect(next.endsWith('老王：重来。')).toBe(true);
  });

  it('越界索引原样返回', () => {
    expect(replaceSceneText(text, 99, 'x')).toBe(text);
    expect(replaceSceneText(text, -1, 'x')).toBe(text);
  });

  it('往返：替换后再解析，场景数与文本仍然自洽', () => {
    const next = replaceSceneText(text, 2, '场景二：天台，深夜。\n老王：重来。\n小陈：好。');
    const parsed = parseScript(next);
    expect(parsed.scenes.map((s) => s.text).join('\n')).toBe(next);
    expect(parsed.scenes[2]!.timeOfDay).toBe('深夜');
  });
});

describe('场景切分', () => {
  it('首个场景标题之前的内容成为 index=0 的无标题场景', () => {
    const { scenes } = parseScript('前言一句话。\n场景一：客户会议室，白天。\n小陈：好。');
    expect(scenes).toHaveLength(2);
    expect(scenes[0]!.title).toBe('');
    expect(scenes[0]!.text).toBe('前言一句话。');
    expect(scenes[1]!.title).toBe('客户会议室');
  });

  it('正文以场景标题开头时不产生空的无标题场景', () => {
    const { scenes } = parseScript('场景一：客户会议室，白天。\n小陈：好。');
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.index).toBe(0);
  });

  it('纯散文只有一个无标题场景', () => {
    const { scenes } = parseScript('一个人走在雨里。\n他没有回头。');
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.title).toBe('');
  });

  it('空正文返回空场景列表', () => {
    expect(parseScript('').scenes).toHaveLength(0);
  });
});

describe('行分类', () => {
  it('识别标题 / 动作 / 对白 / 旁白 / 空行', () => {
    const { scenes } = parseScript(
      ['场景一：客户会议室，白天。', '小陈盯着屏幕皱眉。', '小陈：这方案太泛了。', '旁白：铁三角，从不单打。', ''].join('\n'),
    );
    expect(scenes[0]!.lines.map((l) => l.kind)).toEqual([
      'heading',
      'action',
      'dialogue',
      'narration',
      'blank',
    ]);
  });

  it('对白行拆出说话人与台词', () => {
    const { scenes } = parseScript('小陈：这方案……太泛了。');
    const line = scenes[0]!.lines[0]!;
    expect(line.speaker).toBe('小陈');
    expect(line.text).toBe('这方案……太泛了。');
  });

  it('角色名超 6 字的行不算对白（避免把动作行吞成台词）', () => {
    const { scenes } = parseScript('他转身看着窗外的雨幕：那句话还在耳边。');
    expect(scenes[0]!.lines[0]!.kind).toBe('action');
  });

  it('半角冒号不算对白', () => {
    const { scenes } = parseScript('小陈: 这方案太泛了。');
    expect(scenes[0]!.lines[0]!.kind).toBe('action');
  });

  it('characters 去重保序且不含旁白', () => {
    const { scenes } = parseScript(
      ['场景一：会议室，白天。', '小陈：一。', '老王：二。', '小陈：三。', '旁白：四。'].join('\n'),
    );
    expect(scenes[0]!.characters).toEqual(['小陈', '老王']);
  });
});

describe('场景抬头解析', () => {
  it('解析地点与时间', () => {
    expect(parseSceneHeading('场景一：客户会议室，白天。')).toEqual({
      title: '客户会议室',
      location: '客户会议室',
      interiorExterior: '',
      timeOfDay: '白天',
    });
  });

  it('识别内景标记词', () => {
    expect(parseSceneHeading('第三场：内景 会议室 - 夜')?.interiorExterior).toBe('INT');
  });

  it('「办公室内」按地点+内后缀解析，不咬掉地点名', () => {
    const parsed = parseSceneHeading('场景二：办公室内，傍晚');
    expect(parsed?.location).toBe('办公室');
    expect(parsed?.interiorExterior).toBe('INT');
  });

  it('识别不出的字段留空，不编造', () => {
    const parsed = parseSceneHeading('场景一：');
    expect(parsed).toEqual({ title: '', location: '', interiorExterior: '', timeOfDay: '' });
  });

  it('「场景描述：一个人走过」不是抬头', () => {
    expect(parseSceneHeading('场景描述：一个人走过')).toBeNull();
  });

  it('普通对白行不是抬头', () => {
    expect(parseSceneHeading('小陈：这方案太泛了。')).toBeNull();
  });
});

describe('时长与镜头数估算', () => {
  it('对白字数 × 250ms + 动作行数 × 1500ms', () => {
    // 台词按整串长度计（标点也占口播时间）：6 + 6 = 12 字 → 3000ms；
    // 动作行 2 条 → 3000ms；合计 6000ms → round(6000/4000) = 2 个镜头
    const { scenes } = parseScript(
      ['场景一：会议室，白天。', '他走进来。', '灯亮了。', '小陈：一二三四五。', '旁白：六七八九十。'].join('\n'),
    );
    expect(scenes[0]!.estimatedDurationMs).toBe(6000);
    expect(scenes[0]!.estimatedShotCount).toBe(2);
  });

  it('夹取在 3000~30000ms', () => {
    expect(estimateSceneDurationMs([{ kind: 'blank', raw: '' }])).toBe(3000);
    const longLine = { kind: 'dialogue' as const, raw: '', speaker: '小陈', text: '字'.repeat(500) };
    expect(estimateSceneDurationMs([longLine])).toBe(30000);
  });

  it('镜头数 = clamp(round(时长 / 4000), 1, 5)', () => {
    const longLine = { kind: 'dialogue' as const, raw: '', speaker: '小陈', text: '字'.repeat(500) };
    const { scenes } = parseScript(`场景一：会议室，白天。\n小陈：${'字'.repeat(500)}`);
    expect(estimateSceneDurationMs([longLine])).toBe(30000);
    expect(scenes[0]!.estimatedShotCount).toBe(5);
  });

  it('全剧总时长与总镜头数是各场景之和', () => {
    const parsed = parseScript(
      ['场景一：会议室，白天。', '小陈：好。', '场景二：天台，黄昏。', '老王：走。'].join('\n'),
    );
    expect(parsed.totalDurationMs).toBe(
      parsed.scenes.reduce((s, x) => s + x.estimatedDurationMs, 0),
    );
    expect(parsed.totalShotCount).toBe(parsed.scenes.reduce((s, x) => s + x.estimatedShotCount, 0));
  });

  it('formatDuration 分秒展示', () => {
    expect(formatDuration(18000)).toBe('18秒');
    expect(formatDuration(72000)).toBe('1分12秒');
    expect(formatDuration(120000)).toBe('2分');
  });
});

describe('对白格式问题提示', () => {
  it('半角冒号', () => {
    expect(inspectDialogueIssue('小陈: 这方案太泛了。')).toBe('halfwidth-colon');
  });

  it('角色名过长', () => {
    expect(inspectDialogueIssue('穿白衬衫的年轻人：这方案太泛了。')).toBe('long-speaker');
  });

  it('正常对白无提示', () => {
    expect(inspectDialogueIssue('小陈：这方案太泛了。')).toBeNull();
  });

  it('场景抬头不报格式问题', () => {
    expect(inspectDialogueIssue('场景一：客户会议室，白天。')).toBeNull();
  });

  it('普通动作行不报格式问题', () => {
    expect(inspectDialogueIssue('玻璃幕墙外高楼林立。')).toBeNull();
  });
});
