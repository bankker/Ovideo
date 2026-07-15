/** 后台：API 厂商配置（v2 §8）——四类 Tabs + 厂商卡片 + 模型能力表格 + 连通测试 */
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { ApiOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { Modality, ProviderCategory } from '@ovideo/shared';
import {
  useCreateModel,
  useCreateProvider,
  useDeleteModel,
  useDeleteProvider,
  useProviderModels,
  useProviders,
  useTestProvider,
  useUpdateModel,
  useUpdateProvider,
  type ModelItem,
  type ProviderItem,
  type ProviderUpsertBody,
} from '../../api/admin-hooks';

const { Text, Title } = Typography;

const CATEGORY_TABS: Array<{ key: ProviderCategory; label: string }> = [
  { key: 'TEXT', label: '文本生成' },
  { key: 'IMAGE', label: '图像生成' },
  { key: 'VIDEO', label: '视频生成' },
  { key: 'TTS', label: '语音生成' },
];

const CATEGORY_TO_MODALITY: Record<ProviderCategory, Modality> = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  TTS: 'tts',
};

const MODALITY_OPTIONS: Array<{ value: Modality; label: string }> = [
  { value: 'text', label: 'text（文本）' },
  { value: 'image', label: 'image（图像）' },
  { value: 'video', label: 'video（视频）' },
  { value: 'tts', label: 'tts（语音）' },
];

/** ---------- 厂商新增/编辑弹窗 ---------- */

interface ProviderFormValues {
  name: string;
  vendor: string;
  category: ProviderCategory;
  baseUrl?: string;
  apiKey?: string;
}

function ProviderModal({
  editing,
  defaultCategory,
  onClose,
}: {
  editing: ProviderItem | null;
  defaultCategory: ProviderCategory;
  onClose: () => void;
}) {
  const [form] = Form.useForm<ProviderFormValues>();
  const createProvider = useCreateProvider();
  const updateProvider = useUpdateProvider();
  const pending = createProvider.isPending || updateProvider.isPending;

  const handleOk = async () => {
    const values = await form.validateFields();
    // 编辑时留空表示不改：过滤空串字段（新建时空串走服务端默认值，同样过滤）
    const body: ProviderUpsertBody = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v !== '' && v !== undefined && v !== null),
    ) as ProviderUpsertBody;
    const opts = {
      onSuccess: () => {
        message.success(editing ? '厂商已更新' : '厂商已创建');
        onClose();
      },
      onError: (err: Error) => message.error(err.message),
    };
    if (editing) {
      updateProvider.mutate({ id: editing.id, body }, opts);
    } else {
      createProvider.mutate(body, opts);
    }
  };

  return (
    <Modal
      open
      title={editing ? '编辑厂商' : '新增厂商'}
      okText={editing ? '保存' : '创建'}
      cancelText="取消"
      confirmLoading={pending}
      onOk={() => void handleOk()}
      onCancel={onClose}
      destroyOnClose
    >
      <Form<ProviderFormValues>
        form={form}
        layout="vertical"
        initialValues={
          editing
            ? { name: editing.name, vendor: editing.vendor, category: editing.category, baseUrl: editing.baseUrl }
            : { category: defaultCategory }
        }
      >
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入厂商名称' }]}>
          <Input placeholder="如：OpenAI 官方 / 火山引擎" maxLength={100} />
        </Form.Item>
        <Form.Item name="vendor" label="Vendor（适配器标识）" rules={[{ required: true, message: '请输入 vendor' }]}>
          <Input placeholder="如：openai-compatible / mock" maxLength={60} />
        </Form.Item>
        <Form.Item name="category" label="类别" rules={[{ required: true, message: '请选择类别' }]}>
          <Select
            options={CATEGORY_TABS.map((t) => ({ value: t.key, label: `${t.key}（${t.label}）` }))}
          />
        </Form.Item>
        <Form.Item name="baseUrl" label="Base URL">
          <Input placeholder={editing ? '留空保持不变' : '如：https://api.openai.com/v1'} />
        </Form.Item>
        <Form.Item name="apiKey" label="API Key" extra={editing ? '当前已配置的 Key 不回显，留空保持不变' : undefined}>
          <Input.Password placeholder={editing ? '留空保持不变' : '可留空（Mock 厂商无需 Key）'} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** ---------- 模型新增/编辑弹窗 ---------- */

interface ModelFormValues {
  key: string;
  label: string;
  modality: Modality;
  capabilityText: string;
}

function ModelModal({
  providerId,
  editing,
  defaultModality,
  onClose,
}: {
  providerId: string;
  editing: ModelItem | null;
  defaultModality: Modality;
  onClose: () => void;
}) {
  const [form] = Form.useForm<ModelFormValues>();
  const createModel = useCreateModel();
  const updateModel = useUpdateModel();
  const pending = createModel.isPending || updateModel.isPending;

  const initialCapability = (() => {
    if (editing) {
      try {
        return JSON.stringify(JSON.parse(editing.capabilityJson), null, 2);
      } catch {
        return editing.capabilityJson;
      }
    }
    return JSON.stringify({ modality: defaultModality, input: ['prompt'] }, null, 2);
  })();

  const handleOk = async () => {
    const values = await form.validateFields();
    let capability: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(values.capabilityText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('capability 必须是 JSON 对象');
      }
      capability = parsed as Record<string, unknown>;
    } catch (err) {
      message.error(`capability 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const opts = {
      onSuccess: () => {
        message.success(editing ? '模型已更新' : '模型已添加');
        onClose();
      },
      onError: (err: Error) => message.error(err.message),
    };
    if (editing) {
      updateModel.mutate(
        { id: editing.id, body: { key: values.key, label: values.label, modality: values.modality, capability } },
        opts,
      );
    } else {
      createModel.mutate(
        {
          providerId,
          body: { key: values.key, label: values.label, modality: values.modality, capability, enabled: true },
        },
        opts,
      );
    }
  };

  return (
    <Modal
      open
      title={editing ? '编辑模型' : '添加模型'}
      okText={editing ? '保存' : '添加'}
      cancelText="取消"
      confirmLoading={pending}
      onOk={() => void handleOk()}
      onCancel={onClose}
      destroyOnClose
    >
      <Form<ModelFormValues>
        form={form}
        layout="vertical"
        initialValues={
          editing
            ? { key: editing.key, label: editing.label, modality: editing.modality, capabilityText: initialCapability }
            : { modality: defaultModality, capabilityText: initialCapability }
        }
      >
        <Form.Item name="key" label="模型 Key" rules={[{ required: true, message: '请输入模型 key' }]}>
          <Input placeholder="如：gpt-4o / doubao-seedance-pro" maxLength={120} />
        </Form.Item>
        <Form.Item name="label" label="显示名称" rules={[{ required: true, message: '请输入显示名称' }]}>
          <Input placeholder="前台展示的模型名" maxLength={120} />
        </Form.Item>
        <Form.Item name="modality" label="模态" rules={[{ required: true, message: '请选择模态' }]}>
          <Select options={MODALITY_OPTIONS} />
        </Form.Item>
        <Form.Item
          name="capabilityText"
          label="能力描述（capability JSON）"
          rules={[{ required: true, message: '请填写能力描述 JSON' }]}
          extra="前台按 modality + input 能力动态渲染模型选项与参数表单"
        >
          <Input.TextArea rows={7} style={{ fontFamily: 'monospace', fontSize: 12 }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** ---------- 厂商卡片（含模型表格） ---------- */

function ProviderCard({
  provider,
  onEdit,
  onAddModel,
  onEditModel,
}: {
  provider: ProviderItem;
  onEdit: () => void;
  onAddModel: () => void;
  onEditModel: (model: ModelItem) => void;
}) {
  const updateProvider = useUpdateProvider();
  const deleteProvider = useDeleteProvider();
  const testProvider = useTestProvider();
  const updateModel = useUpdateModel();
  const deleteModel = useDeleteModel();

  // GET /admin/providers 未带 models 时兜底单独拉取
  const needFetchModels = provider.models === undefined;
  const modelsQuery = useProviderModels(provider.id, needFetchModels);
  const models = provider.models ?? modelsQuery.data ?? [];

  const handleToggleEnabled = (enabled: boolean) => {
    updateProvider.mutate(
      { id: provider.id, body: { enabled } },
      {
        onSuccess: () => message.success(enabled ? '厂商已启用' : '厂商已停用'),
        onError: (err) => message.error(err.message),
      },
    );
  };

  const handleDelete = () => {
    deleteProvider.mutate(provider.id, {
      onSuccess: () => message.success('厂商已删除'),
      onError: (err) => message.error(err.message),
    });
  };

  const handleTest = () => {
    testProvider.mutate(provider.id, {
      onSuccess: (result) => {
        const latency = result.latencyMs !== undefined ? `（${result.latencyMs}ms）` : '';
        const detail = result.message ? `：${result.message}` : '';
        if (result.ok) {
          message.success(`连通成功${latency}${detail}`);
        } else {
          message.error(`连通失败${detail}`);
        }
      },
      onError: (err) => message.error(`连通测试失败：${err.message}`),
    });
  };

  const handleToggleModel = (model: ModelItem, enabled: boolean) => {
    updateModel.mutate(
      { id: model.id, body: { enabled } },
      {
        onSuccess: () => message.success(enabled ? `模型「${model.label}」已启用` : `模型「${model.label}」已停用`),
        onError: (err) => message.error(err.message),
      },
    );
  };

  const handleDeleteModel = (model: ModelItem) => {
    deleteModel.mutate(model.id, {
      onSuccess: () => message.success('模型已删除'),
      onError: (err) => message.error(err.message),
    });
  };

  return (
    <Card
      size="small"
      title={
        <Space wrap>
          <ApiOutlined />
          <Text strong>{provider.name}</Text>
          <Tag>{provider.vendor}</Tag>
          {!provider.enabled && <Tag color="default">已停用</Tag>}
        </Space>
      }
      extra={
        <Space>
          <Switch
            checked={provider.enabled}
            checkedChildren="启用"
            unCheckedChildren="停用"
            loading={updateProvider.isPending}
            onChange={handleToggleEnabled}
          />
          <Button
            size="small"
            icon={<ThunderboltOutlined />}
            loading={testProvider.isPending}
            onClick={handleTest}
          >
            连通测试
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={onEdit}>
            编辑
          </Button>
          <Popconfirm
            title="删除厂商"
            description="将同时删除其下全部模型配置，确定删除？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={handleDelete}
          >
            <Button size="small" danger icon={<DeleteOutlined />} loading={deleteProvider.isPending}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      }
    >
      <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
        <Descriptions.Item label="Base URL">
          {provider.baseUrl ? <Text code>{provider.baseUrl}</Text> : <Text type="secondary">未设置</Text>}
        </Descriptions.Item>
        <Descriptions.Item label="API Key">
          {provider.apiKey ? <Text code>{provider.apiKey}</Text> : <Text type="secondary">未设置</Text>}
        </Descriptions.Item>
      </Descriptions>

      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
        <Text strong>模型列表</Text>
        <Button size="small" type="primary" ghost icon={<PlusOutlined />} onClick={onAddModel}>
          添加模型
        </Button>
      </Space>
      <Table<ModelItem>
        size="small"
        rowKey="id"
        loading={needFetchModels && modelsQuery.isLoading}
        dataSource={models}
        pagination={false}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模型，点击右上角添加" /> }}
        columns={[
          {
            title: 'Key',
            dataIndex: 'key',
            render: (v: string) => <Text code>{v}</Text>,
          },
          { title: '名称', dataIndex: 'label' },
          {
            title: '模态',
            dataIndex: 'modality',
            width: 90,
            render: (v: Modality) => <Tag color="blue">{v}</Tag>,
          },
          {
            title: '启用',
            dataIndex: 'enabled',
            width: 80,
            render: (_: boolean, model) => (
              <Switch
                size="small"
                checked={model.enabled}
                loading={updateModel.isPending && updateModel.variables?.id === model.id}
                onChange={(checked) => handleToggleModel(model, checked)}
              />
            ),
          },
          {
            title: '操作',
            key: 'actions',
            width: 140,
            render: (_, model) => (
              <Space size={4}>
                <Button size="small" type="link" onClick={() => onEditModel(model)}>
                  编辑
                </Button>
                <Popconfirm
                  title="确定删除该模型？"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => handleDeleteModel(model)}
                >
                  <Button size="small" type="link" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}

/** ---------- 页面 ---------- */

export function ProvidersPage() {
  const [category, setCategory] = useState<ProviderCategory>('TEXT');
  const [providerModal, setProviderModal] = useState<{ editing: ProviderItem | null } | null>(null);
  const [modelModal, setModelModal] = useState<{ providerId: string; editing: ModelItem | null } | null>(null);
  const { data: providers, isLoading } = useProviders();

  const currentProviders = (providers ?? []).filter((p) => p.category === category);

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <Title level={4} style={{ marginTop: 0 }}>
        API 厂商配置
      </Title>
      <Alert
        type="info"
        showIcon
        closable
        message="后台新增模型后，前台对应功能会动态出现该模型选项（M2 起生效）"
        style={{ marginBottom: 16 }}
      />
      <Tabs
        activeKey={category}
        onChange={(key) => setCategory(key as ProviderCategory)}
        items={CATEGORY_TABS.map((t) => ({ key: t.key, label: `${t.label}（${t.key}）` }))}
        tabBarExtraContent={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setProviderModal({ editing: null })}>
            新增厂商
          </Button>
        }
      />
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : currentProviders.length === 0 ? (
        <Empty description={`暂无「${CATEGORY_TABS.find((t) => t.key === category)?.label ?? ''}」厂商`}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setProviderModal({ editing: null })}>
            新增厂商
          </Button>
        </Empty>
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {currentProviders.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              onEdit={() => setProviderModal({ editing: provider })}
              onAddModel={() => setModelModal({ providerId: provider.id, editing: null })}
              onEditModel={(model) => setModelModal({ providerId: provider.id, editing: model })}
            />
          ))}
        </Space>
      )}

      {providerModal && (
        <ProviderModal
          editing={providerModal.editing}
          defaultCategory={category}
          onClose={() => setProviderModal(null)}
        />
      )}
      {modelModal && (
        <ModelModal
          providerId={modelModal.providerId}
          editing={modelModal.editing}
          defaultModality={
            modelModal.editing?.modality ??
            CATEGORY_TO_MODALITY[
              (providers ?? []).find((p) => p.id === modelModal.providerId)?.category ?? 'TEXT'
            ]
          }
          onClose={() => setModelModal(null)}
        />
      )}
    </div>
  );
}
