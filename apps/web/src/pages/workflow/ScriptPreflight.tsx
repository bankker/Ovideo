import { useMemo } from 'react';
import { Alert, Button, Empty, Modal, Popconfirm, Space, Tag, Typography, theme } from 'antd';
import { CheckCircleOutlined } from '@ant-design/icons';
import { useProjectTags } from '../../api/design-hooks';
// 时长展示口径复用解析器导出的那一份，免得体检弹窗和工具栏显示不一致
import { formatDuration, type ParsedScene, type ParsedScript } from '../../utils/script-parse';

const { Text } = Typography;

export interface ScriptPreflightProps {
  open: boolean;
  /** 取项目标签（人物 / 场景 / 道具）用 */
  projectId: string;
  /** 解析结果；统计与检查全部基于它，不在这里重新解析正文 */
  parsed: ParsedScript;
  onCancel: () => void;
  /** 用户决定继续：由页面去发起分镜规划 */
  onConfirm: () => void;
  /**
   * 'plan'（默认）＝ 从「开始分镜规划」进来，底部给「继续分镜规划」；
   * 'check' ＝ 从「剧本体检」进来，只读，不提供继续。
   */
  mode?: 'check' | 'plan';
}

/** ---------- 判定口径 ---------- */

/** 中文口播约每秒 4 字 → 每字 250ms，与解析器的场景时长口径同源 */
const MS_PER_CHAR = 250;
/** 动作行超过这个数就提示拆场：一场戏塞太多动作，分镜会把它压进有限的镜头里 */
const MAX_ACTION_LINES = 8;
/** 服务端约定：每场 2-5 个镜头，与 clamp(round(时长/4000), 1, 5) 的上界一致 */
const MAX_SHOTS_PER_SCENE = 5;

type Severity = 'error' | 'warning' | 'info';

interface PreflightIssue {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * 该场的纯对白时长（不含动作行），用于判断"对白把这一场撑爆了"。
 * 字数用 trim 后的长度，与 estimateSceneDurationMs 里的算法逐字一致——
 * 两边口径一旦分家，这条检查就会对着自己的幻觉报警。
 */
function dialogueMsOf(scene: ParsedScene): number {
  let chars = 0;
  for (const l of scene.lines) {
    if (l.kind === 'dialogue' || l.kind === 'narration') chars += (l.text ?? '').trim().length;
  }
  return chars * MS_PER_CHAR;
}

function actionLineCountOf(scene: ParsedScene): number {
  return scene.lines.filter((l) => l.kind === 'action').length;
}

/** 有标题行 = 正经场景；没有 = 首个场景抬头之前那段散文，若干检查对它不适用 */
function hasHeading(scene: ParsedScene): boolean {
  return scene.lines.length > 0 && scene.lines[0].kind === 'heading';
}

/** 场景在清单里的称呼：有标题就带上，没有就只说场次，绝不编造标题 */
function sceneRef(scene: ParsedScene): string {
  const n = scene.index + 1;
  return scene.title !== '' ? `第 ${n} 场『${scene.title}』` : `第 ${n} 场`;
}

/**
 * 角色名归一：剥掉中文里最常见的一层称呼修饰，得到"核心名"。
 * 「老张」「张工」都归到「张」，从而能发现同一个人被换着叫。
 * 【为什么只剥这一层】再往下猜就会把「老板」「工头」这类正经词也拆开，
 * 混用提示一旦乱报，用户就再也不看这份清单了——宁可少报不可乱报。
 */
const NAME_PREFIX = /^[老小大阿]/;
const NAME_SUFFIX = /(老师|医生|经理|队长|工|哥|姐|总|叔|姨|婶)$/;

function nameCore(name: string): string {
  const stripped = name.replace(NAME_SUFFIX, '');
  return (stripped === '' ? name : stripped).replace(NAME_PREFIX, '');
}

/** 疑似混用的角色名分组；只收 2 字及以上的名字，单字名剥完就没了，判不准 */
function findNameMixups(names: string[]): string[][] {
  const candidates = names.filter((n) => n.length >= 2);
  const byCore = new Map<string, string[]>();
  for (const n of candidates) {
    const core = nameCore(n);
    if (core === '') continue;
    const list = byCore.get(core);
    if (list) list.push(n);
    else byCore.set(core, [n]);
  }

  const groups: string[][] = [];
  const seen = new Set<string>();
  const push = (g: string[]) => {
    const key = [...g].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    groups.push(g);
  };

  for (const list of byCore.values()) {
    if (list.length >= 2) push(list);
  }
  // 另一种混用形态：一个名字整个包含另一个（「张经理」与「张经理助理」不算，长度差太大的略过）
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      if (a === b) continue;
      if (Math.abs(a.length - b.length) > 1) continue;
      if (a.includes(b) || b.includes(a)) push([a, b]);
    }
  }
  return groups;
}

/** ---------- 组件 ---------- */

export function ScriptPreflight({
  open,
  projectId,
  parsed,
  onCancel,
  onConfirm,
  mode = 'plan',
}: ScriptPreflightProps) {
  const { token } = theme.useToken();
  const tagsQuery = useProjectTags(projectId);
  const tags = useMemo(() => tagsQuery.data ?? [], [tagsQuery.data]);

  const fullText = useMemo(() => parsed.scenes.map((s) => s.text).join('\n'), [parsed.scenes]);

  /** 剧本里出现过的角色（去重保序，不含旁白——解析器已剔除） */
  const scriptCharacters = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of parsed.scenes) {
      for (const c of s.characters) {
        if (!seen.has(c)) {
          seen.add(c);
          out.push(c);
        }
      }
    }
    return out;
  }, [parsed.scenes]);

  const characterTags = useMemo(() => tags.filter((t) => t.type === 'CHARACTER'), [tags]);
  const sceneTags = useMemo(() => tags.filter((t) => t.type === 'SCENE'), [tags]);

  /** 剧本正文里出现过的道具标签；朴素 includes，与场景检查器同一口径 */
  const propTagsInScript = useMemo(
    () => tags.filter((t) => t.type === 'PROP' && t.name !== '' && fullText.includes(t.name)),
    [tags, fullText],
  );

  /** 已识别场景：解析出标题的场景（无标题的散文块不算） */
  const namedScenes = useMemo(
    () => parsed.scenes.filter((s) => hasHeading(s) && s.title !== ''),
    [parsed.scenes],
  );

  const dialogueMsTotal = useMemo(
    () => parsed.scenes.reduce((sum, s) => sum + dialogueMsOf(s), 0),
    [parsed.scenes],
  );

  /** ---------- 问题清单 ---------- */
  const issues = useMemo((): PreflightIssue[] => {
    const list: PreflightIssue[] = [];
    const tagNames = new Set(characterTags.map((t) => t.name));

    // 1) 对白已经撑满甚至超过这一场的预算：镜头时长会被挤爆（严重）
    for (const s of parsed.scenes) {
      const dMs = dialogueMsOf(s);
      if (dMs > s.estimatedDurationMs) {
        list.push({
          key: `overflow-${s.index}`,
          severity: 'error',
          title: `${sceneRef(s)}的对白超出这一场的时长预算`,
          detail: `光对白就要 ${formatDuration(dMs)}，而这一场按上限只有 ${formatDuration(
            s.estimatedDurationMs,
          )}（单场最多 30 秒）。分镜会把台词硬塞进 ${s.estimatedShotCount} 个镜头里，语速会明显偏快。建议把这一场拆开，或删减台词。`,
        });
      }
    }

    // 2) 剧本用到的角色没有参考图：形象会在每个镜头里漂（严重）
    const noRef = characterTags.filter(
      (t) => scriptCharacters.includes(t.name) && t.canonicalAssetId === null,
    );
    if (noRef.length > 0) {
      list.push({
        key: 'character-no-reference',
        severity: 'error',
        title: `${noRef.length} 个角色还没有参考图`,
        detail: `${noRef
          .map((t) => t.name)
          .join('、')}。没有默认参考图，每个镜头都会各画各的，同一个人前后长得不一样。先去「设计」阶段给他们定一张形象图。`,
      });
    }

    // 3) 剧本里有、项目标签里没有：三步生成会补建，属提醒
    const missingTags = scriptCharacters.filter((n) => !tagNames.has(n));
    if (missingTags.length > 0) {
      list.push({
        key: 'character-missing-tag',
        severity: 'warning',
        title: `${missingTags.length} 个角色还没有建标签`,
        detail: `${missingTags.join(
          '、',
        )}。开始分镜规划时会自动创建这些角色标签，但它们一开始没有形象图，需要你随后去「设计」阶段补上。`,
      });
    }

    // 4) 缺地点或时间：分镜取不准景
    const lackInfo = parsed.scenes.filter(
      (s) => hasHeading(s) && (s.location === '' || s.timeOfDay === ''),
    );
    if (lackInfo.length > 0) {
      list.push({
        key: 'scene-missing-info',
        severity: 'warning',
        title: `${lackInfo.length} 个场景缺少地点或时间`,
        detail: `${lackInfo
          .map((s) => {
            const miss = [s.location === '' ? '地点' : '', s.timeOfDay === '' ? '时间' : '']
              .filter((x) => x !== '')
              .join('与');
            return `${sceneRef(s)}（缺${miss}）`;
          })
          .join('、')}。把标题写成「场景二：客户会议室，白天。」这样的形式即可被识别，分镜才能正确取景。`,
      });
    }

    // 5) 动作行过多：一场戏最多 5 个镜头，装不下这么多动作
    const heavy = parsed.scenes.filter((s) => actionLineCountOf(s) > MAX_ACTION_LINES);
    if (heavy.length > 0) {
      list.push({
        key: 'too-many-actions',
        severity: 'warning',
        title: `${heavy.length} 个场景的动作描写过多`,
        detail: `${heavy
          .map((s) => `${sceneRef(s)}（${actionLineCountOf(s)} 行动作）`)
          .join(
            '、',
          )}。一场戏最多拆 ${MAX_SHOTS_PER_SCENE} 个镜头，动作超过 ${MAX_ACTION_LINES} 行通常意味着它其实是好几场戏，建议按地点或时间切开。`,
      });
    }

    // 6) 角色名疑似混用
    const mixups = findNameMixups(scriptCharacters);
    if (mixups.length > 0) {
      list.push({
        key: 'name-mixup',
        severity: 'warning',
        title: '有几组角色名疑似指同一个人',
        detail: `${mixups
          .map((g) => g.join(' / '))
          .join(
            '；',
          )}。如果是同一个人，请在剧本里统一成一个名字——不统一会被当成不同角色，各自生成一套形象。如果本来就是不同的人，忽略这条。`,
      });
    }

    // 7) 项目里有、剧本里没提到：可能是上一版剧本留下的
    const unusedTags = characterTags.filter((t) => !scriptCharacters.includes(t.name));
    if (unusedTags.length > 0) {
      list.push({
        key: 'tag-not-in-script',
        severity: 'info',
        title: `${unusedTags.length} 个角色标签在本篇里没出现`,
        detail: `${unusedTags
          .map((t) => t.name)
          .join('、')}。可能是别的分集用的，或者上一版剧本留下的，不影响这次分镜。`,
      });
    }

    // 8) 开头有一段不属于任何场景的内容
    const prologue = parsed.scenes.find((s) => !hasHeading(s) && s.text.trim() !== '');
    if (prologue) {
      list.push({
        key: 'prologue',
        severity: 'info',
        title: '开头有一段内容不在任何场景里',
        detail:
          '第一个「场景」标题之前的文字没有归属场景。它不会丢，但也不会被单独取景。如果那是正片内容，给它补一个场景标题。',
      });
    }

    return list.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }, [parsed.scenes, scriptCharacters, characterTags]);

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const hasSevere = errorCount > 0;

  // 「剧本体检」按钮进来的是只读体检：用户此刻想知道的是"我的剧本有什么问题"，
  // 在这条路径上摆一个「继续分镜规划」等于把两个意图混成一个按钮
  const continueButton = mode === 'check' ? null : hasSevere ? (
    // 有严重问题不拦死（用户可能有意为之），但要让他多按一下、知道自己在跳过什么
    <Popconfirm
      title="确定跳过这些问题？"
      description={`还有 ${errorCount} 个严重问题没处理，分镜结果可能需要返工。`}
      okText="仍要继续"
      cancelText="回去修改"
      onConfirm={onConfirm}
    >
      <Button type="primary" danger>
        仍要继续
      </Button>
    </Popconfirm>
  ) : (
    <Button type="primary" onClick={onConfirm}>
      继续分镜规划
    </Button>
  );

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      title="剧本体检"
      width={720}
      footer={
        <Space>
          <Button onClick={onCancel}>{mode === 'check' ? '关闭' : '取消'}</Button>
          {continueButton}
        </Space>
      }
    >
      {/* ---------- 统计 ---------- */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 8,
          marginBottom: 16,
        }}
      >
        <StatCard label="场景数量" value={`${parsed.scenes.length} 场`} />
        <StatCard label="预计对白时长" value={formatDuration(dialogueMsTotal)} />
        <StatCard label="预计总时长" value={formatDuration(parsed.totalDurationMs)} />
        <StatCard label="建议镜头数量" value={`${parsed.totalShotCount} 个`} />
        <StatCard
          label="已识别人物"
          value={`${scriptCharacters.length} 个`}
          hint={
            scriptCharacters.length === 0
              ? '剧本里没有对白'
              : `项目标签 ${characterTags.length} 个`
          }
        />
        <StatCard
          label="已识别场景"
          value={`${namedScenes.length} 个`}
          hint={`项目标签 ${sceneTags.length} 个`}
        />
        <StatCard
          label="已识别道具"
          value={`${propTagsInScript.length} 个`}
          hint={
            propTagsInScript.length === 0
              ? '正文里没提到已建标签的道具'
              : propTagsInScript.map((t) => t.name).join('、')
          }
        />
      </div>

      {/* ---------- 问题清单 ---------- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Text strong style={{ fontSize: 13 }}>
          问题清单
        </Text>
        {issues.length > 0 && (
          <Tag style={{ marginInlineEnd: 0 }}>
            {errorCount > 0 ? `${errorCount} 个严重 · ` : ''}
            共 {issues.length} 条
          </Tag>
        )}
      </div>

      <div style={{ maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
        {issues.length === 0 ? (
          <Empty
            image={<CheckCircleOutlined style={{ fontSize: 40, color: token.colorSuccess }} />}
            description={
              <Text type="secondary" style={{ fontSize: 13 }}>
                没有发现问题，可以开始分镜规划
              </Text>
            }
            style={{ padding: '16px 0' }}
          />
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {issues.map((i) => (
              <Alert
                key={i.key}
                type={i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'info'}
                showIcon
                message={<Text style={{ fontSize: 13 }}>{i.title}</Text>}
                description={
                  <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.8 }}>
                    {i.detail}
                  </Text>
                }
              />
            ))}
          </Space>
        )}
      </div>
    </Modal>
  );
}

/** 统计格：一个数字 + 一行说明；hint 用来放"和项目标签比对"的结果 */
function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadius,
        padding: '8px 10px',
        background: token.colorFillQuaternary,
        minWidth: 0,
      }}
    >
      <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
        {label}
      </Text>
      <Text strong style={{ fontSize: 16, display: 'block', lineHeight: 1.6 }}>
        {value}
      </Text>
      {hint !== undefined && (
        <Text
          type="secondary"
          style={{ fontSize: 11, display: 'block' }}
          ellipsis={{ tooltip: hint }}
        >
          {hint}
        </Text>
      )}
    </div>
  );
}
