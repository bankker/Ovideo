// 镜头表（分镜工作台的第二个视图）。
//
// 【它和故事板的分工】故事板回答"这片子长什么样"，镜头表回答"这片子的节奏对不对"。
// 后者要能一眼扫出异常——所以超时长的单元格直接标红，而不是让用户逐个点开检查器去比对。
//
// 【为什么改动要攒批】后端每次 apply-patch 都会产出一个新的 Storyboard 版本，
// 并把 Shot/Take/Binding/DubbingLine 全量深拷贝一份。而镜头表恰恰是"通读一遍、
// 连着改十几格"的使用场景：逐格提交等于逐格造版本，一次通读就能刷出十几个版本。
// 所以这里的下拉只改本地待提交集，用户点"保存"才一次性交给集成方提交。
//
// 纯展示组件：自己不发任何请求，改动一律经 onCommit 交回集成方。

import { useMemo, useState } from 'react';
import { Alert, Button, Select, Space, Table, Tag, Tooltip, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  SHOT_SIZES,
  TRANSITIONS,
  SHOT_DURATION_MAX_MS,
} from '@ovideo/shared';

const { Text } = Typography;

export interface ShotTableRow {
  id: string;
  index: number;
  sceneIndex: number;
  sceneTitle: string;
  thumbUrl: string | null;
  durationMs: number;
  shotSize: string;
  cameraAngle: string;
  cameraMovement: string;
  transition: string;
  composition: string;
  status: string;
}

/** 表格里可就地改的字段；构图是自由文本，只在检查器里改 */
export type ShotTableEditableField =
  | 'shotSize'
  | 'cameraAngle'
  | 'cameraMovement'
  | 'transition';

/** 一个镜头上的一批改动；空串代表清空（库里是 String default ""，不是 null） */
export interface ShotTableEdit {
  shotId: string;
  fields: Partial<Record<ShotTableEditableField, string>>;
}

export interface ShotTableProps {
  rows: ShotTableRow[];
  selectedShotId: string | null;
  onSelectShot: (id: string) => void;
  /**
   * 用户点"保存"时一次性交出全部待提交改动，集成方据此发一次 apply-patch。
   * 必须在数据真正回流之后才 resolve——表格靠它清理待提交集。
   */
  onCommit: (edits: ShotTableEdit[]) => Promise<void>;
  saving: boolean;
}

/** 待提交改动集：shotId -> 字段 -> 新值。只存与当前值不同的项，计数才诚实 */
type PendingEdits = Record<string, Partial<Record<ShotTableEditableField, string>>>;

/** 已知状态的中文与配色；认不出的原样显示，不要吞掉服务端给的信息 */
const STATUS_META: Record<string, { text: string; color?: string }> = {
  PENDING: { text: '待生成' },
  DRAFT: { text: '草稿' },
  READY: { text: '已就绪', color: 'green' },
  GENERATING: { text: '生成中', color: 'processing' },
  FAILED: { text: '失败', color: 'red' },
  STALE: { text: '需重生成', color: 'orange' },
};

/**
 * 缩略图单元格。图片 URL 可能 404 或签名过期，浏览器默认会留一个破图图标——
 * 那看起来像组件坏了。自己接住 error 回落到"无图"占位，和真的没图长一个样。
 */
function ThumbCell({
  url,
  index,
  boxStyle,
}: {
  url: string | null;
  index: number;
  boxStyle: React.CSSProperties;
}): JSX.Element {
  const [broken, setBroken] = useState(false);

  return (
    <div style={boxStyle}>
      {url !== null && !broken ? (
        <img
          src={url}
          alt={`镜头 ${index}`}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setBroken(true)}
        />
      ) : (
        <Text type="secondary" style={{ fontSize: 11 }}>
          {broken ? '图已失效' : '无图'}
        </Text>
      )}
    </div>
  );
}

export function ShotTable({
  rows,
  selectedShotId,
  onSelectShot,
  onCommit,
  saving,
}: ShotTableProps): JSX.Element {
  const { token } = theme.useToken();
  const [pending, setPending] = useState<PendingEdits>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  const pendingCount = useMemo(
    () => Object.values(pending).reduce((sum, fields) => sum + Object.keys(fields).length, 0),
    [pending],
  );

  const setField = (row: ShotTableRow, field: ShotTableEditableField, value: string): void => {
    setPending((prev) => {
      const fields = { ...(prev[row.id] ?? {}) };
      // 改回原值就把这格从待提交集里摘掉，不然会提交一个空操作、白造一个版本
      if (value === row[field]) delete fields[field];
      else fields[field] = value;

      const next = { ...prev };
      if (Object.keys(fields).length === 0) delete next[row.id];
      else next[row.id] = fields;
      return next;
    });
  };

  /**
   * 提交并按结果清理待提交集。
   * 【为什么必须等 onCommit 的 Promise】此前是靠 saving 的下降沿去猜"落地了没有"，
   * 再拿 rows 的新旧值反推哪几格已生效。只要数据回流比 saving 落回晚一拍，
   * 待提交集就永远清不掉，用户被反复告知改动未保存。
   * 现在只认一件事：onCommit resolve 即成功、reject 即失败——集成方负责让
   * Promise 在数据真正回流之后才 resolve。
   */
  const handleSave = async (): Promise<void> => {
    const edits: ShotTableEdit[] = Object.entries(pending).map(([shotId, fields]) => ({
      shotId,
      fields,
    }));
    if (edits.length === 0) return;
    try {
      await onCommit(edits);
      setPending({});
      setSaveError(null);
    } catch (e) {
      // 失败就把这十几格原样留着，否则等于把用户刚改的一批默默扔了
      setSaveError(e instanceof Error ? e.message : '保存失败，请重试');
    }
  };

  /**
   * 枚举列共用一份渲染：这四列除了取值集合和字段名以外完全同构。
   * 已改未保存的格子要看得见——用户连改十几格之后得能回扫自己动过哪里。
   */
  const enumColumn = (
    title: string,
    field: ShotTableEditableField,
    options: readonly string[],
    width: number,
  ): ColumnsType<ShotTableRow>[number] => ({
    title,
    dataIndex: field,
    width,
    render: (value: string, row) => {
      const draft = pending[row.id]?.[field];
      const dirty = draft !== undefined;
      const shown = dirty ? draft : value;
      const select = (
        <Select
          size="small"
          value={shown === '' ? undefined : shown}
          placeholder="未填"
          allowClear
          // 提交期间锁住输入：这时 rows 即将整体换版本，再收编辑会让待提交集对不上行
          disabled={saving}
          style={{ width: '100%' }}
          options={options.map((v) => ({ label: v, value: v }))}
          // 单元格上的点击会冒泡到行、把选中镜头换掉，展开下拉时那是意外行为
          onClick={(e) => e.stopPropagation()}
          // 库里是 String default ""，清空要写回空串而不是 undefined
          onChange={(v) => setField(row, field, v ?? '')}
        />
      );
      if (!dirty) return select;
      return (
        <Tooltip title={`未保存：原为「${value === '' ? '未填' : value}」`}>
          <div
            style={{
              // 左侧色条 + 底色，扫一眼就知道这一格动过；只靠边框在密排表格里看不出来
              borderInlineStart: `3px solid ${token.colorWarning}`,
              background: token.colorWarningBg,
              borderRadius: token.borderRadiusSM,
              paddingInlineStart: 4,
              paddingBlock: 2,
            }}
          >
            {select}
          </div>
        </Tooltip>
      );
    },
  });

  const thumbBoxStyle: React.CSSProperties = {
    width: 72,
    height: 40,
    borderRadius: token.borderRadius,
    border: `1px solid ${token.colorBorderSecondary}`,
    background: token.colorFillQuaternary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  };

  const columns: ColumnsType<ShotTableRow> = [
    {
      title: '镜号',
      dataIndex: 'index',
      width: 64,
      fixed: 'left',
      render: (v: number) => <Text strong>#{v}</Text>,
    },
    {
      title: '场次',
      dataIndex: 'sceneIndex',
      width: 140,
      render: (sceneIndex: number, row) =>
        sceneIndex > 0 ? (
          <Text style={{ fontSize: 12 }} ellipsis={{ tooltip: row.sceneTitle }}>
            {`第 ${sceneIndex} 场 ${row.sceneTitle}`}
          </Text>
        ) : (
          // 无场景归属的镜头必须显性标出来，否则它在按场次阅读时会凭空消失
          <Tooltip title="该镜头未归属任何场次，通读节奏时容易被忽略">
            <Text type="warning" style={{ fontSize: 12 }}>
              未归属
            </Text>
          </Tooltip>
        ),
    },
    {
      title: '缩略图',
      dataIndex: 'thumbUrl',
      width: 96,
      render: (url: string | null, row) => (
        // key 绑 URL：换图时强制重挂载，才不会让上一张的失效状态粘在新图上
        <ThumbCell key={url ?? 'none'} url={url} index={row.index} boxStyle={thumbBoxStyle} />
      ),
    },
    {
      title: '时长',
      dataIndex: 'durationMs',
      width: 92,
      render: (ms: number) => {
        const over = ms > SHOT_DURATION_MAX_MS;
        const label = `${(ms / 1000).toFixed(1)}s`;
        if (!over) return <Text style={{ fontSize: 12 }}>{label}</Text>;
        return (
          // 说清这红不是用户改坏的：8s 是两级生成下单镜的硬上限（一镜=一次视频生成），
          // 超长镜头来自旧的平铺分镜数据；不给出路的告警只会让人干瞪眼，所以直接写办法
          <Tooltip
            title={`超过单镜上限 ${SHOT_DURATION_MAX_MS / 1000} 秒。一个镜头对应一次视频生成，模型单次最长只能出 ${SHOT_DURATION_MAX_MS / 1000} 秒，这一镜会被截断。这不是你改出来的——它是早期平铺分镜留下的存量数据；重新生成一次分镜规划，这段会被拆成若干条合规的镜头。`}
          >
            <Tag color="red" style={{ marginInlineEnd: 0 }}>
              {label}
            </Tag>
          </Tooltip>
        );
      },
    },
    enumColumn('景别', 'shotSize', SHOT_SIZES, 120),
    enumColumn('角度', 'cameraAngle', CAMERA_ANGLES, 110),
    enumColumn('运镜', 'cameraMovement', CAMERA_MOVEMENTS, 110),
    enumColumn('转场', 'transition', TRANSITIONS, 120),
    {
      title: '构图',
      dataIndex: 'composition',
      // 构图是自由文本、长度不可控，表里只做只读预览；要改去检查器，
      // 免得一个长文本输入框把整行撑变形
      render: (v: string) =>
        v === '' ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            未填
          </Text>
        ) : (
          <Text style={{ fontSize: 12 }} ellipsis={{ tooltip: v }}>
            {v}
          </Text>
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 96,
      fixed: 'right',
      render: (status: string) => {
        const meta = STATUS_META[status];
        return (
          <Tag color={meta?.color} style={{ marginInlineEnd: 0 }}>
            {meta?.text ?? (status === '' ? '未知' : status)}
          </Tag>
        );
      },
    },
  ];

  return (
    <div>
      {pendingCount > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: token.marginSM,
            marginBlockEnd: token.marginXS,
            paddingInline: token.paddingSM,
            paddingBlock: token.paddingXS,
            border: `1px solid ${token.colorWarningBorder}`,
            background: token.colorWarningBg,
            borderRadius: token.borderRadius,
          }}
        >
          <Text style={{ fontSize: 12 }}>
            {`${pendingCount} 处改动待保存`}
            <Text type="secondary" style={{ fontSize: 12, marginInlineStart: 8 }}>
              保存会生成一个新的分镜版本，所以攒到一起提交
            </Text>
          </Text>
          <Space size="small">
            <Button size="small" disabled={saving} onClick={() => setPending({})}>
              放弃
            </Button>
            <Button size="small" type="primary" loading={saving} onClick={() => void handleSave()}>
              保存
            </Button>
          </Space>
        </div>
      )}
      {saveError !== null && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setSaveError(null)}
          style={{ marginBlockEnd: token.marginXS }}
          message="保存失败，改动仍留在表格里"
          description={<Text style={{ fontSize: 12 }}>{saveError}</Text>}
        />
      )}
      <Table<ShotTableRow>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        onRow={(row) => ({
          onClick: () => onSelectShot(row.id),
          style: {
            cursor: 'pointer',
            // 主题模板注入的 CSS 无作用域且大量 !important，用 rowClassName + 全局样式
            // 很容易被压掉；行内 style 是这里唯一稳的高亮方式
            background: row.id === selectedShotId ? token.controlItemBgActive : undefined,
          },
        })}
        locale={{
          emptyText: (
            <Text type="secondary" style={{ fontSize: 12 }}>
              这一版分镜还没有镜头
            </Text>
          ),
        }}
      />
    </div>
  );
}
