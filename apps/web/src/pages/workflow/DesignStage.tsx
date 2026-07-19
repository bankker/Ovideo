import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Spin,
  Tag as AntTag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd';
import {
  BgColorsOutlined,
  DeleteOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { CapabilityEntry, TagType } from '@ovideo/shared';
import { useProject, useUpdateProject, type Project, type UpdateProjectInput } from '../../api/hooks';
import { useJob } from '../../api/workflow-hooks';
import { TagDedup } from '../../components/TagDedup';
import { EffectivePromptPopover } from '../../components/EffectivePromptPopover';
import {
  useCapabilities,
  useCreateTag,
  useGenerateDesign,
  useProjectTags,
  useRemoveDesign,
  useSetCanonical,
  useTagDesigns,
  useUploadDesign,
  type TagEntity,
} from '../../api/design-hooks';

const { Text, Paragraph } = Typography;

const TAG_TYPE_LABEL: Record<TagType, string> = {
  CHARACTER: '角色',
  SCENE: '场景',
  PROP: '道具',
};

const GOLD = '#faad14';

/** 画幅比例 → 图像生成 size（全站统一映射；2K 档满足 Seedream 4.5/5.0 最小像素要求，按张计费不加价） */
const RATIO_TO_SIZE: Record<string, string> = {
  '9:16': '1440x2560',
  '16:9': '2560x1440',
  '1:1': '2048x2048',
  '3:4': '1728x2304',
  '4:3': '2304x1728',
};
const RATIO_OPTIONS = ['9:16', '16:9', '1:1', '3:4', '4:3'];
const DEFAULT_RATIO = '9:16';

/** 风格设定预设（点击 Tag 填充） */
const STYLE_PRESETS: Array<{ label: string; prompt: string }> = [
  { label: '日系动漫', prompt: '日系动漫风格，清新明快的赛璐璐上色，干净利落的线条' },
  { label: '国漫厚涂', prompt: '国漫厚涂风格，厚重笔触与光影层次，色彩饱满立体' },
  { label: '美式卡通', prompt: '美式卡通风格，夸张造型与高饱和配色，轮廓线粗犷' },
  { label: '水墨国风', prompt: '水墨国风，留白写意，墨色浓淡相宜，古典东方意境' },
  { label: '3D 皮克斯', prompt: '3D 皮克斯风格，圆润造型与细腻材质，柔和的全局光照' },
  { label: '像素风', prompt: '像素风格，复古 8-bit 色块与抖动渐变，游戏机时代质感' },
];

/** 设计阶段：项目级标签（角色/场景/道具）的候选设计图工作台 */
export function DesignStage() {
  const { projectId = '' } = useParams();

  const [activeType, setActiveType] = useState<TagType>('CHARACTER');
  const tagsQuery = useProjectTags(projectId);
  const tags = tagsQuery.data ?? [];
  const currentTags = tags.filter((t) => t.type === activeType);

  const capabilitiesQuery = useCapabilities('image');
  const imageCapabilities = capabilitiesQuery.data ?? [];

  /* ---------- 新建标签 ---------- */
  const createTag = useCreateTag(projectId);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<{ type: TagType; name: string; description?: string }>();

  const handleCreateTag = async () => {
    let values: { type: TagType; name: string; description?: string };
    try {
      values = await createForm.validateFields();
    } catch {
      return; // 校验失败，保留弹窗
    }
    createTag.mutate(
      { type: values.type, name: values.name.trim(), description: values.description?.trim() },
      {
        onSuccess: (tag) => {
          message.success(`标签「${tag.name}」已创建`);
          setCreateOpen(false);
          createForm.resetFields();
          setActiveType(tag.type);
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Space wrap>
        <Segmented
          value={activeType}
          onChange={(v) => setActiveType(v as TagType)}
          options={(Object.keys(TAG_TYPE_LABEL) as TagType[]).map((type) => ({
            value: type,
            label: `${TAG_TYPE_LABEL[type]}（${tags.filter((t) => t.type === type).length}）`,
          }))}
        />
        <Button
          icon={<PlusOutlined />}
          onClick={() => {
            createForm.resetFields();
            createForm.setFieldsValue({ type: activeType });
            setCreateOpen(true);
          }}
        >
          新建标签
        </Button>
        <TagDedup projectId={projectId} />
        <StylePromptButton projectId={projectId} />
      </Space>

      {tagsQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin />
        </div>
      ) : currentTags.length === 0 ? (
        <Empty
          style={{ marginTop: 60 }}
          description={
            tags.length === 0
              ? '暂无标签：先在剧本阶段完成三步生成，角色/场景/道具标签会自动出现；也可点击「新建标签」手动创建'
              : `暂无${TAG_TYPE_LABEL[activeType]}标签`
          }
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))',
            gap: 16,
          }}
        >
          {currentTags.map((tag) => (
            <TagDesignCard
              key={tag.id}
              tag={tag}
              projectId={projectId}
              imageCapabilities={imageCapabilities}
            />
          ))}
        </div>
      )}

      {/* 新建标签弹窗 */}
      <Modal
        title="新建标签"
        open={createOpen}
        onOk={() => void handleCreateTag()}
        confirmLoading={createTag.isPending}
        onCancel={() => setCreateOpen(false)}
        okText="创建"
        cancelText="取消"
        forceRender
      >
        <Form form={createForm} layout="vertical" initialValues={{ type: activeType }}>
          <Form.Item name="type" label="类型" rules={[{ required: true, message: '请选择类型' }]}>
            <Select
              options={(Object.keys(TAG_TYPE_LABEL) as TagType[]).map((type) => ({
                value: type,
                label: TAG_TYPE_LABEL[type],
              }))}
            />
          </Form.Item>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, whitespace: true, message: '请输入名称' }]}
          >
            <Input maxLength={60} placeholder="如：林小雨 / 教室 / 校徽" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea
              maxLength={2000}
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder="外观特征、风格要点……（AI 生成设计图时作为 Prompt 素材）"
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/** ---------- 项目风格设定：TextArea + 预设快捷 Tag，保存到 Project.stylePrompt ---------- */

function StylePromptButton({ projectId }: { projectId: string }) {
  const projectQuery = useProject(projectId !== '' ? projectId : undefined);
  // 服务端契约已含 stylePrompt，本地 Project 类型未声明 → 交叉断言读取
  const savedStylePrompt =
    (projectQuery.data as (Project & { stylePrompt?: string }) | undefined)?.stylePrompt ?? '';

  const updateProject = useUpdateProject();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const handleSave = () => {
    updateProject.mutate(
      {
        id: projectId,
        data: { stylePrompt: draft.trim() } as UpdateProjectInput & { stylePrompt: string },
      },
      {
        onSuccess: () => {
          message.success('已保存，之后的三步生成与生图将自动携带该画风');
          setOpen(false);
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  return (
    <>
      <Button
        icon={<BgColorsOutlined />}
        onClick={() => {
          setDraft(savedStylePrompt);
          setOpen(true);
        }}
      >
        风格设定
      </Button>
      <Modal
        title="项目画风设定"
        open={open}
        onOk={handleSave}
        confirmLoading={updateProject.isPending}
        onCancel={() => setOpen(false)}
        okText="保存"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Input.TextArea
            value={draft}
            maxLength={500}
            showCount
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder="描述整部作品的统一画风，如：日系动漫风格，清新明快……（留空 = 不附加画风）"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div>
            <Text type="secondary" style={{ fontSize: 12, marginRight: 8 }}>
              快捷预设：
            </Text>
            {STYLE_PRESETS.map((p) => (
              <AntTag
                key={p.label}
                style={{ cursor: 'pointer', marginBottom: 4 }}
                onClick={() => setDraft(p.prompt)}
              >
                {p.label}
              </AntTag>
            ))}
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            保存后，剧本三步生成与所有图像生成（设计图 / 关键帧）将自动携带该画风描述
          </Text>
        </Space>
      </Modal>
    </>
  );
}

/** ---------- 单个标签卡片：候选设计图墙 + AI 生成 / 上传 / 设为默认 / 解除关联 ---------- */

function TagDesignCard({
  tag,
  projectId,
  imageCapabilities,
}: {
  tag: TagEntity;
  projectId: string;
  imageCapabilities: CapabilityEntry[];
}) {
  const qc = useQueryClient();
  const designsQuery = useTagDesigns(tag.id);
  const designs = designsQuery.data?.designs ?? [];
  // designs 响应里的 tag 更新鲜（canonical 变更后即时反映）
  const canonicalAssetId = designsQuery.data?.tag.canonicalAssetId ?? tag.canonicalAssetId;

  const setCanonical = useSetCanonical(projectId);
  const removeDesign = useRemoveDesign(projectId);
  const uploadDesign = useUploadDesign(projectId);

  /* ---------- AI 生成 + Job 轮询 ---------- */
  const generateDesign = useGenerateDesign();
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const jobQuery = useJob(runningJobId);
  const job = jobQuery.data;

  useEffect(() => {
    if (!job || job.id !== runningJobId) return;
    if (job.status === 'SUCCEEDED') {
      message.success(`「${tag.name}」设计图生成完成`);
      void qc.invalidateQueries({ queryKey: ['designs', tag.id] });
      // 首张生成图可能自动 canonical
      void qc.invalidateQueries({ queryKey: ['tags', projectId] });
      setRunningJobId(null);
    } else if (job.status === 'FAILED') {
      message.error(job.error ?? `「${tag.name}」设计图生成失败`);
      setRunningJobId(null);
    } else if (job.status === 'CANCELED') {
      message.warning('生成任务已取消');
      setRunningJobId(null);
    }
  }, [job, runningJobId, tag.id, tag.name, projectId, qc]);

  const generating = generateDesign.isPending || runningJobId !== null;

  const defaultPrompt =
    tag.description.trim() !== '' ? `${tag.name}，${tag.description.trim()}` : tag.name;
  const [genState, setGenState] = useState<{
    prompt: string;
    modelConfigId?: string;
    ratio: string;
  } | null>(null);

  const handleGenerate = () => {
    if (genState === null) return;
    const prompt = genState.prompt.trim();
    generateDesign.mutate(
      {
        tagId: tag.id,
        prompt: prompt !== '' ? prompt : undefined,
        modelConfigId: genState.modelConfigId,
        size: RATIO_TO_SIZE[genState.ratio],
      },
      {
        onSuccess: (j) => {
          message.success('已提交生成任务');
          setRunningJobId(j.id);
          setGenState(null);
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  const handleSetCanonical = (assetId: string) => {
    if (assetId === canonicalAssetId) return;
    setCanonical.mutate(
      { tagId: tag.id, assetId },
      {
        onSuccess: () => message.success('已设为默认参考图'),
        onError: (e) => message.error(e.message),
      },
    );
  };

  return (
    <Card
      size="small"
      title={
        <Space size={6}>
          <span>{tag.name}</span>
          <Text type="secondary" style={{ fontWeight: 'normal', fontSize: 12 }}>
            {TAG_TYPE_LABEL[tag.type]}
          </Text>
        </Space>
      }
      extra={
        <Space size={4}>
          <Button
            size="small"
            type="primary"
            ghost
            icon={<ThunderboltOutlined />}
            loading={generating}
            onClick={() => setGenState({ prompt: defaultPrompt, ratio: DEFAULT_RATIO })}
          >
            AI 生成
          </Button>
          <Upload
            accept="image/*"
            showUploadList={false}
            customRequest={({ file, onSuccess, onError }) => {
              uploadDesign.mutate(
                { tagId: tag.id, file: file as File },
                {
                  onSuccess: (result) => {
                    message.success('设计图已上传');
                    onSuccess?.(result);
                  },
                  onError: (e) => {
                    message.error(e.message);
                    onError?.(e);
                  },
                },
              );
            }}
          >
            <Button size="small" icon={<UploadOutlined />} loading={uploadDesign.isPending}>
              上传
            </Button>
          </Upload>
        </Space>
      }
    >
      {tag.description !== '' && (
        <Paragraph
          type="secondary"
          style={{ fontSize: 12, marginBottom: 8 }}
          ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
        >
          {tag.description}
        </Paragraph>
      )}

      {designsQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin size="small" />
        </div>
      ) : designs.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无候选设计图，点击「AI 生成」或「上传」添加"
          style={{ margin: '12px 0' }}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 120px)', gap: 8 }}>
          {designs.map((d) => {
            const isCanonical = d.assetId === canonicalAssetId;
            return (
              <div
                key={d.id}
                onClick={() => handleSetCanonical(d.assetId)}
                title={isCanonical ? '当前默认参考图' : '点击设为默认参考图'}
                style={{
                  position: 'relative',
                  width: 120,
                  height: 120,
                  cursor: 'pointer',
                  borderRadius: 6,
                  overflow: 'hidden',
                  border: isCanonical ? `2px solid ${GOLD}` : '1px solid rgba(5,5,5,0.15)',
                  boxSizing: 'border-box',
                }}
              >
                <img
                  src={d.asset.thumbUri ?? d.asset.uri}
                  alt={tag.name}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
                {isCanonical && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      background: GOLD,
                      color: '#fff',
                      fontSize: 11,
                      lineHeight: '18px',
                      padding: '0 6px',
                      borderBottomRightRadius: 6,
                    }}
                  >
                    默认
                  </div>
                )}
                <Popconfirm
                  title="解除关联？"
                  description="仅将该图从标签候选中移除，不删除资产文件"
                  okText="解除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => {
                    removeDesign.mutate(
                      { designId: d.id, tagId: tag.id },
                      {
                        onSuccess: () => message.success('已解除关联'),
                        onError: (e) => message.error(e.message),
                      },
                    );
                  }}
                >
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={(e) => e.stopPropagation()}
                    style={{ position: 'absolute', top: 2, right: 2, opacity: 0.85 }}
                  />
                </Popconfirm>
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{ position: 'absolute', bottom: 2, right: 2 }}
                >
                  <EffectivePromptPopover metaJson={d.asset.metaJson} compact />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {runningJobId !== null && (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          生成任务进行中（{job?.status === 'RUNNING' ? `进度 ${job.progress}%` : '排队中'}）……
        </Text>
      )}

      {/* AI 生成弹窗 */}
      <Modal
        title={`AI 生成设计图 —— ${tag.name}`}
        open={genState !== null}
        onOk={handleGenerate}
        confirmLoading={generateDesign.isPending}
        onCancel={() => setGenState(null)}
        okText="生成"
        cancelText="取消"
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Prompt
            </Text>
            <Input.TextArea
              value={genState?.prompt ?? ''}
              autoSize={{ minRows: 3, maxRows: 8 }}
              placeholder="描述设计图内容与风格……"
              onChange={(e) =>
                setGenState((s) => (s === null ? s : { ...s, prompt: e.target.value }))
              }
            />
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              画幅比例
            </Text>
            <div style={{ marginTop: 4 }}>
              <Segmented
                options={RATIO_OPTIONS}
                value={genState?.ratio ?? DEFAULT_RATIO}
                onChange={(v) =>
                  setGenState((s) => (s === null ? s : { ...s, ratio: String(v) }))
                }
              />
            </div>
          </div>
          {imageCapabilities.length > 0 && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                模型
              </Text>
              <Select
                style={{ width: '100%' }}
                allowClear
                placeholder="不选则自动调度（队首图像模型）"
                value={genState?.modelConfigId}
                options={imageCapabilities.map((c) => ({
                  value: c.modelConfigId,
                  label: `${c.providerName} · ${c.label}`,
                }))}
                onChange={(v: string | undefined) =>
                  setGenState((s) => (s === null ? s : { ...s, modelConfigId: v }))
                }
              />
            </div>
          )}
          <Tooltip title="生成完成后自动加入候选墙；首张候选自动设为默认参考图">
            <Text type="secondary" style={{ fontSize: 12 }}>
              生成结果将追加到该标签的候选设计图中
            </Text>
          </Tooltip>
        </Space>
      </Modal>
    </Card>
  );
}
