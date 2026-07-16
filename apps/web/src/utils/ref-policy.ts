/**
 * 参考位策略（前端镜像，与服务端 generation/executors.ts 同一套规则）：
 * - 提示词含 @ → 引用由 @ 决定：@角色/@道具 上参考位；@场景 仅文字锚定；@!场景 强制上参考位；
 * - 无 @ → 自动策略：角色/道具的绑定图全部上参考位，场景图仅在没有任何角色参考（空镜）时上。
 * 素材页每格的"参考位状态"与分镜页"将用参考"预览都由本模块计算，保证三处口径一致。
 */
import type { ResolvedBindingCell } from '../api/design-hooks';

export interface Mention {
  name: string;
  force: boolean;
}

const MENTION_RE = /@(!?)([^\s@!，。；、,;.!？?！:：()（）【】[\]"'`]+)/g;

export function parseMentions(prompt: string): Mention[] {
  const mentions: Mention[] = [];
  for (const m of (prompt || '').matchAll(MENTION_RE)) {
    const name = m[2].trim();
    if (name && !mentions.some((x) => x.name === name)) {
      mentions.push({ name, force: m[1] === '!' });
    }
  }
  return mentions;
}

export type RefParticipation =
  | 'ref' // 上参考位（发给模型的参考图）
  | 'text-anchor' // 仅文字锚定（@场景 未强制）
  | 'unreferenced' // 提示词有 @ 清单但未包含该标签
  | 'no-image'; // 该标签无可用图（未绑定且无默认设计图）

/** 计算镜头内每个标签格的参考位状态 */
export function computeParticipation(
  imagePrompt: string,
  cells: ResolvedBindingCell[],
): Map<string, RefParticipation> {
  const result = new Map<string, RefParticipation>();
  const mentions = parseMentions(imagePrompt);

  if (mentions.length > 0) {
    for (const cell of cells) {
      const mention = mentions.find((m) => m.name === cell.name);
      if (!mention) {
        result.set(cell.tagId, 'unreferenced');
      } else if (!cell.resolved) {
        result.set(cell.tagId, 'no-image');
      } else if (cell.type === 'SCENE' && !mention.force) {
        result.set(cell.tagId, 'text-anchor');
      } else {
        result.set(cell.tagId, 'ref');
      }
    }
    return result;
  }

  // 自动策略
  const withImage = cells.filter((c) => c.resolved);
  const hasCharacterRef = withImage.some((c) => c.type !== 'SCENE');
  for (const cell of cells) {
    if (!cell.resolved) {
      result.set(cell.tagId, 'no-image');
    } else if (cell.type === 'SCENE' && hasCharacterRef) {
      result.set(cell.tagId, 'text-anchor');
    } else {
      result.set(cell.tagId, 'ref');
    }
  }
  return result;
}

/** 分镜页"将用参考"预览：按策略选出实际会发的参考格（保持顺序） */
export function chooseRefCells(imagePrompt: string, cells: ResolvedBindingCell[]): {
  chosen: ResolvedBindingCell[];
  modeNote: string;
} {
  const mentions = parseMentions(imagePrompt);
  if (mentions.length > 0) {
    const chosen = mentions
      .map(({ name, force }) => {
        const cell = cells.find((c) => c.name === name);
        if (!cell?.resolved) return null;
        if (cell.type === 'SCENE' && !force) return null;
        return cell;
      })
      .filter((c): c is ResolvedBindingCell => !!c);
    return { chosen, modeNote: '由提示词中的 @ 指定（@场景 仅锚定文字，@!场景 才发参考图）' };
  }
  const withRef = cells.filter((c) => c.resolved);
  const characters = withRef.filter((c) => c.type !== 'SCENE');
  return {
    chosen: characters.length > 0 ? characters : withRef,
    modeNote: '自动（角色设计图优先，场景图不占参考位，可用 @ 调整）',
  };
}
