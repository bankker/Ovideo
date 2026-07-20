import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Empty,
  Input,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import { CheckOutlined, SendOutlined } from '@ant-design/icons';
import { api } from '../../api/client';
import { useRewriteScript } from '../../api/script-hooks';
import type { ParsedScene } from '../../utils/script-parse';

const { Text } = Typography;

/** ---------- 选区改写：服务端已支持，但既有 hook 没暴露这个入参 ---------- */

/** POST /script-drafts/:id/rewrite 带 selection 时的返回：只给被替换的那一段 */
interface RewriteSelectionResult {
  summary: string;
  replacement: string;
  /** 服务端回显的区间——拼接必须以它为准，不能用本地那份 */
  from: number;
  to: number;
}

/**
 * 选区改写 mutation。
 * 【为什么不复用 useRewriteScript】那个 hook 的 mutationFn 只转发 message / modelConfigId，
 * selection 传不进去，而它的返回类型是 { summary, script }，改成联合类型会波及既有调用方。
 * 本阶段约定不改动既有文件，所以在这里就地定义选区版；整篇改写仍然走 useRewriteScript。
 */
function useRewriteScriptSelection() {
  return useMutation({
    mutationFn: ({
      draftId,
      message: instruction,
      modelConfigId,
      selection,
    }: {
      draftId: string;
      message: string;
      modelConfigId?: string;
      selection: { from: number; to: number };
    }) =>
      api<RewriteSelectionResult>(`/script-drafts/${draftId}/rewrite`, {
        method: 'POST',
        body: {
          message: instruction,
          selection,
          ...(modelConfigId !== undefined ? { modelConfigId } : {}),
        },
      }),
  });
}

/** ---------- 对话轮次模型 ---------- */

/**
 * 一轮 = 一条指令 + 一个改写结果。
 * baseText 是发指令那一刻的全文快照：拼接、对比、重新生成都以它为准，
 * 因为 from/to 只在那一版正文上成立，中途正文变了就必须让用户重来。
 */
interface DirectorTurn {
  id: number;
  instruction: string;
  /** null = 整篇改写；非 null = 选区改写（本地算出的区间，仅用于发请求） */
  selection: { from: number; to: number } | null;
  /** 气泡上的作用范围角标，例如「第 2 场 · 客户会议室」或「全篇」 */
  scopeLabel: string;
  baseText: string;
  status: 'loading' | 'pending' | 'accepted' | 'rejected' | 'failed';
  result?: {
    summary: string;
    /** 对照用：修改前 / 修改后（选区模式下是该场景，整篇模式下是全文） */
    before: string;
    after: string;
    /** 接受时回调出去的完整新正文 */
    nextFullText: string;
  };
}

let turnSeq = 0;
const nextTurnId = () => ++turnSeq;

/** ---------- 快捷指令 ---------- */

interface QuickCommand {
  key: string;
  /** 按钮文案；scene 为 null 时用 labelAll */
  label: string;
  labelAll: string;
  /** 作用于某一场时的指令；n = 场次（1 开始），title 为场景标题（可能为空串） */
  scene: (n: number, title: string) => string;
  /** 作用于全篇时的指令 */
  all: () => string;
}

/** 场景在指令里的称呼：有标题就带上，没有就只说场次，绝不编造标题 */
function sceneRef(n: number, title: string): string {
  return title !== '' ? `第 ${n} 场『${title}』` : `第 ${n} 场`;
}

const QUICK_COMMANDS: QuickCommand[] = [
  {
    key: 'compress',
    label: '压缩当前场景',
    labelAll: '压缩全篇',
    scene: (n, t) =>
      `把${sceneRef(n, t)}压缩到更紧凑，保留关键信息与人物动机，删掉重复的话和可有可无的动作描写，不要删掉推动剧情的台词。`,
    all: () =>
      `把整篇剧本压缩到更紧凑，保留主线与关键信息，删掉重复的话和可有可无的动作描写，不要删掉推动剧情的台词。`,
  },
  {
    key: 'conflict',
    label: '增强人物冲突',
    labelAll: '增强人物冲突',
    scene: (n, t) =>
      `加强${sceneRef(n, t)}的人物冲突：让双方立场更对立、台词更有来有回，冲突要从已有的人物动机里长出来。不要引入新角色，也不要改变这一场的结局。`,
    all: () =>
      `加强整篇剧本的人物冲突：让主要人物的立场更对立、交锋更集中。冲突要从已有的人物动机里长出来，不要引入新角色，也不要改变故事结局。`,
  },
  {
    key: 'dialogue',
    label: '优化对白',
    labelAll: '优化对白',
    scene: (n, t) =>
      `打磨${sceneRef(n, t)}的对白：更短、更有力、留潜台词，避免用台词直白地解释剧情或交代设定。保持每个角色的身份和说话风格不变。`,
    all: () =>
      `打磨整篇剧本的对白：更短、更有力、留潜台词，避免用台词直白地解释剧情或交代设定。保持每个角色的身份和说话风格不变。`,
  },
  {
    key: 'colloquial',
    label: '改成更自然的口语',
    labelAll: '改成更自然的口语',
    scene: (n, t) =>
      `把${sceneRef(n, t)}的对白改成更自然的中文口语：去掉书面腔和翻译腔，允许有口头禅、停顿和不完整的句子，但要符合角色的身份与教育背景。只改说话方式，不改台词表达的意思。`,
    all: () =>
      `把整篇剧本的对白改成更自然的中文口语：去掉书面腔和翻译腔，允许有口头禅、停顿和不完整的句子，但要符合各自角色的身份与教育背景。只改说话方式，不改台词表达的意思。`,
  },
  {
    key: 'consistency',
    label: '检查人物一致性',
    labelAll: '检查人物一致性',
    scene: (n, t) =>
      `检查${sceneRef(n, t)}里人物的称呼、身份和说话风格是否与全剧一致（例如同一个人一会儿叫「老张」一会儿叫「张工」）。发现不一致就直接改掉并统一，并在摘要里说明你统一成了什么。`,
    all: () =>
      `检查整篇剧本里人物的称呼、身份和说话风格是否前后一致（例如同一个人一会儿叫「老张」一会儿叫「张工」）。发现不一致就直接改掉并统一，并在摘要里说明你统一成了什么。`,
  },
  {
    key: 'shots',
    label: '提供三种镜头方案',
    labelAll: '提供三种镜头方案',
    // 三个方案不能一股脑塞进正文（那会污染剧本），所以约定：正文只落最推荐的一种，另外两种写在摘要里
    scene: (n, t) =>
      `为${sceneRef(n, t)}设计三种镜头处理方案，分别偏向：写实跟拍、情绪特写、空间大景。把你最推荐的一种落实到动作/环境行的写法里，另外两种只在摘要里说明思路，不要写进正文。台词一个字都不要改。`,
    all: () =>
      `为整篇剧本的关键场景各设计三种镜头处理方案，分别偏向：写实跟拍、情绪特写、空间大景。把你最推荐的一种落实到动作/环境行的写法里，另外两种只在摘要里说明思路，不要写进正文。台词一个字都不要改。`,
  },
];

/** ---------- 组件 ---------- */

export interface AIDirectorPanelProps {
  /** 当前剧本稿 id；改写接口按它取库里的正文 */
  draftId: string;
  /** 页面持有的完整正文（与库里一致时才允许发指令，见 dirty） */
  fullText: string;
  /** 解析出的全部场景，按顺序；用来算选区在全文里的字符偏移 */
  scenes: ParsedScene[];
  /** 当前选中的场景；null = 指令作用于全篇 */
  scene: ParsedScene | null;
  /** 编辑器有未保存改动：服务端读的是库里的正文，此时发指令会基于旧稿改写 */
  dirty: boolean;
  /** 文本模型；不传走自动调度 */
  modelConfigId?: string;
  /** 接受改写：把拼接好的完整新正文交回页面落库（页面负责留撤销点） */
  onAdopt: (nextFullText: string) => void | Promise<void>;
  /** 页面正在落库，用于按钮 loading */
  adopting?: boolean;
}

export function AIDirectorPanel({
  draftId,
  fullText,
  scenes,
  scene,
  dirty,
  modelConfigId,
  onAdopt,
  adopting = false,
}: AIDirectorPanelProps) {
  const { token } = theme.useToken();
  const rewriteAll = useRewriteScript();
  const rewriteSelection = useRewriteScriptSelection();
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<DirectorTurn[]>([]);
  /** 常驻失败提示：展示服务端错误全文（多为"未配置文本模型"这类需要照着做的指路） */
  const [failure, setFailure] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  const sending = rewriteAll.isPending || rewriteSelection.isPending;

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, sending]);

  /**
   * 当前选中场景在全文里的字符区间。
   *
   * 【口径】解析器契约保证 `scenes.map(s => s.text).join('\n') === 全文`，
   * 所以第 i 场的起点 = 前面所有场景 text 长度之和 + i 个换行符（join 的分隔符各占 1 字符）。
   * 刻意不用 `fullText.indexOf(scene.text)`：场景正文完全可能重复（两场都只有一句「……」），
   * indexOf 会命中第一处，把改写拼到别的场景上。
   *
   * 算完还要用 `fullText.slice(from, to) === scene.text` 复核一次：
   * 万一 props 里的 scenes 与 fullText 不是同一版（父组件异步刷新的一瞬间），
   * 宁可退回整篇改写，也不能拿错位的区间去替换正文。
   */
  const selectionRange = useMemo((): { from: number; to: number } | null => {
    if (!scene) return null;
    const i = scenes.findIndex((s) => s.index === scene.index);
    if (i < 0) return null;
    let from = 0;
    for (let k = 0; k < i; k += 1) from += scenes[k].text.length + 1;
    const to = from + scene.text.length;
    if (fullText.slice(from, to) !== scene.text) return null;
    // 服务端拒绝空选区，本地先挡掉，免得用一次请求换一句 400
    if (scene.text.trim() === '') return null;
    return { from, to };
  }, [scene, scenes, fullText]);

  const scopeLabel = scene
    ? `第 ${scene.index + 1} 场${scene.title !== '' ? ` · ${scene.title}` : ''}`
    : '全篇';

  /** 真正发一轮：整篇 / 选区两条路，结果都归一成 turn.result */
  const send = (instruction: string, turnId: number, range: { from: number; to: number } | null) => {
    const base = fullText;
    setFailure(null);

    const onFail = (e: unknown) => {
      setTurns((prev) =>
        prev.map((t) => (t.id === turnId ? { ...t, status: 'failed' as const } : t)),
      );
      setFailure(e instanceof Error ? e.message : '改写请求失败。');
    };

    if (range) {
      rewriteSelection.mutate(
        { draftId, message: instruction, modelConfigId, selection: range },
        {
          onSuccess: (res) => {
            // 拼接一律用服务端回显的 from/to：本地区间只是"申请"，服务端确认的才作数
            const nextFullText = base.slice(0, res.from) + res.replacement + base.slice(res.to);
            setTurns((prev) =>
              prev.map((t) =>
                t.id === turnId
                  ? {
                      ...t,
                      status: 'pending' as const,
                      result: {
                        summary: res.summary,
                        before: base.slice(res.from, res.to),
                        after: res.replacement,
                        nextFullText,
                      },
                    }
                  : t,
              ),
            );
          },
          onError: onFail,
        },
      );
      return;
    }

    rewriteAll.mutate(
      { draftId, message: instruction, modelConfigId },
      {
        onSuccess: (res) => {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === turnId
                ? {
                    ...t,
                    status: 'pending' as const,
                    result: {
                      summary: res.summary,
                      before: base,
                      after: res.script,
                      nextFullText: res.script,
                    },
                  }
                : t,
            ),
          );
        },
        onError: onFail,
      },
    );
  };

  /** 新开一轮（快捷指令与输入框共用） */
  const startTurn = (instruction: string) => {
    const text = instruction.trim();
    if (text === '' || sending) return;
    // 服务端改写读的是库里的正文；带着未保存内容发指令，模型会基于旧稿改写，
    // 接受时拼回去就把手写内容冲掉了——与三步生成用同一道守卫
    if (dirty) {
      message.warning('请先保存剧本内容再用 AI 导演修改');
      return;
    }
    const id = nextTurnId();
    setTurns((prev) => [
      ...prev,
      {
        id,
        instruction: text,
        selection: selectionRange,
        scopeLabel: selectionRange ? scopeLabel : '全篇',
        baseText: fullText,
        status: 'loading',
      },
    ]);
    send(text, id, selectionRange);
  };

  const handleSendInput = () => {
    const text = input.trim();
    if (text === '') return;
    startTurn(text);
    setInput('');
  };

  const handleAccept = async (turn: DirectorTurn) => {
    if (!turn.result || turn.status !== 'pending') return;
    try {
      await onAdopt(turn.result.nextFullText);
      setTurns((prev) =>
        prev.map((t) => (t.id === turn.id ? { ...t, status: 'accepted' as const } : t)),
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : '写入剧本失败');
    }
  };

  const handleReject = (turn: DirectorTurn) => {
    setTurns((prev) =>
      prev.map((t) => (t.id === turn.id ? { ...t, status: 'rejected' as const } : t)),
    );
  };

  const handleRegenerate = (turn: DirectorTurn) => {
    if (sending) return;
    if (dirty) {
      message.warning('请先保存剧本内容再用 AI 导演修改');
      return;
    }
    // 正文在这一轮之后变过（接受了别的改写、或手动改了），旧的 from/to 已经不指向原来那段
    if (turn.baseText !== fullText) {
      message.warning('剧本已经变过了，请重新发一次指令');
      return;
    }
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turn.id ? { ...t, status: 'loading' as const, result: undefined } : t,
      ),
    );
    send(turn.instruction, turn.id, turn.selection);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* ---------- 快捷指令 ---------- */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 600 }}>
            快捷指令
          </Text>
          <Tag style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }}>
            {selectionRange ? scopeLabel : '全篇'}
          </Tag>
        </div>
        <Space size={[6, 6]} wrap>
          {QUICK_COMMANDS.map((c) => {
            const instruction = scene
              ? c.scene(scene.index + 1, scene.title)
              : c.all();
            return (
              <Tooltip key={c.key} title={instruction} placement="topLeft">
                <Button
                  size="small"
                  disabled={sending || dirty}
                  onClick={() => startTurn(instruction)}
                >
                  {scene ? c.label : c.labelAll}
                </Button>
              </Tooltip>
            );
          })}
        </Space>
      </div>

      {dirty && (
        <Alert
          type="warning"
          showIcon
          message={<Text style={{ fontSize: 12 }}>请先保存剧本内容再用 AI 导演修改</Text>}
        />
      )}

      {/* ---------- 对话记录 ---------- */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
        {turns.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.8 }}>
                点上面的快捷指令，或直接说你想怎么改。
                <br />
                选中场景时只改那一场，未选中时改全篇。
              </Text>
            }
            style={{ marginTop: 32 }}
          />
        ) : (
          <>
            {turns.map((turn) => (
              <TurnBubble
                key={turn.id}
                turn={turn}
                adopting={adopting}
                busy={sending}
                onAccept={() => void handleAccept(turn)}
                onReject={() => handleReject(turn)}
                onRegenerate={() => handleRegenerate(turn)}
              />
            ))}
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

      {/* ---------- 输入区：Enter 发送，Shift+Enter 换行 ---------- */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <Input.TextArea
          value={input}
          autoSize={{ minRows: 1, maxRows: 4 }}
          placeholder={
            scene
              ? '说说这一场想怎么改…（Enter 发送，Shift+Enter 换行）'
              : '说说整篇想怎么改…（Enter 发送，Shift+Enter 换行）'
          }
          disabled={sending}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              handleSendInput();
            }
          }}
          style={{ flex: 1, fontSize: 13, background: token.colorFillQuaternary }}
        />
        <Button
          icon={<SendOutlined />}
          loading={sending}
          disabled={input.trim() === ''}
          onClick={handleSendInput}
        />
      </div>
    </div>
  );
}

/** ---------- 单轮气泡：指令 + 摘要 + 前后对照 + 三个决定 ---------- */

function TurnBubble({
  turn,
  adopting,
  busy,
  onAccept,
  onReject,
  onRegenerate,
}: {
  turn: DirectorTurn;
  adopting: boolean;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onRegenerate: () => void;
}) {
  const { token } = theme.useToken();

  return (
    <div style={{ marginBottom: 12 }}>
      {/* 用户指令 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
        <div
          style={{
            maxWidth: '90%',
            background: token.colorPrimaryBg,
            borderRadius: token.borderRadius,
            padding: '6px 10px',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          <Tag style={{ marginInlineEnd: 6, fontSize: 11, lineHeight: '16px' }}>
            {turn.scopeLabel}
          </Tag>
          {turn.instruction}
        </div>
      </div>

      {/* 改写结果 */}
      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
        <div
          style={{
            maxWidth: '100%',
            width: '100%',
            background: token.colorFillTertiary,
            borderRadius: token.borderRadius,
            padding: '8px 10px',
            fontSize: 13,
          }}
        >
          {turn.status === 'loading' && (
            <Space size={8}>
              <Spin size="small" />
              <Text type="secondary" style={{ fontSize: 12 }}>
                AI 导演正在改写……
              </Text>
            </Space>
          )}

          {turn.status === 'failed' && (
            <Space size={8} wrap>
              <Text type="secondary" style={{ fontSize: 12 }}>
                这一轮没有改成，可以重新生成。
              </Text>
              <Button size="small" disabled={busy} onClick={onRegenerate}>
                重新生成
              </Button>
            </Space>
          )}

          {turn.result && turn.status !== 'loading' && (
            <>
              <div style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>{turn.result.summary}</div>

              {/* 接受会覆盖正文，所以改动必须先看得见：前后并置，长文各自滚动 */}
              <DiffPair before={turn.result.before} after={turn.result.after} />

              <Space size={6} style={{ marginTop: 8 }} wrap>
                <Button
                  size="small"
                  type="primary"
                  disabled={turn.status !== 'pending'}
                  loading={adopting && turn.status === 'pending'}
                  onClick={onAccept}
                >
                  接受
                </Button>
                <Button size="small" disabled={turn.status !== 'pending'} onClick={onReject}>
                  拒绝
                </Button>
                <Button size="small" disabled={busy || turn.status !== 'pending'} onClick={onRegenerate}>
                  重新生成
                </Button>
                {turn.status === 'accepted' && (
                  <Tag icon={<CheckOutlined />} color="success" style={{ marginInlineEnd: 0 }}>
                    已写入剧本
                  </Tag>
                )}
                {turn.status === 'rejected' && <Tag style={{ marginInlineEnd: 0 }}>已拒绝</Tag>}
              </Space>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 修改前 / 修改后两块文本对照；右栏只有 360px 宽，故上下排而非左右分栏 */
function DiffPair({ before, after }: { before: string; after: string }) {
  const { token } = theme.useToken();

  const box: React.CSSProperties = {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: 12,
    lineHeight: 1.8,
    maxHeight: 200,
    overflowY: 'auto',
    background: token.colorBgContainer,
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadiusSM,
    padding: '6px 8px',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div>
        <Text type="secondary" style={{ fontSize: 11 }}>
          修改前
        </Text>
        <div style={{ ...box, marginTop: 2, opacity: 0.75 }}>{before}</div>
      </div>
      <div>
        <Text type="secondary" style={{ fontSize: 11 }}>
          修改后
        </Text>
        <div style={{ ...box, marginTop: 2, borderColor: token.colorPrimaryBorder }}>{after}</div>
      </div>
    </div>
  );
}
