import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Popover,
  Select,
  Space,
  Spin,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  EditOutlined,
  PictureOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { CapabilityEntry, StaleReason, TagType } from '@ovideo/shared';
import { useApplyPatch, useStoryboards } from '../../api/workflow-hooks';
import { useResolvedBindings, type ResolvedBindingCell } from '../../api/design-hooks';
import {
  useCapabilities,
  useClearStale,
  useGenerateKeyframe,
  useSelectTake,
  useShotJob,
  useStaleShots,
  useStoryboardDetail,
  type ProduceShot,
} from '../../api/produce-hooks';

const { Text, Paragraph } = Typography;

const TAG_COLOR: Record<TagType, string> = {
  CHARACTER: 'blue',
  SCENE: 'volcano',
  PROP: 'gold',
};

function formatSeconds(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
}

function parseStaleReasons(raw: string): StaleReason[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is StaleReason =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as StaleReason).source === 'string' &&
        typeof (r as StaleReason).at === 'string' &&
        typeof (r as StaleReason).detail === 'string',
    );
  } catch {
    return [];
  }
}

/** 画面分镜阶段：镜头卡片列（关键图抽卡 + 选定 + stale 溯源）+ 待重生成汇总条 */
export function StoryboardStage() {
  const { episodeId = '' } = useParams();
  const qc = useQueryClient();

  /* ---------- 版本选择（默认最新） ---------- */
  const storyboardsQuery = useStoryboards(episodeId);
  const storyboards = storyboardsQuery.data;
  const [selectedStoryboardId, setSelectedStoryboardId] = useState<string | null>(null);

  /* ---------- "将用参考"数据源（与素材页同一接口，含设计图回落层级） ---------- */
  const resolvedQuery = useResolvedBindings(selectedStoryboardId);
  const resolvedByShot = useMemo(() => {
    const map = new Map<string, ResolvedBindingCell[]>();
    for (const row of resolvedQuery.data?.shots ?? []) map.set(row.shotId, row.tags);
    return map;
  }, [resolvedQuery.data]);

  useEffect(() => {
    if (!storyboards || storyboards.length === 0) return;
    if (selectedStoryboardId !== null && storyboards.some((s) => s.id === selectedStoryboardId)) {
      return;
    }
    const latest = storyboards.reduce((a, b) => (b.version > a.version ? b : a));
    setSelectedStoryboardId(latest.id);
  }, [storyboards, selectedStoryboardId]);

  /* ---------- 批量重生成后轮询分镜详情，直到 stale 清空 ---------- */
  const [batchPolling, setBatchPolling] = useState(false);
  const detailQuery = useStoryboardDetail(selectedStoryboardId, batchPolling ? 5000 : undefined);
  const storyboard = detailQuery.data;
  const shots = useMemo(
    () => [...(storyboard?.shots ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [storyboard],
  );

  /* ---------- 待重生成汇总条 ---------- */
  const staleQuery = useStaleShots(episodeId);
  const staleShots = staleQuery.data ?? [];
  const generateKeyframe = useGenerateKeyframe();
  const [batchSubmitting, setBatchSubmitting] = useState(false);

  useEffect(() => {
    if (batchPolling && staleQuery.isSuccess && staleShots.length === 0) {
      setBatchPolling(false);
      message.success('批量重生成完成');
      void qc.invalidateQueries({ queryKey: ['storyboard', selectedStoryboardId ?? ''] });
    }
  }, [batchPolling, staleQuery.isSuccess, staleShots.length, qc, selectedStoryboardId]);

  const handleBatchRegenerate = async () => {
    if (staleShots.length === 0) return;
    setBatchSubmitting(true);
    let submitted = 0;
    for (const s of staleShots) {
      try {
        await generateKeyframe.mutateAsync({ shotId: s.id });
        submitted += 1;
      } catch (e) {
        message.error(e instanceof Error ? e.message : '提交重生成失败');
      }
    }
    setBatchSubmitting(false);
    if (submitted > 0) {
      message.success(`已提交 ${submitted} 个关键图重生成任务`);
      setBatchPolling(true);
      void qc.invalidateQueries({ queryKey: ['stale-shots', episodeId] });
    }
  };

  /* ---------- 模型选择数据源（image 能力投影；空列表隐藏走 Mock） ---------- */
  const capabilitiesQuery = useCapabilities('image');
  const imageModels = capabilitiesQuery.data ?? [];

  /* ---------- imagePrompt 就地编辑（apply-patch 产出新版本 → 切换选中） ---------- */
  const applyPatch = useApplyPatch(episodeId);
  const handleUpdateImagePrompt = async (shotId: string, imagePrompt: string) => {
    if (selectedStoryboardId === null) return;
    try {
      const result = await applyPatch.mutateAsync({
        storyboardId: selectedStoryboardId,
        patch: [{ op: 'update_shot', shotId, fields: { imagePrompt } }],
      });
      setSelectedStoryboardId(result.storyboard.id);
      message.success('生图 Prompt 已更新');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '更新失败');
      throw e;
    }
  };

  const versionOptions = [...(storyboards ?? [])]
    .sort((a, b) => b.version - a.version)
    .map((s) => ({
      value: s.id,
      label: `v${s.version}${s.stale ? '（剧本已变更）' : ''}`,
    }));

  return (
    <div style={{ padding: 12 }}>
      <Card
        size="small"
        title={
          <Space>
            <PictureOutlined />
            <span>画面分镜</span>
            <Select
              size="small"
              style={{ width: 180 }}
              placeholder="暂无分镜版本"
              value={selectedStoryboardId ?? undefined}
              options={versionOptions}
              onChange={(v) => setSelectedStoryboardId(v)}
            />
          </Space>
        }
      >
        {staleShots.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`${staleShots.length} 个镜头的上游已变更`}
            action={
              <Button
                size="small"
                type="primary"
                ghost
                loading={batchSubmitting || batchPolling}
                onClick={() => void handleBatchRegenerate()}
              >
                批量重新生成关键图
              </Button>
            }
          />
        )}

        {storyboardsQuery.isLoading || detailQuery.isLoading ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spin />
          </div>
        ) : !storyboards || storyboards.length === 0 ? (
          <Empty description="暂无分镜版本，请先在「剧本」阶段生成分镜" style={{ margin: '48px 0' }} />
        ) : shots.length === 0 ? (
          <Empty description="该分镜版本没有镜头" style={{ margin: '48px 0' }} />
        ) : (
          shots.map((shot, index) => (
            <ShotKeyframeCard
              key={shot.id}
              shot={shot}
              index={index}
              episodeId={episodeId}
              storyboardId={selectedStoryboardId ?? ''}
              imageModels={imageModels}
              patching={applyPatch.isPending}
              refCells={resolvedByShot.get(shot.id) ?? []}
              onUpdateImagePrompt={handleUpdateImagePrompt}
            />
          ))
        )}
      </Card>
    </div>
  );
}

/** ---------- 镜头卡片：左 关键图区（大图 + takes 抽卡横排） / 右 信息与操作 ---------- */

/**
 * "将用参考"预览：与服务端生成逻辑一致的前端镜像——
 * 提示词含 @ 时由 @ 决定；否则角色/道具参考优先（场景不挤占参考位）。
 */
function RefPreview({ shot, refCells }: { shot: ProduceShot; refCells: ResolvedBindingCell[] }) {
  const mentions = [
    ...(shot.imagePrompt || '').matchAll(/@(!?)([^\s@!，。；、,;.!？?！:：()（）【】[\]"'`]+)/g),
  ].map((m) => ({ name: m[2], force: m[1] === '!' }));
  let chosen: ResolvedBindingCell[];
  let modeNote: string;
  if (mentions.length > 0) {
    // 与服务端一致：@角色/@道具 发参考图；@场景 仅锚定文字；@!场景 强制发
    chosen = mentions
      .map(({ name, force }) => {
        const cell = refCells.find((c) => c.name === name);
        if (!cell?.resolved) return null;
        if (cell.type === 'SCENE' && !force) return null;
        return cell;
      })
      .filter((c): c is ResolvedBindingCell => !!c);
    modeNote = '由提示词中的 @ 指定（@场景 仅锚定文字，@!场景 才发参考图）';
  } else {
    const withRef = refCells.filter((c) => c.resolved);
    const characters = withRef.filter((c) => c.type !== 'SCENE');
    chosen = characters.length > 0 ? characters : withRef;
    modeNote = '自动（角色设计图优先，场景图不占参考位，可用 @ 调整）';
  }
  if (chosen.length === 0) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <Tooltip title={modeNote}>
        <Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>
          将用参考：
        </Text>
      </Tooltip>
      <Space size={4} wrap>
        {chosen.map((c) => (
          <Tooltip key={c.tagId} title={`${c.name}（点击缩略图可到素材页换绑）`}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <img
                src={c.resolved!.thumbUri ?? c.resolved!.uri}
                alt={c.name}
                style={{ width: 20, height: 20, objectFit: 'cover', borderRadius: 3, border: '1px solid rgba(5,5,5,0.15)' }}
              />
              <Text style={{ fontSize: 12 }}>{c.name}</Text>
            </span>
          </Tooltip>
        ))}
      </Space>
    </div>
  );
}

function ShotKeyframeCard({
  shot,
  index,
  episodeId,
  storyboardId,
  imageModels,
  patching,
  refCells,
  onUpdateImagePrompt,
}: {
  shot: ProduceShot;
  index: number;
  episodeId: string;
  storyboardId: string;
  imageModels: CapabilityEntry[];
  patching: boolean;
  refCells: ResolvedBindingCell[];
  onUpdateImagePrompt: (shotId: string, imagePrompt: string) => Promise<void>;
}) {
  const qc = useQueryClient();
  const [modelConfigId, setModelConfigId] = useState<string | undefined>(undefined);
  const [editingPrompt, setEditingPrompt] = useState<string | null>(null);

  const generate = useGenerateKeyframe();
  const shotJob = useShotJob({
    onSucceeded: () => {
      message.success(`#${index + 1} 关键图生成完成`);
      void qc.invalidateQueries({ queryKey: ['storyboard', storyboardId] });
      void qc.invalidateQueries({ queryKey: ['stale-shots', episodeId] });
    },
    onFailed: (job) => message.error(job.error ?? '关键图生成失败'),
  });
  const selectTake = useSelectTake();

  const keyframeTakes = (shot.takes ?? []).filter((t) => t.slot === 'KEYFRAME');
  const selectedTake =
    keyframeTakes.find((t) => t.id === shot.keyframeSelectedTakeId) ?? null;

  const generating = generate.isPending || shotJob.running;
  const durationMs = shot.durationLockedMs ?? shot.durationPlannedMs;

  const handleGenerate = () => {
    generate.mutate(
      { shotId: shot.id, modelConfigId },
      {
        onSuccess: (job) => {
          message.success('已提交生成任务');
          shotJob.start(job.id);
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  const savePrompt = async () => {
    if (editingPrompt === null) return;
    try {
      await onUpdateImagePrompt(shot.id, editingPrompt);
      setEditingPrompt(null);
    } catch {
      /* 失败保留编辑态 */
    }
  };

  return (
    <Card size="small" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 16 }}>
        {/* 左：关键图区 */}
        <div style={{ width: 340, flexShrink: 0 }}>
          {selectedTake ? (
            <img
              src={selectedTake.asset.uri}
              alt={`镜头 ${index + 1} 关键图`}
              style={{ width: 340, borderRadius: 6, display: 'block' }}
            />
          ) : (
            <div
              style={{
                width: 340,
                height: 190,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0,0,0,0.03)',
                borderRadius: 6,
              }}
            >
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未生成" />
            </div>
          )}
          {keyframeTakes.length > 0 && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {keyframeTakes.map((take) => {
                const isSelected = take.id === shot.keyframeSelectedTakeId;
                return (
                  <img
                    key={take.id}
                    src={take.asset.thumbUri ?? take.asset.uri}
                    alt="take"
                    title={isSelected ? '当前选定' : '点击选定该 take'}
                    style={{
                      width: 56,
                      height: 56,
                      objectFit: 'cover',
                      borderRadius: 4,
                      cursor: 'pointer',
                      boxSizing: 'border-box',
                      border: isSelected ? '2px solid #faad14' : '2px solid transparent',
                      opacity: selectTake.isPending ? 0.6 : 1,
                    }}
                    onClick={() => {
                      if (isSelected || selectTake.isPending) return;
                      selectTake.mutate(
                        { shotId: shot.id, slot: 'KEYFRAME', takeId: take.id, storyboardId },
                        {
                          onSuccess: () => message.success('已切换选定关键图'),
                          onError: (e) => message.error(e.message),
                        },
                      );
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* 右：信息与操作 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space size={8} wrap style={{ marginBottom: 8 }}>
            <Text strong>#{index + 1}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {shot.durationLockedMs !== null ? '锁定' : '计划'} {formatSeconds(durationMs)}
            </Text>
            {shot.keyframeStale && (
              <StalePopover shot={shot} episodeId={episodeId} storyboardId={storyboardId} />
            )}
          </Space>

          {shot.tags.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {shot.tags.map((t) => (
                <Tag key={t.tagId} color={TAG_COLOR[t.tag.type]}>
                  {t.tag.name}
                </Tag>
              ))}
              <Text type="secondary" style={{ fontSize: 12 }}>
                绑定 {shot.tags.length} 个标签
              </Text>
            </div>
          )}

          <RefPreview shot={shot} refCells={refCells} />

          <Paragraph
            type="secondary"
            ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
            style={{ fontSize: 12, marginBottom: 8 }}
          >
            {shot.sourceText !== '' ? shot.sourceText : '（无原文）'}
          </Paragraph>

          {/* imagePrompt 就地编辑 */}
          {editingPrompt !== null ? (
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                生图 Prompt
              </Text>
              <Input.TextArea
                value={editingPrompt}
                autoSize={{ minRows: 2, maxRows: 6 }}
                style={{ fontSize: 12, marginTop: 2 }}
                onChange={(e) => setEditingPrompt(e.target.value)}
              />
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
                @标签名 引用：@角色/@道具 发参考图；@场景 仅锚定文字（防稀释角色形象）；@!场景 强制发参考图；不写 @ 则自动用本镜头角色设计图
              </Text>
              <Space style={{ marginTop: 4 }}>
                <Button size="small" type="primary" loading={patching} onClick={() => void savePrompt()}>
                  保存
                </Button>
                <Button size="small" onClick={() => setEditingPrompt(null)}>
                  取消
                </Button>
              </Space>
            </div>
          ) : (
            <div
              style={{ marginBottom: 8, cursor: 'pointer' }}
              title="点击编辑"
              onClick={() => setEditingPrompt(shot.imagePrompt)}
            >
              <Text type="secondary" style={{ fontSize: 12 }}>
                生图 Prompt <EditOutlined style={{ fontSize: 11 }} />
              </Text>
              <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                {shot.imagePrompt !== '' ? (
                  shot.imagePrompt
                ) : (
                  <Text type="secondary" italic>
                    （空，点击填写）
                  </Text>
                )}
              </div>
            </div>
          )}

          <Space wrap>
            {imageModels.length > 0 && (
              <Select
                size="small"
                allowClear
                placeholder="模型（默认 Mock）"
                style={{ width: 200 }}
                value={modelConfigId}
                onChange={(v: string | undefined) => setModelConfigId(v)}
                options={imageModels.map((m) => ({
                  value: m.modelConfigId,
                  label: `${m.providerName} / ${m.label}`,
                }))}
              />
            )}
            <Button
              size="small"
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={generating}
              onClick={handleGenerate}
            >
              {keyframeTakes.length > 0 ? '重抽' : '生成关键图'}
            </Button>
            {generating && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {shotJob.job?.status === 'RUNNING'
                  ? `生成中（${shotJob.job.progress}%）…`
                  : '排队中…'}
              </Text>
            )}
          </Space>
        </div>
      </div>
    </Card>
  );
}

/** ---------- stale 角标：Popover 溯源时间线 + 忽略 ---------- */

function StalePopover({
  shot,
  episodeId,
  storyboardId,
}: {
  shot: ProduceShot;
  episodeId: string;
  storyboardId: string;
}) {
  const clearStale = useClearStale(episodeId);
  const reasons = parseStaleReasons(shot.staleReasonsJson);

  const content = (
    <div style={{ maxWidth: 340 }}>
      {reasons.length > 0 ? (
        <Timeline
          style={{ marginTop: 8 }}
          items={reasons.map((r) => ({
            color: 'orange',
            children: (
              <div>
                <div style={{ fontSize: 13 }}>{r.detail}</div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {r.source} · {new Date(r.at).toLocaleString()}
                </Text>
              </div>
            ),
          }))}
        />
      ) : (
        <Text type="secondary" style={{ fontSize: 12 }}>
          无溯源记录
        </Text>
      )}
      <Button
        size="small"
        block
        loading={clearStale.isPending}
        onClick={() =>
          clearStale.mutate(
            { shotId: shot.id, slot: 'KEYFRAME', mode: 'ignored', storyboardId },
            {
              onSuccess: () => message.success('已忽略该变更标记'),
              onError: (e) => message.error(e.message),
            },
          )
        }
      >
        忽略
      </Button>
    </div>
  );

  return (
    <Popover content={content} title="上游变更溯源" trigger="click">
      <Tag icon={<WarningOutlined />} color="warning" style={{ cursor: 'pointer' }}>
        上游已变更
      </Tag>
    </Popover>
  );
}
