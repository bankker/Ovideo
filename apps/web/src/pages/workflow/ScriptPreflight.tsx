// 剧本体检：分镜规划向导的第一步内容。
//
// 【为什么从弹窗降级成内容组件】体检以前是独立弹窗，现在它是三步向导的第一步。
// 把 Modal 外壳留在 StoryboardPlanningWizard 里，这里只负责"这份剧本有什么问题"，
// 于是同一份检查既能出现在只读体检里，也能出现在规划流程里，判定逻辑只有一份。

import { useMemo } from 'react';
import { Alert, Button, Empty, Space, Tag, Typography, theme } from 'antd';
import { CheckCircleOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useProjectTags } from '../../api/design-hooks';
// 时长展示口径复用解析器导出的那一份，免得体检弹窗和工具栏显示不一致
import { formatDuration, type ParsedScene, type ParsedScript } from '../../utils/script-parse';
import {
  collectScriptElements,
  detectImpliedScenes,
  type ScriptElements,
} from '../../utils/script-elements';

const { Text } = Typography;

/** ---------- 判定口径 ---------- */

/** 中文口播约每秒 4 字 → 每字 250ms，与解析器的场景时长口径同源 */
const MS_PER_CHAR = 250;
/** 动作行超过这个数就提示拆场：一场戏塞太多动作，分镜会把它压进有限的镜头里 */
const MAX_ACTION_LINES = 8;
/** 服务端约定：每场 2-5 个镜头，与 clamp(round(时长/4000), 1, 5) 的上界一致 */
const MAX_SHOTS_PER_SCENE = 5;

type Severity = 'error' | 'warning' | 'info';

export interface PreflightIssue {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  /** 'design' = 附一个"去设计页"的链接；'annotate' = 提示去工具栏做 @ 标注 */
  action?: 'design' | 'annotate';
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** 清单里最多点名几个要素，超出用「等 N 个」收尾——一屏放不下 30 个名字 */
const MAX_NAMED = 6;

function nameList(names: string[]): string {
  if (names.length <= MAX_NAMED) return names.join('、');
  return `${names.slice(0, MAX_NAMED).join('、')} 等 ${names.length} 个`;
}

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

/** ---------- 体检结果（向导要用 errorCount 决定"下一步"还是"仍要继续"） ---------- */

export interface PreflightResult {
  issues: PreflightIssue[];
  errorCount: number;
  /** 要素归集结果：第二、三步也要读它，所以由体检这一层统一算出来往下传 */
  elements: ScriptElements;
  /** 统计卡片用的派生数据 */
  stats: {
    sceneCount: number;
    dialogueMsTotal: number;
    totalDurationMs: number;
    totalShotCount: number;
    scriptCharacters: string[];
    characterTagCount: number;
  };
}

/**
 * 体检的全部计算。做成 hook 是因为向导的三步都要读同一份结果：
 * 第一步展示问题、第二步据总时长给默认值、第三步逐个要素确认。
 * 各步各算一遍必然会出现"第一步说缺 3 张图、第三步只列出 2 张"。
 */
export function usePreflight(projectId: string, parsed: ParsedScript): PreflightResult {
  const tagsQuery = useProjectTags(projectId);
  const tags = useMemo(() => tagsQuery.data ?? [], [tagsQuery.data]);

  const elements = useMemo(() => collectScriptElements(parsed, tags), [parsed, tags]);

  /**
   * 「标注要素」够得着的要素名：只有出现在动作/环境行里的才算。
   * 场景名通常只写在「场景N：」抬头里，而标注器按硬规则绝不碰抬头行与台词——
   * 若把它们也报成"未标注"，用户照提示去点按钮却是灰的（那时确实没什么可标了），
   * 两条文案互相打脸且这条提醒永远消不掉。
   */
  const annotatableNames = useMemo(() => {
    const actionText = parsed.scenes
      .flatMap((s) => s.lines)
      .filter((l) => l.kind === 'action')
      .map((l) => l.raw)
      .join('\n');
    return (name: string) => actionText.includes(name);
  }, [parsed]);

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

  const dialogueMsTotal = useMemo(
    () => parsed.scenes.reduce((sum, s) => sum + dialogueMsOf(s), 0),
    [parsed.scenes],
  );

  /**
   * 动作行里换了地方却没有场景抬头的那些地点。
   * 已知地点 = 抬头给出的地点 + 已归集的场景要素（含已建场景标签），
   * 两者都算"这地方已经在规划里了"，只有都不沾边的才值得提醒。
   */
  const impliedScenes = useMemo(() => {
    const known = new Set<string>();
    for (const s of parsed.scenes) {
      if (s.location !== '') known.add(s.location);
      if (s.title !== '') known.add(s.title);
    }
    for (const e of elements.scenes) known.add(e.name);
    return detectImpliedScenes(parsed, known);
  }, [parsed, elements.scenes]);

  const issues = useMemo((): PreflightIssue[] => {
    const list: PreflightIssue[] = [];

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
    const charNoRef = elements.characters.filter((e) => e.tagId !== null && !e.hasReference);
    if (charNoRef.length > 0) {
      list.push({
        key: 'character-no-reference',
        severity: 'error',
        title: `${charNoRef.length} 个角色还没有参考图`,
        detail: `${nameList(
          charNoRef.map((e) => e.name),
        )}。没有默认参考图，每个镜头都会各画各的，同一个人前后长得不一样。先去「设计」阶段给他们定一张形象图。`,
        action: 'design',
      });
    }

    // 3) 剧本里有、项目标签里没有：三步生成会补建，属提醒
    const newChars = elements.newElements.characters;
    if (newChars.length > 0) {
      list.push({
        key: 'character-missing-tag',
        severity: 'warning',
        title: `${newChars.length} 个角色还没有建标签`,
        detail: `${nameList(
          newChars.map((e) => e.name),
        )}。开始分镜规划时会自动创建这些角色标签，但它们一开始没有形象图，需要你随后去「设计」阶段补上。`,
        action: 'design',
      });
    }

    // 3b) 即将新建的场景（本阶段新增）：同一地点在不同镜头里会各画各的
    const newScenes = elements.newElements.scenes;
    if (newScenes.length > 0) {
      list.push({
        key: 'scene-will-be-created',
        severity: 'warning',
        title: `将新建 ${newScenes.length} 个场景标签`,
        detail: `${nameList(
          newScenes.map((e) => e.name),
        )}。它们还没有参考图，同一地点在不同镜头里可能长得不一样。建议先去「设计」阶段为主要场景生成参考图，再回来规划分镜。`,
        action: 'design',
      });
    }

    // 3c) 即将新建的道具（本阶段新增）：道具比场景宽容，降一级
    const newProps = elements.newElements.props;
    if (newProps.length > 0) {
      list.push({
        key: 'prop-will-be-created',
        severity: 'info',
        title: `将新建 ${newProps.length} 个道具标签`,
        detail: `${nameList(
          newProps.map((e) => e.name),
        )}。道具没有参考图时由模型自由发挥，关键道具（反复出镜、承担剧情的那几件）建议先在「设计」阶段定稿。`,
        action: 'design',
      });
    }

    // 3d) 已建标签但缺参考图的场景与道具（本阶段新增）：角色那条已在 #2 单列，这里不重复
    const placeNoRef = [...elements.scenes, ...elements.props].filter(
      (e) => e.tagId !== null && !e.hasReference,
    );
    if (placeNoRef.length > 0) {
      list.push({
        key: 'place-prop-no-reference',
        severity: 'warning',
        title: `${placeNoRef.length} 个场景或道具标签还没有参考图`,
        detail: `${nameList(
          placeNoRef.map((e) => e.name),
        )}。标签建好了但没定过图，生成时只能靠文字描述还原，前后镜头的同一地点容易对不上。`,
        action: 'design',
      });
    }

    // 3e) 动作行里换了地方，但没有对应的场景抬头（本阶段新增）
    if (impliedScenes.length > 0) {
      list.push({
        key: 'implied-scene',
        severity: 'warning',
        title: `${impliedScenes.length} 处动作行里出现了新的地点`,
        detail: `${impliedScenes
          .map((s) => `${sceneRef(parsed.scenes[s.sceneIndex])}的「${s.name}」（${s.evidence}）`)
          .join(
            '；',
          )}。这些地方没有自己的场景抬头，分镜只会按当前场的地点取景，换过去的那几个镜头由模型临场编。要么给它补一条「场景N：${impliedScenes[0].name}，……」抬头，要么确认这只是一句过场描写。`,
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
        detail: `${nameList(
          unusedTags.map((t) => t.name),
        )}。可能是别的分集用的，或者上一版剧本留下的，不影响这次分镜。`,
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

    // 9) 未标注 @ 的要素（本阶段新增）：标注是"这一场用哪几张参考图"的唯一抓手。
    //    只报「标注要素」真的能处理的那些，否则这条提醒永远消不掉。
    const annotatable = elements.unannotated.filter((e) => annotatableNames(e.name));
    if (annotatable.length > 0) {
      list.push({
        key: 'not-annotated',
        severity: 'info',
        title: `${annotatable.length} 个要素还没有在正文里标注 @`,
        detail: `${nameList(
          annotatable.map((e) => e.name),
        )}。不标注也能生成，但要素由模型临场推断；标注后可精确控制每一场用哪些参考图（@角色 与 @道具 会带上参考图，@场景 只锚定文字，@!场景 强制带图）。`,
        action: 'annotate',
      });
    }

    return list.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }, [parsed, scriptCharacters, characterTags, elements, annotatableNames, impliedScenes]);

  return {
    issues,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    elements,
    stats: {
      sceneCount: parsed.scenes.length,
      dialogueMsTotal,
      totalDurationMs: parsed.totalDurationMs,
      totalShotCount: parsed.totalShotCount,
      scriptCharacters,
      characterTagCount: characterTags.length,
    },
  };
}

/** ---------- 第一步内容 ---------- */

export function ScriptPreflightContent({
  result,
  designHref,
  annotatableCount = 0,
  onAnnotate,
  annotating = false,
}: {
  result: PreflightResult;
  /** 「去设计页」的目标路由；由向导按当前项目/分集拼好后传进来 */
  designHref: string;
  /** 就地标注能新增多少个 @；由向导算好传入，与工具栏用的是同一个纯函数 */
  annotatableCount?: number;
  /** 有它才把「未标注」那条做成能按的按钮；缺省时退回纯文字提示 */
  onAnnotate?: () => void;
  annotating?: boolean;
}) {
  const { token } = theme.useToken();
  const { issues, errorCount, elements, stats } = result;

  /** 「已有标签 N · 将新建 M」：把一个数字拆成两个，用户才知道哪些是要补的 */
  const tagSplit = (list: { tagId: string | null }[]) => {
    const existing = list.filter((e) => e.tagId !== null).length;
    return `已有标签 ${existing} · 将新建 ${list.length - existing}`;
  };

  return (
    <>
      {/* ---------- 统计 ---------- */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 8,
          marginBottom: 16,
        }}
      >
        <StatCard label="场景数量" value={`${stats.sceneCount} 场`} />
        <StatCard label="预计对白时长" value={formatDuration(stats.dialogueMsTotal)} />
        <StatCard label="预计总时长" value={formatDuration(stats.totalDurationMs)} />
        <StatCard label="建议镜头数量" value={`${stats.totalShotCount} 个`} />
        <StatCard
          label="已识别人物"
          value={`${stats.scriptCharacters.length} 个`}
          hint={
            stats.scriptCharacters.length === 0
              ? '剧本里没有对白'
              : tagSplit(elements.characters)
          }
        />
        <StatCard
          label="已识别场景"
          value={`${elements.scenes.length} 个`}
          hint={tagSplit(elements.scenes)}
        />
        <StatCard
          label="已识别道具"
          value={`${elements.props.length} 个`}
          hint={
            elements.props.length === 0 ? '正文里没识别到道具' : tagSplit(elements.props)
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
                type={
                  i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'info'
                }
                showIcon
                message={<Text style={{ fontSize: 13 }}>{i.title}</Text>}
                description={
                  <div>
                    <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.8 }}>
                      {i.detail}
                    </Text>
                    {i.action === 'design' && (
                      <div style={{ marginTop: 4 }}>
                        <Link to={designHref}>
                          <Button type="link" size="small" style={{ paddingInline: 0 }}>
                            去设计页补参考图
                          </Button>
                        </Link>
                      </div>
                    )}
                    {i.action === 'annotate' && (
                      <div style={{ marginTop: 4 }}>
                        {onAnnotate && annotatableCount > 0 ? (
                          <Button
                            type="link"
                            size="small"
                            style={{ paddingInline: 0 }}
                            loading={annotating}
                            onClick={onAnnotate}
                          >
                            就地标注这 {annotatableCount} 处（可撤销）
                          </Button>
                        ) : (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            标注入口在剧本工具栏的「标注要素」。
                          </Text>
                        )}
                      </div>
                    )}
                  </div>
                }
              />
            ))}
          </Space>
        )}
      </div>
    </>
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
