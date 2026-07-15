import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Empty,
  List,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { MergeCellsOutlined, VideoCameraOutlined } from '@ant-design/icons';
import type { CutStatus } from '@ovideo/shared';
import { useStoryboards } from '../../api/workflow-hooks';
import {
  fmtSeconds,
  useCreateCut,
  useCuts,
  useGenJob,
  useStoryboardTakes,
  type ShotWithTakes,
  type TakeEntity,
} from '../../api/video-hooks';

const { Text } = Typography;

const CUT_STATUS_TAG: Record<CutStatus, { color: string; label: string }> = {
  DRAFT: { color: 'default', label: '草稿' },
  COMPOSING: { color: 'processing', label: '合成中' },
  READY: { color: 'success', label: '就绪' },
  FAILED: { color: 'error', label: '失败' },
};

/** M3 单段增强位（放大/补帧/对口型）：先留白禁用 */
const ENHANCE_PLACEHOLDER_ACTIONS = ['放大', '补帧', '对口型'];

/** 美化阶段（M3 v2.0 最小集）：选定视频片段清单 + 拼接合成成片 + 历史 Cut */
export function EnhanceStage() {
  const { episodeId = '' } = useParams();
  const qc = useQueryClient();

  /* ---------- 版本选择 → 分镜详情 ---------- */
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

  const shots = [...(storyboard?.shots ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const segments = shots.map((shot) => {
    const take =
      (shot.takes ?? []).find((t) => t.slot === 'VIDEO' && t.id === shot.videoSelectedTakeId) ??
      null;
    return { shot, take };
  });
  const missingCount = segments.filter((s) => s.take === null).length;
  const totalMs = segments.reduce((sum, s) => {
    if (s.take === null) return sum;
    return sum + (s.take.asset.durationMs ?? s.shot.durationLockedMs ?? s.shot.durationPlannedMs);
  }, 0);

  /* ---------- 合成成片：POST cuts → { cut, job } → 轮询 ---------- */
  const createCut = useCreateCut(episodeId);
  const [composeJobId, setComposeJobId] = useState<string | null>(null);
  const jobQuery = useGenJob(composeJobId, 2000);
  const job = jobQuery.data;

  useEffect(() => {
    if (!job || job.id !== composeJobId) return;
    if (job.status === 'SUCCEEDED') {
      message.success('成片合成完成，请到成品页查看');
      void qc.invalidateQueries({ queryKey: ['cuts', episodeId] });
      setComposeJobId(null);
    } else if (job.status === 'FAILED') {
      message.error(job.error ?? '成片合成失败');
      void qc.invalidateQueries({ queryKey: ['cuts', episodeId] });
      setComposeJobId(null);
    } else if (job.status === 'CANCELED') {
      message.warning('合成任务已取消');
      void qc.invalidateQueries({ queryKey: ['cuts', episodeId] });
      setComposeJobId(null);
    }
  }, [job, composeJobId, episodeId, qc]);

  const composing = createCut.isPending || composeJobId !== null;
  const composeDisabled =
    selectedStoryboardId === null || shots.length === 0 || missingCount > 0;

  const handleCompose = () => {
    if (selectedStoryboardId === null) return;
    if (missingCount > 0) {
      message.warning(`还有 ${missingCount} 个镜头未选定视频，请先到视频阶段生成并选定`);
      return;
    }
    createCut.mutate(selectedStoryboardId, {
      onSuccess: ({ job: j }) => {
        message.success('已提交合成任务');
        setComposeJobId(j.id);
      },
      onError: (e) => message.error(e.message),
    });
  };

  /* ---------- 历史 Cut ---------- */
  const cutsQuery = useCuts(episodeId);
  const cuts = [...(cutsQuery.data ?? [])].sort((a, b) => b.version - a.version);

  const versionOptions = [...(storyboards ?? [])]
    .sort((a, b) => b.version - a.version)
    .map((s) => ({ value: s.id, label: `v${s.version}` }));

  return (
    <div style={{ padding: 12, height: '100%', overflowY: 'auto' }}>
      {/* 顶部：版本 + 合计 + 合成按钮 */}
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
          {shots.length > 0 && (
            <Text type="secondary">
              片段 {shots.length - missingCount}/{shots.length} · 总时长约 {fmtSeconds(totalMs)}
              {missingCount > 0 && (
                <Text type="danger" style={{ marginInlineStart: 8 }}>
                  {missingCount} 个镜头未选定视频
                </Text>
              )}
            </Text>
          )}
          <Tooltip
            title={
              missingCount > 0
                ? '存在未选定视频的镜头，请先到视频阶段生成并选定'
                : shots.length === 0
                  ? '当前版本没有镜头'
                  : undefined
            }
          >
            <Button
              type="primary"
              icon={<MergeCellsOutlined />}
              disabled={composeDisabled}
              loading={composing}
              onClick={handleCompose}
            >
              合成成片
            </Button>
          </Tooltip>
          {composeJobId !== null && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {job?.status === 'RUNNING' ? `合成中 ${job.progress}%` : '排队中……'}
            </Text>
          )}
        </Space>
      </Card>

      {/* 片段清单 */}
      <Card size="small" title="选定视频片段（按镜头顺序拼接）" style={{ marginBottom: 12 }}>
        {storyboardsQuery.isLoading || storyboardQuery.isLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin />
          </div>
        ) : shots.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无镜头，请先在剧本阶段生成分镜"
          />
        ) : (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {segments.map(({ shot, take }, index) => (
              <SegmentCard key={shot.id} shot={shot} take={take} index={index} />
            ))}
          </div>
        )}
      </Card>

      {/* 历史 Cut */}
      <Card size="small" title="历史成片">
        {cutsQuery.isLoading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        ) : cuts.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无成片记录" />
        ) : (
          <List
            size="small"
            dataSource={cuts}
            renderItem={(cut) => {
              const st = CUT_STATUS_TAG[cut.status];
              return (
                <List.Item>
                  <Space size={12}>
                    <Text strong>v{cut.version}</Text>
                    <Tag color={st.color}>{st.label}</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {new Date(cut.createdAt).toLocaleString()}
                    </Text>
                  </Space>
                </List.Item>
              );
            }}
          />
        )}
      </Card>
    </div>
  );
}

/** ---------- 单个片段卡片（缺失=红色；单段增强 M3 留白） ---------- */

function SegmentCard({
  shot,
  take,
  index,
}: {
  shot: ShotWithTakes;
  take: TakeEntity | null;
  index: number;
}) {
  const missing = take === null;
  const durationMs =
    take !== null
      ? (take.asset.durationMs ?? shot.durationLockedMs ?? shot.durationPlannedMs)
      : null;

  return (
    <Card
      size="small"
      style={{
        width: 168,
        borderColor: missing ? '#ff4d4f' : undefined,
      }}
      styles={{ body: { padding: 8 } }}
    >
      {missing ? (
        <div
          style={{
            height: 90,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            background: 'rgba(255,77,79,0.06)',
            borderRadius: 6,
          }}
        >
          <VideoCameraOutlined style={{ fontSize: 20, color: '#ff4d4f' }} />
          <Text type="danger" style={{ fontSize: 12 }}>
            未选定视频
          </Text>
        </div>
      ) : (
        <img
          src={take.asset.thumbUri ?? take.asset.uri}
          alt={`片段 ${index + 1}`}
          style={{
            width: '100%',
            height: 90,
            objectFit: 'cover',
            borderRadius: 6,
            display: 'block',
          }}
        />
      )}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 6,
        }}
      >
        <Text strong style={{ fontSize: 12 }}>
          #{index + 1}
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {fmtSeconds(durationMs)}
        </Text>
      </div>
      <Space size={4} style={{ marginTop: 6 }}>
        {ENHANCE_PLACEHOLDER_ACTIONS.map((label) => (
          <Tooltip key={label} title="M3 GPU 集群接入后开放">
            <Button size="small" disabled style={{ fontSize: 11, padding: '0 6px' }}>
              {label}
            </Button>
          </Tooltip>
        ))}
      </Space>
    </Card>
  );
}
