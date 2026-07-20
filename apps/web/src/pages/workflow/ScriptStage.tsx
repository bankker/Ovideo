import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Tabs,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import {
  DoubleLeftOutlined,
  DoubleRightOutlined,
  ArrowLeftOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  useApplyPatch,
  useCreateScriptDraft,
  useGenerateStoryboard,
  useJob,
  useScriptDrafts,
  useStoryboard,
  useStoryboards,
  useUpdateScriptDraft,
} from '../../api/workflow-hooks';
import { TagDedup } from '../../components/TagDedup';
import { useCapabilities } from '../../api/produce-hooks';
import { ScriptStarter } from './ScriptStarter';
import { ScriptChatPanel, type ChatMessage } from './ScriptChatDock';
import { ScriptToolbar } from './ScriptToolbar';
import { SceneNavigator } from './SceneNavigator';
import { StructuredScriptEditor } from './StructuredScriptEditor';
import { SceneInspector } from './SceneInspector';
import { AIDirectorPanel } from './AIDirectorPanel';
import { StoryboardPlanningWizard } from './StoryboardPlanningWizard';
import { parseScript } from '../../utils/script-parse';
import { useProjectTags } from '../../api/design-hooks';
import { collectScriptElements } from '../../utils/script-elements';

const { Text } = Typography;

/** 分镜规划的请求参数（用于失败后原样重试） */
interface GenerateStoryboardPayload {
  draftId: string;
  modelConfigId?: string;
  /** 分镜规划向导拼出来的中文导演说明；未走向导（老路径）时不带 */
  directive?: string;
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

/** 右栏分页：场景检查器 / AI 导演 / 改分镜 */
type InspectorTab = 'scene' | 'director' | 'storyboard';

/**
 * 剧本工作台：顶部剧本工具栏横跨，下面 场景导航 / 结构化编辑器 / 检查器 三栏。
 *
 * 【为什么这一页不再显示分镜结果】剧本页负责写作，分镜页负责导演拆镜和视觉设计。
 * 把镜头卡片摆在正文旁边，用户会不自觉地在写作阶段就去调 Prompt，
 * 两件事都做不深。分镜结果现在只在顶部的「分镜」阶段里看。
 */
export function ScriptStage() {
  const { projectId = '', episodeId = '' } = useParams();
  const qc = useQueryClient();
  const { token } = theme.useToken();
  /** 分镜规划成功后 +1 → 触发一次静默的重复标签检查（发现拆裂标签立刻提醒） */
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

  const saveContent = useCallback(() => {
    if (selectedDraft === null || content === selectedDraft.content) return;
    updateDraft.mutate(
      { draftId: selectedDraft.id, content },
      {
        onSuccess: () => message.success('剧本已保存'),
        onError: (e) => message.error(e.message),
      },
    );
  }, [selectedDraft, content, updateDraft]);

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

  /* ---------- 「从想法开始」入口 ---------- */
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
    message.success('剧本已生成，可继续编辑或直接「开始分镜规划」');
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

  /* ---------- 结构化解析 ---------- */
  /**
   * 全页唯一的解析结果：工具栏统计、场景导航、编辑器分块、右栏检查器与体检
   * 全部读它，口径天然一致，不会出现"导航说 8 场、体检说 7 场"。
   */
  const parsed = useMemo(() => parseScript(content), [content]);
  const scenes = parsed.scenes;

  /* ---------- 要素清单 ---------- */
  /**
   * 剧本里的角色/场景/道具与项目标签对齐后的结果。编辑器的高亮、工具栏的「标注要素」
   * 与体检的"即将新建"都读这一份，口径只有一处——否则会出现
   * "编辑器把它标成角色、体检说它是道具"这种自相矛盾。
   */
  const projectTags = useProjectTags(projectId);
  const elements = useMemo(
    () => collectScriptElements(parsed, projectTags.data ?? []),
    [parsed, projectTags.data],
  );

  /** 当前场景：编辑器点击与导航点击共同维护 */
  const [activeSceneIndex, setActiveSceneIndex] = useState(0);
  /** 每次自增即请求编辑器把当前场景滚入视野（点击块本身时不动它，免得打断写字） */
  const [scrollToken, setScrollToken] = useState(0);

  // 场景数变化（删掉了最后几场、切了稿）时把选中项夹回合法范围
  useEffect(() => {
    if (scenes.length === 0) {
      if (activeSceneIndex !== 0) setActiveSceneIndex(0);
      return;
    }
    if (activeSceneIndex > scenes.length - 1) setActiveSceneIndex(scenes.length - 1);
  }, [scenes.length, activeSceneIndex]);

  const activeScene = scenes[activeSceneIndex] ?? null;
  const prevScene = activeSceneIndex > 0 ? (scenes[activeSceneIndex - 1] ?? null) : null;

  const handleNavigatorSelect = (index: number) => {
    setActiveSceneIndex(index);
    setScrollToken((t) => t + 1);
  };

  // 换稿即回到第一场：A 稿的第 7 场落到 B 稿上没有意义
  useEffect(() => {
    setActiveSceneIndex(0);
  }, [selectedDraftId]);

  /* ---------- 剧本体检 / 分镜规划向导 ---------- */
  /** null = 关闭；'check' = 只读体检；'plan' = 三步规划向导 */
  const [preflightMode, setPreflightMode] = useState<'check' | 'plan' | null>(null);

  /* ---------- 分镜规划 + Job 轮询 ---------- */
  const generate = useGenerateStoryboard();
  /* 文本模型选择（分镜规划、AI 导演、创作入口共用；undefined = 自动调度 + 失效转移） */
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
      message.success('分镜生成完成，可到顶部「分镜」阶段查看');
      // 生成成功才关向导：整个规划过程用户都停留在向导里，失败时留在原地即可重试
      setPreflightMode(null);
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

  /**
   * 向导第三步按下「生成分镜」：把三步攒出来的导演说明随请求一起发出去。
   * 【为什么不在这里关向导】生成是异步 Job，关掉向导后用户只剩一行小字进度；
   * 留在向导里，成功时由 Job 轮询关闭，失败时原地显示错误并重试。
   */
  const handleConfirmPlan = (directive: string) => {
    if (selectedDraft === null) return;
    if (dirty) {
      message.warning('请先保存剧本内容再生成');
      return;
    }
    submitGenerate({ draftId: selectedDraft.id, modelConfigId: textModelId, directive });
  };

  /* ---------- 分镜上下文（仅供「改分镜」对话，页面不再展示镜头） ---------- */
  const storyboardsQuery = useStoryboards(episodeId);
  const storyboards = storyboardsQuery.data;
  const [selectedStoryboardId, setSelectedStoryboardId] = useState<string | null>(null);
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

  /* ---------- 对话改分镜 / AI 导演改剧本 ---------- */
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  /**
   * 「撤销上次对话修改」的一次性快照：改写覆盖的是整篇正文，
   * 不给退路的话用户不敢点采纳。只留一份、用完即弃，不引入新数据模型。
   */
  const [undoSnapshot, setUndoSnapshot] = useState<{ draftId: string; content: string } | null>(
    null,
  );

  // 换稿即清空撤销点：A 稿的退路套到 B 稿上会把内容覆盖成另一份剧本
  useEffect(() => {
    setUndoSnapshot(null);
  }, [selectedDraftId]);

  /** 采纳改写：先记下改写前的正文再落库，失败则原样抛回给面板（保持待决状态） */
  const handleAdoptRewrite = useCallback(
    async (nextScript: string) => {
      if (selectedDraft === null) return;
      const before = content; // 以编辑器现值为准——用户想退回的是他刚才看到的那一版
      await updateDraft.mutateAsync({ draftId: selectedDraft.id, content: nextScript });
      setContent(nextScript);
      setUndoSnapshot({ draftId: selectedDraft.id, content: before });
      message.success('已写入剧本，可在顶部工具栏撤销');
    },
    [selectedDraft, content, updateDraft],
  );

  /**
   * 「标注要素」：把工具栏算好的新正文落库。
   * 复用 AI 导演那一份撤销点——两者都是"整篇被改写"，用户需要的退路完全一样，
   * 不必为标注再造一套撤销栈。
   */
  const handleAnnotate = useCallback(
    (nextText: string) => {
      if (selectedDraft === null || nextText === content) return;
      const before = content;
      updateDraft.mutate(
        { draftId: selectedDraft.id, content: nextText },
        {
          onSuccess: () => {
            setContent(nextText);
            setUndoSnapshot({ draftId: selectedDraft.id, content: before });
            message.success('已标注要素，可在顶部工具栏撤销');
          },
          onError: (e) => message.error(e.message),
        },
      );
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
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('scene');

  /** 生成进度：排队与运行中文案统一在工具栏下方回显 */
  const progressText =
    runningJobId === null
      ? null
      : job?.status === 'RUNNING'
        ? `分镜生成中 ${job.progress}%`
        : '任务排队中……';

  /** 主按钮禁用原因：说清楚为什么点不动，比一个灰按钮有用 */
  const planDisabledReason =
    selectedDraft === null
      ? '请先选择或新建剧本稿'
      : showStarter
        ? '正在创作入口中，请先返回编辑器'
        : dirty
          ? '有未保存的修改，请先保存再规划分镜'
          : undefined;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        height: '100%',
        minHeight: 360,
      }}
    >
      {/* ---------- 顶部：横跨全页的剧本工具栏 ---------- */}
      <ScriptToolbar
        draft={selectedDraft}
        drafts={drafts}
        parsed={parsed}
        dirty={dirty}
        saving={updateDraft.isPending}
        onSave={saveContent}
        onSelectDraft={(id) => {
          setSelectedDraftId(id);
          setStarterOpen(false); // 点开某一稿即离开创作入口
        }}
        onCreateDraft={handleCreateDraft}
        creating={createDraft.isPending}
        onOpenStarter={() => setStarterOpen(true)}
        starterDisabled={showStarter}
        onRename={() => {
          if (selectedDraft !== null)
            setRenameState({ id: selectedDraft.id, title: selectedDraft.title });
        }}
        onSetMain={() => {
          if (selectedDraft !== null) handleSetMain(selectedDraft.id);
        }}
        onPreflight={() => setPreflightMode('check')}
        onPlanStoryboard={() => {
          // 重新进入向导 = 重新来一次：把上一次的失败提示清掉，否则第三步会顶着一条旧错误
          setGenerateFailure(null);
          setPreflightMode('plan');
        }}
        planDisabled={planDisabledReason !== undefined}
        planDisabledReason={planDisabledReason}
        planning={generating}
        undoAvailable={undoSnapshot !== null && undoSnapshot.draftId === selectedDraft?.id}
        onUndo={handleUndoRewrite}
        undoing={updateDraft.isPending}
        fullText={content}
        elements={elements}
        onAnnotate={handleAnnotate}
        annotating={updateDraft.isPending}
      />

      {/* 生成成功后静默判重：发现拆裂标签才显示横幅（干净时零打扰） */}
      <TagDedup projectId={projectId} showButton={false} autoCheckSignal={dedupSignal} />

      {progressText !== null && (
        <Text type="secondary" style={{ fontSize: 12, paddingInline: 16 }}>
          {progressText}
        </Text>
      )}

      {/* 生成失败：横跨全页、直接展示服务端错误全文 + 按原参数重试。
          失败必须显眼——用户点了主按钮却什么都没发生是最坏的体验 */}
      {generateFailure !== null && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setGenerateFailure(null)}
          message="分镜生成失败"
          description={
            <div>
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.7 }}>
                {generateFailure.detail}
              </div>
              <Button
                size="small"
                danger
                icon={<ReloadOutlined />}
                disabled={generating}
                style={{ marginTop: 8 }}
                onClick={() => submitGenerate(generateFailure.payload)}
              >
                重试
              </Button>
            </div>
          }
          style={{ marginInline: 4 }}
        />
      )}

      {/* ---------- 下方：三栏 ---------- */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 12, alignItems: 'stretch' }}>
        {showStarter ? (
          /* 创作入口独占整幅画布：这一刻用户只有一件事要做 */
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 24px' }}>
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
          </div>
        ) : selectedDraft === null ? (
          <Empty description="请在顶部选择或新建剧本稿" style={{ marginTop: 80, flex: 1 }} />
        ) : (
          <>
            {/* 左：场景导航 */}
            <SceneNavigator
              scenes={scenes}
              activeIndex={activeSceneIndex}
              onSelect={handleNavigatorSelect}
              collapsed={navCollapsed}
              onToggleCollapsed={() => setNavCollapsed((c) => !c)}
            />

            {/* 中：结构化剧本编辑器 */}
            <div
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                borderInline: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <StructuredScriptEditor
                parsed={parsed}
                fullText={content}
                onChange={setContent}
                onBlur={saveContent}
                activeSceneIndex={activeSceneIndex}
                onActiveSceneChange={setActiveSceneIndex}
                scrollToken={scrollToken}
                elements={elements}
              />
            </div>

            {/* 右：检查器（可收起） */}
            {inspectorCollapsed ? (
              <div style={{ width: 40, flexShrink: 0 }}>
                <Tooltip title="展开检查器" placement="left">
                  <Button
                    icon={<DoubleLeftOutlined />}
                    onClick={() => setInspectorCollapsed(false)}
                    style={{ width: 40, height: 120, writingMode: 'vertical-rl' }}
                  >
                    检查器
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  {/* 文本模型：分镜规划与 AI 导演共用同一个选择，放在两者都看得见的地方 */}
                  <Select
                    size="small"
                    style={{ flex: 1, minWidth: 0 }}
                    allowClear
                    placeholder="文本模型（自动调度）"
                    value={textModelId}
                    onChange={(v) => setTextModelId(v)}
                    options={textModels.map((m) => ({
                      value: m.modelConfigId,
                      label: `${m.label}（${m.providerName}）`,
                    }))}
                  />
                  <Tooltip title="收起">
                    <Button
                      type="text"
                      size="small"
                      icon={<DoubleRightOutlined />}
                      onClick={() => setInspectorCollapsed(true)}
                    />
                  </Tooltip>
                </div>

                {/* Tabs 只当标签栏用：内容渲染在下面那个 flex:1 容器里，
                    面板高度就由本栏自己的 flex 链决定，不必依赖 antd 内部
                    content-holder 的高度传导 */}
                <Tabs
                  size="small"
                  activeKey={inspectorTab}
                  onChange={(k) => setInspectorTab(k as InspectorTab)}
                  tabBarStyle={{ marginBottom: 8 }}
                  items={[
                    { key: 'scene', label: '场景' },
                    { key: 'director', label: 'AI 导演' },
                    { key: 'storyboard', label: '改分镜' },
                  ]}
                />

                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  {inspectorTab === 'scene' ? (
                    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                      <SceneInspector
                        projectId={projectId}
                        episodeId={episodeId}
                        scene={activeScene}
                        prevScene={prevScene}
                      />
                    </div>
                  ) : inspectorTab === 'director' ? (
                    /* key 绑草稿：换稿即重建面板，上一稿的对话与待决改写不会串台 */
                    <AIDirectorPanel
                      key={selectedDraft.id}
                      draftId={selectedDraft.id}
                      fullText={content}
                      scenes={scenes}
                      scene={activeScene}
                      dirty={dirty}
                      modelConfigId={textModelId}
                      onAdopt={handleAdoptRewrite}
                      adopting={updateDraft.isPending}
                    />
                  ) : (
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
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 剧本体检 / 分镜规划：同一个向导，'check' 只走第一步，'plan' 走完整三步 */}
      <StoryboardPlanningWizard
        open={preflightMode !== null}
        mode={preflightMode ?? 'plan'}
        projectId={projectId}
        episodeId={episodeId}
        parsed={parsed}
        generating={generating}
        failure={generateFailure?.detail ?? null}
        onCancel={() => setPreflightMode(null)}
        onGenerate={handleConfirmPlan}
        fullText={content}
        onAnnotate={handleAnnotate}
        annotating={updateDraft.isPending}
      />

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
    </div>
  );
}
