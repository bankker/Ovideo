import { describe, expect, it } from 'vitest';
import { fallbackSceneTitle, parseSceneHeading } from './scene-parse.js';

describe('parseSceneHeading：标准中文抬头', () => {
  it('「场景一：客户会议室，白天。」拆出标题与时间，未写内外景则留空', () => {
    expect(parseSceneHeading('场景一：客户会议室，白天。')).toEqual({
      title: '客户会议室',
      location: '客户会议室',
      interiorExterior: '',
      timeOfDay: '白天',
    });
  });

  it('「场景二：华为作战室，傍晚。」——傍晚不被更短的「晚」类词抢先匹配', () => {
    expect(parseSceneHeading('场景二：华为作战室，傍晚。')).toEqual({
      title: '华为作战室',
      location: '华为作战室',
      interiorExterior: '',
      timeOfDay: '傍晚',
    });
  });

  it('阿拉伯数字编号与英文句号分隔同样识别', () => {
    const r = parseSceneHeading('场景12. 天台，深夜');
    expect(r?.title).toBe('天台');
    expect(r?.timeOfDay).toBe('深夜');
  });

  it('「第三场：」式抬头', () => {
    const r = parseSceneHeading('第三场：地下车库，凌晨。');
    expect(r?.title).toBe('地下车库');
    expect(r?.timeOfDay).toBe('凌晨');
  });

  it('英文 SCENE 抬头（大小写不敏感）', () => {
    const r = parseSceneHeading('SCENE 4: 天台，黄昏');
    expect(r?.title).toBe('天台');
    expect(r?.timeOfDay).toBe('黄昏');
  });
});

describe('parseSceneHeading：内外景', () => {
  it('「内景」→ INT，且不残留在标题里', () => {
    expect(parseSceneHeading('场景一：内景 客户会议室，白天。')).toEqual({
      title: '客户会议室',
      location: '客户会议室',
      interiorExterior: 'INT',
      timeOfDay: '白天',
    });
  });

  it('「外景」→ EXT', () => {
    const r = parseSceneHeading('场景二：外景 城中村巷口，傍晚。');
    expect(r?.interiorExterior).toBe('EXT');
    expect(r?.title).toBe('城中村巷口');
  });

  it('「地点+内/外」后缀：「办公室内」= 办公室 + INT，绝不把地点名咬掉一个字', () => {
    // 回归用例：曾把「室内」当标记词，「办公室内」被切成「办公」+INT
    expect(parseSceneHeading('场景一：办公室内，白天。')).toEqual({
      title: '办公室',
      location: '办公室',
      interiorExterior: 'INT',
      timeOfDay: '白天',
    });
    expect(parseSceneHeading('场景二：天台外，傍晚。')).toMatchObject({
      title: '天台',
      interiorExterior: 'EXT',
    });
  });

  it('内/外后缀只判第一段（地点），后续描述段以内/外结尾不算', () => {
    const r = parseSceneHeading('场景三：同一办公室，明亮清新。');
    expect(r?.title).toBe('同一办公室 明亮清新');
    expect(r?.interiorExterior).toBe('');
  });

  it('显式「内景」标记优先于地点后缀，不被覆盖', () => {
    const r = parseSceneHeading('场景一：内景 会议室外，白天');
    expect(r?.interiorExterior).toBe('INT');
    expect(r?.title).toBe('会议室外');
  });

  it('去掉内/外后不足 2 字的不认（避免把孤立标记拆坏）', () => {
    expect(parseSceneHeading('场景一：室内')?.title).toBe('室内');
    expect(parseSceneHeading('场景一：室内')?.interiorExterior).toBe('');
  });

  it('INT./EXT. 英文写法按词边界识别，不误伤含 INT 的单词', () => {
    expect(parseSceneHeading('SCENE 1: INT. OFFICE - 白天')?.interiorExterior).toBe('INT');
    // INTERIOR 不含独立的 INT 词，不应被判成内景
    expect(parseSceneHeading('场景一：INTERIOR DESIGN 展厅')?.interiorExterior).toBe('');
  });
});

describe('parseSceneHeading：畸形与非抬头输入', () => {
  it('非抬头正文一律返回 null', () => {
    expect(parseSceneHeading('林小满推开门，会议室里已经坐满了人。')).toBeNull();
    expect(parseSceneHeading('对白：我们再谈谈价格。')).toBeNull();
  });

  it('「场景描述：」这类前缀不是抬头（无编号时必须是冒号紧跟「场景」）', () => {
    expect(parseSceneHeading('场景描述：一个人走过长廊')).toBeNull();
  });

  it('空串 / 纯空白 / 非字符串返回 null', () => {
    expect(parseSceneHeading('')).toBeNull();
    expect(parseSceneHeading('   ')).toBeNull();
    expect(parseSceneHeading('\n\t ')).toBeNull();
    // 运行时可能被喂进非字符串（JSON 解析产物），不能抛
    expect(parseSceneHeading(undefined as unknown as string)).toBeNull();
    expect(parseSceneHeading(null as unknown as string)).toBeNull();
  });

  it('多行输入拒绝解析（调用方应自己切行）', () => {
    expect(parseSceneHeading('场景一：会议室\n林小满推门进来')).toBeNull();
  });

  it('只有抬头前缀、没有正文时认成抬头但字段全空', () => {
    expect(parseSceneHeading('场景一：')).toEqual({
      title: '',
      location: '',
      interiorExterior: '',
      timeOfDay: '',
    });
  });

  it('缺分隔符、多余空白、全角数字都能容错', () => {
    expect(parseSceneHeading('  场景３  天台  ')?.title).toBe('天台');
    expect(parseSceneHeading('场景一 客户会议室')?.title).toBe('客户会议室');
  });

  it('没有时间词时 timeOfDay 留空，不猜', () => {
    const r = parseSceneHeading('场景一：客户会议室');
    expect(r?.timeOfDay).toBe('');
    expect(r?.title).toBe('客户会议室');
  });

  it('location 与 title 同源（中文抬头里两者本就是一回事）', () => {
    const r = parseSceneHeading('场景一：客户会议室，白天。');
    expect(r?.location).toBe(r?.title);
  });
});

describe('fallbackSceneTitle', () => {
  it('取首行前 20 字', () => {
    const text = '林小满推开门，会议室里已经坐满了人，气氛凝重得能拧出水来。\n第二行不该出现';
    expect(fallbackSceneTitle(text)).toBe('林小满推开门，会议室里已经坐满了人，气氛');
    expect(fallbackSceneTitle(text).length).toBe(20);
  });

  it('短文本原样返回；空/缺省返回空串', () => {
    expect(fallbackSceneTitle('天台对峙')).toBe('天台对峙');
    expect(fallbackSceneTitle('')).toBe('');
    expect(fallbackSceneTitle(undefined as unknown as string)).toBe('');
  });
});
