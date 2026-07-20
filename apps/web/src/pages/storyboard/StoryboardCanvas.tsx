// 故事板画布：按场景分组铺开镜头卡，支持拖拽与键盘改序。
//
// 关于"为什么拖完不立刻提交"：服务端每次 apply-patch 都会产出一个新的 Storyboard
// 版本，并全量复制 Shot/Take/Binding/DubbingLine。用户调整顺序时往往连拖五六次，
// 一次一提交就是五六个版本、五六份全量复制，代价高得离谱。所以这里只改本地顺序，
// 顶部出现「保存 / 放弃」条，攒够了一次性发一个 reorder。
//
// 关于"为什么本地顺序必须由本组件独占持有"：待提交顺序是一串 shotId，而 shotId 只在
// 单个版本内有效——任何一次 patch（别处的对话式改分镜、另一个标签页、自己刚提交的这次）
// 都会让全部 Shot 换新 cuid。所以本地顺序必须和产生它的版本绑死：versionKey 一变就作废。
//
// 本组件纯展示 + 本地交互，不发任何请求。

import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Space, Tooltip, Typography } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { ShotCard, type ShotCardShot } from './ShotCard';
import { SURFACE } from './workspace-surface';

const { Text } = Typography;

/** 没有 sceneId 的镜头（对话式 add_shot 不带 sceneRef 时会产生）落在这个兜底分组里 */
const UNASSIGNED_KEY = '__unassigned__';

export interface StoryboardCanvasGroup {
  /** null = 未归属任何场景，画布把它们收进末尾的兜底分组，绝不丢弃 */
  sceneId: string | null;
  /** 面向用户的场次号，从 1 起（与 SceneRailScene.index 同一口径，直接显示不再 +1） */
  sceneIndex: number | null;
  sceneTitle: string;
  shots: ShotCardShot[];
}

/** 插入位指示线的落点：某张卡的前面或后面 */
interface DropMark {
  shotId: string;
  side: 'before' | 'after';
}

function groupKey(group: StoryboardCanvasGroup): string {
  return group.sceneId ?? UNASSIGNED_KEY;
}

/** 把分组结构拍平成一条镜头 id 序列——reorder op 要求全量新序 */
function flatten(groups: StoryboardCanvasGroup[]): string[] {
  return groups.flatMap((g) => g.shots.map((s) => s.id));
}

/**
 * 把待提交顺序套回 props 分组上。
 * 只做组内重排：移动本来就限制在组内，未出现在 order 里的镜头（理论上不该有）
 * 保持原位而不是被丢掉——宁可顺序不完美，也不能让镜头从画布上消失。
 */
function applyOrder(
  groups: StoryboardCanvasGroup[],
  order: string[],
): StoryboardCanvasGroup[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return groups.map((g) => ({
    ...g,
    shots: g.shots
      // 排在 order 之后（order 的名次是 0..order.length-1），并按原下标升序保持彼此的相对位置。
      // 用 MAX_SAFE_INTEGER - fallback 会让原本靠后的反而排到前面，把它们整体倒序。
      .map((shot, fallback) => ({ shot, key: rank.get(shot.id) ?? order.length + fallback }))
      .sort((a, b) => a.key - b.key)
      .map((entry) => entry.shot),
  }));
}

/**
 * 在组内把 fromId 移动到 toId 的前/后，然后重新拍平整体顺序。
 * 只允许组内移动：reorder 改不了 shot.sceneId，跨组拖只会让镜头在全局序列里
 * 跳到别处、却仍旧显示在原场景分组下，是纯粹的误导。
 */
function moveWithinGroup(
  groups: StoryboardCanvasGroup[],
  groupIndex: number,
  fromId: string,
  mark: DropMark,
): string[] | null {
  const shots = groups[groupIndex].shots;
  const from = shots.findIndex((s) => s.id === fromId);
  const anchor = shots.findIndex((s) => s.id === mark.shotId);
  if (from < 0 || anchor < 0 || fromId === mark.shotId) return null;

  const next = shots.slice();
  const [moved] = next.splice(from, 1);
  // 摘掉自己之后锚点可能左移一格，重新定位再插
  const anchorAfterRemoval = next.findIndex((s) => s.id === mark.shotId);
  next.splice(mark.side === 'before' ? anchorAfterRemoval : anchorAfterRemoval + 1, 0, moved);

  if (next.every((s, i) => s.id === shots[i].id)) return null;
  return flatten(groups.map((g, i) => (i === groupIndex ? { ...g, shots: next } : g)));
}

/** 组内相对移动 delta 格（键盘/按钮兜底用） */
function nudge(
  groups: StoryboardCanvasGroup[],
  shotId: string,
  delta: number,
): string[] | null {
  const groupIndex = groups.findIndex((g) => g.shots.some((s) => s.id === shotId));
  if (groupIndex < 0) return null;
  const shots = groups[groupIndex].shots;
  const from = shots.findIndex((s) => s.id === shotId);
  const to = from + delta;
  if (to < 0 || to >= shots.length) return null;

  const next = shots.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return flatten(groups.map((g, i) => (i === groupIndex ? { ...g, shots: next } : g)));
}

export function StoryboardCanvas({
  versionKey,
  groups,
  ratio,
  selectedSceneId,
  selectedShotId,
  onSelectShot,
  onPendingOrderChange,
  onCommitOrder,
  committing,
}: {
  /** 当前分镜版本标识（集成方传 storyboardId）。变了就意味着所有 shotId 已作废 */
  versionKey: string;
  groups: StoryboardCanvasGroup[];
  ratio: string;
  /** 左栏选中的场景，画布把对应分组滚进视野并高亮标题 */
  selectedSceneId: string | null;
  selectedShotId: string | null;
  onSelectShot: (shotId: string) => void;
  /** 待提交顺序变化时通知集成方（用于离开页面前的拦截等），null = 已无未保存改动 */
  onPendingOrderChange?: (nextShotIdsInOrder: string[] | null) => void;
  onCommitOrder: (nextShotIdsInOrder: string[]) => void;
  committing: boolean;
}) {
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  // 版本换了但改动是"自己刚提交的那次"造成的，属于预期内，不该报作废
  const [staleDiscarded, setStaleDiscarded] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropMark, setDropMark] = useState<DropMark | null>(null);
  // 被拖走的卡自身会连发 dragleave/dragenter，用 ref 记住源组避免跨组落点被采纳
  const dragGroupIndex = useRef<number>(-1);
  const knownVersion = useRef(versionKey);
  const committedByUs = useRef(false);
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  // 排序期间禁止一切改序交互：此刻提交的 id 列表随时可能因为服务端返回新版本而作废，
  // 让用户继续拖只会在下一秒被无条件丢掉。
  const sortingLocked = committing;

  // 版本一变，手上这串 shotId 指向的镜头已经不存在了，无条件从 props 重来。
  // 渲染期做而不是放进 effect：晚一帧就会拿旧 order 去套新 groups，排出错误画面。
  if (knownVersion.current !== versionKey) {
    knownVersion.current = versionKey;
    const wasOurs = committedByUs.current;
    committedByUs.current = false;
    if (pendingOrder !== null) {
      setPendingOrder(null);
      setStaleDiscarded(!wasOurs);
    }
  }

  // 提交失败（版本没换、loading 落回）时把"这次是我提交的"标记清掉，
  // 否则之后别处来的 patch 会被误判成自己的结果，把作废提示吞掉。
  useEffect(() => {
    if (!committing) committedByUs.current = false;
  }, [committing]);

  // 待提交顺序的对外通知走 effect：版本作废时的重置发生在渲染期，
  // 在那里直接回调父组件会在 React 渲染过程中改别人的 state。
  const pendingListener = useRef(onPendingOrderChange);
  pendingListener.current = onPendingOrderChange;
  useEffect(() => {
    pendingListener.current?.(pendingOrder);
  }, [pendingOrder]);

  const displayGroups = pendingOrder === null ? groups : applyOrder(groups, pendingOrder);

  useEffect(() => {
    if (selectedSceneId === null) return;
    const node = sectionRefs.current.get(selectedSceneId);
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selectedSceneId]);

  const selectedMovable =
    selectedShotId === null
      ? null
      : (displayGroups.find((g) => g.shots.some((s) => s.id === selectedShotId)) ?? null);
  const selectedPos =
    selectedMovable === null || selectedShotId === null
      ? -1
      : selectedMovable.shots.findIndex((s) => s.id === selectedShotId);

  const applyNudge = (delta: number) => {
    if (sortingLocked || selectedShotId === null) return;
    const next = nudge(displayGroups, selectedShotId, delta);
    if (next !== null) setPendingOrder(next);
  };

  const clearDrag = () => {
    setDraggingId(null);
    setDropMark(null);
    dragGroupIndex.current = -1;
  };

  const totalShots = displayGroups.reduce((n, g) => n + g.shots.length, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: SURFACE.space.xs,
          paddingBottom: SURFACE.space.xs,
          flexShrink: 0,
        }}
      >
        <Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
          共 {totalShots} 个镜头 · {displayGroups.length} 场
        </Text>
        {/* 原生拖拽对触控板和读屏软件都不友好，必须有等价的按钮路径 */}
        <Space.Compact>
          <Tooltip title="选中镜头左移（快捷键 ←）">
            <Button
              size="small"
              icon={<LeftOutlined />}
              disabled={sortingLocked || selectedPos <= 0}
              onClick={() => applyNudge(-1)}
            />
          </Tooltip>
          <Tooltip title="选中镜头右移（快捷键 →）">
            <Button
              size="small"
              icon={<RightOutlined />}
              disabled={
                sortingLocked ||
                selectedMovable === null ||
                selectedPos < 0 ||
                selectedPos >= selectedMovable.shots.length - 1
              }
              onClick={() => applyNudge(1)}
            />
          </Tooltip>
        </Space.Compact>
      </div>

      {staleDiscarded ? (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setStaleDiscarded(false)}
          style={{ marginBottom: SURFACE.space.xs, flexShrink: 0 }}
          message="分镜已更新，你的排序改动已作废"
          description="别处提交了一次改动，画布上的镜头已全部换新，未保存的顺序无法再套用，请在新版本上重新调整。"
        />
      ) : null}

      {pendingOrder !== null ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: SURFACE.space.xs, flexShrink: 0 }}
          message="顺序已改动，尚未保存"
          description="保存会生成一个新的分镜版本，建议一次调整到位再提交。"
          action={
            <Space>
              <Button size="small" onClick={() => setPendingOrder(null)} disabled={committing}>
                放弃
              </Button>
              <Button
                size="small"
                type="primary"
                loading={committing}
                onClick={() => {
                  committedByUs.current = true;
                  onCommitOrder(pendingOrder);
                }}
              >
                保存顺序
              </Button>
            </Space>
          }
        />
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {totalShots === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有镜头"
            style={{ marginTop: 60 }}
          />
        ) : (
          displayGroups.map((group, groupIndex) => {
            const key = groupKey(group);
            const sceneSelected = group.sceneId !== null && group.sceneId === selectedSceneId;
            return (
              <section
                key={key}
                ref={(node) => {
                  if (node === null) sectionRefs.current.delete(key);
                  else sectionRefs.current.set(key, node);
                }}
                style={{ marginBottom: SURFACE.space.md }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: SURFACE.space.xs,
                    marginBottom: SURFACE.space.xs,
                    position: 'sticky',
                    top: 0,
                    zIndex: 1,
                    // 选中场景的分组头做浅紫底 + 左侧色条，和左栏的选中态呼应，
                    // 滚动落点才有"到了"的确认感
                    background: sceneSelected ? SURFACE.primarySoft : SURFACE.bg,
                    borderInlineStart: `3px solid ${sceneSelected ? SURFACE.primary : 'transparent'}`,
                    borderRadius: SURFACE.radius.sm,
                    padding: '4px 8px',
                  }}
                >
                  <Text
                    strong
                    style={{ fontSize: 13, color: sceneSelected ? SURFACE.primary : SURFACE.text }}
                  >
                    {group.sceneIndex === null ? '未归属场景' : `第 ${group.sceneIndex} 场`}
                  </Text>
                  <Text ellipsis style={{ flex: 1, minWidth: 0, fontSize: 13, color: SURFACE.text }}>
                    {group.sceneIndex === null
                      ? '这些镜头还没挂到任何场景上'
                      : group.sceneTitle.trim() === ''
                        ? '未命名场景'
                        : group.sceneTitle}
                  </Text>
                  <Text style={{ fontSize: 12, color: SURFACE.textTertiary }}>
                    {group.shots.length} 镜
                  </Text>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                    gap: 12,
                  }}
                >
                  {group.shots.map((shot) => {
                    const mark = dropMark !== null && dropMark.shotId === shot.id ? dropMark : null;
                    return (
                      <div key={shot.id} style={{ position: 'relative' }}>
                        {mark !== null ? (
                          <div
                            style={{
                              position: 'absolute',
                              top: -4,
                              bottom: -4,
                              insetInlineStart: mark.side === 'before' ? -7 : undefined,
                              insetInlineEnd: mark.side === 'after' ? -7 : undefined,
                              width: 3,
                              borderRadius: 2,
                              background: SURFACE.primary,
                              pointerEvents: 'none',
                              zIndex: 2,
                            }}
                          />
                        ) : null}
                        <ShotCard
                          shot={shot}
                          ratio={ratio}
                          selected={selectedShotId === shot.id}
                          onSelect={() => onSelectShot(shot.id)}
                          dragHandlers={{
                            draggable: !sortingLocked,
                            style: { opacity: draggingId === shot.id ? 0.4 : 1 },
                            onDragStart: (e) => {
                              if (sortingLocked) {
                                e.preventDefault();
                                return;
                              }
                              setDraggingId(shot.id);
                              dragGroupIndex.current = groupIndex;
                              e.dataTransfer.effectAllowed = 'move';
                              // Firefox 不设 data 就不触发后续 drag 事件
                              e.dataTransfer.setData('text/plain', shot.id);
                            },
                            onDragEnd: clearDrag,
                            onDragOver: (e) => {
                              if (sortingLocked || draggingId === null) return;
                              if (dragGroupIndex.current !== groupIndex) return;
                              e.preventDefault();
                              e.dataTransfer.dropEffect = 'move';
                              const rect = e.currentTarget.getBoundingClientRect();
                              const side =
                                e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
                              setDropMark((prev) =>
                                prev !== null && prev.shotId === shot.id && prev.side === side
                                  ? prev
                                  : { shotId: shot.id, side },
                              );
                            },
                            onDrop: (e) => {
                              e.preventDefault();
                              if (sortingLocked) return clearDrag();
                              if (draggingId === null || dropMark === null) return clearDrag();
                              if (dragGroupIndex.current !== groupIndex) return clearDrag();
                              const next = moveWithinGroup(
                                displayGroups,
                                groupIndex,
                                draggingId,
                                dropMark,
                              );
                              clearDrag();
                              if (next !== null) setPendingOrder(next);
                            },
                            onKeyDown: (e) => {
                              if (selectedShotId !== shot.id) return;
                              if (e.key === 'ArrowLeft') {
                                e.preventDefault();
                                applyNudge(-1);
                              } else if (e.key === 'ArrowRight') {
                                e.preventDefault();
                                applyNudge(1);
                              }
                            },
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
