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
  Radio,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd';
import {
  DeleteOutlined,
  MergeCellsOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { CapabilityEntry, TagType } from '@ovideo/shared';
import { useJob } from '../../api/workflow-hooks';
import {
  useCapabilities,
  useCheckTagDuplicates,
  useCreateTag,
  useGenerateDesign,
  useMergeTags,
  useProjectTags,
  useRemoveDesign,
  useSetCanonical,
  useTagDesigns,
  useUpdateTag,
  useUploadDesign,
  type DuplicateTagGroup,
  type TagEntity,
} from '../../api/design-hooks';

const { Text, Paragraph } = Typography;

const TAG_TYPE_LABEL: Record<TagType, string> = {
  CHARACTER: '角色',
  SCENE: '场景',
  PROP: '道具',
};

const GOLD = '#faad14';

/** 设计阶段：项目级标签（角色/场景/道具）的候选设计图工作台 */
/**
 * 重复标签检查器：LLM 语义判重（「同一办公室」≈「办公室」这类拆裂提前抓出来），
 * 每组选一个保留目标，其余合并过去并重命名为建议短名。
 */
function DedupChecker({ projectId }: { projectId: string }) {
  const check = useCheckTagDuplicates(projectId);
  const merge = useMergeTags(projectId);
  const updateTag = useUpdateTag(projectId);
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<DuplicateTagGroup[]>([]);
  const [targets, setTargets] = useState<Record<number, string>>({});
  const [merging, setMerging] = useState(false);

  const runCheck = () => {
    check.mutate(undefined, {
      onSuccess: (r) => {
        if (r.groups.length === 0) {
          message.success('未发现疑似重复标签');
          return;
        }
        setGroups(r.groups);
        setTargets(Object.fromEntries(r.groups.map((g, i) => [i, g.tags[0].id])));
        setOpen(true);
      },
      onError: (e) => message.error(e.message),
    });
  };

  const runMerge = async (gi: number) => {
    const group = groups[gi];
    const targetId = targets[gi];
    setMerging(true);
    try {
      for (const t of group.tags) {
        if (t.id !== targetId) {
          await merge.mutateAsync({ sourceTagId: t.id, targetTagId: targetId });
        }
      }
      if (group.suggestedName) {
        await updateTag.mutateAsync({ tagId: targetId, name: group.suggestedName });
      }
      message.success(`已合并 ${group.tags.length} 个标签 → 「${group.suggestedName}」`);
      const rest = groups.filter((_, i) => i !== gi);
      setGroups(rest);
      if (rest.length === 0) setOpen(false);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '合并失败');
    } finally {
      setMerging(false);
    }
  };

  return (
    <>
      <Button icon={<MergeCellsOutlined />} loading={check.isPending} onClick={runCheck}>
        检查重复标签
      </Button>
      <Modal
        open={open}
        title="疑似重复标签（指同一实体，建议合并）"
        footer={null}
        onCancel={() => setOpen(false)}
        width={560}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {groups.map((g, gi) => (
            <div key={gi} style={{ border: '1px solid rgba(5,5,5,0.1)', borderRadius: 8, padding: 12 }}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Space wrap>
                  <Tag color="blue">{TAG_TYPE_LABEL[g.type as TagType] ?? g.type}</Tag>
                  <span>
                    合并后名称：<b>{g.suggestedName}</b>
                  </span>
                </Space>
                <Radio.Group
                  value={targets[gi]}
                  onChange={(e) => setTargets((prev) => ({ ...prev, [gi]: e.target.value as string }))}
                >
                  <Space direction="vertical" size={4}>
                    {g.tags.map((t) => (
                      <Radio key={t.id} value={t.id}>
                        {t.name}
                        <span style={{ color: '#999', fontSize: 12 }}>
                          {targets[gi] === t.id ? '（保留此标签，其余合并进来）' : ''}
                        </span>
                      </Radio>
                    ))}
                  </Space>
                </Radio.Group>
                <Button type="primary" size="small" loading={merging} onClick={() => void runMerge(gi)}>
                  合并这一组
                </Button>
              </Space>
            </div>
          ))}
        </Space>
      </Modal>
    </>
  );
}

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
        <DedupChecker projectId={projectId} />
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
  const [genState, setGenState] = useState<{ prompt: string; modelConfigId?: string } | null>(
    null,
  );

  const handleGenerate = () => {
    if (genState === null) return;
    const prompt = genState.prompt.trim();
    generateDesign.mutate(
      {
        tagId: tag.id,
        prompt: prompt !== '' ? prompt : undefined,
        modelConfigId: genState.modelConfigId,
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
            onClick={() => setGenState({ prompt: defaultPrompt })}
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
          {imageCapabilities.length > 0 && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                模型
              </Text>
              <Select
                style={{ width: '100%' }}
                allowClear
                placeholder="不选则使用 Mock 生成"
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
