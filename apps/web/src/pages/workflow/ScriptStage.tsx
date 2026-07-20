import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import {
  DeleteOutlined,
  DoubleLeftOutlined,
  DoubleRightOutlined,
  ArrowLeftOutlined,
  BulbOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  StarOutlined,
  ThunderboltOutlined,
  UndoOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type {
  CapabilityEntry,
  ShotEditableFields,
  StoryboardPatch,
  TagType,
} from '@ovideo/shared';
import {
  useApplyPatch,
  useCreateScriptDraft,
  useGenerateStoryboard,
  useJob,
  useScriptDrafts,
  useStoryboard,
  useStoryboards,
  useUpdateScriptDraft,
  type ScriptDraft,
  type ShotDetail,
} from '../../api/workflow-hooks';
import { TagDedup } from '../../components/TagDedup';
import { useCapabilities } from '../../api/produce-hooks';
import { ScriptStarter } from './ScriptStarter';
import {
  ScriptChatDock,
  type ChatMessage,
  type ScriptRewriteMessage,
} from './ScriptChatDock';

const { Text, Paragraph } = Typography;

const TAG_COLOR: Record<TagType, string> = {
  CHARACTER: 'blue',
  SCENE: 'volcano',
  PROP: 'gold',
};

/** 三步生成分镜的请求参数（用于失败后原样重试） */
interface GenerateStoryboardPayload {
  draftId: string;
  modelConfigId?: string;
}

/**
 * 分镜生成的常驻失败态。
 * detail 是服务端错误全文（原样呈现，不截断不改写）；
 * payload 是这次失败对应的请求参数快照，「重试」按它原样重发。
 */
interface StoryboardFailure {
  detail: string;
  payload: GenerateStoryboardPayload;
}

const EMPTY_NEW_SHOT = {
  imagePrompt: '',
  videoPrompt: '',
  durationPlannedMs: 12000,
  tags: [] as Array<{ name: string; type: TagType }>,
  dialogue: [] as Array<{ speaker?: string; isNarrator: boolean; text: string }>,
};

/**
 * 剧本阶段：左 剧本稿导航 / 中 剧本文稿（常驻可编辑）/ 右 生成设置 + 对话与分镜结果。
 * 文稿与对话并置而非互斥——用户一边看着正文一边说"怎么改"，
 * 才谈得上"对话即编辑"。
 */
export function ScriptStage() {
  const { projectId = '', episodeId = '' } = useParams();
  const qc = useQueryClient();
  /** 三步生成成功后 +1 → 触发一次静默的重复标签检查（发现拆裂标签立刻提醒） */
  const [dedupSignal, setDedupSignal] = useState(0);

  /* ---------- 剧本稿 ---------- */
  const draftsQuery = useScriptDrafts(episodeId);
  const drafts = draftsQuery.data;
  const createDraft = useCreateScriptDraft(episodeId);
  const updateDraft = useUpdateScriptDraft(episodeId);

  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const loadedDraftRef = useRef<string | null>(null);
  /** 刚由 AI 生成、正文尚未到达的草稿 id：正文到达后补载入一次，随即清空 */
  const awaitingContentRef = useRef<string | null>(null);
  const [renameState, setRenameState] = useState<{ id: string; title: string } | null>(null);

  // 默认选中主剧本；选中项被删时回退
  useEffect(() => {
    if (!drafts || drafts.length === 0) return;
    if (selectedDraftId !== null && drafts.some((d) => d.id === selectedDraftId)) return;
    const main = drafts.find((d) => d.isMain) ?? drafts[0];
    setSelectedDraftId(main.id);
  }, [drafts, selectedDraftId]);

  const selectedDraft = drafts?.find((d) => d.id === selectedDraftId) ?? null;

  // 切换选中稿时载入内容（不覆盖正在输入的文本）。
  // AI 生成走的是"先建空稿 → Job 把正文写回同一条草稿"，草稿 id 不变、内容后到，
  // 因此对刚生成的那一份额外补一次载入——只补一次、且只在正文真的到达后，
  // 不依赖 invalidate 与 effect 的 flush 先后顺序。
  useEffect(() => {
    if (selectedDraft === null) return;
    if (loadedDraftRef.current !== selectedDraft.id) {
      loadedDraftRef.current = selectedDraft.id;
      setContent(selectedDraft.content);
      if (selectedDraft.content !== '') awaitingContentRef.current = null;
      return;
    }
    if (awaitingContentRef.current === selectedDraft.id && selectedDraft.content !== '') {
      awaitingContentRef.current = null;
      setContent(selectedDraft.content);
    }
  }, [selectedDraft]);

  const dirty = selectedDraft !== null && content !== selectedDraft.content;

  const saveContent = () => {
    if (selectedDraft === null || !dirty) return;
    updateDraft.mutate(
      { draftId: selectedDraft.id, content },
      {
        onSuccess: () => message.success('剧本已保存'),
        onError: (e) => message.error(e.message),
      },
    );
  };

  const handleCreateDraft = () => {
    createDraft.mutate(
      { title: `剧本稿 ${(drafts?.length ?? 0) + 1}` },
      {
        onSuccess: (d) => {
          setSelectedDraftId(d.id);
          setStarterOpen(false); // 手工新建 → 直接进编辑器
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  /* ---------- 「从想法开始」入口（新增路径，不影响手工粘贴/编辑链路） ---------- */
  const [starterOpen, setStarterOpen] = useState(false);
  const hasDrafts = (drafts?.length ?? 0) > 0;
  // 一条剧本稿都没有时，创作入口就是这一屏的主视觉（新用户的第一印象）
  const showStarter = !draftsQuery.isLoading && (!hasDrafts || starterOpen);

  /** 生成完成 / 导入成功 → 选中该稿并切回编辑器 */
  const handleStarterCreated = useCallback((draftId: string) => {
    setSelectedDraftId(draftId);
    loadedDraftRef.current = null; // 强制重新载入正文（内容是刚由服务端写回的）
    // 正文可能还没随查询回来，登记等待——到达后由载入 effect 补一次
    awaitingContentRef.current = draftId;
    setStarterOpen(false);
    message.success('剧本已生成，可继续编辑或直接「三步生成分镜」');
  }, []);

  const handleSetMain = (draftId: string) => {
    updateDraft.mutate(
      { draftId, setMain: true },
      {
        onSuccess: () => message.success('已设为主剧本'),
        onError: (e) => message.error(e.message),
      },
    );
  };

  const handleRenameOk = () => {
    if (renameState === null) return;
    const title = renameState.title.trim();
    if (title === '') {
      message.warning('标题不能为空');
      return;
    }
    updateDraft.mutate(
      { draftId: renameState.id, title },
      {
        onSuccess: () => {
          message.success('已重命名');
          setRenameState(null);
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  /* ---------- 三步生成 + Job 轮询 ---------- */
  const generate = useGenerateStoryboard();
  /* 文本模型选择（三步生成与对话修改共用；undefined = 自动调度 + 失效转移） */
  const textModelsQuery = useCapabilities('text');
  const textModels = textModelsQuery.data ?? [];
  const [textModelId, setTextModelId] = useState<string | undefined>(undefined);
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const jobQuery = useJob(runningJobId);
  const job = jobQuery.data;
  const pendingSelectLatestRef = useRef(false);
  /** 分镜生成失败的常驻提示（入队失败与 Job FAILED 共用同一份状态） */
  const [generateFailure, setGenerateFailure] = useState<StoryboardFailure | null>(null);
  /** 最近一次发起用的参数：Job 轮询到 FAILED 时也要能原样重试 */
  const lastGeneratePayloadRef = useRef<GenerateStoryboardPayload | null>(null);

  useEffect(() => {
    if (!job || job.id !== runningJobId) return;
    if (job.status === 'SUCCEEDED') {
      message.success('分镜生成完成');
      pendingSelectLatestRef.current = true;
      void qc.invalidateQueries({ queryKey: ['storyboards', episodeId] });
      setRunningJobId(null);
      setDedupSignal((s) => s + 1); // 生成产生了新标签 → 静默判重
    } else if (job.status === 'FAILED') {
      const detail = job.error ?? '分镜生成失败，服务端未返回具体原因。';
      message.error(detail);
      const payload = lastGeneratePayloadRef.current;
      if (payload !== null) setGenerateFailure({ detail, payload });
      setRunningJobId(null);
    } else if (job.status === 'CANCELED') {
      message.warning('生成任务已取消');
      setRunningJobId(null);
    }
  }, [job, runningJobId, episodeId, qc]);

  const generating = generate.isPending || runningJobId !== null;

  /** 统一的发起入口：新发起与「重试」共用，保证参数与错误清理逻辑只有一份 */
  const submitGenerate = (payload: GenerateStoryboardPayload) => {
    if (generating) return;
    setGenerateFailure(null); // 再次发起 → 清除旧的失败提示
    lastGeneratePayloadRef.current = payload;
    generate.mutate(payload, {
      onSuccess: (j) => {
        message.success('已提交生成任务');
        setRunningJobId(j.id);
      },
      onError: (e) => {
        // 入队就失败（400 / 网络断）：同样留下常驻提示
        const detail = e instanceof Error ? e.message : '分镜生成请求失败。';
        message.error(detail);
        setGenerateFailure({ detail, payload });
      },
    });
  };

  const handleGenerate = () => {
    if (selectedDraft === null) return;
    if (dirty) {
      message.warning('请先保存剧本内容再生成');
      return;
    }
    submitGenerate({ draftId: selectedDraft.id, modelConfigId: textModelId });
  };

  /* ---------- 分镜结果 ---------- */
  const storyboardsQuery = useStoryboards(episodeId);
  const storyboards = storyboardsQuery.data;
  const [selectedStoryboardId, setSelectedStoryboardId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const storyboardQuery = useStoryboard(selectedStoryboardId);
  const storyboard = storyboardQuery.data;
  const applyPatch = useApplyPatch(episodeId);

  // 默认选最新版本；生成成功后强制切到最新版
  useEffect(() => {
    if (!storyboards || storyboards.length === 0) return;
    const latest = storyboards.reduce((a, b) => (b.version > a.version ? b : a));
    if (pendingSelectLatestRef.current) {
      pendingSelectLatestRef.current = false;
      setSelectedStoryboardId(latest.id);
      return;
    }
    if (selectedStoryboardId === null || !storyboards.some((s) => s.id === selectedStoryboardId)) {
      setSelectedStoryboardId(latest.id);
    }
  }, [storyboards, selectedStoryboardId]);

  /** 应用补丁并切换到返回的新版本；失败抛出（调用方据此保留编辑态） */
  const runPatch = async (patch: StoryboardPatch, successMsg: string) => {
    if (selectedStoryboardId === null) return;
    try {
      const result = await applyPatch.mutateAsync({ storyboardId: selectedStoryboardId, patch });
      setSelectedStoryboardId(result.storyboard.id);
      message.success(successMsg);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败');
      throw e;
    }
  };

  const [insertState, setInsertState] = useState<{ afterShotId: string; text: string } | null>(
    null,
  );

  const handleInsertOk = async () => {
    if (insertState === null) return;
    const sourceText = insertState.text.trim();
    if (sourceText === '') {
      message.warning('请填写镜头原文');
      return;
    }
    try {
      await runPatch(
        [
          {
            op: 'add_shot',
            afterShotId: insertState.afterShotId,
            shot: { sourceText, ...EMPTY_NEW_SHOT },
          },
        ],
        '已插入分镜',
      );
      setInsertState(null);
    } catch {
      /* 失败保留弹窗 */
    }
  };

  const versionOptions = [...(storyboards ?? [])]
    .sort((a, b) => b.version - a.version)
    .map((s) => ({
      value: s.id,
      label: `v${s.version}${s.stale ? '（剧本已变更）' : ''}`,
    }));

  /* ---------- 对话（改分镜 M3-lite v2 §4 / 改剧本） ---------- */
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [rewriteMessages, setRewriteMessages] = useState<ScriptRewriteMessage[]>([]);
  /**
   * 「撤销上次对话修改」的一次性快照：改写覆盖的是整篇正文，
   * 不给退路的话用户不敢点采纳。只留一份、用完即弃，不引入新数据模型。
   */
  const [undoSnapshot, setUndoSnapshot] = useState<{ draftId: string; content: string } | null>(
    null,
  );

  // 换稿即清空改剧本的对话与撤销点：A 稿的指令套到 B 稿上没有意义
  useEffect(() => {
    setRewriteMessages([]);
    setUndoSnapshot(null);
  }, [selectedDraftId]);

  /** 采纳改写：先记下改写前的正文再落库，失败则原样抛回给气泡（保持待决状态） */
  const handleAdoptRewrite = useCallback(
    async (nextScript: string) => {
      if (selectedDraft === null) return;
      const before = content; // 以编辑器现值为准——用户想退回的是他刚才看到的那一版
      await updateDraft.mutateAsync({ draftId: selectedDraft.id, content: nextScript });
      setContent(nextScript);
      setUndoSnapshot({ draftId: selectedDraft.id, content: before });
      message.success('已写入剧本，可在标题行撤销');
    },
    [selectedDraft, content, updateDraft],
  );

  const handleUndoRewrite = () => {
    if (undoSnapshot === null) return;
    updateDraft.mutate(
      { draftId: undoSnapshot.draftId, content: undoSnapshot.content },
      {
        onSuccess: () => {
          setContent(undoSnapshot.content);
          setUndoSnapshot(null);
          message.success('已撤销上次对话修改');
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  /* ---------- 布局 ---------- */
  /** 右栏下半区：对话与分镜结果分页共处，默认停在对话（这一屏的主交互） */
  const [dockTab, setDockTab] = useState<'chat' | 'shots'>('chat');
  /** 左侧草稿导航的折叠态：纯展示偏好，不必跨会话保留 */
  const [railCollapsed, setRailCollapsed] = useState(false);

  /** 生成进度：排队与运行中文案统一在右栏设置区呈现 */
  const progressText =
    runningJobId === null
      ? null
      : job?.status === 'RUNNING'
        ? `生成中 ${job.progress}%`
        : '任务排队中……';

  return (
    <div

      style={{
        display: 'flex',
        gap: 12,
        padding: 12,
        height: '100%',
        minHeight: 360,
        alignItems: 'stretch',
      }}
    >
      {/* 左栏：剧本稿导航 */}
      <DraftRail
        collapsed={railCollapsed}
        onToggleCollapsed={() => setRailCollapsed((c) => !c)}
        loading={draftsQuery.isLoading}
        drafts={drafts}
        selectedDraftId={selectedDraftId}
        onSelect={(id) => {
          setSelectedDraftId(id);
          setStarterOpen(false); // 点开某一稿即离开创作入口
        }}
        onRename={(d) => setRenameState({ id: d.id, title: d.title })}
        onSetMain={handleSetMain}
        onOpenStarter={() => setStarterOpen(true)}
        starterDisabled={showStarter}
        onCreate={handleCreateDraft}
        creating={createDraft.isPending}
      />

      {/* 中央画布：剧本正文优先，四周无卡片边框 */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0, // 没有它，正文区的 flex:1 不会收缩，textarea 会把整栏顶高
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {/* 生成成功后静默判重：发现拆裂标签才显示横幅（干净时零打扰） */}
        <TagDedup projectId={projectId} showButton={false} autoCheckSignal={dedupSignal} />

        {showStarter ? (
          <>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 24px' }}
            >
              <span style={{ fontSize: 16, fontWeight: 600 }}>新建剧本</span>
              <span style={{ flex: 1 }} />
              {/* 已有剧本稿时才提供返回；一稿都没有时无处可返回 */}
              {hasDrafts && (
                <Button
                  size="small"
                  icon={<ArrowLeftOutlined />}
                  onClick={() => setStarterOpen(false)}
                >
                  返回编辑器
                </Button>
              )}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 32 }}>
              <ScriptStarter
                episodeId={episodeId}
                textModels={textModels}
                textModelId={textModelId}
                onTextModelChange={setTextModelId}
                onCreated={handleStarterCreated}
                onGenerationStart={() => setStarterOpen(true)}
              />
            </div>
          </>
        ) : selectedDraft === null ? (
          <Empty description="请先在左侧选择或新建剧本稿" style={{ marginTop: 80 }} />
        ) : (
          <>
            {/* 标题行：点标题即改名，省掉一次找按钮的往返 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 24px' }}>
              <Tooltip title="点击重命名">
                <span
                  role="button"
                  tabIndex={0}
                  style={{ fontSize: 16, fontWeight: 600, cursor: 'pointer' }}
                  onClick={() => setRenameState({ id: selectedDraft.id, title: selectedDraft.title })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setRenameState({ id: selectedDraft.id, title: selectedDraft.title });
                    }
                  }}
                >
                  {selectedDraft.title}
                </span>
              </Tooltip>
              {selectedDraft.isMain && <Tag color="gold">主剧本</Tag>}
              <span style={{ flex: 1 }} />
              {/* 采纳改写后才出现，撤销一次即消失——退路就摆在正文旁边，不用去对话里翻 */}
              {undoSnapshot !== null && undoSnapshot.draftId === selectedDraft.id && (
                <Button
                  type="link"
                  size="small"
                  icon={<UndoOutlined />}
                  style={{ padding: 0 }}
                  loading={updateDraft.isPending}
                  onClick={handleUndoRewrite}
                >
                  撤销上次对话修改
                </Button>
              )}
            </div>

            <CanvasToolbar dirty={dirty} saving={updateDraft.isPending} onSave={saveContent} />

            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <Input.TextArea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onBlur={saveContent}
                placeholder="在此粘贴或撰写剧本全文……"
                variant="borderless"
                style={{
                  flex: 1,
                  height: '100%',
                  resize: 'none',
                  fontSize: 15,
                  lineHeight: 1.9,
                  padding: '0 24px',
                }}
              />
            </div>
          </>
        )}
      </div>

      {/* 右栏：生成设置 + 对话 / 分镜结果（可折叠） */}
      {collapsed ? (
        <div style={{ width: 40, flexShrink: 0 }}>
          <Tooltip title="展开生成设置、对话与分镜结果" placement="left">
            <Button
              icon={<DoubleLeftOutlined />}
              onClick={() => setCollapsed(false)}
              style={{ width: 40, height: 120, writingMode: 'vertical-rl' }}
            >
              对话
            </Button>
          </Tooltip>
        </div>
      ) : (
        <div
          style={{
            width: 360,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ flex: 1 }} />
            <Tooltip title="收起">
              <Button
                type="text"
                size="small"
                icon={<DoubleRightOutlined />}
                onClick={() => setCollapsed(true)}
              />
            </Tooltip>
          </div>

          <SettingsPanel
            textModels={textModels}
            textModelId={textModelId}
            onTextModelChange={setTextModelId}
            generating={generating}
            // 停留在创作入口时不允许对上一份草稿发起生成（保持改版前的语义）
            disabled={selectedDraft === null || showStarter}
            onGenerate={handleGenerate}
            progressText={progressText}
            failure={generateFailure}
            onRetry={() => {
              if (generateFailure !== null) submitGenerate(generateFailure.payload);
            }}
            onDismissFailure={() => setGenerateFailure(null)}
          />

          {/* Tabs 只当标签栏用：内容渲染在下面那个 flex:1 容器里，
              面板高度就由本栏自己的 flex 链决定，不必依赖 antd 内部 content-holder 的高度传导 */}
          <Tabs
            size="small"
            activeKey={dockTab}
            onChange={(k) => setDockTab(k as 'chat' | 'shots')}
            tabBarStyle={{ marginBottom: 8 }}
            style={{ marginTop: 8 }}
            items={[
              { key: 'chat', label: '对话' },
              { key: 'shots', label: '分镜结果' },
            ]}
          />

          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {dockTab === 'chat' ? (
              selectedDraft === null ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="请先选择或新建剧本稿"
                  style={{ marginTop: 48 }}
                />
              ) : (
                <ScriptChatDock
                  draftId={selectedDraft.id}
                  modelConfigId={textModelId}
                  rewriteMessages={rewriteMessages}
                  setRewriteMessages={setRewriteMessages}
                  onAdoptRewrite={handleAdoptRewrite}
                  adopting={updateDraft.isPending}
                  dirty={dirty}
                  storyboardId={selectedStoryboardId}
                  storyboard={storyboard}
                  storyboardMessages={chatMessages}
                  setStoryboardMessages={setChatMessages}
                  applyPatch={applyPatch}
                  onSwitchStoryboard={setSelectedStoryboardId}
                />
              )
            ) : (
              /* 分镜结果：版本切换 + 可滚动镜头列表 */
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, flex: 1 }}
              >
                <Select
                  size="small"
                  style={{ width: '100%' }}
                  placeholder="暂无版本"
                  value={selectedStoryboardId ?? undefined}
                  options={versionOptions}
                  onChange={(v) => setSelectedStoryboardId(v)}
                />
                <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                  {storyboardsQuery.isLoading || storyboardQuery.isLoading ? (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                      <Spin />
                    </div>
                  ) : !storyboards || storyboards.length === 0 ? (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="暂无分镜，请点击上方「三步生成分镜」"
                      style={{ marginTop: 60 }}
                    />
                  ) : !storyboard || storyboard.shots.length === 0 ? (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="该版本没有镜头"
                      style={{ marginTop: 60 }}
                    />
                  ) : (
                    <div>
                      {[...storyboard.shots]
                        .sort((a, b) => a.sortOrder - b.sortOrder)
                        .map((shot, index) => (
                          <div key={shot.id}>
                            <ShotCard
                              shot={shot}
                              index={index}
                              patching={applyPatch.isPending}
                              onUpdateShot={(shotId, fields) =>
                                runPatch([{ op: 'update_shot', shotId, fields }], 'Prompt 已更新')
                              }
                              onRemove={(shotId) => {
                                void runPatch([{ op: 'remove_shot', shotId }], '已删除镜头').catch(
                                  () => undefined,
                                );
                              }}
                            />
                            <div style={{ textAlign: 'center', margin: '4px 0 8px' }}>
                              <Button
                                type="dashed"
                                size="small"
                                icon={<PlusOutlined />}
                                style={{ fontSize: 12, width: '90%' }}
                                onClick={() => setInsertState({ afterShotId: shot.id, text: '' })}
                              >
                                插入分镜
                              </Button>
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 重命名弹窗 */}
      <Modal
        title="重命名剧本稿"
        open={renameState !== null}
        onOk={handleRenameOk}
        confirmLoading={updateDraft.isPending}
        onCancel={() => setRenameState(null)}
        okText="确定"
        cancelText="取消"
        destroyOnClose
      >
        <Input
          value={renameState?.title ?? ''}
          maxLength={100}
          placeholder="剧本稿标题"
          onChange={(e) =>
            setRenameState((s) => (s === null ? s : { ...s, title: e.target.value }))
          }
          onPressEnter={handleRenameOk}
        />
      </Modal>

      {/* 插入分镜弹窗 */}
      <Modal
        title="插入分镜"
        open={insertState !== null}
        onOk={() => void handleInsertOk()}
        confirmLoading={applyPatch.isPending}
        onCancel={() => setInsertState(null)}
        okText="插入"
        cancelText="取消"
        destroyOnClose
      >
        <Input.TextArea
          value={insertState?.text ?? ''}
          autoSize={{ minRows: 3, maxRows: 8 }}
          placeholder="镜头原文（对应剧本片段）"
          onChange={(e) => setInsertState((s) => (s === null ? s : { ...s, text: e.target.value }))}
        />
      </Modal>
    </div>
  );
}

/** ---------- 左侧草稿导航栏 ---------- */

/**
 * 剧本稿导航：只负责呈现与事件上抛，所有写操作 handler 由页面注入，
 * 保持"数据在页面、样式在这里"的单向流。
 */
function DraftRail({
  collapsed,
  onToggleCollapsed,
  loading,
  drafts,
  selectedDraftId,
  onSelect,
  onRename,
  onSetMain,
  onOpenStarter,
  starterDisabled,
  onCreate,
  creating,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  loading: boolean;
  drafts: ScriptDraft[] | undefined;
  selectedDraftId: string | null;
  onSelect: (draftId: string) => void;
  onRename: (draft: ScriptDraft) => void;
  onSetMain: (draftId: string) => void;
  onOpenStarter: () => void;
  starterDisabled: boolean;
  onCreate: () => void;
  creating: boolean;
}) {
  const { token } = theme.useToken();
  /** 行内操作按钮平时隐藏，悬停/选中才浮现——窄栏里先保证标题读得完整 */
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  if (collapsed) {
    return (
      <div
        style={{
          width: 40,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <Tooltip title="展开剧本稿" placement="right">
          <Button type="text" icon={<DoubleRightOutlined />} onClick={onToggleCollapsed} />
        </Tooltip>
        <Tooltip title="AI 生成剧本" placement="right">
          <Button type="text" icon={<BulbOutlined />} disabled={starterDisabled} onClick={onOpenStarter} />
        </Tooltip>
        <Tooltip title="新建剧本稿" placement="right">
          <Button type="text" icon={<PlusOutlined />} loading={creating} onClick={onCreate} />
        </Tooltip>
      </div>
    );
  }

  return (
    <div
      style={{
        width: 200,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 8 }}>
        <Text strong style={{ fontSize: 13, flex: 1 }}>
          剧本稿
        </Text>
        <Tooltip title="AI 生成剧本">
          <Button
            type="text"
            size="small"
            icon={<BulbOutlined />}
            disabled={starterDisabled}
            onClick={onOpenStarter}
          />
        </Tooltip>
        <Tooltip title="新建剧本稿">
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined />}
            loading={creating}
            onClick={onCreate}
          />
        </Tooltip>
        <Tooltip title="收起">
          <Button
            type="text"
            size="small"
            icon={<DoubleLeftOutlined />}
            onClick={onToggleCollapsed}
          />
        </Tooltip>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        ) : !drafts || drafts.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无剧本稿" />
        ) : (
          drafts.map((d) => {
            const active = d.id === selectedDraftId;
            const showActions = active || hoveredId === d.id;
            return (
              <div
                key={d.id}
                onClick={() => onSelect(d.id)}
                onMouseEnter={() => setHoveredId(d.id)}
                onMouseLeave={() => setHoveredId((h) => (h === d.id ? null : h))}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  cursor: 'pointer',
                  padding: '5px 6px 5px 9px',
                  marginBottom: 2,
                  borderRadius: token.borderRadius,
                  // 选中态：主色竖条 + 浅填充；未选中悬停只给一层更淡的填充
                  borderInlineStart: `3px solid ${active ? token.colorPrimary : 'transparent'}`,
                  background: active
                    ? token.colorFillSecondary
                    : hoveredId === d.id
                      ? token.colorFillQuaternary
                      : undefined,
                }}
              >
                <Text
                  ellipsis
                  style={{ flex: 1, minWidth: 0, fontSize: 13 }}
                  title={d.title}
                >
                  {d.title}
                </Text>
                {d.isMain && (
                  <Tooltip title="当前主剧本">
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: token.colorWarning,
                      }}
                    />
                  </Tooltip>
                )}
                {showActions && (
                  <>
                    {!d.isMain && (
                      <Tooltip title="设为主剧本">
                        <Button
                          type="text"
                          size="small"
                          icon={<StarOutlined />}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSetMain(d.id);
                          }}
                        />
                      </Tooltip>
                    )}
                    <Tooltip title="重命名">
                      <Button
                        type="text"
                        size="small"
                        icon={<EditOutlined />}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRename(d);
                        }}
                      />
                    </Tooltip>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** ---------- 画布工具条 ---------- */

/** 正文区上方的轻量工具条：只报存盘状态（保存动作仍走页面的 saveContent） */
function CanvasToolbar({
  dirty,
  saving,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const { token } = theme.useToken();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 24px' }}>
      <span style={{ flex: 1 }} />
      {saving ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          保存中…
        </Text>
      ) : dirty ? (
        <Space size={4}>
          <span style={{ fontSize: 12, color: token.colorWarning }}>未保存</span>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={onSave}>
            保存
          </Button>
        </Space>
      ) : (
        <Text type="secondary" style={{ fontSize: 12 }}>
          已保存
        </Text>
      )}
    </div>
  );
}

/** ---------- 右栏「生成设置」---------- */

/** 三步生成的主操作区：模型选择 + 全页最显眼的主按钮 + 进度回显 */
function SettingsPanel({
  textModels,
  textModelId,
  onTextModelChange,
  generating,
  disabled,
  onGenerate,
  progressText,
  failure,
  onRetry,
  onDismissFailure,
}: {
  textModels: CapabilityEntry[];
  textModelId: string | undefined;
  onTextModelChange: (modelConfigId: string | undefined) => void;
  generating: boolean;
  disabled: boolean;
  onGenerate: () => void;
  progressText: string | null;
  /** 生成失败的常驻提示；null 表示无失败 */
  failure: StoryboardFailure | null;
  onRetry: () => void;
  onDismissFailure: () => void;
}) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        borderRadius: token.borderRadiusLG,
        border: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorFillQuaternary,
      }}
    >
      <Text strong style={{ fontSize: 13 }}>
        生成设置
      </Text>

      <Text type="secondary" style={{ fontSize: 12 }}>
        文本模型
      </Text>
      <Select
        size="small"
        style={{ width: '100%' }}
        allowClear
        placeholder="文本模型（自动调度）"
        value={textModelId}
        onChange={(v) => onTextModelChange(v)}
        options={textModels.map((m) => ({
          value: m.modelConfigId,
          label: `${m.label}（${m.providerName}）`,
        }))}
      />

      <Button
        type="primary"
        size="large"
        block
        icon={<ThunderboltOutlined />}
        disabled={disabled}
        loading={generating}
        onClick={onGenerate}
        style={{ marginTop: 4 }}
      >
        三步生成分镜
      </Button>

      <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.6 }}>
        把剧本拆成镜头，并自动抽取角色 / 场景 / 道具要素
      </Text>

      {progressText !== null && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {progressText}
        </Text>
      )}

      {/* 生成失败：常驻在发起按钮下方，直接展示服务端错误全文 + 原参数重试。
          右栏只有 300px，重试按钮放进正文区（而非 Alert 的 action 位）更好读 */}
      {failure !== null && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={onDismissFailure}
          message="分镜生成失败"
          description={
            <div>
              <div
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 12,
                  lineHeight: 1.7,
                }}
              >
                {failure.detail}
              </div>
              <Button
                size="small"
                danger
                icon={<ReloadOutlined />}
                disabled={generating}
                style={{ marginTop: 8 }}
                onClick={onRetry}
              >
                重试
              </Button>
            </div>
          }
          style={{ marginTop: 4 }}
        />
      )}
    </div>
  );
}

/** ---------- 镜头卡片 ---------- */

type PromptField = 'imagePrompt' | 'videoPrompt';

function ShotCard({
  shot,
  index,
  patching,
  onUpdateShot,
  onRemove,
}: {
  shot: ShotDetail;
  index: number;
  patching: boolean;
  onUpdateShot: (shotId: string, fields: ShotEditableFields) => Promise<void>;
  onRemove: (shotId: string) => void;
}) {
  const [editing, setEditing] = useState<{ field: PromptField; value: string } | null>(null);
  const { token } = theme.useToken();

  const stale = shot.keyframeStale || shot.videoStale;
  const seconds = Math.round(shot.durationPlannedMs / 100) / 10;

  const tagNameById = new Map(shot.tags.map((t) => [t.tagId, t.tag.name]));
  const speakerLabel = (line: ShotDetail['dialogue'][number]) => {
    if (line.isNarrator) return '旁白';
    if (line.speakerTagId !== null) return tagNameById.get(line.speakerTagId) ?? '角色';
    return '角色';
  };

  const savePrompt = async () => {
    if (editing === null) return;
    try {
      await onUpdateShot(shot.id, { [editing.field]: editing.value } as ShotEditableFields);
      setEditing(null);
    } catch {
      /* 失败保留编辑态 */
    }
  };

  const renderPrompt = (field: PromptField, label: string) => {
    const value = shot[field];
    if (editing?.field === field) {
      return (
        <div style={{ marginBottom: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {label}
          </Text>
          <Input.TextArea
            value={editing.value}
            autoSize={{ minRows: 2, maxRows: 6 }}
            style={{ fontSize: 12, marginTop: 2 }}
            onChange={(e) => setEditing((s) => (s === null ? s : { ...s, value: e.target.value }))}
          />
          <Space style={{ marginTop: 4 }}>
            <Button
              size="small"
              type="primary"
              loading={patching}
              onClick={() => void savePrompt()}
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
    return (
      <div
        style={{ marginBottom: 4, cursor: 'pointer' }}
        onClick={() => setEditing({ field, value })}
        title="点击编辑"
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          {label} <EditOutlined style={{ fontSize: 11 }} />
        </Text>
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          {value !== '' ? (
            value
          ) : (
            <Text type="secondary" italic>
              （空，点击填写）
            </Text>
          )}
        </div>
      </div>
    );
  };

  return (
    <Card
      size="small"
      style={{ marginBottom: 4 }}
      title={
        <Space size={6}>
          <span>#{index + 1}</span>
          <Text type="secondary" style={{ fontWeight: 'normal', fontSize: 12 }}>
            {seconds}s
          </Text>
        </Space>
      }
      extra={
        <Space size={4}>
          {stale && (
            <Tooltip
              title={`上游已变更：${[
                shot.keyframeStale ? '关键帧待更新' : '',
                shot.videoStale ? '视频待更新' : '',
              ]
                .filter(Boolean)
                .join('、')}`}
            >
              <Tag icon={<WarningOutlined />} color="warning" style={{ marginInlineEnd: 0 }}>
                上游已变更
              </Tag>
            </Tooltip>
          )}
          <Popconfirm
            title="删除该镜头？"
            description="删除后其产物将被回收"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => onRemove(shot.id)}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      }
    >
      {shot.tags.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          {shot.tags.map((t) => (
            <Tag key={t.tagId} color={TAG_COLOR[t.tag.type]}>
              {t.tag.name}
            </Tag>
          ))}
        </div>
      )}

      <Paragraph
        ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
        style={{ marginBottom: 8 }}
      >
        {shot.sourceText !== '' ? (
          shot.sourceText
        ) : (
          <Text type="secondary" italic>
            （无原文）
          </Text>
        )}
      </Paragraph>

      {renderPrompt('imagePrompt', '生图 Prompt')}
      {renderPrompt('videoPrompt', '视频 Prompt')}

      {shot.dialogue.length > 0 && (
        <div style={{ marginTop: 8, borderTop: `1px dashed ${token.colorSplit}`, paddingTop: 6 }}>
          {[...shot.dialogue]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((line) => (
              <div key={line.id} style={{ fontSize: 12, lineHeight: 1.8 }}>
                <Text strong style={{ fontSize: 12 }}>
                  {speakerLabel(line)}：
                </Text>
                {line.text}
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}
