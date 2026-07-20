// 分镜工作台：脱离九阶段 tab 栏的独立全屏页面。
//
// 【为什么要独立一页】分镜是整条管线里唯一需要"通读全片"的环节——左手场景、
// 中间画面、右手镜头参数，三者得同时在视野里。挤在阶段页的内容区里做不到，
// 那里横向被 tab 栏和 padding 吃掉一大截，纵向还要和阶段切换器共存。
//
// 【它与旧分镜页的关系】旧页（StoryboardStage）保留不动：它是"逐镜头抽卡"的作业面，
// 抽卡、选版本、AI 收敛都在那边。工作台负责"编排"——顺序、场次归属、影视语义。
// 两条线共用同一份数据与同一套 apply-patch，谁都不是谁的替代品。

import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { App, Button, ConfigProvider, Empty, Segmented, Select, Space, Spin, Tooltip, Typography } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import type { ShotEditableFields, StoryboardPatch } from '@ovideo/shared';
import { useStoryboards, useApplyPatch, type ShotDetail } from '../../api/workflow-hooks';
import { useStoryboardDetail } from '../../api/produce-hooks';
import { useProject } from '../../api/hooks';
import { NEUTRAL_THEME, SURFACE, useNeutralSurface } from './workspace-surface';
import { SceneRail, type SceneRailScene } from './SceneRail';
import { StoryboardCanvas, type StoryboardCanvasGroup } from './StoryboardCanvas';
import type { ShotCardShot } from './ShotCard';
import { ShotInspector, type InspectorShot } from './ShotInspector';
import { ShotTable, type ShotTableEdit, type ShotTableRow } from './ShotTable';

const { Text } = Typography;

type ViewKey = 'canvas' | 'table';

/** 关键图状态：以选中的 KEYFRAME take 是否存在为准，stale 标志优先级最高 */
function shotStatus(
  shot: ShotDetail & { takes?: Array<{ id: string; slot: string }> },
): ShotCardShot['status'] {
  const hasKeyframe =
    shot.keyframeSelectedTakeId !== null &&
    (shot.takes ?? []).some((t) => t.id === shot.keyframeSelectedTakeId);
  if (shot.keyframeStale) return 'stale';
  return hasKeyframe ? 'ready' : 'none';
}

/**
 * 这一层只负责搭出 antd 的 App 上下文。
 * 【为什么非有不可】工作台的路由挂在 AppLayout 之外（它要独占全屏），
 * 而 <App> 是在 AppLayout 里提供的。缺了它，App.useApp() 返回的是空对象，
 * message.success 变成 undefined——保存明明成功了，却在弹提示那一步抛异常，
 * 于是 onSave 被判为 reject，检查器如实报"保存失败"。
 * 症状看起来像检查器有 bug，根子在这里少了一层 Provider。
 */
export function StoryboardWorkspace(): JSX.Element {
  return (
    <ConfigProvider theme={NEUTRAL_THEME}>
      <App>
        <WorkspaceInner />
      </App>
    </ConfigProvider>
  );
}

function WorkspaceInner(): JSX.Element {
  const { projectId = '', episodeId = '' } = useParams();
  const { message } = App.useApp();

  // 挂上中性表面：模板 CSS（野兽派的黑粗边/0 圆角）在 body.surface-neutral 下不匹配。
  // 光靠它还不够——AntD 的 token 走 ConfigProvider 而非 CSS，所以下面还要套一层 NEUTRAL_THEME。
  useNeutralSurface();

  const projectQuery = useProject(projectId !== '' ? projectId : undefined);
  const ratio = (projectQuery.data as { aspectRatio?: string } | undefined)?.aspectRatio ?? '9:16';

  const storyboardsQuery = useStoryboards(episodeId);
  const versions = useMemo(
    () => [...(storyboardsQuery.data ?? [])].sort((a, b) => b.version - a.version),
    [storyboardsQuery.data],
  );
  const [pickedId, setPickedId] = useState<string | null>(null);
  const storyboardId = pickedId ?? versions[0]?.id ?? null;

  const detailQuery = useStoryboardDetail(storyboardId);
  const detail = detailQuery.data;

  const applyPatch = useApplyPatch(episodeId);

  const [view, setView] = useState<ViewKey>('canvas');
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);

  /**
   * 选中项按 lineage 记，不按 id 记。
   * 【为什么】每保存一次就产出一个新版本，全部 Scene/Shot 都换新 cuid。
   * 用 id 记选中，改完一个字段检查器就空了、左栏也失去高亮——用户得重新点一遍卡片
   * 才能接着改下一个字段。lineageId 是跨版本不变的那一个，选中理应跟着它走。
   */
  const [selectedSceneKey, setSelectedSceneKey] = useState<string | null>(null);
  const [selectedShotKey, setSelectedShotKey] = useState<string | null>(null);

  const shots = useMemo(
    () => [...(detail?.shots ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [detail?.shots],
  );
  const scenes = useMemo(
    () => [...(detail?.scenes ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [detail?.scenes],
  );

  /** lineage 键 → 当前版本里的实体 id。版本一换，这两个映射就把选中项接过去 */
  const selectedSceneId = useMemo(
    () => scenes.find((s) => (s.lineageId ?? s.id) === selectedSceneKey)?.id ?? null,
    [scenes, selectedSceneKey],
  );
  const selectedShotId = useMemo(
    () => shots.find((s) => (s.lineageId ?? s.id) === selectedShotKey)?.id ?? null,
    [shots, selectedShotKey],
  );

  const selectSceneById = useCallback(
    (sceneId: string) => {
      const s = scenes.find((x) => x.id === sceneId);
      setSelectedSceneKey(s ? (s.lineageId ?? s.id) : null);
    },
    [scenes],
  );
  const selectShotById = useCallback(
    (shotId: string) => {
      const s = shots.find((x) => x.id === shotId);
      setSelectedShotKey(s ? (s.lineageId ?? s.id) : null);
    },
    [shots],
  );

  /** sceneId → 场次序号（1 起）与标题；镜头分组、检查器、表格三处都要它，算一次 */
  const sceneMeta = useMemo(() => {
    const map = new Map<string, { index: number; title: string }>();
    scenes.forEach((s, i) => {
      map.set(s.id, { index: i + 1, title: s.title !== '' ? s.title : s.location });
    });
    return map;
  }, [scenes]);

  /** 关键图 URL：选中的 KEYFRAME take 的资源地址，没有就是 null（卡片按画幅留占位） */
  const imageUrlOf = useCallback((shot: (typeof shots)[number]): string | null => {
    const take = (shot.takes ?? []).find(
      (t) => t.slot === 'KEYFRAME' && t.id === shot.keyframeSelectedTakeId,
    );
    return take?.asset.uri ?? null;
  }, []);

  const railScenes: SceneRailScene[] = useMemo(
    () =>
      scenes.map((s, i) => {
        const own = shots.filter((sh) => sh.sceneId === s.id);
        return {
          id: s.id,
          index: i + 1,
          title: s.title,
          location: s.location,
          shotCount: own.length,
          durationMs: own.reduce((sum, sh) => sum + (sh.durationLockedMs ?? sh.durationPlannedMs), 0),
          hasKeyframes: own.filter((sh) => shotStatus(sh) === 'ready').length,
        };
      }),
    [scenes, shots],
  );

  const groups: StoryboardCanvasGroup[] = useMemo(() => {
    const byScene = new Map<string, typeof shots>();
    const orphans: typeof shots = [];
    for (const sh of shots) {
      if (sh.sceneId === null || !sceneMeta.has(sh.sceneId)) orphans.push(sh);
      else {
        const list = byScene.get(sh.sceneId);
        if (list) list.push(sh);
        else byScene.set(sh.sceneId, [sh]);
      }
    }
    const toCard = (sh: (typeof shots)[number]) => ({
      id: sh.id,
      // 镜号是全片连续编号，不是组内序号——通读时用户说的"第 3 个镜头"是全片第 3 个
      index: shots.indexOf(sh) + 1,
      durationMs: sh.durationLockedMs ?? sh.durationPlannedMs,
      shotSize: sh.shotSize,
      imageUrl: imageUrlOf(sh),
      status: shotStatus(sh),
      // 锁定尚未建模到 Shot 上——先如实报 false，不要拿别的字段假装它存在
      locked: false,
    });
    const out: StoryboardCanvasGroup[] = scenes.map((s, i) => ({
      sceneId: s.id,
      sceneIndex: i + 1,
      sceneTitle: s.title !== '' ? s.title : s.location,
      shots: (byScene.get(s.id) ?? []).map(toCard),
    }));
    // 无场景归属的镜头收进末尾兜底分组：它们是对话改分镜等路径产生的，绝不能从画布上消失
    if (orphans.length > 0) {
      out.push({
        sceneId: null,
        sceneIndex: null,
        sceneTitle: '未归属场次',
        shots: orphans.map(toCard),
      });
    }
    return out;
  }, [scenes, shots, sceneMeta, imageUrlOf]);

  const tableRows: ShotTableRow[] = useMemo(
    () =>
      shots.map((sh, i) => {
        const meta = sh.sceneId !== null ? sceneMeta.get(sh.sceneId) : undefined;
        return {
          id: sh.id,
          index: i + 1,
          sceneIndex: meta?.index ?? 0,
          sceneTitle: meta?.title ?? '',
          thumbUrl: imageUrlOf(sh),
          durationMs: sh.durationLockedMs ?? sh.durationPlannedMs,
          shotSize: sh.shotSize,
          cameraAngle: sh.cameraAngle,
          cameraMovement: sh.cameraMovement,
          transition: sh.transition,
          composition: sh.composition,
          status: shotStatus(sh) === 'ready' ? 'READY' : 'PENDING',
        };
      }),
    [shots, sceneMeta, imageUrlOf],
  );

  const inspectorShot: InspectorShot | null = useMemo(() => {
    const sh = shots.find((s) => s.id === selectedShotId);
    if (!sh) return null;
    const meta = sh.sceneId !== null ? sceneMeta.get(sh.sceneId) : undefined;
    return {
      id: sh.id,
      // 跨版本身份：没有它，别处任何一次提交都会让检查器把用户的草稿当成"切换了镜头"丢掉
      lineageId: sh.lineageId ?? undefined,
      index: shots.indexOf(sh) + 1,
      sceneIndex: meta?.index ?? 0,
      durationPlannedMs: sh.durationPlannedMs,
      shotSize: sh.shotSize,
      cameraAngle: sh.cameraAngle,
      cameraMovement: sh.cameraMovement,
      composition: sh.composition,
      transition: sh.transition,
      sourceText: sh.sourceText,
      // 对白行只存 speakerTagId，说话人名字要另查标签；旁白是唯一能就地判定的
      dialogue: sh.dialogue.map((d) => ({ speaker: d.isNarrator ? '旁白' : '', text: d.text })),
      imagePrompt: sh.imagePrompt,
    };
  }, [shots, selectedShotId, sceneMeta]);

  /**
   * 所有写操作的唯一出口。
   * 【为什么要 await 到数据回流】三个子组件都靠"这个 Promise resolve 了"来清理本地草稿。
   * 若只等 mutation 返回就 resolve，组件会在新数据到达之前清空草稿，用户会看到值闪回旧的。
   * applyPatch 的 onSuccess 已经播种了新详情，这里再等一次 refetch 落定才算真的完成。
   */
  const commitPatch = useCallback(
    async (patch: StoryboardPatch, successText: string): Promise<void> => {
      if (storyboardId === null) throw new Error('还没有可编辑的分镜版本');
      const result = await applyPatch.mutateAsync({ storyboardId, patch, source: 'manual' });
      // 每次 patch 都产出新版本，页面要跟着切过去，否则后续编辑还打在旧版本上
      setPickedId(result.storyboard.id);
      message.success(successText);
    },
    [storyboardId, applyPatch, message],
  );

  const handleInspectorSave = useCallback(
    async (shotId: string, changes: ShotEditableFields): Promise<void> => {
      await commitPatch([{ op: 'update_shot', shotId, fields: changes }], '镜头已更新');
    },
    [commitPatch],
  );

  const handleTableCommit = useCallback(
    async (edits: ShotTableEdit[]): Promise<void> => {
      await commitPatch(
        edits.map((e) => ({ op: 'update_shot' as const, shotId: e.shotId, fields: e.fields })),
        `已保存 ${edits.length} 个镜头的改动`,
      );
    },
    [commitPatch],
  );

  const handleCommitOrder = useCallback(
    (nextShotIds: string[]): void => {
      // reorder 要求给全量新序，缺一个都会被服务端打回
      void commitPatch([{ op: 'reorder', shotIds: nextShotIds }], '镜头顺序已保存').catch(
        (e: unknown) => {
          message.error(e instanceof Error ? e.message : '排序保存失败');
        },
      );
    },
    [commitPatch, message],
  );

  const loading = storyboardsQuery.isPending || detailQuery.isPending;

  return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          background: SURFACE.bg,
          color: SURFACE.text,
        }}
      >
        {/* ---------- 顶栏 ---------- */}
        <div
          style={{
            flexShrink: 0,
            height: 52,
            display: 'flex',
            alignItems: 'center',
            gap: SURFACE.space.sm,
            paddingInline: SURFACE.space.sm,
            background: SURFACE.bgElevated,
            borderBlockEnd: `1px solid ${SURFACE.border}`,
          }}
        >
          <Link to={`/projects/${projectId}/episodes/${episodeId}/storyboard`}>
            <Button type="text" icon={<ArrowLeftOutlined />} size="small">
              返回分镜
            </Button>
          </Link>
          <Text strong>分镜工作台</Text>

          {versions.length > 0 && (
            <Select
              size="small"
              style={{ width: 120 }}
              value={storyboardId ?? undefined}
              onChange={(v) => {
                setPickedId(v);
                setSelectedShotKey(null);
              }}
              options={versions.map((v) => ({ value: v.id, label: `v${v.version}` }))}
            />
          )}

          <Segmented<ViewKey>
            size="small"
            value={view}
            onChange={setView}
            options={[
              { label: '故事板', value: 'canvas' },
              { label: '镜头表', value: 'table' },
            ]}
          />

          <div style={{ marginInlineStart: 'auto' }}>
            <Space size="small">
              <Tooltip title="画幅由项目决定，改它请去分镜规划向导">
                <Text type="secondary" style={{ fontSize: 12 }}>
                  画幅 {ratio}
                </Text>
              </Tooltip>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {shots.length} 个镜头 · {scenes.length} 场
              </Text>
            </Space>
          </div>
        </div>

        {/* ---------- 三栏 ---------- */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {loading ? (
            <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
              <Spin tip="正在载入分镜…" />
            </div>
          ) : storyboardId === null ? (
            <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
              <Empty
                description={
                  <Space direction="vertical" size={4}>
                    <Text>这一集还没有分镜</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      去剧本页点「开始分镜规划」，走完向导就会生成第一版
                    </Text>
                    <Link to={`/projects/${projectId}/episodes/${episodeId}/script`}>
                      <Button type="primary" size="small">
                        去剧本页
                      </Button>
                    </Link>
                  </Space>
                }
              />
            </div>
          ) : (
            <>
              <SceneRail
                scenes={railScenes}
                selectedSceneId={selectedSceneId}
                onSelect={selectSceneById}
              />

              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  overflowY: 'auto',
                  padding: SURFACE.space.sm,
                }}
              >
                {view === 'canvas' ? (
                  <StoryboardCanvas
                    versionKey={storyboardId}
                    groups={groups}
                    ratio={ratio}
                    selectedSceneId={selectedSceneId}
                    selectedShotId={selectedShotId}
                    onSelectShot={selectShotById}
                    onCommitOrder={handleCommitOrder}
                    committing={applyPatch.isPending}
                  />
                ) : (
                  <ShotTable
                    rows={tableRows}
                    selectedShotId={selectedShotId}
                    onSelectShot={selectShotById}
                    onCommit={handleTableCommit}
                    saving={applyPatch.isPending}
                  />
                )}
              </div>

              <ShotInspector
                shot={inspectorShot}
                collapsed={inspectorCollapsed}
                onToggleCollapsed={() => setInspectorCollapsed((v) => !v)}
                onSave={handleInspectorSave}
                saving={applyPatch.isPending}
              />
            </>
          )}
        </div>
      </div>
  );
}
