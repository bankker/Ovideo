// 结构化剧本编辑器。
//
// 每一场戏是一个独立的块：默认呈现有层次的只读视图（角色名着色、格式问题标注），
// 点进去才变成该块的 Input.TextArea。这样既保住了"剧本读起来像剧本"，
// 又不用引入富文本模型——库里存的始终是那段纯文本。
//
// 往返无损的做法：进入编辑态时按当前场景切分把全文冻结成 prefix / draft / suffix 三段，
// 之后每次输入都是 prefix + draft + suffix 直接拼回。
// 刻意不在每次按键时重新解析全文——用户中途敲出一个新的场景抬头会让块一分为二，
// 场景下标随即错位，再按下标回写就会把内容拼重复。

import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
} from 'react';
import { Input, Tooltip, Typography, theme } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import type { GlobalToken } from 'antd/es/theme/interface';
import {
  formatDuration,
  formatInteriorExterior,
  inspectDialogueIssue,
  type ParsedScene,
  type ParsedScript,
  type ScriptLine,
} from '../../utils/script-parse';
import {
  buildElementIndex,
  splitLineByElements,
  type AnnotationElements,
  type ElementIndexEntry,
  type ElementNameType,
} from '../../utils/annotate-mentions';

const { Text } = Typography;

/** 空正文时给一个空场景占位，否则编辑器一行都渲染不出来、用户无处下笔 */
const EMPTY_SCENE: ParsedScene = {
  index: 0,
  title: '',
  location: '',
  interiorExterior: '',
  timeOfDay: '',
  lines: [{ kind: 'blank', raw: '' }],
  text: '',
  characters: [],
  estimatedDurationMs: 0,
  estimatedShotCount: 0,
};

/** 编辑态快照：draft 之外的两段在整个编辑过程中保持冻结 */
interface EditingState {
  index: number;
  draft: string;
  prefix: string;
  suffix: string;
}

export function StructuredScriptEditor({
  parsed,
  fullText,
  onChange,
  onBlur,
  activeSceneIndex,
  onActiveSceneChange,
  scrollToken,
  elements,
}: {
  parsed: ParsedScript;
  fullText: string;
  /** 块内编辑 → 拼回的整篇新正文 */
  onChange: (nextFullText: string) => void;
  /** 块失焦 → 页面按既有语义落库 */
  onBlur: () => void;
  activeSceneIndex: number;
  onActiveSceneChange: (index: number) => void;
  /** 变化即把 activeSceneIndex 对应的块滚入视野（由场景导航的点击驱动） */
  scrollToken: number;
  /** 要素清单：预览态据此给角色/场景/道具着色。不传则完全退回改版前的渲染 */
  elements?: AnnotationElements;
}) {
  const { token } = theme.useToken();
  /** 匹配表按长度倒序，最长优先——高亮与「标注要素」共用同一份规则，不会各说各话 */
  const elementIndex = useMemo(
    () => (elements === undefined ? [] : buildElementIndex(elements)),
    [elements],
  );
  const [editing, setEditing] = useState<EditingState | null>(null);
  /** 进入编辑态后要落的光标位置；用完即清 */
  const pendingCaretRef = useRef<number | null>(null);
  const textAreaRef = useRef<TextAreaRef | null>(null);
  const blockRefs = useRef<Array<HTMLDivElement | null>>([]);
  const scrollRootRef = useRef<HTMLDivElement>(null);

  const blocks = useMemo(
    () => (parsed.scenes.length > 0 ? parsed.scenes : [EMPTY_SCENE]),
    [parsed.scenes],
  );

  // 场景导航点击 → 滚动定位。用 scrollToken 而非 activeSceneIndex 作依赖，
  // 这样"点击块本身"改变选中场景时不会把页面又滚一次（那会打断正在写字的人）
  useEffect(() => {
    if (scrollToken === 0) return;
    const el = blockRefs.current[activeSceneIndex];
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    // activeSceneIndex 故意不进依赖：只有 scrollToken 变化才代表"请求滚动"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToken]);

  // 编辑态挂载后聚焦并落光标，让"点哪儿就从哪儿开始改"成立
  useLayoutEffect(() => {
    if (editing === null) return;
    const el = textAreaRef.current?.resizableTextArea?.textArea;
    if (!el) return;
    el.focus();
    const caret = pendingCaretRef.current;
    if (caret !== null) {
      const pos = Math.max(0, Math.min(caret, el.value.length));
      el.setSelectionRange(pos, pos);
      pendingCaretRef.current = null;
    }
  }, [editing?.index]);

  /** 进入某个块的编辑态；caretOffset 是块内字符偏移 */
  const beginEdit = (index: number, caretOffset: number) => {
    if (editing !== null && editing.index === index) return;
    // 从别的块切过来：先按既有语义结束上一个块（落库交给页面的 onBlur）
    if (editing !== null) onBlur();

    const texts = blocks.map((s) => s.text);
    const prefix = index > 0 ? `${texts.slice(0, index).join('\n')}\n` : '';
    const suffix = index < texts.length - 1 ? `\n${texts.slice(index + 1).join('\n')}` : '';
    pendingCaretRef.current = caretOffset;
    setEditing({ index, draft: texts[index] ?? '', prefix, suffix });
    onActiveSceneChange(index);
  };

  const handleDraftChange = (next: string) => {
    if (editing === null) return;
    setEditing({ ...editing, draft: next });
    onChange(editing.prefix + next + editing.suffix);
  };

  const endEdit = () => {
    if (editing === null) return;
    setEditing(null);
    onBlur();
  };

  // 块列表跟着实时解析走：编辑时删掉「场景N：」抬头会让两场并作一场，
  // 正在编辑的下标随即越界，那个 textarea 没有挂载点 → 打字打到一半编辑框凭空消失、焦点丢失。
  // 正文本身不丢（prefix+draft+suffix 不变），但体感很坏，故越界时主动收尾。
  useEffect(() => {
    if (editing !== null && editing.index > blocks.length - 1) endEdit();
    // endEdit 只读 editing，随 editing 变化即可，不必进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks.length, editing]);

  return (
    <div
      ref={scrollRootRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: '4px 24px 120px',
      }}
    >
      {blocks.map((scene, i) => (
        <SceneBlock
          key={scene.index}
          ref={(el) => {
            blockRefs.current[i] = el;
          }}
          scene={scene}
          active={scene.index === activeSceneIndex}
          editing={editing?.index === scene.index}
          draft={editing?.index === scene.index ? editing.draft : scene.text}
          textAreaRef={textAreaRef}
          onDraftChange={handleDraftChange}
          onBeginEdit={(caret) => beginEdit(scene.index, caret)}
          onEndEdit={endEdit}
          onFocusScene={() => onActiveSceneChange(scene.index)}
          token={token}
          elementIndex={elementIndex}
        />
      ))}

      {/* 全文为空时给一句引导：空白画布上没有任何抓手最劝退 */}
      {fullText === '' && editing === null && (
        <Text type="secondary" style={{ fontSize: 13 }}>
          点击上方空白处开始撰写。建议以「场景一：客户会议室，白天。」这样的抬头分场。
        </Text>
      )}
    </div>
  );
}

/* ---------------- 单个场景块 ---------------- */

interface SceneBlockProps {
  scene: ParsedScene;
  active: boolean;
  editing: boolean;
  draft: string;
  textAreaRef: MutableRefObject<TextAreaRef | null>;
  onDraftChange: (next: string) => void;
  onBeginEdit: (caretOffset: number) => void;
  onEndEdit: () => void;
  onFocusScene: () => void;
  token: GlobalToken;
  elementIndex: ElementIndexEntry[];
}

const SceneBlock = forwardRef<HTMLDivElement, SceneBlockProps>(function SceneBlock(
  {
    scene,
    active,
    editing,
    draft,
    textAreaRef,
    onDraftChange,
    onBeginEdit,
    onEndEdit,
    onFocusScene,
    token,
    elementIndex,
  },
  ref,
) {
  const headerText = buildSceneHeader(scene);

  const containerStyle: CSSProperties = {
    marginBottom: 20,
    borderRadius: token.borderRadiusLG,
    // 选中块给一层极淡的主色描边：找得到自己在哪一场，又不至于喧宾夺主
    border: `1px solid ${active ? token.colorPrimaryBorder : 'transparent'}`,
    background: active ? token.colorFillQuaternary : undefined,
    transition: 'border-color .15s, background .15s',
  };

  return (
    <div ref={ref} style={containerStyle}>
      {/* 抬头条：把场景的结构化信息摆在正文之上，点它从块首开始编辑 */}
      <div
        role="button"
        tabIndex={-1}
        onClick={() => {
          onFocusScene();
          if (!editing) onBeginEdit(0);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 12px',
          borderRadius: `${token.borderRadiusLG}px ${token.borderRadiusLG}px 0 0`,
          background: token.colorFillTertiary,
          cursor: 'text',
        }}
      >
        <Text
          strong
          style={{ fontSize: 12, letterSpacing: 0.3, color: token.colorTextSecondary }}
        >
          {headerText}
        </Text>
      </div>

      <div style={{ padding: '8px 12px' }}>
        {editing ? (
          <Input.TextArea
            ref={textAreaRef}
            value={draft}
            autoSize={{ minRows: 2 }}
            variant="borderless"
            onChange={(e) => onDraftChange(e.target.value)}
            onBlur={onEndEdit}
            placeholder="在此撰写这一场……"
            style={{
              padding: 0,
              fontSize: 15,
              lineHeight: 1.9,
              resize: 'none',
            }}
          />
        ) : (
          <ScenePreview
            scene={scene}
            onBeginEdit={onBeginEdit}
            token={token}
            elementIndex={elementIndex}
          />
        )}
      </div>
    </div>
  );
});

/** 抬头条文案：`S01｜内景｜客户会议室｜白天｜预计18秒`，缺失字段整段跳过 */
function buildSceneHeader(scene: ParsedScene): string {
  const parts = [
    `S${String(scene.index + 1).padStart(2, '0')}`,
    formatInteriorExterior(scene.interiorExterior),
    scene.title.trim(),
    scene.timeOfDay,
    `预计${formatDuration(scene.estimatedDurationMs)}`,
  ].filter((s) => s !== '');
  return parts.join('｜');
}

/* ---------------- 只读预览（有层次的剧本视图） ---------------- */

function ScenePreview({
  scene,
  onBeginEdit,
  token,
  elementIndex,
}: {
  scene: ParsedScene;
  onBeginEdit: (caretOffset: number) => void;
  token: GlobalToken;
  elementIndex: ElementIndexEntry[];
}) {
  // 抬头行已经由抬头条呈现，正文里不再重复一遍
  const bodyLines = scene.lines[0]?.kind === 'heading' ? scene.lines.slice(1) : scene.lines;
  const bodyStartOffset = scene.lines[0]?.kind === 'heading' ? scene.lines[0].raw.length + 1 : 0;

  /** 块内字符偏移 = 前面各行长度（含换行）之和 + 行内偏移 */
  const offsetOfLine = (lineIndex: number): number => {
    let offset = bodyStartOffset;
    for (let i = 0; i < lineIndex; i += 1) offset += (bodyLines[i]?.raw.length ?? 0) + 1;
    return offset;
  };

  const handleLineClick = (lineIndex: number) => {
    onBeginEdit(offsetOfLine(lineIndex) + readIntraLineOffset());
  };

  if (bodyLines.length === 0) {
    return (
      <div onClick={() => onBeginEdit(bodyStartOffset)} style={{ cursor: 'text', minHeight: 28 }}>
        <Text type="secondary" italic style={{ fontSize: 13 }}>
          （这一场还没有内容，点击撰写）
        </Text>
      </div>
    );
  }

  return (
    <div style={{ cursor: 'text' }}>
      {bodyLines.map((line, i) => (
        <PreviewLine
          key={i}
          line={line}
          token={token}
          elementIndex={elementIndex}
          onClick={() => handleLineClick(i)}
        />
      ))}
    </div>
  );
}

/**
 * 读取点击落点在该行内的字符偏移。
 * 只读视图不是输入框，浏览器仍会在点击处放一个折叠选区，借它还原用户的意图；
 * 取不到就退化到行首——比把光标甩到块尾好得多。
 *
 * anchorOffset 是相对**所在文本节点**的。对白行渲染成「角色名：」与台词两个 span，
 * 点在台词里拿到的偏移会少算角色名那一截，光标因此落早。
 * 故每个 span 自带 data-line-base 基址，这里向上找到它再相加。
 */
function readIntraLineOffset(): number {
  try {
    const selection = window.getSelection();
    if (selection === null || !selection.isCollapsed) return 0;
    const node = selection.anchorNode;
    const el = node === null ? null : node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const base = Number(el?.closest('[data-line-base]')?.getAttribute('data-line-base') ?? 0);
    return (Number.isFinite(base) ? base : 0) + selection.anchorOffset;
  } catch {
    return 0;
  }
}

function PreviewLine({
  line,
  token,
  elementIndex,
  onClick,
}: {
  line: ScriptLine;
  token: GlobalToken;
  elementIndex: ElementIndexEntry[];
  onClick: () => void;
}) {
  const baseStyle: CSSProperties = {
    fontSize: 15,
    lineHeight: 1.9,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };

  if (line.kind === 'blank') {
    // 空行保留为可点击的间隔：它在正文里是真实存在的一行
    return <div onClick={onClick} style={{ height: 14 }} />;
  }

  // 写法不规范的对白：正文照旧展示，只在行尾挂一个提示图标，不改用户一个字
  const issue = line.kind === 'dialogue' || line.kind === 'narration' ? null : inspectDialogueIssue(line.raw);

  if (line.kind === 'dialogue' || line.kind === 'narration') {
    const narration = line.kind === 'narration';
    return (
      <div onClick={onClick} style={baseStyle}>
        <span
          data-line-base={0}
          style={{
            fontWeight: 600,
            // 角色名走主色、旁白走次级文字色：一眼看出"谁在说"与"画外音"
            color: narration ? token.colorTextTertiary : token.colorPrimary,
          }}
        >
          {line.speaker}：
        </span>
        {/* 台词 span 的基址 = 角色名长度 + 全角冒号，否则点台词时光标会落早这一截 */}
        <span
          data-line-base={(line.speaker?.length ?? 0) + 1}
          style={{ color: narration ? token.colorTextSecondary : token.colorText }}
        >
          {line.text}
        </span>
      </div>
    );
  }

  return (
    <div onClick={onClick} style={{ ...baseStyle, color: token.colorTextSecondary }}>
      <ElementText raw={line.raw} token={token} elementIndex={elementIndex} />
      {issue !== null && (
        <Tooltip title="该行可能无法被自动拆分镜识别为对白">
          <ExclamationCircleOutlined
            style={{ marginInlineStart: 6, color: token.colorWarning, fontSize: 13 }}
          />
        </Tooltip>
      )}
    </div>
  );
}

/* ---------------- 要素高亮 ---------------- */

/** 三类要素的颜色一律取自 token（主色/成功/警告），换主题与暗色自动跟随 */
function elementColor(type: ElementNameType, token: GlobalToken): string {
  if (type === 'CHARACTER') return token.colorPrimary; // 与对白行的说话人同色，认人只需记一种颜色
  if (type === 'SCENE') return token.colorSuccess;
  return token.colorWarning;
}

/**
 * 动作/环境行的正文：把要素名按类型着色，带 @ 的额外加一条虚线下划线。
 *
 * 【只给动作行上色】台词里出现的人名是角色在称呼别人，不是画面里的引用，
 * 着色会误导用户去 @ 它——而「标注要素」恰恰绝不会动对白行。两处口径必须一致。
 *
 * 【caret 定位】只读视图靠 data-line-base 还原点击落点：anchorOffset 是相对**所在文本节点**的，
 * 一旦把一行拆成多个 span，每个 span 都必须带上自己在行内的起始下标，否则点击后光标会错位。
 * 无要素命中时刻意退回单个文本节点，DOM 与改版前逐字相同（base 缺省 0 的老路径继续成立）。
 */
function ElementText({
  raw,
  token,
  elementIndex,
}: {
  raw: string;
  token: GlobalToken;
  elementIndex: ElementIndexEntry[];
}) {
  const segments = useMemo(() => splitLineByElements(raw, elementIndex), [raw, elementIndex]);

  if (!segments.some((s) => s.element !== null)) return <>{raw}</>;

  return (
    <>
      {segments.map((seg, i) =>
        seg.element === null ? (
          <span key={i} data-line-base={seg.start}>
            {seg.text}
          </span>
        ) : (
          <span
            key={i}
            data-line-base={seg.start}
            title={`${ELEMENT_TYPE_LABEL[seg.element.type]}${seg.element.annotated ? '（已标注）' : ''}`}
            style={{
              color: elementColor(seg.element.type, token),
              // 已显式 @ 标注：一条细虚线，表示"这处引用是用户确定过的"
              textDecoration: seg.element.annotated ? 'underline' : undefined,
              textDecorationStyle: seg.element.annotated ? 'dotted' : undefined,
              textUnderlineOffset: 3,
            }}
          >
            {seg.text}
          </span>
        ),
      )}
    </>
  );
}

const ELEMENT_TYPE_LABEL: Record<ElementNameType, string> = {
  CHARACTER: '角色',
  SCENE: '场景',
  PROP: '道具',
};
