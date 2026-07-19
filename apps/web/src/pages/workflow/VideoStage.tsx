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
  useCapabilities,
  useClearStale,
  useGenJob,
  useGenerateShotVideo,
  useSelectTake,
  useStoryboardTakes,
  type ShotWithTakes,
  type TakeEntity,
} from '../../api/video-hooks';
import { getShotGroup, useSplitGroup } from '../../api/enhance-hooks';

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

/** 视频阶段：I2V 逐镜头生成视频片段（抽卡语义：takes 横排 + selected 金框） */
export function VideoStage() {
  const { episodeId = '' } = useParams();

  /* ---------- 版本选择 ---------- */
  const storyboardsQuery = useStoryboards(episodeId);
  const storyboards = storyboardsQuery.data;
  const [selectedStoryboardId, setSelectedStoryboardId] = useState<string | null>(null);

  useEffect(() => {
    if (!storyboards || storyboards.length === 0) return;
    if (
      selectedStoryboardId !== null &&
      storyboards.some((s) => s.id === selectedStoryboardId)
    )
      return;
    const latest = storyboards.reduce((a, b) => (b.version > a.version ? b : a));
    setSelectedStoryboardId(latest.id);
  }, [storyboards, selectedStoryboardId]);

  const storyboardQuery = useStoryboardTakes(selectedStoryboardId);
  const storyboard = storyboardQuery.data;

  /* ---------- 模型选择（modality=video；视频需显式选择模型） ---------- */
  const capsQuery = useCapabilities('video');
  const capabilities = capsQuery.data ?? [];
  const [modelConfigId, setModelConfigId] = useState<string | undefined>(undefined);

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

  const versionOptions = [...(storyboards ?? [])]
    .sort((a, b) => b.version - a.version)
    .map((s) => ({ value: s.id, label: `v${s.version}` }));

  return (
    <div style={{ padding: 12, height: '100%', overflowY: 'auto' }}>
      {/* 顶部：版本 + 进度摘要 + 模型选择 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space size={16} wrap>
          <Space size={8}>
            <Text type="secondary">分镜版本</Text>
            <Select
              size="small"
              style={{ width: 140 }}
              placeholder="暂无版本"
              value={selectedStoryboardId ?? undefined}
              options={versionOptions}
              onChange={(v) => setSelectedStoryboardId(v)}
            />
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

/** ---------- 镜头卡片 ---------- */

function VideoShotCard({
  shot,
  index,
  group,
  episodeId,
  storyboardId,
  modelConfigId,
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
  const keyframeTakes = takes.filter((t) => t.slot === 'KEYFRAME');
  const selectedKeyframe =
    keyframeTakes.find((t) => t.id === shot.keyframeSelectedTakeId) ?? null;
  const hasKeyframe = selectedKeyframe !== null;

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
      { shotId: shot.id, modelConfigId },
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
            {/* 首帧参考小图角标（衔接组非首段：首帧 = 上一段尾帧自动传递） */}
            {selectedKeyframe !== null && (
              <Tooltip
                title={
                  isChained
                    ? '上一段尾帧（衔接组自动传递）'
                    : '首帧参考（分镜阶段选定的关键图）'
                }
              >
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
                    {isChained ? '上一段尾帧' : '首帧'}
                  </div>
                </div>
              </Tooltip>
            )}
          </div>

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
