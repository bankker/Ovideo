import { describe, expect, it } from 'vitest';
import type { TagEntity } from '../api/design-hooks';
import { collectScriptElements, detectImpliedScenes, parseScriptMentions } from './script-elements';
import { parseScript } from './script-parse';

/** 造一条项目标签；测试只关心 type/name/canonicalAssetId，其余字段给占位值 */
function tag(
  type: TagEntity['type'],
  name: string,
  canonicalAssetId: string | null = null,
): TagEntity {
  return {
    id: `tag-${type}-${name}`,
    projectId: 'p1',
    type,
    name,
    description: '',
    canonicalAssetId,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const SCRIPT = [
  '场景一：天台，黄昏。',
  '小美走上天台，风很大。',
  '小美：阿强，你到底来不来？',
  '旁白：那一天她等了很久。',
  '',
  '场景二：客户机房，深夜。',
  '阿强蹲在机柜前，手里攥着钥匙。',
  '阿强：找到了。',
].join('\n');

const parsed = parseScript(SCRIPT);

describe('parseScriptMentions', () => {
  it('抽取 @ 与 @! 提及，去重保序', () => {
    expect(parseScriptMentions('@小美 站在 @!天台，@小美 又转身')).toEqual(['小美', '天台']);
  });

  it('名字在空白或标点处终止', () => {
    expect(parseScriptMentions('（@钥匙）掉在 @机柜前，')).toEqual(['钥匙', '机柜前']);
  });

  it('没有提及时返回空数组', () => {
    expect(parseScriptMentions('小美走上天台。')).toEqual([]);
  });
});

describe('collectScriptElements — 角色', () => {
  it('角色来自对白说话人，旁白不算角色', () => {
    const { characters } = collectScriptElements(parsed, []);
    expect(characters.map((c) => c.name)).toEqual(['小美', '阿强']);
    expect(characters.some((c) => c.name === '旁白')).toBe(false);
  });

  it('记录角色出现在哪几场（升序去重）', () => {
    const { characters } = collectScriptElements(parsed, []);
    expect(characters.find((c) => c.name === '小美')!.sceneIndexes).toEqual([0]);
    expect(characters.find((c) => c.name === '阿强')!.sceneIndexes).toEqual([1]);
  });

  it('剧本里的角色没建标签 → 计入 newElements（分镜生成时会被新建）', () => {
    const { newElements } = collectScriptElements(parsed, []);
    expect(newElements.characters.map((c) => c.name)).toEqual(['小美', '阿强']);
  });

  it('已建标签且有默认参考图 → 不再计入 newElements 与 missingReference', () => {
    const tags = [tag('CHARACTER', '小美', 'asset-1'), tag('CHARACTER', '阿强')];
    const { characters, newElements, missingReference } = collectScriptElements(parsed, tags);
    expect(characters.find((c) => c.name === '小美')!.hasReference).toBe(true);
    expect(newElements.characters).toEqual([]);
    expect(missingReference.map((e) => e.name)).toContain('阿强');
    expect(missingReference.map((e) => e.name)).not.toContain('小美');
  });
});

describe('collectScriptElements — 场景（缺口二：即将新建的地点）', () => {
  it('剧本里写出的地点就是即将新建的场景标签', () => {
    const { scenes, newElements } = collectScriptElements(parsed, []);
    expect(scenes.map((s) => s.name)).toEqual(['天台', '客户机房']);
    // 用户不会自己意识到「客户机房」将被建成一个没有参考图的新场景——这正是要提醒的事
    expect(newElements.scenes.map((s) => s.name)).toEqual(['天台', '客户机房']);
    expect(newElements.scenes.every((s) => !s.hasReference)).toBe(true);
  });

  it('已建场景标签但没有参考图 → 落进 missingReference', () => {
    const { newElements, missingReference } = collectScriptElements(parsed, [tag('SCENE', '天台')]);
    expect(newElements.scenes.map((s) => s.name)).toEqual(['客户机房']);
    expect(missingReference.map((e) => e.name)).toContain('天台');
  });

  it('没有抬头的散文块不贡献场景要素（不编造地点）', () => {
    const prose = parseScript('这是一段没有场景抬头的散文。');
    expect(collectScriptElements(prose, []).scenes).toEqual([]);
  });
});

describe('collectScriptElements — 道具', () => {
  it('只认已建道具标签的字符串命中，不从散文里猜道具', () => {
    const { props } = collectScriptElements(parsed, [tag('PROP', '钥匙'), tag('PROP', '雨伞')]);
    expect(props.map((p) => p.name)).toEqual(['钥匙']); // 正文没写雨伞就不报
    expect(props[0]!.sceneIndexes).toEqual([1]);
  });

  it('没有任何道具标签时，正文里的名词不会被臆测成道具', () => {
    expect(collectScriptElements(parsed, []).props).toEqual([]);
  });
});

describe('collectScriptElements — @ 提及', () => {
  const annotated = parseScript(
    ['场景一：天台，黄昏。', '@小美 走上 @!天台，掏出 @钥匙。', '小美：终于到了。'].join('\n'),
  );

  it('标注过的要素 annotated=true，未标注的为 false', () => {
    const { characters, scenes, props } = collectScriptElements(annotated, [tag('PROP', '钥匙')]);
    expect(characters.find((c) => c.name === '小美')!.annotated).toBe(true);
    expect(scenes.find((s) => s.name === '天台')!.annotated).toBe(true);
    expect(props.find((p) => p.name === '钥匙')!.annotated).toBe(true);
  });

  it('未标注的要素落进 unannotated', () => {
    const { unannotated } = collectScriptElements(parsed, [tag('PROP', '钥匙')]);
    expect(unannotated.map((e) => e.name)).toEqual(['小美', '阿强', '天台', '客户机房', '钥匙']);
  });

  it('提及命中已建标签时以标签类型为准', () => {
    const withTag = parseScript('场景一：天台，黄昏。\n他掏出 @备用钥匙 。');
    const { props } = collectScriptElements(withTag, [tag('PROP', '备用钥匙')]);
    expect(props.map((p) => p.name)).toEqual(['备用钥匙']);
  });

  it('没有标签的孤儿提及：与地点同名判为场景，否则判为道具', () => {
    const orphan = parseScript('场景一：天台，黄昏。\n他站在 @天台 边，手里是 @青铜钥匙 。');
    const { scenes, props } = collectScriptElements(orphan, []);
    expect(scenes.map((s) => s.name)).toEqual(['天台']);
    expect(props.map((p) => p.name)).toEqual(['青铜钥匙']);
  });

  it('@ 一个还没建标签的角色，不该同时被报成同名道具', () => {
    // 「小美」是对白说话人，已按角色收录；孤儿提及的兜底规则不能再把它当道具报一遍，
    // 否则体检会提示"即将新建道具：小美"，用户会以为系统坏了
    const mentioned = parseScript(
      ['场景一：天台，黄昏。', '@小美 走上天台。', '小美：我在这儿。'].join('\n'),
    );
    const { props, characters } = collectScriptElements(mentioned, []);
    expect(characters.map((c) => c.name)).toEqual(['小美']);
    expect(props.map((p) => p.name)).toEqual([]);
  });
});

describe('detectImpliedScenes', () => {
  /** 抬头只有一条，戏却走到了别处 */
  const MOVING = parseScript(
    [
      '场景一：办公室，白天。',
      '小美收拾东西，走出办公室，来到顶楼天台。',
      '小美：终于结束了。',
    ].join('\n'),
  );

  it('报出动作行里换到的新地点，并带上原文作为证据', () => {
    const found = detectImpliedScenes(MOVING, new Set(['办公室']));
    expect(found.map((s) => s.name)).toEqual(['顶楼天台']);
    expect(found[0].sceneIndex).toBe(0);
    expect(found[0].evidence).toContain('顶楼天台');
  });

  it('抬头已经写过的地点不再报——那不是新场景', () => {
    expect(detectImpliedScenes(MOVING, new Set(['办公室', '天台']))).toEqual([]);
  });

  it('同一个地点出现多次只报一条', () => {
    const twice = parseScript(
      ['场景一：办公室，白天。', '他走进会议室。', '她也走进会议室。'].join('\n'),
    );
    expect(detectImpliedScenes(twice, new Set(['办公室'])).map((s) => s.name)).toEqual(['会议室']);
  });

  it('移动动词后面不是地点名词时不报——宁可漏掉也不制造噪音', () => {
    const noise = parseScript(
      ['场景一：办公室，白天。', '他走向她，回到从前的样子。'].join('\n'),
    );
    expect(detectImpliedScenes(noise, new Set(['办公室']))).toEqual([]);
  });

  it('只看动作行，台词里的地点不算——那是人物在说话，不是戏真的走过去了', () => {
    const inDialogue = parseScript(
      ['场景一：办公室，白天。', '小美：我们走进会议室再谈吧。'].join('\n'),
    );
    expect(detectImpliedScenes(inDialogue, new Set(['办公室']))).toEqual([]);
  });
});
