// 剧本要素归集：把「剧本正文里出现了什么」与「项目里已经建了什么标签」对齐成一张表。
//
// 【为什么需要这一层】分镜规划之前，用户唯一能看见的是正文；而真正决定画面稳定性的是
// 标签与参考图。两者之间此前没有任何映射，用户只能等分镜生成出来再回头补图。
// 这个模块把二者摊平成 ScriptElement 列表，体检与视觉确认都读它，口径只有一份。
//
// 【@ 标注的语义与服务端一致】见 apps/server/src/modules/generation/executors.ts 的 parseMentions：
// @角色 / @道具 = 名字锚定 + 参考图必发；@场景 = 仅文字锚定；@!场景 = 强制发参考图。
// 这里只关心"有没有被标注"，不关心 force——force 影响的是生成时发不发图，不影响规划期的清单。

import type { TagEntity } from '../api/design-hooks';
import type { ParsedScript } from './script-parse';

export type ScriptElementType = 'CHARACTER' | 'SCENE' | 'PROP';

export interface ScriptElement {
  type: ScriptElementType;
  name: string;
  /** 已建标签的 id；null = 正文里出现但项目标签里还没有，分镜生成时会被新建 */
  tagId: string | null;
  /** 标签描述（角色服装、道具材质等就写在这里）；无标签时为空串 */
  description: string;
  /** 是否已有默认参考图（canonicalAssetId）。无标签一律视为没有 */
  hasReference: boolean;
  /** 正文里是否出现过 @名字 形式的标注 */
  annotated: boolean;
  /** 出现在哪几场（0-based，升序去重）。散文块也算一"场" */
  sceneIndexes: number[];
}

/** 按类型分组的三元组，避免调用方到处写 filter */
export interface ScriptElementGroups {
  characters: ScriptElement[];
  scenes: ScriptElement[];
  props: ScriptElement[];
}

export interface ScriptElements extends ScriptElementGroups {
  /** 三类合并，保序：角色 → 场景 → 道具 */
  all: ScriptElement[];
  /** 即将新建的标签（tagId === null），分镜生成时由服务端 findOrCreateTags 补建 */
  newElements: ScriptElementGroups;
  /** 缺参考图的要素：既包含已建但没图的，也包含即将新建的（新建的必然没图） */
  missingReference: ScriptElement[];
  /** 正文里没有被 @ 标注的要素 */
  unannotated: ScriptElement[];
}

/**
 * 与服务端 MENTION_RE 逐字一致的提及正则。
 * 【为什么要一致】前端提示"这些要素已标注"而服务端解析不出同一批名字，
 * 用户会以为标注失效——两边的分词规则必须同源。
 */
const MENTION_RE = /@(!?)([^\s@!，。；、,;.!？?！:：()（）【】[\]"'`]+)/g;

/** 抽取正文里的全部 @ 提及名（去重保序） */
export function parseScriptMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const name = m[2].trim();
    if (name !== '' && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 累加器：同名要素只保留一条，场景下标合并 */
interface Draft {
  type: ScriptElementType;
  name: string;
  sceneIndexes: Set<number>;
  annotated: boolean;
}

function touch(
  map: Map<string, Draft>,
  type: ScriptElementType,
  name: string,
  sceneIndex: number | null,
  annotated: boolean,
): void {
  const trimmed = name.trim();
  if (trimmed === '') return;
  // key 带类型：同名的场景标签与道具标签是两个要素（「病房」既可以是地点也可以是道具时不该合并）
  const key = `${type}:${trimmed}`;
  const found = map.get(key);
  if (found) {
    if (sceneIndex !== null) found.sceneIndexes.add(sceneIndex);
    if (annotated) found.annotated = true;
    return;
  }
  map.set(key, {
    type,
    name: trimmed,
    sceneIndexes: new Set(sceneIndex === null ? [] : [sceneIndex]),
    annotated,
  });
}

/**
 * 归集剧本要素。
 *
 * 识别口径（宁可少报不可乱报——一份会误报的清单用户看两次就不看了）：
 * - 角色：解析器给出的 scene.characters（对白说话人，已剔除旁白），外加 @ 提及中命中角色标签的名字；
 * - 场景：每一场的 location（缺失时回落 title），外加正文里出现的已建场景标签、@ 提及命中的场景标签；
 * - 道具：正文里出现的已建道具标签（朴素 includes，与场景检查器同口径），外加 @ 提及。
 * - 未命中任何已建标签的 @ 提及：与某一场的地点/标题同名判为场景，否则判为道具。
 *   （角色不走这条——角色由对白说话人认定，比猜准得多。）
 */
export function collectScriptElements(parsed: ParsedScript, tags: TagEntity[]): ScriptElements {
  const fullText = parsed.scenes.map((s) => s.text).join('\n');
  const mentions = parseScriptMentions(fullText);
  const mentionSet = new Set(mentions);

  const tagByKey = new Map(tags.map((t) => [`${t.type}:${t.name}`, t]));
  const tagByName = new Map(tags.map((t) => [t.name, t]));

  const drafts = new Map<string, Draft>();

  // 1) 角色：来自对白说话人
  for (const scene of parsed.scenes) {
    for (const name of scene.characters) {
      touch(drafts, 'CHARACTER', name, scene.index, mentionSet.has(name));
    }
  }

  // 2) 场景：每场的地点（没有地点就用标题，两者本就同源；都没有则这一场不贡献场景要素）
  for (const scene of parsed.scenes) {
    const place = scene.location !== '' ? scene.location : scene.title;
    if (place !== '') touch(drafts, 'SCENE', place, scene.index, mentionSet.has(place));
  }
  /** 正文里出现过的地点集合，用来给"孤儿 @ 提及"定类型 */
  const placeNames = new Set(
    parsed.scenes
      .map((s) => (s.location !== '' ? s.location : s.title))
      .filter((p) => p !== ''),
  );

  // 3) 已建的场景/道具标签在正文里被提到：逐场判断出现位置，这样清单能说清"第几场用到"
  for (const tag of tags) {
    if (tag.name === '') continue;
    if (tag.type !== 'SCENE' && tag.type !== 'PROP') continue;
    for (const scene of parsed.scenes) {
      if (scene.text.includes(tag.name)) {
        touch(drafts, tag.type, tag.name, scene.index, mentionSet.has(tag.name));
      }
    }
  }

  // 4) @ 提及里没被上面任何一条覆盖到的名字
  for (const name of mentions) {
    const tag = tagByName.get(name);
    /**
     * 上面三步已经收录过这个名字时沿用既有类型，不再走兜底猜测。
     * 【为什么必须先看这一条】@一个还没建标签的角色（如 `@小美`，小美同时是对白说话人）
     * 会掉进"猜不出就当道具"的兜底里，于是同一个名字既是角色又是道具，
     * 体检会提示"即将新建道具：小美"——用户只会以为系统坏了。
     */
    const collected = (['CHARACTER', 'SCENE', 'PROP'] as const).find((t) =>
      drafts.has(`${t}:${name}`),
    );
    const type: ScriptElementType = tag
      ? (tag.type as ScriptElementType)
      : (collected ?? (placeNames.has(name) ? 'SCENE' : 'PROP'));
    if (type !== 'CHARACTER' && type !== 'SCENE' && type !== 'PROP') continue;
    // 找出它出现在哪几场；一处都找不到（理论上不可能）也要登记，只是没有场次
    let matched = false;
    for (const scene of parsed.scenes) {
      if (scene.text.includes(`@${name}`) || scene.text.includes(`@!${name}`)) {
        touch(drafts, type, name, scene.index, true);
        matched = true;
      }
    }
    if (!matched) touch(drafts, type, name, null, true);
  }

  const materialize = (d: Draft): ScriptElement => {
    const tag = tagByKey.get(`${d.type}:${d.name}`) ?? null;
    return {
      type: d.type,
      name: d.name,
      tagId: tag?.id ?? null,
      description: tag?.description ?? '',
      hasReference: tag?.canonicalAssetId != null,
      annotated: d.annotated,
      sceneIndexes: [...d.sceneIndexes].sort((a, b) => a - b),
    };
  };

  const items = [...drafts.values()].map(materialize);
  const characters = items.filter((e) => e.type === 'CHARACTER');
  const scenes = items.filter((e) => e.type === 'SCENE');
  const props = items.filter((e) => e.type === 'PROP');
  const all = [...characters, ...scenes, ...props];

  return {
    characters,
    scenes,
    props,
    all,
    newElements: {
      characters: characters.filter((e) => e.tagId === null),
      scenes: scenes.filter((e) => e.tagId === null),
      props: props.filter((e) => e.tagId === null),
    },
    missingReference: all.filter((e) => !e.hasReference),
    unannotated: all.filter((e) => !e.annotated),
  };
}
