// 分镜工作台左栏：场景导航（220px 固定宽）。
//
// 纯展示组件，不发请求——镜头数、时长、出图数都由集成方按 shot.sceneId 分组算好传进来。
// 这样它在「故事板」和「镜头表」两个视图下是同一个组件，选中态也只有一份真相。

import { SURFACE } from './workspace-surface';

export interface SceneRailScene {
  id: string;
  /**
   * 面向用户的场次号，从 1 起——直接显示，不再 +1。
   * 【为什么写死这条】工作台的四个组件里 index/sceneIndex 曾经一半按 0 起、一半按 1 起，
   * 于是同一个场景在左栏是 S02、在画布是「第 2 场」，而它其实是第 1 场。
   * 这类偏移只在真跑起来才看得见，类型系统一个字都拦不住。
   */
  index: number;
  title: string;
  location: string;
  shotCount: number;
  durationMs: number;
  /** 已出图（有关键帧）的镜头数 */
  hasKeyframes: number;
}

/** 场次标题回退链：标题 → 地点 → 未命名。空串是"未填"，库里这些列不为 null */
function displayTitle(scene: SceneRailScene): string {
  if (scene.title.trim() !== '') return scene.title.trim();
  if (scene.location.trim() !== '') return scene.location.trim();
  return '未命名';
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

type SceneProgress = { color: string; label: string; hollow: boolean };

/**
 * 状态点表达的是"这一场推进到哪了"。
 * 空场景单独一档且用空心点——一个镜头都没有的场次是分镜规划漏掉的地方，
 * 混在「待出图」里会被当成正常待办而永远没人回头看。
 */
function deriveProgress(scene: SceneRailScene): SceneProgress {
  if (scene.shotCount === 0) return { color: SURFACE.warning, label: '无镜头', hollow: true };
  if (scene.hasKeyframes === 0) return { color: SURFACE.textTertiary, label: '待出图', hollow: false };
  if (scene.hasKeyframes < scene.shotCount) {
    return { color: SURFACE.primary, label: `${scene.hasKeyframes}/${scene.shotCount} 已出图`, hollow: false };
  }
  return { color: SURFACE.success, label: '已出图', hollow: false };
}

export function SceneRail({
  scenes,
  selectedSceneId,
  onSelect,
}: {
  scenes: SceneRailScene[];
  selectedSceneId: string | null;
  onSelect: (sceneId: string) => void;
}): JSX.Element {
  return (
    <nav
      aria-label="场景导航"
      style={{
        width: SURFACE.railWidth,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: SURFACE.bgElevated,
        borderInlineEnd: `1px solid ${SURFACE.border}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          padding: `${SURFACE.space.xs}px ${SURFACE.space.sm}px`,
          borderBottom: `1px solid ${SURFACE.border}`,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: SURFACE.text }}>场景</span>
        <span style={{ fontSize: 12, color: SURFACE.textTertiary }}>{scenes.length} 场</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: SURFACE.space.xs }}>
        {scenes.length === 0 ? (
          <p
            style={{
              margin: 0,
              padding: SURFACE.space.sm,
              fontSize: 12,
              lineHeight: 1.6,
              color: SURFACE.textTertiary,
            }}
          >
            这一版分镜没有场景数据。先在剧本阶段拆场，再重新生成分镜。
          </p>
        ) : (
          scenes.map((scene) => {
            const selected = scene.id === selectedSceneId;
            const progress = deriveProgress(scene);
            const empty = scene.shotCount === 0;
            return (
              <button
                key={scene.id}
                type="button"
                aria-current={selected}
                onClick={() => onSelect(scene.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'start',
                  cursor: 'pointer',
                  font: 'inherit',
                  padding: SURFACE.space.xs,
                  marginBottom: SURFACE.space.xs,
                  borderRadius: SURFACE.radius.sm,
                  border: `1px solid ${selected ? SURFACE.primaryBorder : 'transparent'}`,
                  background: selected ? SURFACE.primarySoft : 'transparent',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: SURFACE.space.xs }}>
                  <span
                    style={{
                      fontSize: 12,
                      fontVariantNumeric: 'tabular-nums',
                      color: selected ? SURFACE.primary : SURFACE.textTertiary,
                    }}
                  >
                    S{String(scene.index).padStart(2, '0')}
                  </span>
                  <span
                    title={displayTitle(scene)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 13,
                      fontWeight: selected ? 600 : 400,
                      color: SURFACE.text,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {displayTitle(scene)}
                  </span>
                  <span
                    title={progress.label}
                    aria-hidden
                    style={{
                      flexShrink: 0,
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: progress.hollow ? 'transparent' : progress.color,
                      border: progress.hollow ? `1.5px solid ${progress.color}` : 'none',
                    }}
                  />
                </span>
                <span
                  style={{
                    display: 'block',
                    marginTop: 2,
                    fontSize: 11,
                    color: empty ? SURFACE.warning : SURFACE.textSecondary,
                  }}
                >
                  {empty ? '还没有镜头' : `${scene.shotCount} 镜 · ${formatDuration(scene.durationMs)}`}
                  {empty ? '' : ` · ${progress.label}`}
                </span>
              </button>
            );
          })
        )}
      </div>
    </nav>
  );
}
