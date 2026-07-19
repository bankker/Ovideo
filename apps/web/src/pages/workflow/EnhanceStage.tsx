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
  Upload,
  message,
} from 'antd';
import { MergeCellsOutlined, UploadOutlined, VideoCameraOutlined } from '@ant-design/icons';
import type { CutStatus } from '@ovideo/shared';
import { useStoryboards } from '../../api/workflow-hooks';
import {
  fmtSeconds,
  useCreateCut,
  useCuts,
  useGenJob,
  useProjectAudioAssets,
  useStoryboardTakes,
  useUploadProjectAsset,
  type AssetEntity,
  type AudioMixMode,
  type CutRatio,
  type ShotWithTakes,
  type TakeEntity,
} from '../../api/video-hooks';
import { useEnhanceShot, type EnhanceKind } from '../../api/enhance-hooks';

const { Text } = Typography;

const CUT_STATUS_TAG: Record<CutStatus, { color: string; label: string }> = {
  DRAFT: { color: 'default', label: '草稿' },
  COMPOSING: { color: 'processing', label: '合成中' },
  READY: { color: 'success', label: '就绪' },
  FAILED: { color: 'error', label: '失败' },
};

/** BGM 候选的展示名：上传时的原始文件名，缺失时回落资产 id 片段 */
function audioAssetLabel(a: AssetEntity): string {
  try {
    const meta = JSON.parse(a.metaJson) as { originalName?: string };
    if (meta.originalName) return meta.originalName;
  } catch {
    /* 落到兜底 */
  }
  return `音频 ${a.id.slice(-6)}`;
}

const BGM_VOLUME_OPTIONS = [
  { value: 0.1, label: '音量 10%' },
  { value: 0.15, label: '音量 15%' },
  { value: 0.25, label: '音量 25%' },
  { value: 0.4, label: '音量 40%' },
  { value: 0.6, label: '音量 60%' },
  { value: 1, label: '音量 100%' },
];

/** 美化阶段（M3 v2.0 最小集）：选定视频片段清单 + 拼接合成成片 + 历史 Cut */
export function EnhanceStage() {
  const { projectId = '', episodeId = '' } = useParams();
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
  const [audioMixMode, setAudioMixMode] = useState<AudioMixMode>('SMART');
  const [cutRatio, setCutRatio] = useState<CutRatio>('AUTO');

  /* ---------- 背景音乐：项目资产库音频 + 上传 + 音量 ---------- */
  const audioAssetsQuery = useProjectAudioAssets(projectId);
  const audioAssets = audioAssetsQuery.data ?? [];
  const uploadAsset = useUploadProjectAsset(projectId);
  const [bgmAssetId, setBgmAssetId] = useState<string | undefined>(undefined);
  const [bgmVolume, setBgmVolume] = useState(0.25);
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
    createCut.mutate(
      {
        storyboardId: selectedStoryboardId,
        audioMixMode,
        ratio: cutRatio,
        ...(bgmAssetId !== undefined ? { bgmAssetId, bgmVolume } : {}),
      },
      {
        onSuccess: ({ job: j }) => {
          message.success('已提交合成任务');
          setComposeJobId(j.id);
        },
        onError: (e) => message.error(e.message),
      },
    );
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
          <Space size={8}>
            <Tooltip title="成片画幅：自动 = 跟随片段的实际分辨率（推荐）；显式比例会把所有片段等比缩放并补边到统一画布">
              <Text type="secondary" style={{ fontSize: 12 }}>
                画幅
              </Text>
            </Tooltip>
            <Select
              size="small"
              style={{ width: 110 }}
              value={cutRatio}
              onChange={(v: CutRatio) => setCutRatio(v)}
              options={[
                { value: 'AUTO', label: '自动（推荐）' },
                { value: '9:16', label: '9:16 竖屏' },
                { value: '16:9', label: '16:9 横屏' },
                { value: '1:1', label: '1:1' },
                { value: '3:4', label: '3:4' },
                { value: '4:3', label: '4:3' },
              ]}
            />
            <Tooltip title="有配音的镜头如何处理视频自带的声音（无配音镜头总是保留原声）">
              <Text type="secondary" style={{ fontSize: 12 }}>
                音轨
              </Text>
            </Tooltip>
            <Select
              size="small"
              style={{ width: 150 }}
              value={audioMixMode}
              onChange={(v: AudioMixMode) => setAudioMixMode(v)}
              options={[
                { value: 'SMART', label: '配音替换原声' },
                { value: 'DUCK', label: '原声压低垫底' },
                { value: 'MIX', label: '原声配音叠加' },
              ]}
            />
            <Tooltip title="背景音乐：循环铺满全片压在台词下方，结尾自动淡出 2 秒">
              <Text type="secondary" style={{ fontSize: 12 }}>
                音乐
              </Text>
            </Tooltip>
            <Select
              size="small"
              allowClear
              style={{ width: 168 }}
              placeholder="无背景音乐"
              value={bgmAssetId}
              onChange={(v: string | undefined) => setBgmAssetId(v)}
              options={audioAssets.map((a) => ({ value: a.id, label: audioAssetLabel(a) }))}
            />
            <Upload
              accept="audio/*"
              showUploadList={false}
              customRequest={({ file, onSuccess, onError }) => {
                uploadAsset.mutate(file as File, {
                  onSuccess: (asset) => {
                    message.success('音乐已上传并选用');
                    setBgmAssetId(asset.id);
                    onSuccess?.(asset);
                  },
                  onError: (e) => {
                    message.error(e.message);
                    onError?.(e);
                  },
                });
              }}
            >
              <Tooltip title="上传音乐文件（mp3/wav/m4a…）">
                <Button size="small" icon={<UploadOutlined />} loading={uploadAsset.isPending} />
              </Tooltip>
            </Upload>
            {bgmAssetId !== undefined && (
              <Select
                size="small"
                style={{ width: 104 }}
                value={bgmVolume}
                onChange={(v: number) => setBgmVolume(v)}
                options={BGM_VOLUME_OPTIONS}
              />
            )}
          </Space>
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

/** ---------- 单个片段卡片（缺失=红色；单段增强：放大/补帧可用，对口型留白） ---------- */

function SegmentCard({
  shot,
  take,
  index,
}: {
  shot: ShotWithTakes;
  take: TakeEntity | null;
  index: number;
}) {
  const qc = useQueryClient();
  const missing = take === null;
  const durationMs =
    take !== null
      ? (take.asset.durationMs ?? shot.durationLockedMs ?? shot.durationPlannedMs)
      : null;

  /* ---------- 单段增强：POST enhance → 202 job → 轮询 → 成功后刷新分镜 ---------- */
  const enhance = useEnhanceShot();
  const [activeKind, setActiveKind] = useState<EnhanceKind | null>(null);
  const [enhanceJobId, setEnhanceJobId] = useState<string | null>(null);
  const enhanceJobQuery = useGenJob(enhanceJobId, 2000);
  const enhanceJob = enhanceJobQuery.data;

  useEffect(() => {
    if (!enhanceJob || enhanceJob.id !== enhanceJobId) return;
    if (enhanceJob.status === 'SUCCEEDED') {
      message.success('增强完成，已替换为增强版片段');
      void qc.invalidateQueries({ queryKey: ['storyboard', shot.storyboardId] });
      setEnhanceJobId(null);
      setActiveKind(null);
    } else if (enhanceJob.status === 'FAILED') {
      message.error(enhanceJob.error ?? `片段 #${index + 1} 增强失败`);
      setEnhanceJobId(null);
      setActiveKind(null);
    } else if (enhanceJob.status === 'CANCELED') {
      message.warning(`片段 #${index + 1} 增强任务已取消`);
      setEnhanceJobId(null);
      setActiveKind(null);
    }
  }, [enhanceJob, enhanceJobId, index, shot.storyboardId, qc]);

  const enhancing = enhance.isPending || enhanceJobId !== null;

  const handleEnhance = (kind: EnhanceKind) => {
    if (missing || enhancing) return;
    setActiveKind(kind);
    enhance.mutate(
      { shotId: shot.id, kind },
      {
        onSuccess: (job) => {
          message.success('已提交增强任务');
          setEnhanceJobId(job.id);
        },
        onError: (e) => {
          message.error(e.message);
          setActiveKind(null);
        },
      },
    );
  };

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
      <Space size={4} wrap style={{ marginTop: 6 }}>
        <Tooltip title={missing ? '请先在视频阶段生成并选定视频' : undefined}>
          <Button
            size="small"
            style={{ fontSize: 11, padding: '0 6px' }}
            disabled={missing || (enhancing && activeKind !== 'upscale')}
            loading={enhancing && activeKind === 'upscale'}
            onClick={() => handleEnhance('upscale')}
          >
            高清放大
          </Button>
        </Tooltip>
        <Tooltip
          title={
            missing ? '请先在视频阶段生成并选定视频' : 'CPU 补帧较慢，请耐心等待'
          }
        >
          <Button
            size="small"
            style={{ fontSize: 11, padding: '0 6px' }}
            disabled={missing || (enhancing && activeKind !== 'interpolate')}
            loading={enhancing && activeKind === 'interpolate'}
            onClick={() => handleEnhance('interpolate')}
          >
            智能补帧
          </Button>
        </Tooltip>
        <Tooltip title="需 GPU 集群，M3 完整版开放">
          <Button size="small" disabled style={{ fontSize: 11, padding: '0 6px' }}>
            对口型
          </Button>
        </Tooltip>
      </Space>
      {enhanceJobId !== null && (
        <div style={{ marginTop: 4 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {enhanceJob?.status === 'RUNNING'
              ? `增强中 ${enhanceJob.progress}%`
              : '排队中……'}
          </Text>
        </div>
      )}
    </Card>
  );
}
