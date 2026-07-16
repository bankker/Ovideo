import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Button,
  Card,
  Empty,
  Input,
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
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import type { TagType } from '@ovideo/shared';
import { useApplyPatch, useStoryboard, useStoryboards } from '../../api/workflow-hooks';
import {
  useEpisodeBindings,
  usePutBinding,
  useResolvedBindings,
  useTagDesigns,
  type PutBindingResult,
  type ResolvedBindingCell,
  type ResolvedBindingShotRow,
} from '../../api/design-hooks';
import { computeParticipation } from '../../utils/ref-policy';

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

  // patch 产出新版本时，列表刷新前先记下目标版本，防止选择被重置回旧版本（竞态）
  const pendingSelectRef = useRef<string | null>(null);

  useEffect(() => {
    if (!storyboards || storyboards.length === 0) return;
    if (pendingSelectRef.current && storyboards.some((s) => s.id === pendingSelectRef.current)) {
      setSelectedStoryboardId(pendingSelectRef.current);
      pendingSelectRef.current = null;
      return;
    }
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

  /* ---------- 提示词就地编辑（@ 引用管理，与分镜页同一套 patch 版本机制） ---------- */
  const applyPatch = useApplyPatch(episodeId);
  const patching = applyPatch.isPending;
  const savePrompt = (shotId: string, imagePrompt: string) => {
    if (selectedStoryboardId === null) return;
    applyPatch.mutate(
      {
        storyboardId: selectedStoryboardId,
        patch: [{ op: 'update_shot', shotId, fields: { imagePrompt } }],
      },
      {
        onSuccess: (result) => {
          // 切到 patch 产出的新版本；版本列表可能尚未刷新，记入待选引用防止被重置
          pendingSelectRef.current = result.storyboard.id;
          setSelectedStoryboardId(result.storyboard.id);
          message.success('提示词已更新（生成了新分镜版本）');
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

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
      title: '镜头（点击提示词可编辑 @ 引用）',
      key: 'shot',
      fixed: 'left',
      width: 300,
      render: (_, row, index) => (
        <div>
          <Text strong>#{index + 1}</Text>
          <Paragraph
            type="secondary"
            style={{ fontSize: 12, marginBottom: 4, marginTop: 2 }}
            ellipsis={{ rows: 2, tooltip: sourceTextByShotId.get(row.shotId) }}
          >
            {sourceTextByShotId.get(row.shotId) ?? ''}
          </Paragraph>
          <PromptMentionEditor row={row} onSave={(prompt) => savePrompt(row.shotId, prompt)} saving={patching} />
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
          const participation = computeParticipation(row.imagePrompt, row.tags).get(cell.tagId);
          return (
            <BindingCellView
              cell={cell}
              participation={participation}
              onClick={() => openCellModal(row, cell, index)}
            />
          );
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

/**
 * 提示词就地编辑器（素材页的 @ 引用管理入口）：
 * 展示态高亮 @提及，点击进入编辑；保存走 apply-patch（产出新分镜版本，旧版本可回切）。
 */
function PromptMentionEditor({
  row,
  saving,
  onSave,
}: {
  row: ResolvedBindingShotRow;
  saving: boolean;
  onSave: (imagePrompt: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  if (editing !== null) {
    return (
      <div onClick={(e) => e.stopPropagation()}>
        <Input.TextArea
          value={editing}
          autoSize={{ minRows: 2, maxRows: 6 }}
          style={{ fontSize: 12 }}
          onChange={(e) => setEditing(e.target.value)}
        />
        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
          @角色/@道具 上参考位；@场景 仅锚定文字；@!场景 强制上参考
        </Text>
        <Space style={{ marginTop: 4 }}>
          <Button
            size="small"
            type="primary"
            loading={saving}
            onClick={() => {
              onSave(editing);
              setEditing(null);
            }}
          >
            保存
          </Button>
          <Button size="small" onClick={() => setEditing(null)}>
            取消
          </Button>
        </Space>
      </div>
    );
  }

  // 展示态：@提及 渲染为蓝色 token，一眼看出该镜头引用了谁
  const parts = (row.imagePrompt || '').split(/(@!?[^\s@!，。；、,;.!？?！:：()（）【】[\]"'`]+)/g);
  return (
    <div
      onClick={() => setEditing(row.imagePrompt)}
      style={{ cursor: 'pointer', fontSize: 12, lineHeight: '20px' }}
      title="点击编辑生图提示词（管理 @ 引用）"
    >
      <Text type="secondary" style={{ fontSize: 11 }}>
        生图 Prompt <EditOutlined style={{ fontSize: 10 }} />：
      </Text>
      <Paragraph style={{ fontSize: 12, marginBottom: 0 }} ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}>
        {row.imagePrompt === '' ? (
          <Text type="secondary">（空，点击填写）</Text>
        ) : (
          parts.map((p, i) =>
            p.startsWith('@') ? (
              <Text key={i} style={{ fontSize: 12, color: '#1677ff', fontWeight: 600 }}>
                {p}
              </Text>
            ) : (
              <span key={i}>{p}</span>
            ),
          )
        )}
      </Paragraph>
    </div>
  );
}

/** 参考位状态标注（与生成逻辑同一套规则，见 utils/ref-policy） */
const PARTICIPATION_META: Record<string, { color: string; label: string; tip: string }> = {
  ref: { color: 'success', label: '上参考', tip: '生成该镜头关键图时，这张图会作为参考图发给模型' },
  'text-anchor': {
    color: 'default',
    label: '仅文字',
    tip: '场景默认只做文字锚定不占参考位（防稀释角色形象）；提示词里写 @!场景名 可强制上参考',
  },
  unreferenced: {
    color: 'warning',
    label: '未引用',
    tip: '该镜头提示词用 @ 指定了引用清单，但没有 @ 这个标签——需要的话在提示词里补 @标签名',
  },
};

function BindingCellView({
  cell,
  participation,
  onClick,
}: {
  cell: ResolvedBindingCell;
  participation?: string;
  onClick: () => void;
}) {
  const partMeta = participation ? PARTICIPATION_META[participation] : undefined;
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
  const LEVEL_META: Record<string, { color: string; label: string; tip: string }> = {
    shot: { color: 'orange', label: '覆盖', tip: '镜头级覆盖（优先于标签默认）' },
    tag: { color: 'blue', label: '默认', tip: '来自标签级默认绑定' },
    design: { color: 'green', label: '设计', tip: '未绑定，生成时自动使用该标签的默认设计图' },
  };
  const meta = LEVEL_META[cell.resolved.level] ?? LEVEL_META.tag;
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
        <Space direction="vertical" size={2}>
          <Tooltip title={meta.tip}>
            <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>
              {meta.label}
            </Tag>
          </Tooltip>
          {partMeta && (
            <Tooltip title={partMeta.tip}>
              <Tag color={partMeta.color} style={{ marginInlineEnd: 0 }}>
                {partMeta.label}
              </Tag>
            </Tooltip>
          )}
        </Space>
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
