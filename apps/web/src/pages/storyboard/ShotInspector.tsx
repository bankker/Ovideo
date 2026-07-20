// 镜头检查器（分镜工作台右栏，360px）。
//
// 【它存在的理由】改造前，景别/角度/运镜/提示词全都平铺在卡面上，卡片变成一堵文字墙，
// 用户扫一屏看不出片子长什么样。现在卡面只留画面，所有可调参数收进这里；
// 提示词更进一步塞进「高级设置」——默认不可见，要的人展开就有。
//
// 纯展示组件：自己不发任何请求，改动一律经 onSave 交回集成方。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Divider,
  Empty,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { DoubleLeftOutlined, DoubleRightOutlined } from '@ant-design/icons';
import {
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  SHOT_SIZES,
  SHOT_DURATION_MAX_MS,
  SHOT_DURATION_MIN_MS,
  TRANSITIONS,
  type ShotEditableFields,
} from '@ovideo/shared';

const { Text, Paragraph } = Typography;

/**
 * 时长边界的真相在 @ovideo/shared（服务端拆镜提示词用的是同一份）。
 * 这里转出口只为不打断既有的 `from './ShotInspector'` 导入方（镜头表）。
 */
export { SHOT_DURATION_MIN_MS, SHOT_DURATION_MAX_MS };

export interface InspectorShot {
  id: string;
  /**
   * 跨版本稳定的镜头身份。
   * 【为什么不能用 id】每次 apply-patch 都会产出新版本并全量复制 Shot，全部镜头都换新 cuid；
   * 拿 id 当身份，别处任何一次提交都会被当成"用户切换了镜头"，把正在编辑的草稿悄悄丢掉。
   */
  lineageId?: string;
  index: number;
  sceneIndex: number;
  /** 与 apply-patch 的 ShotEditableFields 同名——不同名会被 zod 非 strict 静默 strip 掉 */
  durationPlannedMs: number;
  shotSize: string;
  cameraAngle: string;
  cameraMovement: string;
  composition: string;
  transition: string;
  sourceText: string;
  dialogue: Array<{ speaker: string; text: string }>;
  imagePrompt: string;
}

/** 草稿只覆盖可编辑字段；只读字段（原文、台词）没有草稿态 */
type DraftFields = Pick<
  InspectorShot,
  | 'durationPlannedMs'
  | 'shotSize'
  | 'cameraAngle'
  | 'cameraMovement'
  | 'composition'
  | 'transition'
  | 'imagePrompt'
>;

const DRAFT_KEYS: Array<keyof DraftFields> = [
  'durationPlannedMs',
  'shotSize',
  'cameraAngle',
  'cameraMovement',
  'composition',
  'transition',
  'imagePrompt',
];

function toDraft(shot: InspectorShot): DraftFields {
  return {
    durationPlannedMs: shot.durationPlannedMs,
    shotSize: shot.shotSize,
    cameraAngle: shot.cameraAngle,
    cameraMovement: shot.cameraMovement,
    composition: shot.composition,
    transition: shot.transition,
    imagePrompt: shot.imagePrompt,
  };
}

function sameFields(a: DraftFields, b: DraftFields): boolean {
  return DRAFT_KEYS.every((k) => a[k] === b[k]);
}

/** 跨版本身份；lineageId 缺省时退回 id（新建但尚未落库的镜头） */
function identityOf(shot: InspectorShot): string {
  return shot.lineageId ?? shot.id;
}

/**
 * 校验只回答一件事：用户这次填进去的时长本身合不合法。
 * 【为什么不校验存量值】库里的历史镜头是旧的平铺拆分留下的，普遍在 12000ms 上下；
 * 那不是用户填的，也不该拦着用户改景别/角度/提示词。所以调用方只在时长真被改动时才问这里。
 */
function validateDuration(ms: number): string | null {
  if (!Number.isFinite(ms)) return '时长必须是数字';
  // 契约里 durationPlannedMs 是 z.number().int()：小数会在服务端被拒，得在这里就说清楚
  if (!Number.isInteger(ms)) return '时长必须是整毫秒的整数';
  if (ms < SHOT_DURATION_MIN_MS) {
    return `不能短于 ${SHOT_DURATION_MIN_MS / 1000} 秒：再短就装不下一句完整台词了`;
  }
  if (ms > SHOT_DURATION_MAX_MS) {
    return `不能超过 ${SHOT_DURATION_MAX_MS / 1000} 秒：一个镜头对应一次视频生成，模型单次上限就是 8 秒`;
  }
  return null;
}

/**
 * Segmented 的"未填"哨兵值。
 * 库里这几列是 String default ""，空串在 Segmented 里没有任何选中态——"没填"和"还没加载出来"
 * 长得一模一样。给空串一个显式选项，既让未填有视觉表达，也补上了清空能力
 * （镜头表同样三列用的是 allowClear 的 Select，两个视图的可编辑范围必须一致）。
 */
/**
 * Segmented 的值不能是空串（空串会被当成"没有选中"，"未填"与"加载中"就分不出来），
 * 所以给"未填"一个哨兵值。取一个绝不会成为合法景别/角度/运镜的串——
 * 那几组取值都是中文词，冒号前缀在其中不可能出现。哨兵只活在组件内部，
 * onChange 时已映射回空串，不会外泄进补丁。
 */
const EMPTY_CHOICE = '::empty';

function choiceOptions(values: readonly string[]): Array<{ label: string; value: string }> {
  return [{ label: '未填', value: EMPTY_CHOICE }, ...values.map((v) => ({ label: v, value: v }))];
}

export interface ShotInspectorProps {
  /** 当前选中的镜头；null = 未选中，显示空态 */
  shot: InspectorShot | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** 只回传真正变化的字段，避免把未改的值也算进补丁；字段名与 apply-patch 契约同源 */
  onSave: (shotId: string, changes: ShotEditableFields) => Promise<void>;
  saving: boolean;
  /** 生图模型选择 / 参考图由集成方塞进来，检查器不自己发请求 */
  advanced?: React.ReactNode;
}

export function ShotInspector({
  shot,
  collapsed,
  onToggleCollapsed,
  onSave,
  saving,
  advanced,
}: ShotInspectorProps): JSX.Element {
  const { token } = theme.useToken();

  /**
   * 【为什么要草稿】每次 apply-patch 都会产出一个新的 Storyboard 版本，
   * 并全量复制 Shot/Take/Binding/DubbingLine。逐字提交等于打一个字造一个版本，
   * 几分钟就能把版本历史冲成噪音。所以改动先落在本地草稿，失焦或点保存时一次性提交。
   */
  const [draft, setDraft] = useState<DraftFields | null>(shot ? toDraft(shot) : null);
  /** 草稿归属的镜头身份（lineage 级）：切换镜头时用它判断草稿该不该丢弃 */
  const [draftIdentity, setDraftIdentity] = useState<string | null>(
    shot ? identityOf(shot) : null,
  );
  /** 草稿派生自的那份服务端值；用来区分"用户改的"与"别处改的" */
  const [baseline, setBaseline] = useState<DraftFields | null>(shot ? toDraft(shot) : null);
  /** 同一镜头在别处被改过，而本地草稿又不肯丢——提示用户自己裁决 */
  const [outdated, setOutdated] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 草稿是同步态，effect 里读它会拿到上一轮的值；用 ref 保证比对的是当下这份。
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (shot === null) {
      setDraft(null);
      setDraftIdentity(null);
      setBaseline(null);
      setOutdated(false);
      return;
    }
    const identity = identityOf(shot);
    const next = toDraft(shot);

    // 真的换了镜头：草稿属于上一个镜头，丢弃
    if (identity !== draftIdentity) {
      setDraft(next);
      setDraftIdentity(identity);
      setBaseline(next);
      setOutdated(false);
      setSaveError(null);
      return;
    }

    const current = draftRef.current;
    if (baseline === null || current === null || sameFields(next, baseline)) return;

    // 同一镜头、服务端值变了。用户没动过草稿就静默跟随；动过就保住草稿，把冲突摆到台面上，
    // 不能像从前那样直接覆盖——那等于用户白敲一遍。
    if (sameFields(current, baseline)) {
      setDraft(next);
    } else {
      setOutdated(true);
    }
    setBaseline(next);
  }, [shot, draftIdentity, baseline]);

  /** 与服务端值不一致的字段。空数组 = 干净 */
  const dirtyKeys = useMemo(() => {
    if (!shot || !draft) return [];
    return DRAFT_KEYS.filter((k) => draft[k] !== shot[k]);
  }, [shot, draft]);
  const dirty = dirtyKeys.length > 0;

  const durationDirty = dirtyKeys.includes('durationPlannedMs');

  /**
   * 只在用户真的改了时长时才校验。存量超长镜头（旧平铺数据留下的 12000ms 上下）
   * 原样显示、不报错、更不静默夹断，用户改别的字段照样存得下去。
   */
  const durationError = useMemo(
    () => (draft && durationDirty ? validateDuration(draft.durationPlannedMs) : null),
    [draft, durationDirty],
  );

  /** 时长非法时只拦时长这一个字段，其余字段照常提交 */
  const savableKeys = useMemo(
    () => (durationError === null ? dirtyKeys : dirtyKeys.filter((k) => k !== 'durationPlannedMs')),
    [dirtyKeys, durationError],
  );

  const overLimitLegacy =
    draft !== null && !durationDirty && draft.durationPlannedMs > SHOT_DURATION_MAX_MS;

  const patch = useCallback((changes: Partial<DraftFields>) => {
    setDraft((prev) => (prev === null ? prev : { ...prev, ...changes }));
  }, []);

  /**
   * 一次性提交所有可提交的脏字段。
   * 失焦时也走这里而不是「只提交刚失焦的那个字段」：既然一次提交就是一个版本，
   * 顺手把同时脏着的其它字段一起带走，能少造几个版本。
   */
  const commit = useCallback(async () => {
    if (!shot || !draft || savableKeys.length === 0 || saving) return;
    const changes: ShotEditableFields = {};
    for (const k of savableKeys) {
      // 逐键赋值而非 spread：只带脏字段，未改的字段不进补丁
      Object.assign(changes, { [k]: draft[k] });
    }
    try {
      await onSave(shot.id, changes);
      /**
       * 把基线推进到"我们刚提交的这份"。保存成功后服务端值必然会变，
       * 若基线还停在提交前的旧值，回流的新值就会被判成"别处改的"，
       * 于是用户每存一次都收到一句「这个镜头在别处被改过」——那是他自己改的。
       */
      setBaseline(draft);
      setSaveError(null);
      setOutdated(false);
    } catch (e) {
      // 调用点是 onBlur={() => void commit()}，不接住就是一个未捕获的 Promise rejection，
      // 用户只会看到改动"没生效"。留住草稿并把失败摆出来，让他能重试。
      setSaveError(e instanceof Error ? e.message : '保存失败，请重试');
    }
  }, [shot, draft, savableKeys, saving, onSave]);

  const revert = useCallback(() => {
    if (!shot) return;
    setDraft(toDraft(shot));
    setBaseline(toDraft(shot));
    setOutdated(false);
    setSaveError(null);
  }, [shot]);

  if (collapsed) {
    return (
      <div
        style={{
          width: 40,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          borderInlineStart: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Tooltip title="展开镜头检查器" placement="left">
          <Button type="text" icon={<DoubleLeftOutlined />} onClick={onToggleCollapsed} />
        </Tooltip>
        <Text
          type="secondary"
          style={{ fontSize: 12, writingMode: 'vertical-rl', marginTop: 8 }}
        >
          {shot ? `#${shot.index}` : '镜头检查器'}
        </Text>
        {/* 收起时也要能看见有未保存改动，否则用户会以为已经存了 */}
        {dirty && (
          <Tooltip title="有未保存的改动" placement="left">
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: token.colorWarning,
                marginTop: 8,
              }}
            />
          </Tooltip>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        width: 360,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderInlineStart: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      {/* ---------- 标题栏 ---------- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Tooltip title="收起">
          <Button
            type="text"
            size="small"
            icon={<DoubleRightOutlined />}
            onClick={onToggleCollapsed}
          />
        </Tooltip>
        <Text strong style={{ fontSize: 13, flex: 1 }}>
          镜头检查器
        </Text>
        {dirty && (
          <Tag color="warning" style={{ marginInlineEnd: 0 }}>
            未保存
          </Tag>
        )}
      </div>

      {!shot || !draft ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Text type="secondary" style={{ fontSize: 12 }}>
              在故事板中选择一个镜头
            </Text>
          }
          style={{ marginTop: 64 }}
        />
      ) : (
        <>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 }}>
            {outdated && (
              <Alert
                type="warning"
                showIcon
                closable
                onClose={() => setOutdated(false)}
                style={{ marginBottom: 10 }}
                message="这个镜头在别处被改过"
                description={
                  <Text style={{ fontSize: 12 }}>
                    你的改动还留着，尚未提交。保存会以你这份为准覆盖，放弃则取回最新的服务端值。
                  </Text>
                }
              />
            )}
            {saveError !== null && (
              <Alert
                type="error"
                showIcon
                closable
                style={{ marginBottom: 10 }}
                message="保存失败"
                description={<Text style={{ fontSize: 12 }}>{saveError}</Text>}
                onClose={() => setSaveError(null)}
              />
            )}

            {/* ---------- a. 镜头标识 ---------- */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <Text strong style={{ fontSize: 18 }}>
                #{shot.index}
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {shot.sceneIndex > 0 ? `第 ${shot.sceneIndex} 场` : '未归属场次'}
              </Text>
            </div>

            <div style={{ marginTop: 10 }}>
              <FieldLabel>时长</FieldLabel>
              <Space size={8} align="center" style={{ marginTop: 4 }}>
                <InputNumber
                  // 不设 min/max：antd 会在失焦时静默夹回边界，用户根本看不到自己填了什么、
                  // 也不知道为什么被改；存量的超长镜头更会被无声改写。放行输入、当场讲清原因。
                  value={draft.durationPlannedMs}
                  step={500}
                  precision={0}
                  status={durationError !== null ? 'error' : undefined}
                  disabled={saving}
                  style={{ width: 120 }}
                  onChange={(v) =>
                    patch({ durationPlannedMs: typeof v === 'number' ? v : NaN })
                  }
                  onBlur={() => void commit()}
                  addonAfter="ms"
                />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  ≈ {(draft.durationPlannedMs / 1000).toFixed(1)} 秒
                </Text>
              </Space>
              {durationError !== null && (
                <div style={{ marginTop: 4 }}>
                  <Text type="danger" style={{ fontSize: 12 }}>
                    {durationError}（其余改动不受影响，照常保存）
                  </Text>
                </div>
              )}
              {/* 存量超长值不是用户填的，说明现状即可，不能报成他的错 */}
              {overLimitLegacy && (
                <div style={{ marginTop: 4 }}>
                  <Text type="warning" style={{ fontSize: 12 }}>
                    这是早期平铺拆分留下的超长镜头，超过 {SHOT_DURATION_MAX_MS / 1000} 秒的单镜上限，
                    生成时会被截断；改动此镜时顺手调回区间内更稳。
                  </Text>
                </div>
              )}
            </div>

            <Divider style={{ margin: '12px 0' }} />

            {/* ---------- b. 影视语义 ---------- */}
            <FieldLabel>景别</FieldLabel>
            <div style={{ marginTop: 4 }}>
              <Segmented
                block
                size="small"
                value={draft.shotSize === '' ? EMPTY_CHOICE : draft.shotSize}
                disabled={saving}
                options={choiceOptions(SHOT_SIZES)}
                // 库里是 String default ""，不是 null；清空要写回空串
                onChange={(v) => patch({ shotSize: v === EMPTY_CHOICE ? '' : String(v) })}
              />
            </div>

            <div style={{ marginTop: 10 }}>
              <FieldLabel>角度</FieldLabel>
              <div style={{ marginTop: 4 }}>
                <Segmented
                  block
                  size="small"
                  value={draft.cameraAngle === '' ? EMPTY_CHOICE : draft.cameraAngle}
                  disabled={saving}
                  options={choiceOptions(CAMERA_ANGLES)}
                  onChange={(v) => patch({ cameraAngle: v === EMPTY_CHOICE ? '' : String(v) })}
                />
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <FieldLabel>运镜</FieldLabel>
              <div style={{ marginTop: 4 }}>
                <Segmented
                  block
                  size="small"
                  value={draft.cameraMovement === '' ? EMPTY_CHOICE : draft.cameraMovement}
                  disabled={saving}
                  options={choiceOptions(CAMERA_MOVEMENTS)}
                  onChange={(v) => patch({ cameraMovement: v === EMPTY_CHOICE ? '' : String(v) })}
                />
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <FieldLabel>构图</FieldLabel>
              <Input
                value={draft.composition}
                placeholder="如：人物居右三分线，前景虚化的门框"
                disabled={saving}
                style={{ marginTop: 4 }}
                onChange={(e) => patch({ composition: e.target.value })}
                onBlur={() => void commit()}
              />
            </div>

            <div style={{ marginTop: 10 }}>
              <FieldLabel>转场</FieldLabel>
              <Select
                value={draft.transition === '' ? undefined : draft.transition}
                placeholder="未填"
                allowClear
                disabled={saving}
                style={{ width: '100%', marginTop: 4 }}
                options={TRANSITIONS.map((v) => ({ label: v, value: v }))}
                // 库里是 String default ""，不是 null；清空要写回空串而不是 undefined
                onChange={(v) => patch({ transition: v ?? '' })}
              />
            </div>

            <Divider style={{ margin: '12px 0' }} />

            {/* ---------- c. 剧本原文 ---------- */}
            <FieldLabel>剧本原文</FieldLabel>
            <div
              style={{
                marginTop: 4,
                padding: 8,
                borderRadius: token.borderRadius,
                background: token.colorFillQuaternary,
              }}
            >
              {shot.sourceText.trim() === '' ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  本镜没有对应的剧本原文
                </Text>
              ) : (
                <Paragraph style={{ fontSize: 13, marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                  {shot.sourceText}
                </Paragraph>
              )}
            </div>

            <Divider style={{ margin: '12px 0' }} />

            {/* ---------- d. 台词 ---------- */}
            <FieldLabel>台词</FieldLabel>
            <div style={{ marginTop: 4 }}>
              {shot.dialogue.length === 0 ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  本镜无台词
                </Text>
              ) : (
                shot.dialogue.map((line, i) => (
                  <div
                    key={`${line.speaker}-${i}`}
                    style={{ display: 'flex', gap: 8, marginTop: i === 0 ? 0 : 6 }}
                  >
                    <Text
                      type="secondary"
                      style={{ fontSize: 12, width: 56, flexShrink: 0 }}
                      ellipsis={{ tooltip: line.speaker }}
                    >
                      {line.speaker}
                    </Text>
                    <Text style={{ fontSize: 13, minWidth: 0 }}>{line.text}</Text>
                  </div>
                ))
              )}
            </div>

            <Divider style={{ margin: '12px 0' }} />

            {/* ---------- e. 高级设置 ---------- */}
            <Collapse
              size="small"
              ghost
              items={[
                {
                  key: 'advanced',
                  label: <Text style={{ fontSize: 13 }}>高级设置</Text>,
                  children: (
                    <>
                      <FieldLabel>生图提示词</FieldLabel>
                      <Input.TextArea
                        value={draft.imagePrompt}
                        autoSize={{ minRows: 3, maxRows: 12 }}
                        disabled={saving}
                        style={{ marginTop: 4, fontSize: 12 }}
                        onChange={(e) => patch({ imagePrompt: e.target.value })}
                        onBlur={() => void commit()}
                      />
                      {advanced !== undefined && (
                        <div style={{ marginTop: 12 }}>{advanced}</div>
                      )}
                    </>
                  ),
                },
              ]}
            />
          </div>

          {/* ---------- 保存条 ---------- */}
          {dirty && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderTop: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorFillQuaternary,
              }}
            >
              <Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
                {savableKeys.length} 项未保存
                {durationError !== null && '（时长被拦下）'}
              </Text>
              <Button size="small" disabled={saving} onClick={revert}>
                放弃
              </Button>
              {/* disabled 的 antd 按钮 pointer-events:none，Tooltip 挂在它身上永远不触发；套一层 span 接事件 */}
              <Tooltip title={savableKeys.length === 0 ? (durationError ?? '') : ''}>
                <span>
                  <Button
                    size="small"
                    type="primary"
                    loading={saving}
                    disabled={savableKeys.length === 0}
                    onClick={() => void commit()}
                  >
                    保存
                  </Button>
                </span>
              </Tooltip>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 字段标签：统一的次级小灰字，避免每处各写一套 */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text type="secondary" style={{ fontSize: 12, fontWeight: 600 }}>
      {children}
    </Text>
  );
}
