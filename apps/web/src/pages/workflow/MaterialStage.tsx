import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Button,
  Card,
  Empty,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
import type { TagType } from '@ovideo/shared';
import { useStoryboard, useStoryboards } from '../../api/workflow-hooks';
import {
  useEpisodeBindings,
  usePutBinding,
  useResolvedBindings,
  useTagDesigns,
  type PutBindingResult,
  type ResolvedBindingCell,
  type ResolvedBindingShotRow,
} from '../../api/design-hooks';

const { Text, Paragraph } = Typography;

const TAG_COLOR: Record<TagType, string> = {
  CHARACTER: 'blue',
  SCENE: 'volcano',
  PROP: 'gold',
};

interface TagColumn {
  tagId: string;
  name: string;
  type: TagType;
}

/** 换绑弹层状态：shotId=null 为标签级默认，非 null 为镜头级覆盖 */
interface BindModalState {
  tagId: string;
  tagName: string;
  shotId: string | null;
  shotLabel: string;
  /** 当前生效的资产（用于初始高亮，可能来自上级默认） */
  effectiveAssetId: string | null;
  /** 该级是否已有绑定行（决定「解除绑定」可用与 OK 判重） */
  boundAtThisLevel: boolean;
}

function withAffected(base: string, res: PutBindingResult): string {
  const n = res.affectedShotIds?.length ?? 0;
  return n > 0 ? `${base}，波及 ${n} 个镜头（关键图已标记待重生成）` : base;
}

/** 素材阶段：镜头 × 标签 绑定矩阵（标签级默认 + 镜头级覆盖） */
export function MaterialStage() {
  const { episodeId = '' } = useParams();

  /* ---------- 分镜版本选择（默认最新） ---------- */
  const storyboardsQuery = useStoryboards(episodeId);
  const storyboards = storyboardsQuery.data;
  const [selectedStoryboardId, setSelectedStoryboardId] = useState<string | null>(null);

  useEffect(() => {
    if (!storyboards || storyboards.length === 0) return;
    if (selectedStoryboardId !== null && storyboards.some((s) => s.id === selectedStoryboardId))
      return;
    const latest = storyboards.reduce((a, b) => (b.version > a.version ? b : a));
    setSelectedStoryboardId(latest.id);
  }, [storyboards, selectedStoryboardId]);

  const versionOptions = [...(storyboards ?? [])]
    .sort((a, b) => b.version - a.version)
    .map((s) => ({ value: s.id, label: `v${s.version}${s.stale ? '（剧本已变更）' : ''}` }));

  /* ---------- 数据源 ---------- */
  const resolvedQuery = useResolvedBindings(selectedStoryboardId);
  const resolved = resolvedQuery.data;
  const storyboardQuery = useStoryboard(selectedStoryboardId);
  const bindingsQuery = useEpisodeBindings(episodeId);

  /** 本分镜出现过的标签（按首次出现顺序去重）→ 表格列 + 顶部默认绑定卡片 */
  const uniqueTags = useMemo<TagColumn[]>(() => {
    const seen = new Map<string, TagColumn>();
    for (const shot of resolved?.shots ?? []) {
      for (const cell of shot.tags) {
        if (!seen.has(cell.tagId)) {
          seen.set(cell.tagId, { tagId: cell.tagId, name: cell.name, type: cell.type });
        }
      }
    }
    return [...seen.values()];
  }, [resolved]);

  /** shotId → 原文（表格行首列展示） */
  const sourceTextByShotId = useMemo(
    () => new Map((storyboardQuery.data?.shots ?? []).map((s) => [s.id, s.sourceText])),
    [storyboardQuery.data],
  );

  /** 标签级默认绑定行（shotId 为 null 的 Binding） */
  const defaultAssetIdByTag = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of bindingsQuery.data ?? []) {
      if ((b.shotId ?? null) === null) m.set(b.tagId, b.assetId);
    }
    return m;
  }, [bindingsQuery.data]);

  /** assetId → 展示地址（从解析矩阵收集，供顶部默认卡片找图） */
  const uriByAssetId = useMemo(() => {
    const m = new Map<string, { uri: string; thumbUri: string | null }>();
    for (const shot of resolved?.shots ?? []) {
      for (const cell of shot.tags) {
        if (cell.resolved !== null) {
          m.set(cell.resolved.assetId, {
            uri: cell.resolved.uri,
            thumbUri: cell.resolved.thumbUri,
          });
        }
      }
    }
    return m;
  }, [resolved]);

  /* ---------- 换绑弹层 ---------- */
  const [modalState, setModalState] = useState<BindModalState | null>(null);

  const openDefaultModal = (tag: TagColumn) => {
    const defaultAssetId = defaultAssetIdByTag.get(tag.tagId) ?? null;
    setModalState({
      tagId: tag.tagId,
      tagName: tag.name,
      shotId: null,
      shotLabel: '',
      effectiveAssetId: defaultAssetId,
      boundAtThisLevel: defaultAssetId !== null,
    });
  };

  const openCellModal = (row: ResolvedBindingShotRow, cell: ResolvedBindingCell, index: number) => {
    setModalState({
      tagId: cell.tagId,
      tagName: cell.name,
      shotId: row.shotId,
      shotLabel: `镜头 #${index + 1}`,
      effectiveAssetId: cell.resolved?.assetId ?? null,
      boundAtThisLevel: cell.resolved?.level === 'shot',
    });
  };

  /* ---------- 表格 ---------- */
  const columns: ColumnsType<ResolvedBindingShotRow> = [
    {
      title: '镜头',
      key: 'shot',
      fixed: 'left',
      width: 240,
      render: (_, row, index) => (
        <div>
          <Text strong>#{index + 1}</Text>
          <Paragraph
            type="secondary"
            style={{ fontSize: 12, marginBottom: 0, marginTop: 2 }}
            ellipsis={{ rows: 2, tooltip: sourceTextByShotId.get(row.shotId) }}
          >
            {sourceTextByShotId.get(row.shotId) ?? ''}
          </Paragraph>
        </div>
      ),
    },
    ...uniqueTags.map(
      (tag): ColumnsType<ResolvedBindingShotRow>[number] => ({
        title: (
          <Tag color={TAG_COLOR[tag.type]} style={{ marginInlineEnd: 0 }}>
            {tag.name}
          </Tag>
        ),
        key: tag.tagId,
        width: 150,
        render: (_: unknown, row: ResolvedBindingShotRow, index: number) => {
          const cell = row.tags.find((c) => c.tagId === tag.tagId);
          if (!cell) return <Text type="secondary">—</Text>;
          return <BindingCellView cell={cell} onClick={() => openCellModal(row, cell, index)} />;
        },
      }),
    ),
  ];

  const loading = storyboardsQuery.isLoading || resolvedQuery.isLoading;

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Space>
        <Text>分镜版本</Text>
        <Select
          style={{ width: 200 }}
          placeholder="暂无版本"
          value={selectedStoryboardId ?? undefined}
          options={versionOptions}
          onChange={(v) => setSelectedStoryboardId(v)}
        />
      </Space>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin />
        </div>
      ) : !storyboards || storyboards.length === 0 ? (
        <Empty style={{ marginTop: 60 }} description="暂无分镜版本，请先在剧本阶段生成分镜" />
      ) : !resolved || resolved.shots.length === 0 ? (
        <Empty style={{ marginTop: 60 }} description="该分镜版本没有镜头" />
      ) : (
        <>
          {/* 标签级默认绑定卡片行 */}
          <Card size="small" title="标签级默认绑定（对本集所有含该标签的镜头生效，可被镜头级覆盖）">
            {uniqueTags.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本分镜没有标签" />
            ) : (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {uniqueTags.map((tag) => {
                  const assetId = defaultAssetIdByTag.get(tag.tagId) ?? null;
                  const media = assetId !== null ? uriByAssetId.get(assetId) : undefined;
                  return (
                    <div
                      key={tag.tagId}
                      onClick={() => openDefaultModal(tag)}
                      title="点击更换默认绑定"
                      style={{
                        cursor: 'pointer',
                        width: 108,
                        border: '1px solid rgba(5,5,5,0.1)',
                        borderRadius: 8,
                        padding: 8,
                        textAlign: 'center',
                      }}
                    >
                      <div
                        style={{
                          width: 88,
                          height: 88,
                          margin: '0 auto 6px',
                          borderRadius: 6,
                          overflow: 'hidden',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: 'rgba(5,5,5,0.04)',
                          border: assetId === null ? '1px dashed rgba(5,5,5,0.25)' : 'none',
                        }}
                      >
                        {assetId === null ? (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            未绑定
                          </Text>
                        ) : media ? (
                          <img
                            src={media.thumbUri ?? media.uri}
                            alt={tag.name}
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                        ) : (
                          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                            已绑定
                          </Tag>
                        )}
                      </div>
                      <Tag color={TAG_COLOR[tag.type]} style={{ marginInlineEnd: 0, maxWidth: 92 }}>
                        <span
                          style={{
                            display: 'inline-block',
                            maxWidth: 76,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            verticalAlign: 'bottom',
                          }}
                        >
                          {tag.name}
                        </span>
                      </Tag>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* 镜头 × 标签 矩阵 */}
          <Table<ResolvedBindingShotRow>
            size="small"
            rowKey={(row) => row.shotId}
            dataSource={resolved.shots}
            columns={columns}
            pagination={false}
            scroll={{ x: 240 + uniqueTags.length * 150 }}
          />
        </>
      )}

      {modalState !== null && (
        <BindingModal
          state={modalState}
          episodeId={episodeId}
          onClose={() => setModalState(null)}
        />
      )}
    </div>
  );
}

/** ---------- 单元格：解析图缩略 + 来源徽标 ---------- */

function BindingCellView({
  cell,
  onClick,
}: {
  cell: ResolvedBindingCell;
  onClick: () => void;
}) {
  if (cell.resolved === null) {
    return (
      <div onClick={onClick} style={{ cursor: 'pointer' }} title="点击绑定">
        <Space size={6}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 4,
              border: '1px dashed rgba(5,5,5,0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <PlusOutlined style={{ color: 'rgba(5,5,5,0.35)' }} />
          </div>
          <Tag style={{ marginInlineEnd: 0 }}>未绑定</Tag>
        </Space>
      </div>
    );
  }
  const isOverride = cell.resolved.level === 'shot';
  return (
    <div onClick={onClick} style={{ cursor: 'pointer' }} title="点击换绑">
      <Space size={6}>
        <img
          src={cell.resolved.thumbUri ?? cell.resolved.uri}
          alt={cell.name}
          style={{
            width: 48,
            height: 48,
            objectFit: 'cover',
            borderRadius: 4,
            border: '1px solid rgba(5,5,5,0.15)',
            display: 'block',
          }}
        />
        <Tooltip title={isOverride ? '镜头级覆盖（优先于标签默认）' : '来自标签级默认绑定'}>
          <Tag color={isOverride ? 'orange' : 'blue'} style={{ marginInlineEnd: 0 }}>
            {isOverride ? '覆盖' : '默认'}
          </Tag>
        </Tooltip>
      </Space>
    </div>
  );
}

/** ---------- 换绑弹层：候选设计图网格 + 解除绑定 ---------- */

function BindingModal({
  state,
  episodeId,
  onClose,
}: {
  state: BindModalState;
  episodeId: string;
  onClose: () => void;
}) {
  const designsQuery = useTagDesigns(state.tagId);
  const designs = designsQuery.data?.designs ?? [];
  const putBinding = usePutBinding(episodeId);
  const [selected, setSelected] = useState<string | null>(state.effectiveAssetId);

  const isDefaultLevel = state.shotId === null;

  const handleOk = () => {
    if (selected === null) return;
    putBinding.mutate(
      { tagId: state.tagId, shotId: state.shotId, assetId: selected },
      {
        onSuccess: (res) => {
          message.success(withAffected('绑定已更新', res));
          onClose();
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  const handleUnbind = () => {
    putBinding.mutate(
      { tagId: state.tagId, shotId: state.shotId, assetId: null },
      {
        onSuccess: (res) => {
          message.success(
            withAffected(isDefaultLevel ? '已解除默认绑定' : '已解除覆盖，回落到标签默认', res),
          );
          onClose();
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  const okDisabled =
    selected === null || (state.boundAtThisLevel && selected === state.effectiveAssetId);

  return (
    <Modal
      title={
        isDefaultLevel
          ? `默认绑定 —— ${state.tagName}`
          : `镜头级覆盖 —— ${state.tagName} · ${state.shotLabel}`
      }
      open
      onCancel={onClose}
      width={560}
      destroyOnClose
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Tooltip
            title={
              state.boundAtThisLevel
                ? isDefaultLevel
                  ? '删除该标签的默认绑定行'
                  : '删除该镜头的覆盖行，回落到标签级默认'
                : '该级当前没有绑定行'
            }
          >
            <Button
              danger
              disabled={!state.boundAtThisLevel}
              loading={putBinding.isPending}
              onClick={handleUnbind}
            >
              解除绑定
            </Button>
          </Tooltip>
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button
              type="primary"
              disabled={okDisabled}
              loading={putBinding.isPending}
              onClick={handleOk}
            >
              确定
            </Button>
          </Space>
        </div>
      }
    >
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
        {isDefaultLevel
          ? '默认绑定对本集所有含该标签的镜头生效；有镜头级覆盖的镜头不受影响。'
          : '覆盖仅对该镜头生效，优先于标签级默认。'}
      </Text>

      {designsQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
      ) : designs.length === 0 ? (
        <Empty description="该标签暂无候选设计图，请先到「设计」阶段生成或上传" />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 96px)', gap: 8 }}>
          {designs.map((d) => {
            const isSelected = d.assetId === selected;
            return (
              <div
                key={d.id}
                onClick={() => setSelected(d.assetId)}
                style={{
                  width: 96,
                  height: 96,
                  cursor: 'pointer',
                  borderRadius: 6,
                  overflow: 'hidden',
                  border: isSelected ? '2px solid #1677ff' : '1px solid rgba(5,5,5,0.15)',
                  boxSizing: 'border-box',
                }}
              >
                <img
                  src={d.asset.thumbUri ?? d.asset.uri}
                  alt={state.tagName}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
