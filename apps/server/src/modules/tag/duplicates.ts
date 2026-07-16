// 重复标签检测：找出"语义相同但被拆成多个"的标签组（如「办公室内，白天。」「同一办公室，明亮清新。」）。
// 优先用已配置的文本模型做语义判重（这类判断 LLM 一眼准）；无可用模型时退回确定性启发式。
import type { PrismaClient, Tag } from '@prisma/client';
import { z } from 'zod';

export type TextGenFn = (prompt: string) => Promise<string>;

export interface DuplicateGroup {
  type: string;
  /** 组内标签（顺序即建议的合并方向：首个为建议保留的目标） */
  tags: Array<{ id: string; name: string }>;
  suggestedName: string;
}

const LlmGroupsSchema = z.object({
  groups: z.array(
    z.object({
      names: z.array(z.string()).min(2),
      suggestedName: z.string().min(1),
    }),
  ),
});

/** 归一化：去标点/空白，剥掉"同一/相同/还是/原/该"等指代前缀 */
export function normalizeTagName(name: string): string {
  return name
    .replace(/[\s，。；、,;.!？?！:：()（）【】\[\]"'`]/g, '')
    .replace(/^(同一个?|相同的?|还是|原来的?|原|该|这个?|那个?)/, '');
}

/**
 * 启发式判重（离线兜底）：同类型标签，归一化后一方包含另一方（公共部分 ≥ 2 字）即疑似同实体。
 * 例：「办公室内白天」vs「办公室明亮清新」→ 剥前缀后都含「办公室」前缀 → 按最长公共前缀 ≥ 3 判组。
 */
export function heuristicDuplicateGroups(tags: Tag[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const used = new Set<string>();
  const byType = new Map<string, Tag[]>();
  for (const t of tags) {
    byType.set(t.type, [...(byType.get(t.type) ?? []), t]);
  }
  const commonPrefixLen = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    return i;
  };
  for (const [type, list] of byType) {
    for (let i = 0; i < list.length; i++) {
      if (used.has(list[i].id)) continue;
      const normA = normalizeTagName(list[i].name);
      const group = [list[i]];
      for (let j = i + 1; j < list.length; j++) {
        if (used.has(list[j].id)) continue;
        const normB = normalizeTagName(list[j].name);
        const containment = normA.includes(normB) || normB.includes(normA);
        const prefix = commonPrefixLen(normA, normB);
        if ((containment && Math.min(normA.length, normB.length) >= 2) || prefix >= 3) {
          group.push(list[j]);
        }
      }
      if (group.length >= 2) {
        group.forEach((t) => used.add(t.id));
        // 建议名：组内归一化后最短的核心名
        const suggested = group
          .map((t) => normalizeTagName(t.name))
          .reduce((a, b) => (b.length < a.length ? b : a));
        groups.push({
          type,
          tags: group.map((t) => ({ id: t.id, name: t.name })),
          suggestedName: suggested,
        });
      }
    }
  }
  return groups;
}

function buildDedupPrompt(tags: Tag[]): string {
  const byType = (type: string, label: string) =>
    `${label}：${tags.filter((t) => t.type === type).map((t) => `「${t.name}」`).join('、') || '（无）'}`;
  return [
    '你是漫剧平台的标签管理员。下面是一个项目的标签清单，标签是全剧形象一致性的锚点，同一实体必须只有一个标签。',
    '请找出【指同一实体但名字不同】的标签组（例：「办公室内，白天。」「同一办公室，明亮清新。」都指同一间办公室；时间/光线/氛围差异不构成不同实体）。',
    '注意：不同实体不要合并（「办公室」和「会议室」是两个地点；「小悟」和「小空」是两个角色）。',
    byType('CHARACTER', '角色'),
    byType('SCENE', '场景'),
    byType('PROP', '道具'),
    '只输出 JSON：{"groups":[{"names":["原名1","原名2"],"suggestedName":"建议的简短标签名（≤6字，无标点）"}]}；没有重复则输出 {"groups":[]}。',
  ].join('\n');
}

/**
 * 检测项目内的疑似重复标签组。
 * textGen 可用 → LLM 语义判重（结果与项目标签求交集校验，防幻觉名字）；
 * 不可用/失败 → 启发式兜底。
 */
export async function findDuplicateTagGroups(
  db: PrismaClient,
  projectId: string,
  textGen: TextGenFn | null,
): Promise<{ groups: DuplicateGroup[]; method: 'llm' | 'heuristic' }> {
  const tags = await db.tag.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  if (tags.length < 2) return { groups: [], method: 'heuristic' };

  if (textGen) {
    try {
      const raw = await textGen(buildDedupPrompt(tags));
      const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      const parsed = LlmGroupsSchema.parse(JSON.parse((fenced ? fenced[1] : raw).trim()));
      const byName = new Map(tags.map((t) => [t.name, t]));
      const groups: DuplicateGroup[] = [];
      for (const g of parsed.groups) {
        // 防幻觉：只保留真实存在的标签名，且同组必须同类型
        const real = g.names.map((n) => byName.get(n)).filter((t): t is Tag => !!t);
        const types = new Set(real.map((t) => t.type));
        if (real.length >= 2 && types.size === 1) {
          groups.push({
            type: real[0].type,
            tags: real.map((t) => ({ id: t.id, name: t.name })),
            suggestedName: g.suggestedName.slice(0, 12),
          });
        }
      }
      return { groups, method: 'llm' };
    } catch {
      // LLM 不可用/输出异常 → 兜底
    }
  }
  return { groups: heuristicDuplicateGroups(tags), method: 'heuristic' };
}
