import { Fragment, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Divider,
  Empty,
  Input,
  Popconfirm,
  Popover,
  Progress,
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
  ScissorOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useApplyPatch, useStoryboards } from '../../api/workflow-hooks';
import {
  fmtSeconds,
  parseStaleReasons,
  useAdoptKeyframe,
  useCapabilities,
  useClearStale,
  useGenJob,
  useGenerateShotVideo,
  useSelectTake,
  useShotKeyframeTakes,
  useStoryboardTakes,
  type ShotKeyframeTake,
  type ShotWithTakes,
  type TakeEntity,
  type VideoResolution,
} from '../../api/video-hooks';
import { getShotGroup, useSplitGroup } from '../../api/enhance-hooks';
import { EffectivePromptPopover } from '../../components/EffectivePromptPopover';

const { Text } = Typography;

const GOLD = '#faad14';

/** 衔接组内单段的展示元信息（v2 §5：首尾帧自动传递，强制串行生成） */
interface GroupMeta {
  /** 组内序号（0 起） */
  index: number;
  /** 组内总段数 */
  total: number;
  /** 是否需等待上一段：上一段（groupIndex-1）尚无 selected video */
  waitPrev: boolean;
}

/** 衔接组拆分阈值：锁定时长超过 15s 的非组镜头提供「拆分为衔接组」 */
const SPLIT_THRESHOLD_MS = 15000;

/** 分辨率选项（1080p 成本更高，label 加提示） */
const RESOLUTION_OPTIONS: Array<{ value: VideoResolution; label: string }> = [
  { value: '480p', label: '480p' },
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p（贵）' },
];

/** 视频阶段：I2V 逐镜头生成视频片段（抽卡语义：takes 横排 + selected 金框） */
export function VideoStage() {
  const { episodeId = '' } = useParams();

  /* ---------- 版本选择 ---------- */
  const storyboardsQuery = useStoryboards(episodeId);
  const storyboards = storyboardsQuery.data;
  const [selectedStoryboardId, setSelectedStoryboardId] = useState<string | null>(null);

  /** 用户手动选过旧版本 = 钉住；否则页面始终跟随最新分镜版本 */
  const [versionPinned, setVersionPinned] = useState(false);

  useEffect(() => {
    if (!storyboards || storyboards.length === 0) return;
    const latest = storyboards.reduce((a, b) => (b.version > a.version ? b : a));
    const currentExists =
      selectedStoryboardId !== null && storyboards.some((s) => s.id === selectedStoryboardId);
    // 未钉住时自动跟最新：改提示词产生的新版本里才有新抽的关键图，
    // 停留在旧版本会导致"选不到最新分镜"
    if (!currentExists || (!versionPinned && selectedStoryboardId !== latest.id)) {
      setSelectedStoryboardId(latest.id);
    }
  }, [storyboards, selectedStoryboardId, versionPinned]);

  const storyboardQuery = useStoryboardTakes(selectedStoryboardId);
  const storyboard = storyboardQuery.data;

  /* ---------- 模型选择（modality=video；视频需显式选择模型） ---------- */
  const capsQuery = useCapabilities('video');
  const capabilities = capsQuery.data ?? [];
  const [modelConfigId, setModelConfigId] = useState<string | undefined>(undefined);

  /* ---------- 分辨率（页面级共用；1080p 成本更高） ---------- */
  const [resolution, setResolution] = useState<VideoResolution>('720p');

  /* ---------- videoPrompt 就地编辑（apply-patch → 新版本） ---------- */
  const applyPatch = useApplyPatch(episodeId);
  const updateVideoPrompt = async (shotId: string, videoPrompt: string) => {
    if (selectedStoryboardId === null) return;
    try {
      const result = await applyPatch.mutateAsync({
        storyboardId: selectedStoryboardId,
        patch: [{ op: 'update_shot', shotId, fields: { videoPrompt } }],
      });
      setSelectedStoryboardId(result.storyboard.id);
      message.success('视频 Prompt 已更新');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '更新失败');
      throw e;
    }
  };

  const shots = [...(storyboard?.shots ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const doneCount = shots.filter((s) => s.videoSelectedTakeId !== null).length;

  /* ---------- 衔接组元信息（组内总数 / 是否等待上一段） ---------- */
  const groupSizes = new Map<string, number>();
  for (const s of shots) {
    const { groupId } = getShotGroup(s);
    if (groupId !== null) groupSizes.set(groupId, (groupSizes.get(groupId) ?? 0) + 1);
  }
  const prevSegmentHasVideo = (groupId: string, groupIndex: number): boolean => {
    const prev = shots.find((s) => {
      const g = getShotGroup(s);
      return g.groupId === groupId && g.groupIndex === groupIndex - 1;
    });
    return prev !== undefined && prev.videoSelectedTakeId !== null;
  };
  const groupMetaOf = (shot: ShotWithTakes): GroupMeta | null => {
    const { groupId, groupIndex } = getShotGroup(shot);
    if (groupId === null || groupIndex === null) return null;
    return {
      index: groupIndex,
      total: groupSizes.get(groupId) ?? 1,
      waitPrev: groupIndex > 0 && !prevSegmentHasVideo(groupId, groupIndex),
    };
  };

  const latestStoryboard =
    storyboards && storyboards.length > 0
      ? storyboards.reduce((a, b) => (b.version > a.version ? b : a))
      : null;
  const onOldVersion =
    latestStoryboard !== null &&
    selectedStoryboardId !== null &&
    selectedStoryboardId !== latestStoryboard.id;

  const versionOptions = [...(storyboards ?? [])]
    .sort((a, b) => b.version - a.version)
    .map((s) => ({
      value: s.id,
      label: s.id === latestStoryboard?.id ? `v${s.version}（最新）` : `v${s.version}`,
    }));

  return (
    <div style={{ padding: 12, height: '100%', overflowY: 'auto' }}>
      {/* 顶部：版本 + 进度摘要 + 模型选择 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space size={16} wrap>
          <Space size={8}>
            <Text type="secondary">分镜版本</Text>
            <Select
              size="small"
              style={{ width: 156 }}
              placeholder="暂无版本"
              value={selectedStoryboardId ?? undefined}
              options={versionOptions}
              onChange={(v) => {
                setSelectedStoryboardId(v);
                // 选到最新 = 解除钉住（继续自动跟随后续新版本）
                setVersionPinned(v !== latestStoryboard?.id);
              }}
            />
            {onOldVersion && (
              <Tooltip title="当前停留在旧分镜版本，新抽的关键图在最新版本里">
                <Button
                  size="small"
                  type="link"
                  style={{ paddingInline: 0 }}
                  onClick={() => {
                    if (latestStoryboard === null) return;
                    setSelectedStoryboardId(latestStoryboard.id);
                    setVersionPinned(false);
                  }}
                >
                  回到最新
                </Button>
              </Tooltip>
            )}
          </Space>
          {capabilities.length > 0 && (
            <Space size={8}>
              <Text type="secondary">视频模型</Text>
              <Select
                size="small"
                style={{ width: 220 }}
                allowClear
                placeholder="请选择视频模型（如 Seedance）"
                value={modelConfigId}
                onChange={(v: string | undefined) => setModelConfigId(v)}
                options={capabilities.map((c) => ({
                  value: c.modelConfigId,
                  label: `${c.providerName} · ${c.label}`,
                }))}
              />
            </Space>
          )}
          <Space size={8}>
            <Text type="secondary">分辨率</Text>
            <Select
              size="small"
              style={{ width: 92 }}
              value={resolution}
              onChange={(v: VideoResolution) => setResolution(v)}
              options={RESOLUTION_OPTIONS}
            />
          </Space>
          {shots.length > 0 && (
            <Space size={8}>
              <Text>
                {doneCount}/{shots.length} 镜头已有选定视频
              </Text>
              <Progress
                percent={Math.round((doneCount / shots.length) * 100)}
                size="small"
                style={{ width: 160, marginBottom: 0 }}
              />
            </Space>
          )}
        </Space>
      </Card>

      {storyboardsQuery.isLoading || storyboardQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin />
        </div>
      ) : !storyboards || storyboards.length === 0 ? (
        <Empty description="暂无分镜版本，请先在剧本阶段生成分镜" style={{ marginTop: 80 }} />
      ) : shots.length === 0 ? (
        <Empty description="该版本没有镜头" style={{ marginTop: 80 }} />
      ) : (
        shots.map((shot, index) => {
          const group = groupMetaOf(shot);
          const prevShot = index > 0 ? shots[index - 1] : undefined;
          const isGroupStart =
            group !== null &&
            (prevShot === undefined ||
              getShotGroup(prevShot).groupId !== getShotGroup(shot).groupId);
          return (
            <Fragment key={shot.id}>
              {isGroupStart && (
                <Divider orientation="left" plain style={{ margin: '16px 0 12px' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    衔接组（首尾帧自动传递，需按顺序生成）
                  </Text>
                </Divider>
              )}
              <VideoShotCard
                shot={shot}
                index={index}
                group={group}
                episodeId={episodeId}
                storyboardId={selectedStoryboardId ?? ''}
                modelConfigId={modelConfigId}
                resolution={resolution}
                patching={applyPatch.isPending}
                onUpdatePrompt={updateVideoPrompt}
                onSwitchVersion={(id) => setSelectedStoryboardId(id)}
              />
            </Fragment>
          );
        })
      )}
    </div>
  );
}

/** ---------- 首帧关键图选择器（跨分镜版本） ---------- */

/**
 * 版本化分镜里，旧版本上抽的关键图不会自动同步到新版本，
 * 所以候选必须按 lineage 跨版本拉取，而不是只看当前 shot 行的 takes。
 */
function KeyframePicker({ shotId, active }: { shotId: string; active: boolean }) {
  const query = useShotKeyframeTakes(active ? shotId : null);
  const adopt = useAdoptKeyframe();
  const takes = query.data ?? [];

  if (query.isLoading) {
    return (
      <div style={{ width: 296, textAlign: 'center', padding: 24 }}>
        <Spin size="small" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div style={{ maxWidth: 296 }}>
        <Text type="danger" style={{ fontSize: 12 }}>
          关键图加载失败：{query.error instanceof Error ? query.error.message : '未知错误'}
        </Text>
      </div>
    );
  }

  if (takes.length === 0) {
    return (
      <div style={{ maxWidth: 296 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          该镜头还没有关键图，请先在分镜阶段生成
        </Text>
      </div>
    );
  }

  const handleAdopt = (t: ShotKeyframeTake) => {
    if (t.isSelected || adopt.isPending) return;
    adopt.mutate(
      { shotId, assetId: t.assetId },
      {
        onSuccess: () => message.success('首帧已切换，重新生成视频将使用该关键图'),
        onError: (e) => message.error(e.message),
      },
    );
  };

  return (
    <div style={{ maxWidth: 296 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {/* 接口已按时间倒序去重返回，前端不再排序 */}
        {takes.map((t, i) => (
          <div key={t.takeId} style={{ position: 'relative', lineHeight: 0 }}>
            <img
              src={t.thumbUri ?? t.uri}
              alt="关键图版本"
              title={
                t.isSelected
                  ? '当前首帧'
                  : t.isCurrentShot
                    ? '点击用作首帧'
                    : `来自 v${t.storyboardVersion}，点击取用为首帧`
              }
              style={{
                width: 64,
                height: 64,
                objectFit: 'cover',
                borderRadius: 4,
                cursor: 'pointer',
                boxSizing: 'border-box',
                border: t.isSelected ? `2px solid ${GOLD}` : '2px solid transparent',
                opacity: adopt.isPending ? 0.6 : 1,
              }}
              onClick={() => handleAdopt(t)}
            />
            {i === 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  left: 2,
                  background: '#52c41a',
                  color: '#fff',
                  fontSize: 10,
                  lineHeight: '14px',
                  padding: '0 4px',
                  borderRadius: 3,
                  pointerEvents: 'none',
                }}
              >
                最新
              </span>
            )}
            {/* 蓝色 = 来自其他分镜版本，提示这张是"捞回来的"而非本版本产物 */}
            <span
              style={{
                position: 'absolute',
                right: 2,
                bottom: 2,
                fontSize: 9,
                lineHeight: '12px',
                padding: '0 3px',
                borderRadius: 2,
                background: 'rgba(255,255,255,0.85)',
                color: t.isCurrentShot ? 'rgba(0,0,0,0.45)' : '#1677ff',
                pointerEvents: 'none',
              }}
            >
              v{t.storyboardVersion}
            </span>
          </div>
        ))}
      </div>
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
        按生成时间倒序，共 {takes.length} 张；含其他分镜版本抽过的关键图（蓝色版本号）
      </Text>
    </div>
  );
}

/** ---------- 镜头卡片 ---------- */

function VideoShotCard({
  shot,
  index,
  group,
  episodeId,
  storyboardId,
  modelConfigId,
  resolution,
  patching,
  onUpdatePrompt,
  onSwitchVersion,
}: {
  shot: ShotWithTakes;
  index: number;
  group: GroupMeta | null;
  episodeId: string;
  storyboardId: string;
  modelConfigId: string | undefined;
  /** 顶部工具栏选择的分辨率（页面级共用） */
  resolution: VideoResolution;
  patching: boolean;
  onUpdatePrompt: (shotId: string, videoPrompt: string) => Promise<void>;
  onSwitchVersion: (storyboardId: string) => void;
}) {
  const qc = useQueryClient();

  /** 组内非首段：首帧来自上一段尾帧，且必须等上一段有 selected video */
  const isChained = group !== null && group.index > 0;

  const takes = shot.takes ?? [];
  const videoTakes = takes.filter((t) => t.slot === 'VIDEO');
  const selectedVideo =
    videoTakes.find((t) => t.id === shot.videoSelectedTakeId) ?? null;
  // 角标只需要当前选定的那张；候选列表改由 KeyframePicker 跨版本拉取
  const selectedKeyframe =
    takes.find((t) => t.slot === 'KEYFRAME' && t.id === shot.keyframeSelectedTakeId) ?? null;
  const hasKeyframe = selectedKeyframe !== null;

  /** 受控开关：关闭时让跨版本候选查询 disabled，避免每张卡片常驻请求 */
  const [keyframePickerOpen, setKeyframePickerOpen] = useState(false);

  /* 切换选定 take */
  const selectTake = useSelectTake();
  const handleSelect = (take: TakeEntity) => {
    if (take.id === shot.videoSelectedTakeId || selectTake.isPending) return;
    selectTake.mutate(
      { shotId: shot.id, slot: 'VIDEO', takeId: take.id, storyboardId },
      {
        onSuccess: () => message.success('已切换选定视频'),
        onError: (e) => message.error(e.message),
      },
    );
  };

  /* 生成视频 → job 轮询（2s）→ 成功后失效 storyboard */
  const generate = useGenerateShotVideo();
  const [jobId, setJobId] = useState<string | null>(null);
  const jobQuery = useGenJob(jobId, 2000);
  const job = jobQuery.data;

  useEffect(() => {
    if (!job || job.id !== jobId) return;
    if (job.status === 'SUCCEEDED') {
      message.success(`镜头 #${index + 1} 视频生成完成`);
      void qc.invalidateQueries({ queryKey: ['storyboard', storyboardId] });
      setJobId(null);
    } else if (job.status === 'FAILED') {
      message.error(job.error ?? `镜头 #${index + 1} 视频生成失败`);
      setJobId(null);
    } else if (job.status === 'CANCELED') {
      message.warning(`镜头 #${index + 1} 生成任务已取消`);
      setJobId(null);
    }
  }, [job, jobId, index, storyboardId, qc]);

  const generating = generate.isPending || jobId !== null;

  const handleGenerate = () => {
    generate.mutate(
      { shotId: shot.id, modelConfigId, resolution },
      {
        onSuccess: (j) => {
          message.success('已提交视频生成任务');
          setJobId(j.id);
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  /* 拆分为衔接组（非组镜头且锁定时长 > 15s）→ 新分镜版本并切换 */
  const splitGroup = useSplitGroup(episodeId);
  const canSplit =
    group === null &&
    shot.durationLockedMs !== null &&
    shot.durationLockedMs > SPLIT_THRESHOLD_MS;
  const handleSplit = () => {
    splitGroup.mutate(shot.id, {
      onSuccess: (result) => {
        message.success(`已拆分为衔接组，已切换到新分镜版本 v${result.storyboard.version}`);
        onSwitchVersion(result.storyboard.id);
      },
      onError: (e) => message.error(e.message),
    });
  };

  /* stale 角标：溯源时间线 + 忽略 */
  const clearStale = useClearStale();
  const staleReasons = parseStaleReasons(shot.staleReasonsJson);

  /* videoPrompt 就地编辑 */
  const [editing, setEditing] = useState<string | null>(null);
  const savePrompt = async () => {
    if (editing === null) return;
    try {
      await onUpdatePrompt(shot.id, editing);
      setEditing(null);
    } catch {
      /* 失败保留编辑态 */
    }
  };

  const durationMs = shot.durationLockedMs ?? shot.durationPlannedMs;
  const durationLocked = shot.durationLockedMs !== null;

  return (
    <Card size="small" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* 左：视频区 + takes 横排 */}
        <div style={{ width: 360, flexShrink: 0 }}>
          <div style={{ position: 'relative' }}>
            {selectedVideo !== null ? (
              <video
                controls
                src={selectedVideo.asset.uri}
                style={{ width: 340, borderRadius: 8, background: '#000', display: 'block' }}
              />
            ) : (
              <div
                style={{
                  width: 340,
                  height: 190,
                  borderRadius: 8,
                  background: 'rgba(5,5,5,0.04)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无选定视频" />
              </div>
            )}
            {/* 首帧参考小图角标：非衔接段可点开在本镜头的关键图抽卡版本间切换；组内非首段固定为上一段尾帧 */}
            {selectedKeyframe !== null &&
              (() => {
                const badge = (
                  <div
                    style={{
                      position: 'absolute',
                      top: 6,
                      left: 6,
                      width: 64,
                      borderRadius: 6,
                      overflow: 'hidden',
                      border: '1px solid rgba(255,255,255,0.8)',
                      boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                      lineHeight: 0,
                      cursor: isChained ? 'default' : 'pointer',
                    }}
                  >
                    <img
                      src={selectedKeyframe.asset.thumbUri ?? selectedKeyframe.asset.uri}
                      alt="首帧"
                      style={{ width: 64, height: 64, objectFit: 'cover', display: 'block' }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        background: 'rgba(0,0,0,0.55)',
                        color: '#fff',
                        fontSize: 10,
                        lineHeight: '14px',
                        textAlign: 'center',
                      }}
                    >
                      {isChained ? '上一段尾帧' : '首帧 ▾'}
                    </div>
                  </div>
                );
                if (isChained) {
                  return <Tooltip title="上一段尾帧（衔接组自动传递）">{badge}</Tooltip>;
                }
                return (
                  <Popover
                    trigger="click"
                    placement="rightTop"
                    title="选择首帧关键图（跨分镜版本）"
                    open={keyframePickerOpen}
                    // 打开即拉最新：分镜页刚抽出的关键图可能还没同步到本页缓存
                    onOpenChange={(open) => {
                      setKeyframePickerOpen(open);
                      if (!open) return;
                      void qc.invalidateQueries({ queryKey: ['storyboard', storyboardId] });
                      void qc.invalidateQueries({ queryKey: ['storyboards', episodeId] });
                    }}
                    content={
                      <KeyframePicker
                        shotId={shot.id}
                        // 关闭时置 null 让查询 disabled，下次打开重新拉取
                        active={keyframePickerOpen}
                      />
                    }
                  >
                    {badge}
                  </Popover>
                );
              })()}
          </div>
          {selectedVideo !== null && (
            <div style={{ marginTop: 6 }}>
              <EffectivePromptPopover metaJson={selectedVideo.asset.metaJson} />
            </div>
          )}

          {/* takes 横排缩略（selected 金框，点击切换） */}
          {videoTakes.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {videoTakes.map((t) => {
                const isSelected = t.id === shot.videoSelectedTakeId;
                return (
                  <Tooltip key={t.id} title={isSelected ? '当前选定' : '点击设为选定'}>
                    <div
                      onClick={() => handleSelect(t)}
                      style={{
                        cursor: 'pointer',
                        borderRadius: 6,
                        overflow: 'hidden',
                        border: isSelected ? `2px solid ${GOLD}` : '2px solid transparent',
                        boxShadow: isSelected ? `0 0 4px ${GOLD}` : undefined,
                        lineHeight: 0,
                      }}
                    >
                      <img
                        src={t.asset.thumbUri ?? t.asset.uri}
                        alt="take"
                        style={{ width: 76, height: 48, objectFit: 'cover', display: 'block' }}
                      />
                    </div>
                  </Tooltip>
                );
              })}
            </div>
          )}
        </div>

        {/* 右：信息 + 操作 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space size={8} wrap style={{ marginBottom: 8 }}>
            <Text strong>#{index + 1}</Text>
            {group !== null && (
              <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                衔接 {group.index + 1}/{group.total}
              </Tag>
            )}
            <Text type="secondary">
              生成时长 {fmtSeconds(durationMs)}
              <Tag
                color={durationLocked ? 'blue' : 'default'}
                style={{ marginInlineStart: 6 }}
              >
                {durationLocked ? '锁定（配音）' : '计划'}
              </Tag>
            </Text>
            {shot.videoStale && (
              <Popover
                trigger="click"
                title="上游已变更（溯源）"
                content={
                  <div style={{ maxWidth: 320 }}>
                    <div style={{ maxHeight: 240, overflowY: 'auto', paddingTop: 4 }}>
                      {staleReasons.length === 0 ? (
                        <Text type="secondary">无变更记录</Text>
                      ) : (
                        <Timeline
                          items={staleReasons.map((r) => ({
                            children: (
                              <div style={{ fontSize: 12 }}>
                                <Text type="secondary" style={{ fontSize: 11 }}>
                                  {new Date(r.at).toLocaleString()}
                                </Text>
                                <div>
                                  {r.source}：{r.detail}
                                </div>
                              </div>
                            ),
                          }))}
                        />
                      )}
                    </div>
                    <Button
                      size="small"
                      loading={clearStale.isPending}
                      onClick={() =>
                        clearStale.mutate(
                          { shotId: shot.id, slot: 'VIDEO', mode: 'ignored', storyboardId },
                          {
                            onSuccess: () => message.success('已忽略该失效标记'),
                            onError: (e) => message.error(e.message),
                          },
                        )
                      }
                    >
                      忽略
                    </Button>
                  </div>
                }
              >
                <Tag
                  icon={<WarningOutlined />}
                  color="warning"
                  style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                >
                  上游已变更
                </Tag>
              </Popover>
            )}
          </Space>

          {/* videoPrompt 就地编辑 */}
          {editing !== null ? (
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                视频 Prompt
              </Text>
              <Input.TextArea
                value={editing}
                autoSize={{ minRows: 2, maxRows: 6 }}
                style={{ fontSize: 12, marginTop: 2 }}
                onChange={(e) => setEditing(e.target.value)}
              />
              <Space style={{ marginTop: 4 }}>
                <Button size="small" type="primary" loading={patching} onClick={() => void savePrompt()}>
                  保存
                </Button>
                <Button size="small" onClick={() => setEditing(null)}>
                  取消
                </Button>
              </Space>
            </div>
          ) : (
            <div
              style={{ marginBottom: 8, cursor: 'pointer' }}
              onClick={() => setEditing(shot.videoPrompt)}
              title="点击编辑"
            >
              <Text type="secondary" style={{ fontSize: 12 }}>
                视频 Prompt <EditOutlined style={{ fontSize: 11 }} />
              </Text>
              <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                {shot.videoPrompt !== '' ? (
                  shot.videoPrompt
                ) : (
                  <Text type="secondary" italic>
                    （空，点击填写）
                  </Text>
                )}
              </div>
            </div>
          )}

          <Space size={8}>
            <Tooltip
              title={
                isChained
                  ? group.waitPrev
                    ? '衔接组需按顺序生成，请先完成上一段'
                    : undefined
                  : hasKeyframe
                    ? undefined
                    : '请先在分镜阶段生成并选定关键图'
              }
            >
              <Button
                type="primary"
                size="small"
                icon={<ThunderboltOutlined />}
                disabled={isChained ? group.waitPrev : !hasKeyframe}
                loading={generating}
                onClick={handleGenerate}
              >
                {videoTakes.length > 0 ? '重抽' : '生成视频'}
              </Button>
            </Tooltip>
            {canSplit && (
              <Popconfirm
                title="拆分为衔接组"
                description="将按 15 秒拆分为多段并生成新分镜版本"
                okText="拆分"
                cancelText="取消"
                onConfirm={handleSplit}
              >
                <Button
                  size="small"
                  icon={<ScissorOutlined />}
                  loading={splitGroup.isPending}
                >
                  拆分为衔接组
                </Button>
              </Popconfirm>
            )}
            {jobId !== null && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {job?.status === 'RUNNING' ? `生成中 ${job.progress}%` : '排队中……'}
              </Text>
            )}
          </Space>
        </div>
      </div>
    </Card>
  );
}
