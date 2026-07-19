import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Empty,
  Input,
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
import {
  EditOutlined,
  SoundOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { DubbingStatus } from '@ovideo/shared';
import { useStoryboards } from '../../api/workflow-hooks';
import { useUpdateVoiceProfile } from '../../api/design-hooks';
import {
  dubbingQueryOptions,
  useCapabilities,
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

/** 模型能力未提供音色清单时的兜底（qwen-tts 四音色） */
const FALLBACK_VOICES: Array<{ id: string; label: string }> = [
  { id: 'Cherry', label: '芊悦（女·活泼）' },
  { id: 'Ethan', label: '晨煦（男·阳光）' },
  { id: 'Chelsie', label: '千雪（女·温柔）' },
  { id: 'Serena', label: '苏瑶（女·沉稳）' },
];

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

  /* ---------- 语音模型选择（undefined = 自动调度 tts 队首模型） ---------- */
  const ttsModelsQuery = useCapabilities('tts');
  const ttsModels = ttsModelsQuery.data ?? [];
  const [ttsModelId, setTtsModelId] = useState<string | undefined>(undefined);

  /* ---------- 全部生成 + 批量完成检测 ---------- */
  const generateAll = useGenerateAllDubbing();
  const [awaitingBatch, setAwaitingBatch] = useState(false);

  const allLines = dubbingQueries.flatMap((q) => q.data ?? []);
  const generatingCount = allLines.filter((l) => l.status === 'GENERATING').length;
  const pendingCount = allLines.filter((l) => l.status === 'PENDING').length;

  /* ---------- 角色声音面板：从全部配音行收集去重 voiceProfile ---------- */
  const voiceProfileMap = new Map<string, { id: string; name: string; voiceId: string | null }>();
  for (const line of allLines) {
    const vp = line.voiceProfile;
    if (vp !== null && vp !== undefined && !voiceProfileMap.has(vp.id)) {
      // 契约中配音行 voiceProfile 携带 voiceId，本地类型未声明 → 交叉断言读取
      const voiceId = (vp as typeof vp & { voiceId?: string | null }).voiceId ?? null;
      voiceProfileMap.set(vp.id, { id: vp.id, name: vp.name, voiceId });
    }
  }
  const voiceProfiles = [...voiceProfileMap.values()];

  // 音色选项：选中模型的 voices → 队首模型的 voices → 固定四音色兜底
  const activeTtsModel =
    (ttsModelId !== undefined
      ? ttsModels.find((m) => m.modelConfigId === ttsModelId)
      : undefined) ?? ttsModels[0];
  const voiceOptions = activeTtsModel?.capability.voices ?? FALLBACK_VOICES;

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
    generateAll.mutate({ storyboardId: selectedStoryboardId, modelConfigId: ttsModelId }, {
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
            <Select
              size="small"
              style={{ width: 190 }}
              allowClear
              placeholder="语音模型（自动调度）"
              value={ttsModelId}
              onChange={(v) => setTtsModelId(v)}
              options={ttsModels.map((m) => ({
                value: m.modelConfigId,
                label: `${m.label}（${m.providerName}）`,
              }))}
            />
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
          <>
            <VoiceProfilePanel profiles={voiceProfiles} voiceOptions={voiceOptions} />
            {shots.map((shot, index) => (
              <ShotDubbingGroup
                key={shot.id}
                shot={shot}
                index={index}
                storyboardId={selectedStoryboardId ?? ''}
                modelConfigId={ttsModelId}
                lines={dubbingQueries[index]?.data ?? []}
                loading={dubbingQueries[index]?.isLoading ?? false}
              />
            ))}
          </>
        )}
      </Card>
    </div>
  );
}

/** ---------- 角色声音面板：每个 voiceProfile 一行，指定/清除音色 ---------- */

function VoiceProfilePanel({
  profiles,
  voiceOptions,
}: {
  profiles: Array<{ id: string; name: string; voiceId: string | null }>;
  voiceOptions: Array<{ id: string; label: string }>;
}) {
  const updateVoice = useUpdateVoiceProfile();

  if (profiles.length === 0) return null;

  return (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      title={
        <Space size={6} style={{ fontWeight: 'normal' }}>
          <UserOutlined />
          <Text strong>角色声音</Text>
        </Space>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {profiles.map((profile) => (
          <Space key={profile.id} size={12} wrap>
            <Text strong style={{ display: 'inline-block', minWidth: 80 }}>
              {profile.name}
            </Text>
            <Select
              size="small"
              style={{ width: 200 }}
              allowClear
              placeholder="自动分配"
              value={
                profile.voiceId !== null && profile.voiceId !== '' ? profile.voiceId : undefined
              }
              options={voiceOptions.map((v) => ({ value: v.id, label: v.label }))}
              onChange={(v: string | undefined) =>
                updateVoice.mutate(
                  { voiceProfileId: profile.id, voiceId: v ?? '' },
                  {
                    onSuccess: () =>
                      message.success(
                        v !== undefined
                          ? `已指定「${profile.name}」的音色`
                          : `「${profile.name}」已恢复自动分配`,
                      ),
                    onError: (e) => message.error(e.message),
                  },
                )
              }
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              改音色后需重新生成该角色的配音
            </Text>
          </Space>
        ))}
        <Text type="secondary" style={{ fontSize: 12 }}>
          旁白不在列表中（固定使用「苏瑶」音色）
        </Text>
      </Space>
    </Card>
  );
}

/** ---------- 单镜头分组：小标题行 + 配音行表格 ---------- */

function ShotDubbingGroup({
  shot,
  index,
  storyboardId,
  modelConfigId,
  lines,
  loading,
}: {
  shot: ProduceShot;
  index: number;
  storyboardId: string;
  /** 顶栏选中的语音模型（undefined = 自动调度） */
  modelConfigId?: string;
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
        <EditableLineText
          line={line}
          saving={updateLine.isPending}
          onSave={(text) =>
            updateLine.mutateAsync({ lineId: line.id, shotId: shot.id, text }).then(() => {
              message.success('台词已更新，请重新生成该行配音');
            })
          }
        />
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
        <LineGenerateButton line={line} storyboardId={storyboardId} modelConfigId={modelConfigId} />
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
  modelConfigId,
}: {
  line: DubbingLineEntity;
  storyboardId: string;
  modelConfigId?: string;
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
          { lineId: line.id, shotId: line.shotId, modelConfigId },
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

/** ---------- 台词就地编辑 ---------- */

/**
 * 配音表格的文本单元格：点击进入编辑，Enter 保存 / Esc 取消（Shift+Enter 换行）。
 * 保存后服务端改写来源对白并把该行打回待生成，故此处不做本地乐观更新，等列表刷新为准。
 */
function EditableLineText({
  line,
  saving,
  onSave,
}: {
  line: DubbingLineEntity;
  saving: boolean;
  onSave: (text: string) => Promise<unknown>;
}) {
  const current = line.dialogueLine?.text ?? line.text ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current);
  const editable = Boolean(line.dialogueLine);

  const commit = () => {
    const next = draft.trim();
    if (next === '' || next === current) {
      setEditing(false);
      setDraft(current);
      return;
    }
    void onSave(next)
      .then(() => setEditing(false))
      .catch((e: unknown) => {
        message.error(e instanceof Error ? e.message : '台词保存失败');
      });
  };

  if (!editable) {
    return <Text style={{ fontSize: 13 }}>{current}</Text>;
  }

  if (editing) {
    return (
      <Input.TextArea
        autoFocus
        autoSize={{ minRows: 1, maxRows: 6 }}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            setDraft(current);
            setEditing(false);
          }
        }}
        style={{ fontSize: 13 }}
      />
    );
  }

  return (
    <Tooltip title="点击修改台词（改后需重新生成该行配音）">
      <div
        onClick={() => {
          setDraft(current);
          setEditing(true);
        }}
        style={{ cursor: 'text', minHeight: 22 }}
      >
        <Text style={{ fontSize: 13 }}>{current}</Text>
        <EditOutlined style={{ fontSize: 11, opacity: 0.35, marginInlineStart: 6 }} />
      </div>
    </Tooltip>
  );
}
