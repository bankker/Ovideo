// 剧本工具栏：横跨剧本页顶部的那一条。
//
// 左边回答"我在改哪一份、它有多大"，右边只留两个动作。
// 全页仅此一个主按钮——「开始分镜规划」。剧本页负责写作，
// 把剧本交给导演的动作只该有一个入口，且不该藏在右栏的设置卡片里。

import {
  Button,
  Dropdown,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme,
  type MenuProps,
} from 'antd';
import {
  BulbOutlined,
  CheckCircleOutlined,
  DownOutlined,
  EditOutlined,
  PlusOutlined,
  StarOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import type { ScriptDraft } from '../../api/workflow-hooks';
import { formatDuration, type ParsedScript } from '../../utils/script-parse';

const { Text } = Typography;

export function ScriptToolbar({
  draft,
  drafts,
  parsed,
  dirty,
  saving,
  onSave,
  onSelectDraft,
  onCreateDraft,
  creating,
  onOpenStarter,
  starterDisabled,
  onRename,
  onSetMain,
  onPreflight,
  onPlanStoryboard,
  planDisabled,
  planDisabledReason,
  planning,
  undoAvailable,
  onUndo,
  undoing,
}: {
  draft: ScriptDraft | null;
  drafts: ScriptDraft[] | undefined;
  parsed: ParsedScript;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onSelectDraft: (draftId: string) => void;
  onCreateDraft: () => void;
  creating: boolean;
  onOpenStarter: () => void;
  starterDisabled: boolean;
  onRename: () => void;
  onSetMain: () => void;
  onPreflight: () => void;
  onPlanStoryboard: () => void;
  planDisabled: boolean;
  /** 禁用原因（dirty / 停留在创作入口），挂在按钮的 Tooltip 上 */
  planDisabledReason?: string;
  planning: boolean;
  undoAvailable: boolean;
  onUndo: () => void;
  undoing: boolean;
}) {
  const { token } = theme.useToken();

  // 版本号取该稿在列表里的序号：库里没有版本字段，
  // 而"这是我的第几稿"恰好就是列表顺序，不必为此加数据模型
  const versionIndex = drafts?.findIndex((d) => d.id === draft?.id) ?? -1;
  const versionLabel = versionIndex >= 0 ? `V${versionIndex + 1}` : '';

  const draftMenu: MenuProps = {
    items: [
      ...(drafts && drafts.length > 0
        ? [
            {
              key: 'switch',
              type: 'group' as const,
              label: '切换剧本稿',
              children: drafts.map((d) => ({
                key: `draft:${d.id}`,
                icon: d.id === draft?.id ? <SwapOutlined /> : undefined,
                label: d.isMain ? `${d.title}（主）` : d.title,
              })),
            },
            { type: 'divider' as const },
          ]
        : []),
      { key: 'rename', icon: <EditOutlined />, label: '重命名', disabled: draft === null },
      {
        key: 'setMain',
        icon: <StarOutlined />,
        label: '设为主剧本',
        disabled: draft === null || draft.isMain,
      },
      { type: 'divider' as const },
      { key: 'create', icon: <PlusOutlined />, label: '新建剧本稿' },
      { key: 'starter', icon: <BulbOutlined />, label: 'AI 生成剧本', disabled: starterDisabled },
    ],
    onClick: ({ key }) => {
      if (key.startsWith('draft:')) {
        onSelectDraft(key.slice('draft:'.length));
        return;
      }
      if (key === 'rename') onRename();
      else if (key === 'setMain') onSetMain();
      else if (key === 'create') onCreateDraft();
      else if (key === 'starter') onOpenStarter();
    },
  };

  const planButton = (
    <Button
      type="primary"
      icon={<ThunderboltOutlined />}
      disabled={planDisabled}
      loading={planning}
      onClick={onPlanStoryboard}
    >
      开始分镜规划
    </Button>
  );

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 16px 10px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        flexShrink: 0,
      }}
    >
      {/* ---- 左：身份与体量 ---- */}
      <Dropdown menu={draftMenu} trigger={['click']} disabled={creating}>
        <span
          role="button"
          tabIndex={0}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            fontSize: 16,
            fontWeight: 600,
            maxWidth: 280,
          }}
        >
          <Text ellipsis style={{ fontSize: 16, fontWeight: 600, maxWidth: 240 }}>
            {draft?.title ?? '未选择剧本稿'}
          </Text>
          <DownOutlined style={{ fontSize: 11, color: token.colorTextTertiary }} />
        </span>
      </Dropdown>

      {versionLabel !== '' && (
        <Tag style={{ marginInlineEnd: 0, fontVariantNumeric: 'tabular-nums' }}>{versionLabel}</Tag>
      )}
      {draft?.isMain === true && (
        <Tag color="gold" style={{ marginInlineEnd: 0 }}>
          主剧本
        </Tag>
      )}

      {/* 统计口径与右栏体检、场景导航同源，都来自同一个 parsed */}
      <Space size={12} style={{ marginInlineStart: 4 }}>
        <Stat label="预计总时长" value={formatDuration(parsed.totalDurationMs)} />
        <Stat label="场景" value={`${parsed.scenes.length}`} />
        <Stat label="预计镜头" value={`${parsed.totalShotCount}`} />
      </Space>

      <SaveState dirty={dirty} saving={saving} onSave={onSave} />

      <span style={{ flex: 1, minWidth: 8 }} />

      {/* ---- 右：两个动作 ---- */}
      {undoAvailable && (
        <Button type="link" size="small" icon={<UndoOutlined />} loading={undoing} onClick={onUndo}>
          撤销上次对话修改
        </Button>
      )}

      <Button icon={<CheckCircleOutlined />} onClick={onPreflight} disabled={draft === null}>
        剧本体检
      </Button>

      {planDisabled && planDisabledReason !== undefined ? (
        // disabled 的按钮不派发鼠标事件，Tooltip 需要一层包裹才挂得住
        <Tooltip title={planDisabledReason}>
          <span>{planButton}</span>
        </Tooltip>
      ) : (
        planButton
      )}
    </div>
  );
}

/** 工具栏里的一格统计：小字标签 + 数值，避免每项都写一遍样式 */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Text>
      <Text style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{value}</Text>
    </span>
  );
}

/** 保存状态：与改版前的画布工具条同一套文案，用户的肌肉记忆不必重建 */
function SaveState({
  dirty,
  saving,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const { token } = theme.useToken();
  if (saving) {
    return (
      <Text type="secondary" style={{ fontSize: 12 }}>
        保存中…
      </Text>
    );
  }
  if (dirty) {
    return (
      <Space size={4}>
        <span style={{ fontSize: 12, color: token.colorWarning }}>未保存</span>
        <Button type="link" size="small" style={{ padding: 0 }} onClick={onSave}>
          保存
        </Button>
      </Space>
    );
  }
  return (
    <Text type="secondary" style={{ fontSize: 12 }}>
      已保存
    </Text>
  );
}
