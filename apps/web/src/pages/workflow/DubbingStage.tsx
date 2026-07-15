import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Empty,
  InputNumber,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { SoundOutlined, SyncOutlined, ThunderboltOutlined, WarningOutlined } from '@ant-design/icons';
import type { DubbingStatus } from '@ovideo/shared';
import { useStoryboards } from '../../api/workflow-hooks';
import {
  dubbingQueryOptions,
  useGenerateAllDubbing,
  useGenerateDubbingLine,
  useShotJob,
  useStoryboardDetail,
  useSyncDubbing,
  useUpdateDubbingLine,
  type DubbingLineEntity,
  type ProduceShot,
} from '../../api/produce-hooks';

const { Text } = Typography;

/** 单次生成时长上限（超过提示 M3 衔接组） */
const SINGLE_GEN_LIMIT_MS = 15_000;

const STATUS_META: Record<DubbingStatus, { color: string; label: string }> = {
  PENDING: { color: 'default', label: '待生成' },
  GENERATING: { color: 'processing', label: '生成中' },
  READY: { color: 'success', label: '就绪' },
  FAILED: { color: 'error', label: '失败' },
};

function formatSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
}

/** 声音与配音阶段：版本选择 → 逐镜头配音行（同步/语速/单句生成/全部生成/时长锁定） */
export function DubbingStage() {
  const { episodeId = '' } = useParams();
  const qc = useQueryClient();

  /* ---------- 版本选择（默认最新） ---------- */
  const storyboardsQuery = useStoryboards(episodeId);
  const storyboards = storyboardsQuery.data;
  const [selectedStoryboardId, setSelectedStoryboardId] = useState<string | null>(null);

  useEffect(() => {
    if (!storyboards || storyboards.length === 0) return;
    if (selectedStoryboardId !== null && storyboards.some((s) => s.id === selectedStoryboardId)) {
      return;
    }
    const latest = storyboards.reduce((a, b) => (b.version > a.version ? b : a));
    setSelectedStoryboardId(latest.id);
  }, [storyboards, selectedStoryboardId]);

  const detailQuery = useStoryboardDetail(selectedStoryboardId);
  const storyboard = detailQuery.data;
  const shots = useMemo(
    () => [...(storyboard?.shots ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [storyboard],
  );

  /* ---------- 每镜头配音行查询（并行；GENERATING 时自动轮询） ---------- */
  const dubbingQueries = useQueries({
    queries: shots.map((shot) => dubbingQueryOptions(shot.id)),
  });

  /* ---------- 进入页面自动同步：查询结果为空的镜头 sync 一次（防重） ---------- */
  const syncDubbing = useSyncDubbing();
  const autoSyncedRef = useRef(new Set<string>());
  useEffect(() => {
    shots.forEach((shot, i) => {
      const q = dubbingQueries[i];
      if (
        q !== undefined &&
        q.isSuccess &&
        q.data.length === 0 &&
        !autoSyncedRef.current.has(shot.id)
      ) {
        autoSyncedRef.current.add(shot.id);
        syncDubbing.mutate(shot.id, {
          onError: (e) => message.error(`同步对白失败：${e.message}`),
        });
      }
    });
  }, [shots, dubbingQueries, syncDubbing]);

  /* ---------- 全部生成 + 批量完成检测 ---------- */
  const generateAll = useGenerateAllDubbing();
  const [awaitingBatch, setAwaitingBatch] = useState(false);

  const allLines = dubbingQueries.flatMap((q) => q.data ?? []);
  const generatingCount = allLines.filter((l) => l.status === 'GENERATING').length;
  const pendingCount = allLines.filter((l) => l.status === 'PENDING').length;

  // 批量提交后每 5s invalidate 所有 dubbing 查询，直到无 GENERATING
  useEffect(() => {
    if (!awaitingBatch) return;
    const timer = window.setInterval(() => {
      void qc.invalidateQueries({ queryKey: ['dubbing'] });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [awaitingBatch, qc]);

  useEffect(() => {
    if (!awaitingBatch) return;
    if (allLines.length === 0) return;
    if (generatingCount === 0 && pendingCount === 0) {
      setAwaitingBatch(false);
      message.success('镜头时长已按真实配音锁定，视频阶段将按锁定时长生成');
      // 刷新分镜详情以拿到 durationLockedMs
      void qc.invalidateQueries({ queryKey: ['storyboard', selectedStoryboardId ?? ''] });
    }
  }, [awaitingBatch, allLines.length, generatingCount, pendingCount, qc, selectedStoryboardId]);

  const handleGenerateAll = () => {
    if (selectedStoryboardId === null) return;
    generateAll.mutate(selectedStoryboardId, {
      onSuccess: (result) => {
        const n = result.enqueued ?? result.jobs?.length;
        message.success(n !== undefined ? `已提交 ${n} 条配音生成任务` : '已提交全部生成任务');
        setAwaitingBatch(true);
      },
      onError: (e) => message.error(e.message),
    });
  };

  const versionOptions = [...(storyboards ?? [])]
    .sort((a, b) => b.version - a.version)
    .map((s) => ({
      value: s.id,
      label: `v${s.version}${s.stale ? '（剧本已变更）' : ''}`,
    }));

  /* ---------- 布局 ---------- */
  return (
    <div style={{ padding: 12 }}>
      <Card
        size="small"
        title={
          <Space>
            <SoundOutlined />
            <span>声音与配音</span>
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
        extra={
          <Space>
            {(generatingCount > 0 || awaitingBatch) && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                <SyncOutlined spin /> 生成中 {generatingCount} 条…
              </Text>
            )}
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              disabled={selectedStoryboardId === null || shots.length === 0}
              loading={generateAll.isPending}
              onClick={handleGenerateAll}
            >
              全部生成
            </Button>
          </Space>
        }
      >
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
            <ShotDubbingGroup
              key={shot.id}
              shot={shot}
              index={index}
              storyboardId={selectedStoryboardId ?? ''}
              lines={dubbingQueries[index]?.data ?? []}
              loading={dubbingQueries[index]?.isLoading ?? false}
            />
          ))
        )}
      </Card>
    </div>
  );
}

/** ---------- 单镜头分组：小标题行 + 配音行表格 ---------- */

function ShotDubbingGroup({
  shot,
  index,
  storyboardId,
  lines,
  loading,
}: {
  shot: ProduceShot;
  index: number;
  storyboardId: string;
  lines: DubbingLineEntity[];
  loading: boolean;
}) {
  const syncDubbing = useSyncDubbing();
  const updateLine = useUpdateDubbingLine();

  const locked = shot.durationLockedMs;
  const overLimit = locked !== null && locked > SINGLE_GEN_LIMIT_MS;

  const columns = [
    {
      title: '说话人',
      key: 'speaker',
      width: 110,
      render: (_: unknown, line: DubbingLineEntity) => (
        <Text>{line.voiceProfile?.name ?? '旁白'}</Text>
      ),
    },
    {
      title: '文本',
      key: 'text',
      render: (_: unknown, line: DubbingLineEntity) => (
        <Text style={{ fontSize: 13 }}>{line.dialogueLine?.text ?? line.text ?? ''}</Text>
      ),
    },
    {
      title: '语速',
      key: 'speed',
      width: 100,
      render: (_: unknown, line: DubbingLineEntity) => (
        <InputNumber
          size="small"
          min={0.5}
          max={2}
          step={0.1}
          value={line.speed}
          disabled={line.status === 'GENERATING'}
          style={{ width: 72 }}
          onChange={(v) => {
            if (v === null || v < 0.5 || v > 2) return;
            updateLine.mutate(
              { lineId: line.id, shotId: shot.id, speed: v },
              { onError: (e) => message.error(e.message) },
            );
          }}
        />
      ),
    },
    {
      title: '时长',
      key: 'duration',
      width: 70,
      render: (_: unknown, line: DubbingLineEntity) => formatSeconds(line.durationMs),
    },
    {
      title: '状态',
      key: 'status',
      width: 90,
      render: (_: unknown, line: DubbingLineEntity) => {
        const meta = STATUS_META[line.status] ?? STATUS_META.PENDING;
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '播放',
      key: 'play',
      width: 240,
      render: (_: unknown, line: DubbingLineEntity) =>
        line.audioAsset ? (
          <audio controls src={line.audioAsset.uri} style={{ height: 30, width: 220 }} />
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_: unknown, line: DubbingLineEntity) => (
        <LineGenerateButton line={line} storyboardId={storyboardId} />
      ),
    },
  ];

  return (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      styles={{ body: { padding: 0 } }}
      title={
        <Space size={8} style={{ fontWeight: 'normal' }}>
          <Text strong>#{index + 1}</Text>
          <Text type="secondary" ellipsis style={{ maxWidth: 360, fontSize: 12 }}>
            {shot.sourceText !== '' ? shot.sourceText : '（无原文）'}
          </Text>
          <Text style={{ fontSize: 12 }}>
            计划 {formatSeconds(shot.durationPlannedMs)}
            {locked !== null && <> / 锁定 {formatSeconds(locked)}</>}
          </Text>
          {overLimit && (
            <Tooltip title="超过单次生成上限，M3 将支持镜头衔接组">
              <WarningOutlined style={{ color: '#faad14' }} />
            </Tooltip>
          )}
        </Space>
      }
      extra={
        <Button
          size="small"
          icon={<SyncOutlined />}
          loading={syncDubbing.isPending}
          onClick={() =>
            syncDubbing.mutate(shot.id, {
              onSuccess: () => message.success('对白已同步'),
              onError: (e) => message.error(e.message),
            })
          }
        >
          同步对白
        </Button>
      }
    >
      <Table<DubbingLineEntity>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={lines}
        columns={columns}
        pagination={false}
        locale={{ emptyText: '暂无配音行（点击「同步对白」从对白生成）' }}
      />
    </Card>
  );
}

/** ---------- 单句生成按钮（生成类统一模式：POST → job 轮询 → invalidate） ---------- */

function LineGenerateButton({
  line,
  storyboardId,
}: {
  line: DubbingLineEntity;
  storyboardId: string;
}) {
  const qc = useQueryClient();
  const generate = useGenerateDubbingLine();
  const shotJob = useShotJob({
    onSucceeded: () => {
      message.success('配音生成完成，镜头时长已按真实配音锁定');
      void qc.invalidateQueries({ queryKey: ['dubbing', line.shotId] });
      void qc.invalidateQueries({ queryKey: ['storyboard', storyboardId] });
    },
    onFailed: (job) => {
      message.error(job.error ?? '配音生成失败');
      void qc.invalidateQueries({ queryKey: ['dubbing', line.shotId] });
    },
  });

  const running = generate.isPending || shotJob.running || line.status === 'GENERATING';

  return (
    <Button
      size="small"
      type={line.status === 'READY' ? 'default' : 'primary'}
      ghost={line.status !== 'READY'}
      loading={running}
      onClick={() =>
        generate.mutate(
          { lineId: line.id, shotId: line.shotId },
          {
            onSuccess: (job) => {
              message.success('已提交生成任务');
              shotJob.start(job.id);
            },
            onError: (e) => message.error(e.message),
          },
        )
      }
    >
      {line.status === 'READY' ? '重新生成' : '生成'}
    </Button>
  );
}
