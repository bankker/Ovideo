import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  Alert,
  Button,
  Collapse,
  Empty,
  Input,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
  message,
  theme,
} from 'antd';
import { CheckOutlined, SendOutlined } from '@ant-design/icons';
import type { StoryboardPatch, StoryboardPatchOp } from '@ovideo/shared';
import { useApplyPatch, type StoryboardDetail } from '../../api/workflow-hooks';
import { useScriptChat } from '../../api/chat-hooks';
import { useRewriteScript } from '../../api/script-hooks';

const { Text } = Typography;

/** 对话的作用域：文稿旁边的这块面板既能改剧本正文，也能改分镜，用它区分 */
export type ChatScope = 'script' | 'storyboard';

/** ---------- 消息模型 ---------- */

/** 改分镜的一轮消息（v2 §4：assistant 携带 patch，确认后应用） */
export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  /** user：指令文本；assistant：summary */
  text: string;
  patch?: StoryboardPatch;
  applied?: boolean;
}

/**
 * 改剧本的一轮消息。
 * status 只在 assistant 气泡上有意义：pending 待用户决定、adopted 已写库、discarded 已放弃。
 */
export interface ScriptRewriteMessage {
  id: number;
  role: 'user' | 'assistant';
  /** user：指令文本；assistant：summary */
  text: string;
  /** assistant：改写后的完整正文 */
  script?: string;
  status?: 'pending' | 'adopted' | 'discarded';
}

let chatMessageSeq = 0;
const nextChatMessageId = () => ++chatMessageSeq;

/** ---------- 对话面板容器 ---------- */

/**
 * 文稿右侧的对话坞：顶部切作用域，下面挂对应的对话面板。
 * 两种作用域的消息各存一份且都由页面持有——切来切去不该丢上下文，
 * 换剧本稿时也才好由页面统一清空。
 */
export function ScriptChatDock({
  draftId,
  modelConfigId,
  rewriteMessages,
  setRewriteMessages,
  onAdoptRewrite,
  adopting,
  dirty,
  storyboardId,
  storyboard,
  storyboardMessages,
  setStoryboardMessages,
  applyPatch,
  onSwitchStoryboard,
}: {
  draftId: string;
  /** 右栏选中的文本模型（与三步生成共用；undefined = 自动调度） */
  modelConfigId?: string;
  rewriteMessages: ScriptRewriteMessage[];
  setRewriteMessages: Dispatch<SetStateAction<ScriptRewriteMessage[]>>;
  /** 采纳改写：由页面落库并留下撤销点；失败时抛出，气泡据此保持待决状态 */
  onAdoptRewrite: (script: string) => Promise<void>;
  adopting: boolean;
  /**
   * 编辑器有未保存改动。服务端改写读的是库里的正文，
   * 带着未保存内容发指令会让模型基于旧稿改写，采纳时整篇覆盖 → 手写内容静默丢失。
   * 与三步生成同一套守卫语义。
   */
  dirty: boolean;
  storyboardId: string | null;
  storyboard: StoryboardDetail | undefined;
  storyboardMessages: ChatMessage[];
  setStoryboardMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  applyPatch: ReturnType<typeof useApplyPatch>;
  onSwitchStoryboard: (storyboardId: string) => void;
}) {
  const [scope, setScope] = useState<ChatScope>('script');

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Segmented
        size="small"
        block
        value={scope}
        onChange={(v) => setScope(v as ChatScope)}
        options={[
          { label: '改剧本', value: 'script' },
          { label: '改分镜', value: 'storyboard' },
        ]}
      />

      {scope === 'script' ? (
        <ScriptRewritePanel
          draftId={draftId}
          modelConfigId={modelConfigId}
          messages={rewriteMessages}
          setMessages={setRewriteMessages}
          onAdopt={onAdoptRewrite}
          adopting={adopting}
          dirty={dirty}
        />
      ) : (
        <ScriptChatPanel
          draftId={draftId}
          storyboardId={storyboardId}
          storyboard={storyboard}
          modelConfigId={modelConfigId}
          messages={storyboardMessages}
          setMessages={setStoryboardMessages}
          applyPatch={applyPatch}
          onSwitchStoryboard={onSwitchStoryboard}
        />
      )}
    </div>
  );
}

/** ---------- 改剧本：指令 → 改写预览 → 采纳 / 放弃 ---------- */

function ScriptRewritePanel({
  draftId,
  modelConfigId,
  messages,
  setMessages,
  onAdopt,
  adopting,
  dirty,
}: {
  draftId: string;
  modelConfigId?: string;
  messages: ScriptRewriteMessage[];
  setMessages: Dispatch<SetStateAction<ScriptRewriteMessage[]>>;
  onAdopt: (script: string) => Promise<void>;
  adopting: boolean;
  dirty: boolean;
}) {
  const rewrite = useRewriteScript();
  const { token } = theme.useToken();
  const [input, setInput] = useState('');
  /** 常驻失败提示：展示服务端错误全文（多为"未配置文本模型"这类需要照着做的指路） */
  const [failure, setFailure] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, rewrite.isPending]);

  const handleSend = () => {
    const text = input.trim();
    if (text === '' || rewrite.isPending) return;
    // 服务端改写读的是库里的正文；带着未保存内容发指令，模型会基于旧稿改写，
    // 采纳时整篇覆盖就把手写内容冲掉了——与三步生成用同一道守卫
    if (dirty) {
      message.warning('请先保存剧本内容再用对话修改');
      return;
    }
    setFailure(null);
    const userMsgId = nextChatMessageId();
    setMessages((prev) => [...prev, { id: userMsgId, role: 'user', text }]);
    rewrite.mutate(
      { draftId, message: text, modelConfigId },
      {
        onSuccess: (res) => {
          setInput('');
          setMessages((prev) => [
            ...prev,
            {
              id: nextChatMessageId(),
              role: 'assistant',
              text: res.summary,
              script: res.script,
              status: 'pending',
            },
          ]);
        },
        onError: (e) => {
          // 撤回本轮 user 气泡并保留输入框内容，便于改一改再发
          setMessages((prev) => prev.filter((m) => m.id !== userMsgId));
          setFailure(e instanceof Error ? e.message : '改写请求失败。');
        },
      },
    );
  };

  const handleAdopt = async (msg: ScriptRewriteMessage) => {
    if (msg.script === undefined || msg.status !== 'pending') return;
    try {
      await onAdopt(msg.script);
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, status: 'adopted' } : m)));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '写入剧本失败');
    }
  };

  const handleDiscard = (msg: ScriptRewriteMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, status: 'discarded' } : m)));
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
        {messages.length === 0 && !rewrite.isPending ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.8 }}>
                告诉我要怎么改，例如：把结尾改得更有冲击力 / 给老张加一句吐槽 / 压缩到 40 秒
              </Text>
            }
            style={{ marginTop: 48 }}
          />
        ) : (
          <>
            {messages.map((msg) =>
              msg.role === 'user' ? (
                <div
                  key={msg.id}
                  style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}
                >
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
                <div
                  key={msg.id}
                  style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}
                >
                  <div
                    style={{
                      maxWidth: '95%',
                      background: token.colorFillTertiary,
                      borderRadius: 8,
                      padding: '8px 10px',
                      fontSize: 13,
                    }}
                  >
                    <div style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>

                    {msg.script !== undefined && (
                      <>
                        {/* 采纳是要覆盖整篇正文的，所以改写结果必须先看得到 */}
                        <Collapse
                          ghost
                          size="small"
                          style={{ marginTop: 4 }}
                          items={[
                            {
                              key: 'full',
                              label: (
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  查看改写后的完整剧本
                                </Text>
                              ),
                              children: (
                                <div
                                  style={{
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    fontSize: 12,
                                    lineHeight: 1.8,
                                    maxHeight: 280,
                                    overflowY: 'auto',
                                  }}
                                >
                                  {msg.script}
                                </div>
                              ),
                            },
                          ]}
                        />

                        <Space size={6} style={{ marginTop: 6 }} wrap>
                          <Button
                            size="small"
                            type="primary"
                            disabled={msg.status !== 'pending'}
                            loading={adopting && msg.status === 'pending'}
                            onClick={() => void handleAdopt(msg)}
                          >
                            采纳
                          </Button>
                          <Button
                            size="small"
                            disabled={msg.status !== 'pending'}
                            onClick={() => handleDiscard(msg)}
                          >
                            放弃
                          </Button>
                          {msg.status === 'adopted' && (
                            <Tag icon={<CheckOutlined />} color="success" style={{ marginInlineEnd: 0 }}>
                              已写入剧本
                            </Tag>
                          )}
                          {msg.status === 'discarded' && (
                            <Tag style={{ marginInlineEnd: 0 }}>已放弃</Tag>
                          )}
                        </Space>
                      </>
                    )}
                  </div>
                </div>
              ),
            )}
            {rewrite.isPending && (
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
                      正在改写剧本……
                    </Text>
                  </Space>
                </div>
              </div>
            )}
            <div ref={listEndRef} />
          </>
        )}
      </div>

      {failure !== null && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setFailure(null)}
          message="改写失败"
          description={
            <div
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 12,
                lineHeight: 1.7,
              }}
            >
              {failure}
            </div>
          }
        />
      )}

      {/* 输入区：Enter 发送，Shift+Enter 换行 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <Input.TextArea
          value={input}
          autoSize={{ minRows: 1, maxRows: 4 }}
          placeholder="描述你想怎么改剧本…（Enter 发送，Shift+Enter 换行）"
          disabled={rewrite.isPending}
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
          loading={rewrite.isPending}
          disabled={input.trim() === ''}
          onClick={handleSend}
        />
      </div>
    </div>
  );
}

/** ---------- 改分镜：对话产出 patch → 预览 → 确认应用（v2 §4，实现自 ScriptStage 原样迁入） ---------- */

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
  /** 右栏选中的文本模型（与三步生成共用；undefined = 自动调度） */
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
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="先用三步生成产出首版分镜，再用对话修改"
        style={{ marginTop: 48 }}
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
            style={{ marginTop: 48 }}
          />
        ) : (
          <>
            {messages.map((msg) =>
              msg.role === 'user' ? (
                <div
                  key={msg.id}
                  style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}
                >
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
                <div
                  key={msg.id}
                  style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}
                >
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
        />
      </div>
    </div>
  );
}
