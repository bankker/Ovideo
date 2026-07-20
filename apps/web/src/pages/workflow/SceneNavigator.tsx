// 场景导航（剧本页左栏，220px）。
//
// 它是"这部剧有几场戏、每场多长、哪几场还缺信息"的一览表，
// 点一下就把中间的编辑器滚到那一场。所有数据都由解析器现算，
// 不落库——剧本页的真相永远是那段纯文本。

import { Empty, Tag, Tooltip, Typography, theme } from 'antd';
import { DoubleLeftOutlined, DoubleRightOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import {
  formatDuration,
  formatInteriorExterior,
  type ParsedScene,
} from '../../utils/script-parse';

const { Text } = Typography;

/**
 * 本阶段只给"可从正文直接推导"的两种状态。
 * 「已确认」「已拆镜」需要落库的人工/管线痕迹，留给 C/D 阶段，
 * 现在编一个出来只会误导用户。
 */
export type SceneStatus = 'issue' | 'unchecked';

/** 缺地点或时间 → 存在问题；否则未检查 */
export function deriveSceneStatus(scene: ParsedScene): SceneStatus {
  if (scene.location.trim() === '' || scene.timeOfDay.trim() === '') return 'issue';
  return 'unchecked';
}

/** 副标题：内外景 · 时间 · 预计时长；缺失的字段整段跳过，不留空的分隔点 */
function buildSubtitle(scene: ParsedScene): string {
  const parts = [
    formatInteriorExterior(scene.interiorExterior),
    scene.timeOfDay,
    `预计${formatDuration(scene.estimatedDurationMs)}`,
  ].filter((s) => s !== '');
  return parts.join(' · ');
}

export function SceneNavigator({
  scenes,
  activeIndex,
  onSelect,
  collapsed,
  onToggleCollapsed,
}: {
  scenes: ParsedScene[];
  /** 当前光标/选中所在的场景；-1 表示无 */
  activeIndex: number;
  onSelect: (index: number) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { token } = theme.useToken();

  if (collapsed) {
    return (
      <div style={{ width: 40, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <Tooltip title="展开场景导航" placement="right">
          <Button type="text" icon={<DoubleRightOutlined />} onClick={onToggleCollapsed} />
        </Tooltip>
        <Text
          type="secondary"
          style={{ fontSize: 12, writingMode: 'vertical-rl', marginTop: 8, alignSelf: 'center' }}
        >
          {scenes.length} 场
        </Text>
      </div>
    );
  }

  return (
    <div
      style={{
        width: 220,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
        <Text strong style={{ fontSize: 13, flex: 1 }}>
          场景
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {scenes.length}
        </Text>
        <Tooltip title="收起">
          <Button
            type="text"
            size="small"
            icon={<DoubleLeftOutlined />}
            onClick={onToggleCollapsed}
          />
        </Tooltip>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {scenes.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无场景"
            style={{ marginTop: 40 }}
          />
        ) : (
          scenes.map((scene) => {
            const active = scene.index === activeIndex;
            const status = deriveSceneStatus(scene);
            const title = scene.title.trim() === '' ? '未命名场景' : scene.title;
            return (
              <div
                key={scene.index}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(scene.index)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(scene.index);
                  }
                }}
                style={{
                  cursor: 'pointer',
                  padding: '6px 8px',
                  marginBottom: 4,
                  borderRadius: token.borderRadius,
                  // 选中态：主色竖条 + 浅填充，与剧本稿导航保持同一套视觉语言
                  borderInlineStart: `3px solid ${active ? token.colorPrimary : 'transparent'}`,
                  background: active ? token.colorFillSecondary : undefined,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Text
                    style={{
                      fontSize: 12,
                      fontVariantNumeric: 'tabular-nums',
                      color: token.colorTextTertiary,
                    }}
                  >
                    S{String(scene.index + 1).padStart(2, '0')}
                  </Text>
                  <Text ellipsis style={{ flex: 1, minWidth: 0, fontSize: 13 }} title={title}>
                    {title}
                  </Text>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    marginTop: 2,
                  }}
                >
                  <Text
                    ellipsis
                    type="secondary"
                    style={{ flex: 1, minWidth: 0, fontSize: 11 }}
                  >
                    {buildSubtitle(scene)}
                  </Text>
                  {status === 'issue' ? (
                    <Tooltip title="缺少地点或时间，自动拆分镜时可能识别不准">
                      <Tag color="orange" style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }}>
                        存在问题
                      </Tag>
                    </Tooltip>
                  ) : (
                    <Tag style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }}>未检查</Tag>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
