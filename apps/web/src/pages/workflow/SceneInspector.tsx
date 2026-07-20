import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Divider, Empty, Space, Tag, Tooltip, Typography, theme } from 'antd';
import { useProjectTags, useTagDesigns, type TagEntity } from '../../api/design-hooks';
// 时长与内外景的展示口径复用解析器导出的那一份，免得检查器和工具栏各写一套、显示不一致
import { formatDuration, formatInteriorExterior, type ParsedScene } from '../../utils/script-parse';

const { Text } = Typography;

/**
 * 场景检查器：只读地把「当前这一场需要什么素材、缺什么」摊开给用户看。
 *
 * 【为什么要 prevScene】连续性判断（同地点但时间跳跃）天然需要看上一场，
 * 而 ParsedScene 本身不持有兄弟节点的引用——与其让检查器反向依赖整个 ParsedScript，
 * 不如让调用方把"上一场"显式传进来：调用方本来就有 scenes 数组，取 scenes[i-1] 是 O(1)。
 * 传 null / 不传 = 当前是第一场（或调用方不关心连续性），此时不做连续性提示。
 */
export interface SceneInspectorProps {
  /** 取项目标签（人物 / 场景 / 道具）用；空串时 useProjectTags 自动禁用 */
  projectId: string;
  /** 拼「去设计页」的链接用 */
  episodeId: string;
  /** 当前选中的场景；null = 未选中，显示空态 */
  scene: ParsedScene | null;
  /** 上一场，用于连续性检查；见上方说明 */
  prevScene?: ParsedScene | null;
}

/** 小节标题：统一的次级灰字，避免每处各写一套样式 */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text type="secondary" style={{ fontSize: 12, fontWeight: 600 }}>
      {children}
    </Text>
  );
}

/** 「未标注」占位：缺失项不能显示空白，否则用户分不清"没写"和"没解析出来" */
function NotMarked() {
  const { token } = theme.useToken();
  return (
    <Text style={{ fontSize: 12, color: token.colorTextQuaternary }}>未标注</Text>
  );
}

export function SceneInspector({ projectId, episodeId, scene, prevScene }: SceneInspectorProps) {
  const { token } = theme.useToken();
  const tagsQuery = useProjectTags(projectId);
  const tags = useMemo(() => tagsQuery.data ?? [], [tagsQuery.data]);

  /** 人物标签按名字索引：剧本里的角色名与标签名是同一套命名，直接等值匹配 */
  const characterTagByName = useMemo(() => {
    const m = new Map<string, TagEntity>();
    for (const t of tags) if (t.type === 'CHARACTER') m.set(t.name, t);
    return m;
  }, [tags]);

  /**
   * 本场出现的道具：项目里的 PROP 标签，名字在场景原文里出现过就算。
   * 【为什么用朴素的 includes】道具名多是具体名词（"工牌"「白板」），
   * 中文没有词边界，任何分词都得引依赖；宁可漏报也不引一套不受控的匹配规则。
   */
  const propTags = useMemo(() => {
    if (!scene) return [];
    return tags.filter((t) => t.type === 'PROP' && t.name !== '' && scene.text.includes(t.name));
  }, [tags, scene]);

  /**
   * 连续性：与上一场同地点但时间不同 → 时间跳跃。
   * 两边都必须有值才判断——地点或时间任一为空时说明"没标注"，那是另一条提示该管的事，
   * 拿空串去比会把所有未标注场景都报成跳跃。
   */
  const timeJump = useMemo(() => {
    if (!scene || !prevScene) return false;
    if (scene.location === '' || prevScene.location === '') return false;
    if (scene.timeOfDay === '' || prevScene.timeOfDay === '') return false;
    return scene.location === prevScene.location && scene.timeOfDay !== prevScene.timeOfDay;
  }, [scene, prevScene]);

  if (!scene) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Text type="secondary" style={{ fontSize: 12 }}>
            在左侧选择一个场景查看详情
          </Text>
        }
        style={{ marginTop: 64 }}
      />
    );
  }

  const missingLocation = scene.location === '';
  const missingTime = scene.timeOfDay === '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
      {/* ---------- 场景 ---------- */}
      <SectionTitle>场景</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
        <Row label="标题">
          {scene.title !== '' ? <Text style={{ fontSize: 13 }}>{scene.title}</Text> : <NotMarked />}
        </Row>
        <Row label="内外景">
          {formatInteriorExterior(scene.interiorExterior) !== '' ? (
            <Tag style={{ marginInlineEnd: 0 }}>
              {formatInteriorExterior(scene.interiorExterior)}
            </Tag>
          ) : (
            <NotMarked />
          )}
        </Row>
        <Row label="地点">
          {!missingLocation ? (
            <Text style={{ fontSize: 13 }}>{scene.location}</Text>
          ) : (
            <NotMarked />
          )}
        </Row>
        <Row label="时间">
          {!missingTime ? <Text style={{ fontSize: 13 }}>{scene.timeOfDay}</Text> : <NotMarked />}
        </Row>
      </div>

      {(missingLocation || missingTime) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message={
            <Text style={{ fontSize: 12 }}>补上地点与时间，分镜才能正确取景</Text>
          }
          description={
            <Text type="secondary" style={{ fontSize: 12 }}>
              把场景标题写成「场景二：客户会议室，白天。」这样的形式即可被识别。
            </Text>
          }
        />
      )}

      {timeJump && (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 8 }}
          message={<Text style={{ fontSize: 12 }}>与上一场同地点但时间跳跃</Text>}
          description={
            <Text type="secondary" style={{ fontSize: 12 }}>
              {`${prevScene?.timeOfDay ?? ''} → ${scene.timeOfDay}，同一地点「${scene.location}」。光线与氛围会明显变化，确认这是有意为之。`}
            </Text>
          }
        />
      )}

      <Divider style={{ margin: '12px 0' }} />

      {/* ---------- 人物 ---------- */}
      <SectionTitle>人物</SectionTitle>
      <div style={{ marginTop: 6 }}>
        {scene.characters.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            本场没有对白角色
          </Text>
        ) : (
          <Space size={[4, 6]} wrap>
            {scene.characters.map((name) => {
              const tag = characterTagByName.get(name);
              // 剧本里出现但项目标签里没有：三步生成会补建，所以是提示而非错误
              if (!tag) {
                return (
                  <Tooltip key={name} title="三步生成时会自动创建该角色标签">
                    <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                      {name}
                      <Text style={{ fontSize: 11, marginInlineStart: 4, opacity: 0.75 }}>
                        未建标签
                      </Text>
                    </Tag>
                  </Tooltip>
                );
              }
              const hasDesign = tag.canonicalAssetId !== null;
              return (
                <Tooltip key={name} title={hasDesign ? '已有形象设计' : '尚无形象设计'}>
                  <Tag style={{ marginInlineEnd: 0 }}>
                    {hasDesign && (
                      <span
                        style={{
                          display: 'inline-block',
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: token.colorSuccess,
                          marginInlineEnd: 6,
                          verticalAlign: 'middle',
                        }}
                      />
                    )}
                    {name}
                  </Tag>
                </Tooltip>
              );
            })}
          </Space>
        )}
      </div>

      <Divider style={{ margin: '12px 0' }} />

      {/* ---------- 道具 ---------- */}
      <SectionTitle>道具</SectionTitle>
      <div style={{ marginTop: 6 }}>
        {propTags.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            本场未提到已建标签的道具
          </Text>
        ) : (
          <Space size={[4, 6]} wrap>
            {propTags.map((t) => (
              <Tag key={t.id} color="blue" style={{ marginInlineEnd: 0 }}>
                {t.name}
              </Tag>
            ))}
          </Space>
        )}
      </div>

      <Divider style={{ margin: '12px 0' }} />

      {/* ---------- 时长 ---------- */}
      <SectionTitle>时长</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
        {/* 用 scene 上算好的字段，不在这里另算一套口径，免得和工具栏总计对不上 */}
        <Row label="预计时长">
          <Text style={{ fontSize: 13 }}>{formatDuration(scene.estimatedDurationMs)}</Text>
        </Row>
        <Row label="预计镜头">
          <Text style={{ fontSize: 13 }}>{scene.estimatedShotCount} 个</Text>
        </Row>
      </div>

      <Divider style={{ margin: '12px 0' }} />

      {/* ---------- 已绑定素材 ---------- */}
      <SectionTitle>已绑定素材</SectionTitle>
      <div style={{ marginTop: 6 }}>
        {scene.characters.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            本场没有需要形象的角色
          </Text>
        ) : (
          <Space size={[8, 8]} wrap align="start">
            {scene.characters.map((name) => (
              <CanonicalThumb
                key={name}
                name={name}
                tag={characterTagByName.get(name) ?? null}
                projectId={projectId}
                episodeId={episodeId}
              />
            ))}
          </Space>
        )}
      </div>
    </div>
  );
}

/** 定宽标签 + 值的一行；定宽是为了几行值左对齐，读起来像一张表 */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Text type="secondary" style={{ fontSize: 12, width: 52, flexShrink: 0 }}>
        {label}
      </Text>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

/**
 * 单个角色的 canonical 设计图缩略图。
 *
 * 【为什么按角色拆成子组件】TagEntity 只带 canonicalAssetId（一个 id），
 * 拿不到 uri；uri 在 /tags/:id/designs 里。hooks 不能在循环里条件调用，
 * 所以把"取某个标签的候选图"这件事下沉成组件，每个角色各自查一次。
 * 一场戏的角色个位数，且 TanStack Query 会按 ['designs', tagId] 复用缓存。
 */
function CanonicalThumb({
  name,
  tag,
  projectId,
  episodeId,
}: {
  name: string;
  tag: TagEntity | null;
  projectId: string;
  episodeId: string;
}) {
  const { token } = theme.useToken();
  // 标签不存在、或存在但没有 canonical 时不必发请求
  const enabled = tag !== null && tag.canonicalAssetId !== null;
  const designsQuery = useTagDesigns(enabled ? tag.id : null);

  const asset = useMemo(() => {
    if (!enabled || !designsQuery.data) return null;
    const hit = designsQuery.data.designs.find((d) => d.assetId === tag.canonicalAssetId);
    return hit?.asset ?? null;
  }, [enabled, designsQuery.data, tag]);

  const box: React.CSSProperties = {
    width: 72,
    height: 96,
    borderRadius: token.borderRadius,
    border: `1px solid ${token.colorBorderSecondary}`,
    background: token.colorFillQuaternary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    textAlign: 'center',
    padding: 4,
  };

  return (
    <div style={{ width: 72 }}>
      <div style={box}>
        {asset ? (
          <img
            src={asset.thumbUri ?? asset.uri}
            alt={name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Text type="secondary" style={{ fontSize: 11, lineHeight: 1.5 }}>
            尚无形象设计
          </Text>
        )}
      </div>
      <div style={{ marginTop: 4, textAlign: 'center' }}>
        <Text
          style={{ fontSize: 12, display: 'block' }}
          ellipsis={{ tooltip: name }}
        >
          {name}
        </Text>
        {!asset && (
          // 没有形象时给一条能立刻动手的出路，而不是只报告缺失
          <Link
            to={`/projects/${projectId}/episodes/${episodeId}/design`}
            style={{ fontSize: 11 }}
          >
            去设计
          </Link>
        )}
      </div>
    </div>
  );
}
