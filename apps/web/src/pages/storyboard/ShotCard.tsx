// 故事板镜头卡（视觉优先）。
//
// 这张卡是对旧版"文字墙卡片"的正面回应：旧卡把原文、完整生图提示词、模型、
// 比例全平铺在卡面上，最显眼的东西是提示词——而导演翻分镜时想看的是画面。
// 所以这里卡面上只留能一眼扫过的东西：关键图、镜号、时长、景别、状态、锁。
// 提示词一个字都不在卡面出现，它属于右侧检查器的「高级设置」。

import { useRef, useState } from 'react';
import { LockOutlined } from '@ant-design/icons';
import { Typography, theme } from 'antd';
import { SURFACE } from './workspace-surface';

const { Text } = Typography;

export interface ShotCardShot {
  id: string;
  index: number;
  durationMs: number;
  shotSize: string;
  imageUrl: string | null;
  status: 'none' | 'generating' | 'ready' | 'stale';
  locked: boolean;
}

const STATUS_META: Record<ShotCardShot['status'], { color: string; label: string }> = {
  none: { color: '#8c8c8c', label: '未出图' },
  generating: { color: '#1668dc', label: '生成中' },
  ready: { color: '#52c41a', label: '已出图' },
  stale: { color: '#fa8c16', label: '待更新' },
};

/**
 * '16:9' → '16 / 9'。占位块必须按真实画幅留白，
 * 否则用户在"还没出图"阶段看到的构图比例是假的，选比例这一步就失去了预览意义。
 * 解析不出来时退回 16:9，而不是塌成方块。
 */
export function parseRatio(ratio: string): string {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)\s*$/.exec(ratio);
  if (!m) return '16 / 9';
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!(w > 0) || !(h > 0)) return '16 / 9';
  return `${w} / ${h}`;
}

/** 时长展示到 0.1 秒：分镜里大量镜头是 1~3 秒，取整会让它们看起来一样长 */
function formatShotDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const seconds = ms / 1000;
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}'${String(Math.round(seconds % 60)).padStart(2, '0')}"`
    : `${seconds.toFixed(1)}s`;
}

/** 压在图上的角标统一样式：深色半透明底，保证在任何画面上都读得清 */
const overlayChip: React.CSSProperties = {
  position: 'absolute',
  background: 'rgba(0,0,0,0.62)',
  color: '#fff',
  fontSize: 11,
  lineHeight: '16px',
  padding: '1px 6px',
  borderRadius: 4,
  fontVariantNumeric: 'tabular-nums',
  pointerEvents: 'none',
};

export function ShotCard({
  shot,
  ratio,
  selected,
  onSelect,
  dragHandlers,
}: {
  shot: ShotCardShot;
  /** 如 '16:9' */
  ratio: string;
  selected: boolean;
  onSelect: () => void;
  dragHandlers?: React.HTMLAttributes<HTMLDivElement>;
}) {
  const { token } = theme.useToken();
  const status = STATUS_META[shot.status] ?? STATUS_META.none;

  // 关键图的 URL 是带签名有效期的对象存储直链，过期或对象被清理后会 404。
  // 不接 onError 的话浏览器会留一个破图图标，比"未出图"占位块更难看也更难解释。
  const [broken, setBroken] = useState(false);
  const loadedUrl = useRef(shot.imageUrl);
  if (loadedUrl.current !== shot.imageUrl) {
    loadedUrl.current = shot.imageUrl;
    // 重新出图后换了新 URL，上一张的失败不该继续压着新图
    if (broken) setBroken(false);
  }

  const showImage = shot.imageUrl !== null && shot.imageUrl !== '' && !broken;

  return (
    <div
      {...dragHandlers}
      role="button"
      aria-pressed={selected}
      aria-label={`镜头 ${shot.index}，${status.label}`}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
        dragHandlers?.onKeyDown?.(e);
      }}
      style={{
        cursor: 'pointer',
        borderRadius: token.borderRadius,
        overflow: 'hidden',
        background: token.colorBgContainer,
        // 选中只靠描边表达：故事板一屏几十张卡，阴影堆叠会让整片区域发脏
        border: `2px solid ${selected ? SURFACE.primary : token.colorBorderSecondary}`,
        ...dragHandlers?.style,
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: parseRatio(ratio),
          background: token.colorFillQuaternary,
        }}
      >
        {showImage ? (
          <img
            src={shot.imageUrl as string}
            alt={`镜头 ${shot.index} 关键图`}
            // 一集可能上百个镜头且每个都带图，不做懒加载会在打开故事板的瞬间打满带宽
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: `1px dashed ${token.colorBorder}`,
              boxSizing: 'border-box',
            }}
          >
            <Text type="secondary" style={{ fontSize: 12 }}>
              {broken ? '图片已失效' : shot.status === 'generating' ? '生成中…' : '未出图'}
            </Text>
          </div>
        )}

        <span style={{ ...overlayChip, top: 6, insetInlineStart: 6, fontWeight: 600 }}>
          #{shot.index}
        </span>

        <span style={{ ...overlayChip, bottom: 6, insetInlineEnd: 6 }}>
          {formatShotDuration(shot.durationMs)}
        </span>

        {/* 景别未填时字段是空串（库里 String default ""），不出角标而不是显示"未知" */}
        {shot.shotSize !== '' ? (
          <span style={{ ...overlayChip, top: 6, insetInlineEnd: 6 }}>{shot.shotSize}</span>
        ) : null}

        <span
          style={{
            ...overlayChip,
            bottom: 6,
            insetInlineStart: 6,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
          title={status.label}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: status.color,
              flexShrink: 0,
            }}
          />
          {status.label}
          {shot.locked ? <LockOutlined style={{ fontSize: 10 }} title="已锁定" /> : null}
        </span>
      </div>
    </div>
  );
}
