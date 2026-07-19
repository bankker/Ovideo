import {
  useCallback,
  useEffect,

  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Divider,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import {
  CheckOutlined,
  DeleteOutlined,
  DoubleLeftOutlined,
  DoubleRightOutlined,
  ArrowLeftOutlined,
  BulbOutlined,
  EditOutlined,
  PlusOutlined,
  SendOutlined,
  StarOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type {
  CapabilityEntry,
  ShotEditableFields,
  StoryboardPatch,
  StoryboardPatchOp,
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
  type StoryboardDetail,
} from '../../api/workflow-hooks';
import { TagDedup } from '../../components/TagDedup';
import { useCapabilities } from '../../api/produce-hooks';
import { useScriptChat } from '../../api/chat-hooks';
import { ScriptStarter } from './ScriptStarter';

const { Text, Paragraph } = Typography;

const TAG_COLOR: Record<TagType, string> = {
  CHARACTER: 'blue',
  SCENE: 'volcano',
  PROP: 'gold',
};

const EMPTY_NEW_SHOT = {
  imagePrompt: '',
  videoPrompt: '',
  durationPlannedMs: 12000,
  tags: [] as Array<{ name: string; type: TagType }>,
  dialogue: [] as Array<{ speaker?: string; isNarrator: boolean; text: string }>,
};

/** 剧本阶段（M1 三步生成表单流）：左 剧本稿列表 / 中 内容编辑 / 右 分镜结果 */
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
  /** 编辑 / 对话模式（声明在此以便创作入口完成后切回编辑器） */
  const [mode, setMode] = useState<'edit' | 'chat'>('edit');
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
    setMode('edit');
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

  useEffect(() => {
    if (!job || job.id !== runningJobId) return;
    if (job.status === 'SUCCEEDED') {
      message.success('分镜生成完成');
      pendingSelectLatestRef.current = true;
      void qc.invalidateQueries({ queryKey: ['storyboards', episodeId] });
      setRunningJobId(null);
      setDedupSignal((s) => s + 1); // 生成产生了新标签 → 静默判重
    } else if (job.status === 'FAILED') {
      message.error(job.error ?? '分镜生成失败');
      setRunningJobId(null);
    } else if (job.status === 'CANCELED') {
      message.warning('生成任务已取消');
      setRunningJobId(null);
    }
  }, [job, runningJobId, episodeId, qc]);

  const generating = generate.isPending || runningJobId !== null;

  const handleGenerate = () => {
    if (selectedDraft === null) return;
    if (dirty) {
      message.warning('请先保存剧本内容再生成');
      return;
    }
    generate.mutate(
      { draftId: selectedDraft.id, modelConfigId: textModelId },
      {
        onSuccess: (j) => {
          message.success('已提交生成任务');
          setRunningJobId(j.id);
        },
        onError: (e) => message.error(e.message),
      },
    );
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

  /* ---------- 对话修改模式（M3-lite，v2 §4） ---------- */
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  /* ---------- 布局 ---------- */
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
            </div>

            <CanvasToolbar
              mode={mode}
              onModeChange={setMode}
              dirty={dirty}
              saving={updateDraft.isPending}
              onSave={saveContent}
            />

            {mode === 'edit' ? (
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
            ) : (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', padding: '0 24px' }}>
                <ScriptChatPanel
                  draftId={selectedDraft.id}
                  storyboardId={selectedStoryboardId}
                  storyboard={storyboard}
                  modelConfigId={textModelId}
                  messages={chatMessages}
                  setMessages={setChatMessages}
                  applyPatch={applyPatch}
                  onSwitchStoryboard={setSelectedStoryboardId}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* 右栏：生成设置 + 分镜结果（可折叠） */}
      {collapsed ? (
        <div style={{ width: 40, flexShrink: 0 }}>
          <Tooltip title="展开生成设置与分镜结果" placement="left">
            <Button
              icon={<DoubleLeftOutlined />}
              onClick={() => setCollapsed(false)}
              style={{ width: 40, height: 120, writingMode: 'vertical-rl' }}
            >
              分镜
            </Button>
          </Tooltip>
        </div>
      ) : (
        <div
          style={{
            width: 300,
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
          />

          <Divider style={{ margin: '12px 0' }} />

          {/* 分镜结果：小标题 + 版本切换 + 可滚动镜头列表 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, flex: 1 }}>
            <Text strong style={{ fontSize: 13 }}>
              分镜结果
            </Text>
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

/** 正文区上方的轻量工具条：左切模式、右报存盘状态（保存动作仍走页面的 saveContent） */
function CanvasToolbar({
  mode,
  onModeChange,
  dirty,
  saving,
  onSave,
}: {
  mode: 'edit' | 'chat';
  onModeChange: (mode: 'edit' | 'chat') => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const { token } = theme.useToken();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 24px' }}>
      <Segmented
        size="small"
        value={mode}
        onChange={(v) => onModeChange(v as 'edit' | 'chat')}
        options={[
          { label: '编辑', value: 'edit' },
          { label: '对话', value: 'chat' },
        ]}
      />
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
}: {
  textModels: CapabilityEntry[];
  textModelId: string | undefined;
  onTextModelChange: (modelConfigId: string | undefined) => void;
  generating: boolean;
  disabled: boolean;
  onGenerate: () => void;
  progressText: string | null;
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
    </div>
  );
}

/** ---------- 对话修改面板（v2 §4：多轮对话产出 patch → 预览 → 确认应用） ---------- */

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  /** user：指令文本；assistant：summary */
  text: string;
  patch?: StoryboardPatch;
  applied?: boolean;
}

let chatMessageSeq = 0;
const nextChatMessageId = () => ++chatMessageSeq;

const SHOT_FIELD_LABEL: Record<string, string> = {
  sourceText: '原文',
  imagePrompt: '生图 Prompt',
  videoPrompt: '视频 Prompt',
  durationPlannedMs: '时长',
  tags: '标签',
  dialogue: '台词',
};

/** 把 patch op 渲染为中文摘要；镜头序号按当前分镜 shots 的 sortOrder 映射，找不到显示 id 前 6 位 */
function describePatchOp(op: StoryboardPatchOp, storyboard: StoryboardDetail | undefined): string {
  const shotLabel = (shotId: string) => {
    const sorted = [...(storyboard?.shots ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = sorted.findIndex((s) => s.id === shotId);
    return idx >= 0 ? `#${idx + 1}` : shotId.slice(0, 6);
  };
  switch (op.op) {
    case 'add_shot':
      return op.afterShotId != null
        ? `新增镜头（插入到镜头 ${shotLabel(op.afterShotId)} 之后）`
        : '新增镜头（追加到末尾）';
    case 'update_shot': {
      const fields = Object.keys(op.fields)
        .map((k) => SHOT_FIELD_LABEL[k] ?? k)
        .join('、');
      return `修改镜头 ${shotLabel(op.shotId)} 的 ${fields !== '' ? fields : '内容'}`;
    }
    case 'remove_shot':
      return `删除镜头 ${shotLabel(op.shotId)}`;
    case 'reorder':
      return '调整顺序';
  }
}

function ScriptChatPanel({
  draftId,
  storyboardId,
  storyboard,
  modelConfigId,
  messages,
  setMessages,
  applyPatch,
  onSwitchStoryboard,
}: {
  draftId: string;
  storyboardId: string | null;
  storyboard: StoryboardDetail | undefined;
  /** 顶栏选中的文本模型（与三步生成共用；undefined = 自动调度） */
  modelConfigId?: string;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  applyPatch: ReturnType<typeof useApplyPatch>;
  onSwitchStoryboard: (storyboardId: string) => void;
}) {
  const chat = useScriptChat();
  const { token } = theme.useToken();
  const [input, setInput] = useState('');
  const listEndRef = useRef<HTMLDivElement | null>(null);

  // 新消息 / loading 气泡出现时滚到底部
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, chat.isPending]);

  if (storyboardId === null) {
    return (
      <Empty
        description="先用三步生成产出首版分镜，再用对话修改"
        style={{ marginTop: 80 }}
      />
    );
  }

  const handleSend = () => {
    const text = input.trim();
    if (text === '' || chat.isPending) return;
    const userMsgId = nextChatMessageId();
    setMessages((prev) => [...prev, { id: userMsgId, role: 'user', text }]);
    chat.mutate(
      { draftId, message: text, baseStoryboardId: storyboardId, modelConfigId },
      {
        onSuccess: (res) => {
          setInput('');
          setMessages((prev) => [
            ...prev,
            {
              id: nextChatMessageId(),
              role: 'assistant',
              text: res.summary,
              patch: res.patch,
              applied: false,
            },
          ]);
        },
        onError: (e) => {
          // 失败：撤回本轮 user 气泡并保留输入，便于修改后重发
          setMessages((prev) => prev.filter((m) => m.id !== userMsgId));
          message.error(e instanceof Error ? e.message : '发送失败');
        },
      },
    );
  };

  const handleApply = async (msg: ChatMessage) => {
    if (msg.applied === true || !msg.patch || msg.patch.length === 0) return;
    try {
      const result = await applyPatch.mutateAsync({
        storyboardId,
        patch: msg.patch,
        source: 'chat',
      });
      onSwitchStoryboard(result.storyboard.id);
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, applied: true } : m)));
      message.success('修改已应用，已生成新分镜版本');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '应用失败');
    }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        对话产出的修改先预览后应用，应用后生成新版本，旧版本可随时切回
      </Text>

      {/* 消息列表 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
        {messages.length === 0 && !chat.isPending ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="输入修改指令，例如「把第 2 个镜头拆成两个」"
            style={{ marginTop: 60 }}
          />
        ) : (
          <>
            {messages.map((msg) =>
              msg.role === 'user' ? (
                <div key={msg.id} style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                  <div
                    style={{
                      maxWidth: '85%',
                      background: token.colorPrimaryBg,
                      borderRadius: 8,
                      padding: '6px 10px',
                      whiteSpace: 'pre-wrap',
                      fontSize: 13,
                    }}
                  >
                    {msg.text}
                  </div>
                </div>
              ) : (
                <div key={msg.id} style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}>
                  <div
                    style={{
                      maxWidth: '92%',
                      background: token.colorFillTertiary,
                      borderRadius: 8,
                      padding: '8px 10px',
                      fontSize: 13,
                    }}
                  >
                    <div style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
                    {msg.patch && msg.patch.length > 0 && (
                      <>
                        <ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
                          {msg.patch.map((op, i) => (
                            <li key={i} style={{ fontSize: 12, lineHeight: 1.8 }}>
                              {describePatchOp(op, storyboard)}
                            </li>
                          ))}
                        </ul>
                        <div style={{ marginTop: 6 }}>
                          {msg.applied === true ? (
                            <Tag icon={<CheckOutlined />} color="success">
                              已应用
                            </Tag>
                          ) : (
                            <Button
                              size="small"
                              type="primary"
                              loading={applyPatch.isPending}
                              onClick={() => void handleApply(msg)}
                            >
                              应用此修改
                            </Button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ),
            )}
            {chat.isPending && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}>
                <div
                  style={{
                    background: token.colorFillTertiary,
                    borderRadius: 8,
                    padding: '8px 10px',
                    fontSize: 13,
                  }}
                >
                  <Space size={8}>
                    <Spin size="small" />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      正在生成修改建议……
                    </Text>
                  </Space>
                </div>
              </div>
            )}
            <div ref={listEndRef} />
          </>
        )}
      </div>

      {/* 输入区：Enter 发送，Shift+Enter 换行 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <Input.TextArea
          value={input}
          autoSize={{ minRows: 1, maxRows: 4 }}
          placeholder="描述你想对分镜做的修改…（Enter 发送，Shift+Enter 换行）"
          disabled={chat.isPending}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          loading={chat.isPending}
          disabled={input.trim() === ''}
          onClick={handleSend}
        >
          发送
        </Button>
      </div>
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
