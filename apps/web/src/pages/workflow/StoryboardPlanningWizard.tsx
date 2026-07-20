// 分镜规划向导：体检 → 导演方案 → 视觉确认 → 生成。
//
// 【为什么要三步而不是一个按钮】以前「开始分镜规划」= 把整篇剧本丢给模型，
// 拆多少镜、什么节奏、用哪张参考图全由模型临场决定，用户只能在结果出来后返工。
// 这三步把三件本该在开拍前定下来的事摆到台面上：剧本有没有硬伤、这一集要什么拆镜风格、
// 视觉素材齐不齐。前两步产出一段导演说明随请求下发，第三步只做确认与补救。

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Slider,
  Space,
  Steps,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import { CheckCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useProject, useUpdateProject, type Project, type UpdateProjectInput } from '../../api/hooks';
import { useTagDesigns, useProjectTags } from '../../api/design-hooks';
import { formatDuration, type ParsedScript } from '../../utils/script-parse';
import type { ScriptElement } from '../../utils/script-elements';
import { annotateMentions } from '../../utils/annotate-mentions';
import {
  averageShotSec,
  buildDirective,
  CAMERA_OPTIONS,
  DIRECTOR_PLANS,
  PACE_OPTIONS,
  suggestShotCount,
  type CameraIntensity,
  type DirectorPlanKey,
  type Pace,
  type Priority,
} from '../../utils/storyboard-directive';
import { ScriptPreflightContent, usePreflight } from './ScriptPreflight';

const { Text, Paragraph } = Typography;

/** 画面比例候选，与设计页 / 分镜页的 RATIO_OPTIONS 保持同一套取值 */
const RATIO_OPTIONS = ['9:16', '16:9', '1:1', '3:4', '4:3'];
const DEFAULT_RATIO = '9:16';

/** 目标总时长滑杆的上下界（秒）。上界给到 10 分钟，够一集短剧 */
const DURATION_MIN_SEC = 10;
const DURATION_MAX_SEC = 600;

export interface StoryboardPlanningWizardProps {
  open: boolean;
  /** 'check' = 只读体检（只有第一步、不能前进）；'plan' = 完整三步 */
  mode: 'check' | 'plan';
  projectId: string;
  episodeId: string;
  parsed: ParsedScript;
  /** 生成中：主按钮 loading、向导不可关闭 */
  generating: boolean;
  /** 服务端错误全文；非 null 时在向导内常驻显示 */
  failure: string | null;
  onCancel: () => void;
  /** 用户确认后发起生成；directive 是第二步参数拼成的中文导演说明 */
  onGenerate: (directive: string) => void;
  /** 剧本正文原文：标注要在向导里就地做，需要它作为改写的基底 */
  fullText: string;
  /** 就地标注：把算好的新正文交给页面落库（与工具栏「标注要素」同一条落库路径） */
  onAnnotate: (nextText: string) => void;
  annotating: boolean;
}

export function StoryboardPlanningWizard({
  open,
  mode,
  projectId,
  episodeId,
  parsed,
  generating,
  failure,
  onCancel,
  onGenerate,
  fullText,
  onAnnotate,
  annotating,
}: StoryboardPlanningWizardProps) {
  const result = usePreflight(projectId, parsed);
  const { errorCount, elements } = result;

  const designHref = `/projects/${projectId}/episodes/${episodeId}/design`;

  /**
   * 就地标注。体检里报「N 个要素还没标注 @」，此前只写一句"入口在剧本工具栏"——
   * 用户得关掉向导、找到工具栏、点完再重新走一遍体检，于是这条提醒基本没人处理。
   * 标注结果与工具栏用同一个纯函数算，落库也走同一个回调，两处不会各标各的。
   */
  const annotation = useMemo(() => annotateMentions(fullText, elements), [fullText, elements]);
  const handleAnnotateHere = useCallback(() => {
    if (annotation.added === 0) return;
    onAnnotate(annotation.text);
  }, [annotation, onAnnotate]);

  const [step, setStep] = useState(0);

  /* ---------- 第二步：导演方案参数 ---------- */
  const parsedDurationSec = Math.max(
    DURATION_MIN_SEC,
    Math.min(DURATION_MAX_SEC, Math.round(parsed.totalDurationMs / 1000)),
  );

  const [plan, setPlan] = useState<DirectorPlanKey>('steady');
  const [targetDurationSec, setTargetDurationSec] = useState(parsedDurationSec);
  const [pace, setPace] = useState<Pace>('medium');
  const [shotCount, setShotCount] = useState(() =>
    suggestShotCount('steady', parsedDurationSec, 'medium'),
  );
  const [camera, setCamera] = useState<CameraIntensity>('medium');
  const [priority, setPriority] = useState<Priority>('dialogue');
  const [autoEstablishing, setAutoEstablishing] = useState(true);
  const [autoReaction, setAutoReaction] = useState(true);
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_RATIO);

  // 每次重新打开向导都回到第一步，并把目标时长对齐到当前剧本。
  // 【为什么要重置】用户改完剧本再打开向导，上一次那个按旧剧本算出来的时长会误导他。
  // 项目画幅是"这一部片子是横是竖"的真相，向导打开时以它为准，
  // 否则每次都显示默认竖屏，横屏项目的用户会以为自己上次没选上
  const wizardProjectQuery = useProject(projectId !== '' ? projectId : undefined);
  const projectAspectRatio = (wizardProjectQuery.data as { aspectRatio?: string } | undefined)
    ?.aspectRatio;

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setTargetDurationSec(parsedDurationSec);
    if (projectAspectRatio) setAspectRatio(projectAspectRatio);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开这一刻同步一次
  }, [open]);

  // 方案 / 时长 / 节奏一变就重算建议镜头数；用户随后手改的值保留到下一次变动为止。
  // 这就是「联动但可手改」——不做成单向绑定，否则调完滑杆就得再改一次镜头数。
  useEffect(() => {
    setShotCount(suggestShotCount(plan, targetDurationSec, pace));
  }, [plan, targetDurationSec, pace]);

  const avgShotSec = averageShotSec(targetDurationSec, shotCount);

  const directive = useMemo(
    () =>
      buildDirective({
        plan,
        targetDurationSec,
        pace,
        shotCount,
        camera,
        priority,
        autoEstablishing,
        autoReaction,
        aspectRatio,
      }),
    [
      plan,
      targetDurationSec,
      pace,
      shotCount,
      camera,
      priority,
      autoEstablishing,
      autoReaction,
      aspectRatio,
    ],
  );

  /* ---------- 底部动作 ---------- */

  const goNext = () => setStep((s) => Math.min(2, s + 1));
  const goPrev = () => setStep((s) => Math.max(0, s - 1));

  const footer = (() => {
    // 只读体检：这条路径上用户想知道的是"我的剧本有什么问题"，摆一个「下一步」等于把两个意图混成一个按钮
    if (mode === 'check') return [<Button key="close" onClick={onCancel}>关闭</Button>];

    if (step === 0) {
      const nextButton =
        errorCount > 0 ? (
          // 有严重问题不拦死（用户可能有意为之），但要让他多按一下、知道自己在跳过什么
          <Popconfirm
            key="next"
            title="确定跳过这些问题？"
            description={`还有 ${errorCount} 个严重问题没处理，分镜结果可能需要返工。`}
            okText="仍要继续"
            cancelText="回去修改"
            onConfirm={goNext}
          >
            <Button type="primary" danger>
              仍要继续
            </Button>
          </Popconfirm>
        ) : (
          <Button key="next" type="primary" onClick={goNext}>
            下一步
          </Button>
        );
      return [
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        nextButton,
      ];
    }

    if (step === 1) {
      return [
        <Button key="prev" onClick={goPrev}>
          上一步
        </Button>,
        <Button key="next" type="primary" onClick={goNext}>
          下一步
        </Button>,
      ];
    }

    return [
      <Button key="prev" onClick={goPrev} disabled={generating}>
        上一步
      </Button>,
      <Button
        key="go"
        type="primary"
        loading={generating}
        onClick={() => onGenerate(directive)}
      >
        {failure !== null ? '重试生成' : '生成分镜'}
      </Button>,
    ];
  })();

  return (
    <Modal
      open={open}
      // 生成中不给关：任务已经在跑，关掉向导只会让用户以为没发出去
      onCancel={generating ? undefined : onCancel}
      closable={!generating}
      maskClosable={!generating}
      keyboard={!generating}
      title={mode === 'check' ? '剧本体检' : '分镜规划'}
      width={860}
      footer={<Space>{footer}</Space>}
    >
      {mode === 'plan' && (
        <Steps
          size="small"
          current={step}
          items={[{ title: '剧本体检' }, { title: '导演方案' }, { title: '视觉确认' }]}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* 失败常驻在向导内：用户是在这里按的按钮，错误就该在这里出现 */}
      {failure !== null && (
        <Alert
          type="error"
          showIcon
          message="分镜生成失败"
          description={
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.7 }}>
              {failure}
            </div>
          }
          style={{ marginBottom: 12 }}
        />
      )}

      {step === 0 && (
        <ScriptPreflightContent
          result={result}
          designHref={designHref}
          annotatableCount={annotation.added}
          onAnnotate={handleAnnotateHere}
          annotating={annotating}
        />
      )}

      {step === 1 && (
        <DirectorPlanStep
          plan={plan}
          onPlanChange={setPlan}
          targetDurationSec={targetDurationSec}
          onDurationChange={setTargetDurationSec}
          pace={pace}
          onPaceChange={setPace}
          shotCount={shotCount}
          onShotCountChange={setShotCount}
          avgShotSec={avgShotSec}
          camera={camera}
          onCameraChange={setCamera}
          priority={priority}
          onPriorityChange={setPriority}
          autoEstablishing={autoEstablishing}
          onAutoEstablishingChange={setAutoEstablishing}
          autoReaction={autoReaction}
          onAutoReactionChange={setAutoReaction}
          directive={directive}
        />
      )}

      {step === 2 && (
        <VisualCheckStep
          projectId={projectId}
          parsed={parsed}
          characters={elements.characters}
          scenes={elements.scenes}
          props={elements.props}
          designHref={designHref}
          aspectRatio={aspectRatio}
          onAspectRatioChange={setAspectRatio}
          directive={directive}
        />
      )}
    </Modal>
  );
}

/** ---------- 第二步：导演方案 ---------- */

function DirectorPlanStep({
  plan,
  onPlanChange,
  targetDurationSec,
  onDurationChange,
  pace,
  onPaceChange,
  shotCount,
  onShotCountChange,
  avgShotSec,
  camera,
  onCameraChange,
  priority,
  onPriorityChange,
  autoEstablishing,
  onAutoEstablishingChange,
  autoReaction,
  onAutoReactionChange,
  directive,
}: {
  plan: DirectorPlanKey;
  onPlanChange: (v: DirectorPlanKey) => void;
  targetDurationSec: number;
  onDurationChange: (v: number) => void;
  pace: Pace;
  onPaceChange: (v: Pace) => void;
  shotCount: number;
  onShotCountChange: (v: number) => void;
  avgShotSec: number;
  camera: CameraIntensity;
  onCameraChange: (v: CameraIntensity) => void;
  priority: Priority;
  onPriorityChange: (v: Priority) => void;
  autoEstablishing: boolean;
  onAutoEstablishingChange: (v: boolean) => void;
  autoReaction: boolean;
  onAutoReactionChange: (v: boolean) => void;
  directive: string;
}) {
  const { token } = theme.useToken();

  return (
    <div>
      {/* 三张方案卡片：估算值随下面的时长/节奏实时变，用户能看出选择带来的差别 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 10,
        }}
      >
        {DIRECTOR_PLANS.map((p) => {
          const selected = p.key === plan;
          const estShots = suggestShotCount(p.key, targetDurationSec, pace);
          return (
            <div
              key={p.key}
              role="button"
              tabIndex={0}
              onClick={() => onPlanChange(p.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onPlanChange(p.key);
              }}
              style={{
                border: `1px solid ${selected ? token.colorPrimary : token.colorBorderSecondary}`,
                background: selected ? token.controlItemBgActive : token.colorFillQuaternary,
                borderRadius: token.borderRadiusLG,
                padding: 12,
                cursor: 'pointer',
                minWidth: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Text strong style={{ fontSize: 14 }}>
                  {p.name}
                </Text>
                {selected && <CheckCircleOutlined style={{ color: token.colorPrimary }} />}
              </div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                {p.summary}
              </Text>
              <div style={{ marginTop: 8 }}>
                <Tag style={{ marginInlineEnd: 4 }}>约 {estShots} 个镜头</Tag>
                <Tag>平均 {averageShotSec(targetDurationSec, estShots)} 秒</Tag>
              </div>
            </div>
          );
        })}
      </div>

      <Divider style={{ margin: '16px 0 12px' }} />

      <ParamRow label="目标总时长">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Slider
            min={DURATION_MIN_SEC}
            max={DURATION_MAX_SEC}
            step={5}
            value={targetDurationSec}
            onChange={onDurationChange}
            style={{ flex: 1, minWidth: 0 }}
          />
          <Text style={{ width: 88, textAlign: 'right' }}>
            {formatDuration(targetDurationSec * 1000)}
          </Text>
        </div>
      </ParamRow>

      <ParamRow label="镜头节奏">
        <Segmented
          value={pace}
          onChange={(v) => onPaceChange(v as Pace)}
          options={PACE_OPTIONS}
        />
      </ParamRow>

      <ParamRow label="建议镜头数">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <InputNumber
            min={1}
            max={400}
            value={shotCount}
            onChange={(v) => onShotCountChange(typeof v === 'number' && v > 0 ? v : 1)}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            改方案、时长或节奏会重新给一个建议值，之后可随意手改
          </Text>
        </div>
      </ParamRow>

      <ParamRow label="平均镜头长度">
        <Text strong>{avgShotSec} 秒</Text>
        <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
          由总时长与镜头数算出。单镜超过 8 秒时服务端会强制再拆
        </Text>
      </ParamRow>

      <ParamRow label="运镜强度">
        <Segmented
          value={camera}
          onChange={(v) => onCameraChange(v as CameraIntensity)}
          options={CAMERA_OPTIONS}
        />
      </ParamRow>

      <ParamRow label="拆镜取向">
        <Segmented
          value={priority}
          onChange={(v) => onPriorityChange(v as Priority)}
          options={[
            { value: 'dialogue', label: '对白优先' },
            { value: 'visual', label: '画面优先' },
          ]}
        />
      </ParamRow>

      <ParamRow label="自动补充">
        <Space size={16}>
          <Space size={6}>
            <Switch
              size="small"
              checked={autoEstablishing}
              onChange={onAutoEstablishingChange}
            />
            <Text style={{ fontSize: 13 }}>空镜</Text>
          </Space>
          <Space size={6}>
            <Switch size="small" checked={autoReaction} onChange={onAutoReactionChange} />
            <Text style={{ fontSize: 13 }}>反应镜头</Text>
          </Space>
        </Space>
      </ParamRow>

      <Divider style={{ margin: '12px 0' }} />

      {/* 把最终发给模型的那段话原样摆出来：参数怎么影响结果，用户看得见才敢调 */}
      <Text type="secondary" style={{ fontSize: 12 }}>
        将随剧本一并发给分镜模型的导演说明
      </Text>
      <Paragraph
        style={{
          marginTop: 6,
          marginBottom: 0,
          padding: '8px 10px',
          background: token.colorFillQuaternary,
          borderRadius: token.borderRadius,
          fontSize: 12,
          lineHeight: 1.8,
        }}
      >
        {directive}
      </Paragraph>
    </div>
  );
}

function ParamRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
      <Text type="secondary" style={{ fontSize: 13, width: 88, flexShrink: 0 }}>
        {label}
      </Text>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** ---------- 第三步：视觉确认 ---------- */

function VisualCheckStep({
  projectId,
  parsed,
  characters,
  scenes,
  props,
  designHref,
  aspectRatio,
  onAspectRatioChange,
  directive,
}: {
  projectId: string;
  parsed: ParsedScript;
  characters: ScriptElement[];
  scenes: ScriptElement[];
  props: ScriptElement[];
  designHref: string;
  aspectRatio: string;
  onAspectRatioChange: (v: string) => void;
  directive: string;
}) {
  const { token } = theme.useToken();
  const tagsQuery = useProjectTags(projectId);
  const tags = tagsQuery.data ?? [];

  /* 色彩风格：就地编辑项目 stylePrompt，省得为了改一句画风退出向导 */
  const projectQuery = useProject(projectId !== '' ? projectId : undefined);
  // 服务端契约已含 stylePrompt，本地 Project 类型未声明 → 交叉断言读取（与设计页同一写法）
  const savedStylePrompt =
    (projectQuery.data as (Project & { stylePrompt?: string }) | undefined)?.stylePrompt ?? '';
  const updateProject = useUpdateProject();
  const [styleDraft, setStyleDraft] = useState<string | null>(null);
  const styleValue = styleDraft ?? savedStylePrompt;
  const styleDirty = styleDraft !== null && styleDraft.trim() !== savedStylePrompt;

  const saveStyle = () => {
    if (styleDraft === null) return;
    updateProject.mutate(
      {
        id: projectId,
        data: { stylePrompt: styleDraft.trim() } as UpdateProjectInput & { stylePrompt: string },
      },
      {
        onSuccess: () => {
          message.success('画风已保存，本次生成即刻生效');
          setStyleDraft(null);
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  /** 缺时间的场景：时间与光线直接决定生图的色温，缺了模型只能瞎猜 */
  const scenesWithoutTime = parsed.scenes.filter(
    (s) => s.lines.length > 0 && s.lines[0].kind === 'heading' && s.timeOfDay === '',
  );

  return (
    <div>
      <SectionTitle
        title="角色参考图与服装"
        hint="缺图的角色在每个镜头里都会重新长一次脸"
      />
      <ElementGrid items={characters} tags={tags} designHref={designHref} kindLabel="角色" />

      <SectionTitle title="场景参考图" hint="同一地点复用同一张图，前后镜头才对得上" />
      <ElementGrid items={scenes} tags={tags} designHref={designHref} kindLabel="场景" />

      <SectionTitle title="关键道具" hint="反复出镜、承担剧情的道具建议先定稿" />
      <ElementGrid items={props} tags={tags} designHref={designHref} kindLabel="道具" />

      <Divider style={{ margin: '16px 0 12px' }} />

      <ParamRow label="色彩风格">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <Input.TextArea
            value={styleValue}
            maxLength={500}
            autoSize={{ minRows: 1, maxRows: 4 }}
            placeholder="描述整部作品的统一画风，如：日系动漫风格，清新明快……（留空 = 不附加画风）"
            onChange={(e) => setStyleDraft(e.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <Button
            size="small"
            disabled={!styleDirty}
            loading={updateProject.isPending}
            onClick={saveStyle}
          >
            保存
          </Button>
        </div>
      </ParamRow>

      <ParamRow label="画面比例">
        <div style={{ minWidth: 0 }}>
          <Segmented
            value={aspectRatio}
            onChange={(v) => {
              const next = String(v);
              onAspectRatioChange(next);
              // 落到项目上：这是"这一部片子是横是竖"的唯一真相。
              // 只写进 directive 的话，模型知道了、生图尺寸却还是竖屏，选了等于没选。
              updateProject.mutate(
                {
                  id: projectId,
                  data: { aspectRatio: next } as UpdateProjectInput & { aspectRatio: string },
                },
                { onError: (e) => message.error(e.message) },
              );
            }}
            options={RATIO_OPTIONS}
          />
          <div style={{ marginTop: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              保存为项目画幅，关键图与成片都按它生成
            </Text>
          </div>
        </div>
      </ParamRow>

      <ParamRow label="时间与光线">
        <div style={{ minWidth: 0 }}>
          <Space size={[4, 4]} wrap>
            {parsed.scenes
              .filter((s) => s.lines.length > 0 && s.lines[0].kind === 'heading')
              .map((s) => (
                <Tag
                  key={s.index}
                  color={s.timeOfDay === '' ? 'warning' : undefined}
                  style={{ marginInlineEnd: 0 }}
                >
                  {`S${String(s.index + 1).padStart(2, '0')} ${
                    s.timeOfDay === '' ? '未标时间' : s.timeOfDay
                  }`}
                </Tag>
              ))}
          </Space>
          {scenesWithoutTime.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <Text type="warning" style={{ fontSize: 12 }}>
                <ExclamationCircleOutlined /> {scenesWithoutTime.length} 场没写时间，光线由模型自行决定
              </Text>
            </div>
          )}
        </div>
      </ParamRow>

      <Divider style={{ margin: '12px 0' }} />

      <Text type="secondary" style={{ fontSize: 12 }}>
        导演说明
      </Text>
      <Paragraph
        style={{
          marginTop: 6,
          marginBottom: 0,
          padding: '8px 10px',
          background: token.colorFillQuaternary,
          borderRadius: token.borderRadius,
          fontSize: 12,
          lineHeight: 1.8,
        }}
      >
        {directive}
      </Paragraph>
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
      <Text strong style={{ fontSize: 13 }}>
        {title}
      </Text>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {hint}
      </Text>
    </div>
  );
}

function ElementGrid({
  items,
  tags,
  designHref,
  kindLabel,
}: {
  items: ScriptElement[];
  tags: { id: string; canonicalAssetId: string | null }[];
  designHref: string;
  kindLabel: string;
}) {
  const { token } = theme.useToken();

  if (items.length === 0) {
    return (
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
        剧本里没有识别到{kindLabel}。
      </Text>
    );
  }

  const missing = items.filter((e) => !e.hasReference);

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {items.map((e) => (
          <ElementCard key={`${e.type}:${e.name}`} element={e} tags={tags} />
        ))}
      </div>
      {missing.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {missing.length} 个{kindLabel}还没有参考图。
          </Text>
          <Link to={designHref}>
            <Button type="link" size="small" style={{ paddingInline: 4 }}>
              去设计页补图
            </Button>
          </Link>
        </div>
      )}
      <div style={{ height: 0, borderBottom: `0px solid ${token.colorBorderSecondary}` }} />
    </div>
  );
}

/**
 * 单个要素卡：缩略图 + 名字 + 服装/描述。
 *
 * 【为什么按要素拆成子组件】TagEntity 只带 canonicalAssetId（一个 id），
 * uri 在 /tags/:id/designs 里。hooks 不能在循环里条件调用，
 * 所以把"取某个标签的候选图"下沉成组件，每个要素各自查一次；
 * TanStack Query 会按 ['designs', tagId] 复用缓存，同一标签只发一次请求。
 */
function ElementCard({
  element,
  tags,
}: {
  element: ScriptElement;
  tags: { id: string; canonicalAssetId: string | null }[];
}) {
  const { token } = theme.useToken();
  const tag = tags.find((t) => t.id === element.tagId) ?? null;
  const enabled = tag !== null && tag.canonicalAssetId !== null;
  const designsQuery = useTagDesigns(enabled ? tag.id : null);

  const asset = useMemo(() => {
    if (!enabled || !designsQuery.data || tag === null) return null;
    const hit = designsQuery.data.designs.find((d) => d.assetId === tag.canonicalAssetId);
    return hit?.asset ?? null;
  }, [enabled, designsQuery.data, tag]);

  return (
    <div style={{ width: 84 }}>
      <div
        style={{
          width: 84,
          height: 108,
          borderRadius: token.borderRadius,
          border: `1px solid ${element.hasReference ? token.colorBorderSecondary : token.colorWarningBorder}`,
          background: token.colorFillQuaternary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          textAlign: 'center',
          padding: 4,
        }}
      >
        {asset ? (
          <img
            src={asset.thumbUri ?? asset.uri}
            alt={element.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Text type="warning" style={{ fontSize: 11, lineHeight: 1.5 }}>
            {element.tagId === null ? '将新建·无图' : '缺参考图'}
          </Text>
        )}
      </div>
      <div style={{ marginTop: 4, textAlign: 'center' }}>
        <Text style={{ fontSize: 12, display: 'block' }} ellipsis={{ tooltip: element.name }}>
          {element.name}
        </Text>
        <Tooltip title={element.description === '' ? '标签还没有描述，可在设计页补充服装、材质等信息' : element.description}>
          <Text
            type="secondary"
            style={{ fontSize: 11, display: 'block' }}
            ellipsis
          >
            {element.description === '' ? '无描述' : element.description}
          </Text>
        </Tooltip>
      </div>
    </div>
  );
}
