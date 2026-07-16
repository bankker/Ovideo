/**
 * 后台：API 厂商配置（傻瓜化改造）。
 * 一个平台一张卡片、一把 Key 多模态通用（模态归属由 ModelConfig.modality 决定，不再按类别分家）；
 * 新增厂商 = 选平台预置模板（自动填 BaseURL + 推荐模型勾选导入）；
 * 「自动发现模型」调服务端代理的厂商 /models 接口；capability JSON 收进折叠面板按模态自动生成。
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
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
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  ApiOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { Modality } from '@ovideo/shared';
import {
  useAutoConfigKey,
  useBatchCreateModels,
  useCreateModel,
  useCreateProvider,
  useDeleteModel,
  useDeleteProvider,
  useDiscoverModels,
  useProviderModels,
  useProviderPresets,
  useProviders,
  useTestProvider,
  useUpdateModel,
  useUpdateProvider,
  type DiscoveredModel,
  type ModelItem,
  type ProviderItem,
  type ProviderPreset,
  type ProviderUpsertBody,
} from '../../api/admin-hooks';

const { Text, Title } = Typography;

/** 模态 → 中文标签 + Tag 颜色（文本=blue/图像=purple/视频=magenta/语音=cyan） */
const MODALITY_META: Record<Modality, { label: string; color: string }> = {
  text: { label: '文本', color: 'blue' },
  image: { label: '图像', color: 'purple' },
  video: { label: '视频', color: 'magenta' },
  tts: { label: '语音', color: 'cyan' },
};

const MODALITY_OPTIONS: Array<{ value: Modality; label: string }> = [
  { value: 'text', label: '文本（text）' },
  { value: 'image', label: '图像（image）' },
  { value: 'video', label: '视频（video）' },
  { value: 'tts', label: '语音（tts）' },
];

function ModalityTag({ modality }: { modality: Modality }) {
  const meta = MODALITY_META[modality] ?? { label: modality, color: 'default' };
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

/** 按模态生成 capability 模板（高级折叠面板默认内容；一般无需修改） */
const CAPABILITY_TEMPLATES: Record<Modality, Record<string, unknown>> = {
  text: { modality: 'text', input: ['prompt'] },
  image: {
    modality: 'image',
    input: ['prompt', 'ref_images'],
    output: { resolutions: ['1024x1024'], ratios: ['16:9', '9:16', '1:1'] },
  },
  video: {
    modality: 'video',
    input: ['prompt', 'first_frame'],
    output: { resolutions: ['720p', '1080p'], maxDurationS: 10 },
  },
  tts: { modality: 'tts', input: ['prompt'], flags: { supportsVoiceReference: true } },
};

function capabilityTemplate(modality: Modality): string {
  return JSON.stringify(CAPABILITY_TEMPLATES[modality], null, 2);
}

/** ---------- 新增厂商：选平台两步式弹窗 ---------- */

const CUSTOM_PRESET_ID = '__custom__';

interface CreateProviderFormValues {
  presetId: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
}

function CreateProviderModal({ onClose }: { onClose: () => void }) {
  const [form] = Form.useForm<CreateProviderFormValues>();
  const [step, setStep] = useState<0 | 1>(0);
  const [presetId, setPresetId] = useState<string>(CUSTOM_PRESET_ID);
  const [checkedKeys, setCheckedKeys] = useState<string[]>([]);
  const presetsQuery = useProviderPresets();
  const createProvider = useCreateProvider();
  const batchCreate = useBatchCreateModels();
  const pending = createProvider.isPending || batchCreate.isPending;

  const presets = presetsQuery.data ?? [];
  const preset: ProviderPreset | undefined = presets.find((p) => p.id === presetId);
  const hasModelStep = !!preset && preset.models.length > 0;

  const handlePresetChange = (id: string) => {
    setPresetId(id);
    setStep(0);
    const next = presets.find((p) => p.id === id);
    if (next) {
      // 预置平台：名称/BaseURL 自动填入（仍可修改）；推荐模型默认勾选，带 note 的默认不勾
      form.setFieldsValue({ name: next.name, baseUrl: next.baseUrl });
      setCheckedKeys(next.models.filter((m) => m.recommended && !m.note).map((m) => m.key));
    } else {
      form.setFieldsValue({ name: '', baseUrl: '' });
      setCheckedKeys([]);
    }
  };

  const handleNext = async () => {
    await form.validateFields();
    setStep(1);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    createProvider.mutate(
      {
        name: values.name,
        // 预置平台用其 vendor；自定义走 OpenAI 兼容适配器
        vendor: preset?.vendor ?? 'openai-compatible',
        baseUrl: values.baseUrl || undefined,
        apiKey: values.apiKey || undefined,
      },
      {
        onSuccess: (provider) => {
          const models = (preset?.models ?? [])
            .filter((m) => checkedKeys.includes(m.key))
            .map((m) => ({ key: m.key, label: m.label, modality: m.modality, capability: m.capability }));
          if (models.length === 0) {
            message.success('厂商已创建');
            onClose();
            return;
          }
          batchCreate.mutate(
            { providerId: provider.id, models },
            {
              onSuccess: (result) => {
                message.success(`已创建，共导入 ${result.created} 个模型`);
                onClose();
              },
              onError: (err) => {
                // 厂商已建成功，仅模型导入失败：提示后关闭，用户可用「自动发现」或手动补
                message.warning(`厂商已创建，但模型导入失败：${err.message}`);
                onClose();
              },
            },
          );
        },
        onError: (err) => message.error(err.message),
      },
    );
  };

  const footer =
    step === 0
      ? [
          <Button key="cancel" onClick={onClose}>
            取消
          </Button>,
          hasModelStep ? (
            <Button key="next" type="primary" onClick={() => void handleNext()}>
              下一步：选择模型
            </Button>
          ) : (
            <Button key="ok" type="primary" loading={pending} onClick={() => void handleSubmit()}>
              创建
            </Button>
          ),
        ]
      : [
          <Button key="prev" onClick={() => setStep(0)}>
            上一步
          </Button>,
          <Button key="ok" type="primary" loading={pending} onClick={() => void handleSubmit()}>
            {checkedKeys.length > 0 ? `创建并导入 ${checkedKeys.length} 个模型` : '创建（暂不导入模型）'}
          </Button>,
        ];

  return (
    <Modal open title="新增厂商" footer={footer} onCancel={onClose} destroyOnClose width={560}>
      {presetsQuery.isError && (
        <Alert
          type="warning"
          showIcon
          message={`预置模板加载失败：${presetsQuery.error.message}，仍可选择「自定义」创建`}
          style={{ marginBottom: 12 }}
        />
      )}
      <Form<CreateProviderFormValues>
        form={form}
        layout="vertical"
        initialValues={{ presetId: CUSTOM_PRESET_ID }}
      >
        {/* 两步共用一个 Form：第二步时用 display:none 隐藏而非卸载，保住字段值与校验 */}
        <div style={{ display: step === 0 ? 'block' : 'none' }}>
          <Form.Item name="presetId" label="选择平台" rules={[{ required: true, message: '请选择平台' }]}>
            <Select
              loading={presetsQuery.isLoading}
              onChange={handlePresetChange}
              options={[
                ...presets.map((p) => ({ value: p.id, label: p.name })),
                { value: CUSTOM_PRESET_ID, label: '自定义（OpenAI 兼容）' },
              ]}
            />
          </Form.Item>
          {preset?.note && (
            <Alert type="info" showIcon message={preset.note} style={{ marginBottom: 12 }} />
          )}
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入厂商名称' }]}>
            <Input placeholder="如：火山引擎（豆包）" maxLength={100} />
          </Form.Item>
          <Form.Item name="baseUrl" label="Base URL">
            <Input placeholder="如：https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item name="apiKey" label="API Key" extra="可留空，稍后在卡片「编辑」中填写">
            <Input.Password placeholder="平台的 API Key（一把 Key 各模态通用）" />
          </Form.Item>
        </div>
        {step === 1 && preset && (
          <div>
            <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text strong>选择要启用的模型</Text>
              <Space size={4}>
                <Button size="small" type="link" onClick={() => setCheckedKeys(preset.models.map((m) => m.key))}>
                  全选
                </Button>
                <Button
                  size="small"
                  type="link"
                  onClick={() =>
                    setCheckedKeys(preset.models.filter((m) => !checkedKeys.includes(m.key)).map((m) => m.key))
                  }
                >
                  反选
                </Button>
              </Space>
            </Space>
            <Space direction="vertical" size={8} style={{ width: '100%', maxHeight: 360, overflowY: 'auto' }}>
              {preset.models.map((m) => (
                <Checkbox
                  key={m.key}
                  checked={checkedKeys.includes(m.key)}
                  onChange={(e) =>
                    setCheckedKeys((prev) =>
                      e.target.checked ? [...prev, m.key] : prev.filter((k) => k !== m.key),
                    )
                  }
                >
                  <Space size={6} wrap>
                    <Text code>{m.key}</Text>
                    <span>{m.label}</span>
                    <ModalityTag modality={m.modality} />
                    {m.recommended && <Tag color="green">推荐</Tag>}
                    {m.note && <Text type="secondary">{m.note}</Text>}
                  </Space>
                </Checkbox>
              ))}
            </Space>
          </div>
        )}
      </Form>
    </Modal>
  );
}

/** ---------- 编辑厂商弹窗（名称 / Base URL / API Key） ---------- */

interface EditProviderFormValues {
  name: string;
  baseUrl?: string;
  apiKey?: string;
}

function EditProviderModal({ provider, onClose }: { provider: ProviderItem; onClose: () => void }) {
  const [form] = Form.useForm<EditProviderFormValues>();
  const updateProvider = useUpdateProvider();

  const handleOk = async () => {
    const values = await form.validateFields();
    // 留空表示不改：过滤空串字段
    const body = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v !== '' && v !== undefined && v !== null),
    ) as ProviderUpsertBody;
    updateProvider.mutate(
      { id: provider.id, body },
      {
        onSuccess: () => {
          message.success('厂商已更新');
          onClose();
        },
        onError: (err) => message.error(err.message),
      },
    );
  };

  return (
    <Modal
      open
      title={`编辑厂商：${provider.name}`}
      okText="保存"
      cancelText="取消"
      confirmLoading={updateProvider.isPending}
      onOk={() => void handleOk()}
      onCancel={onClose}
      destroyOnClose
    >
      <Form<EditProviderFormValues>
        form={form}
        layout="vertical"
        initialValues={{ name: provider.name, baseUrl: provider.baseUrl }}
      >
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入厂商名称' }]}>
          <Input maxLength={100} />
        </Form.Item>
        <Form.Item name="baseUrl" label="Base URL">
          <Input placeholder="留空保持不变" />
        </Form.Item>
        <Form.Item name="apiKey" label="API Key" extra="当前已配置的 Key 不回显，留空保持不变">
          <Input.Password placeholder="留空保持不变" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** ---------- 模型新增/编辑弹窗（去 JSON 化：三项表单 + 高级折叠面板） ---------- */

interface ModelFormValues {
  key: string;
  label: string;
  modality: Modality;
  capabilityText: string;
}

function ModelModal({
  providerId,
  editing,
  onClose,
}: {
  providerId: string;
  editing: ModelItem | null;
  onClose: () => void;
}) {
  const [form] = Form.useForm<ModelFormValues>();
  const createModel = useCreateModel();
  const updateModel = useUpdateModel();
  const pending = createModel.isPending || updateModel.isPending;
  // 编辑态的 JSON 来自服务端（视为已手动定制）；新建态未手改时跟随模态刷新模板
  const [jsonTouched, setJsonTouched] = useState(!!editing);

  const initialCapability = (() => {
    if (editing) {
      try {
        return JSON.stringify(JSON.parse(editing.capabilityJson), null, 2);
      } catch {
        return editing.capabilityJson;
      }
    }
    return capabilityTemplate('text');
  })();

  const handleValuesChange = (changed: Partial<ModelFormValues>) => {
    if ('capabilityText' in changed) {
      setJsonTouched(true);
      return;
    }
    if ('modality' in changed && changed.modality && !jsonTouched) {
      // setFieldValue 不触发 onValuesChange，不会误标 touched
      form.setFieldValue('capabilityText', capabilityTemplate(changed.modality));
    }
  };

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
      message.error(`高级能力描述不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // 模态以表单 Select 为准，避免折叠面板里的 JSON 与之不一致
    capability.modality = values.modality;
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
        onValuesChange={handleValuesChange}
        initialValues={
          editing
            ? { key: editing.key, label: editing.label, modality: editing.modality, capabilityText: initialCapability }
            : { modality: 'text', capabilityText: initialCapability }
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
        <Collapse
          ghost
          items={[
            {
              key: 'capability',
              label: '高级：能力描述(JSON)',
              children: (
                <>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                    一般无需修改；用于声明模型输入类型/分辨率/时长上限，前台按此渲染选项
                  </Text>
                  <Form.Item name="capabilityText" noStyle rules={[{ required: true, message: '请填写能力描述 JSON' }]}>
                    <Input.TextArea rows={7} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                  </Form.Item>
                </>
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  );
}

/** ---------- 自动发现模型弹窗 ---------- */

function DiscoverModal({ provider, onClose }: { provider: ProviderItem; onClose: () => void }) {
  const discover = useDiscoverModels();
  const batchCreate = useBatchCreateModels();
  const [models, setModels] = useState<DiscoveredModel[] | null>(null);
  const [checkedKeys, setCheckedKeys] = useState<string[]>([]);

  const runDiscover = () => {
    setModels(null);
    discover.mutate(provider.id, {
      onSuccess: (list) => {
        setModels(list);
        // 默认勾选全部未添加的
        setCheckedKeys(list.filter((m) => !m.exists).map((m) => m.key));
      },
    });
  };

  useEffect(() => {
    runDiscover();
    // 仅打开弹窗时发现一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectable = (models ?? []).filter((m) => !m.exists);

  const handleImport = () => {
    const picked = selectable
      .filter((m) => checkedKeys.includes(m.key))
      .map((m) => ({ key: m.key, label: m.label, modality: m.modality }));
    batchCreate.mutate(
      { providerId: provider.id, models: picked },
      {
        onSuccess: (result) => {
          message.success(
            `已导入 ${result.created} 个模型${result.skipped > 0 ? `，跳过 ${result.skipped} 个已存在` : ''}`,
          );
          onClose();
        },
        onError: (err) => message.error(err.message),
      },
    );
  };

  return (
    <Modal
      open
      title={`自动发现模型：${provider.name}`}
      onCancel={onClose}
      destroyOnClose
      width={560}
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button
          key="ok"
          type="primary"
          disabled={checkedKeys.length === 0}
          loading={batchCreate.isPending}
          onClick={handleImport}
        >
          导入 {checkedKeys.length} 个模型
        </Button>,
      ]}
    >
      {discover.isPending && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin tip="正在调用平台 /models 接口发现模型…">
            <div style={{ minHeight: 48 }} />
          </Spin>
        </div>
      )}
      {discover.isError && (
        <Alert
          type="error"
          showIcon
          message="模型发现失败"
          description={discover.error.message}
          action={
            <Button size="small" onClick={runDiscover}>
              重试
            </Button>
          }
        />
      )}
      {models && models.length === 0 && <Empty description="平台未返回任何模型" />}
      {models && models.length > 0 && (
        <>
          <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
            <Text type="secondary">共发现 {models.length} 个模型（已添加的置灰）</Text>
            <Space size={4}>
              <Button size="small" type="link" onClick={() => setCheckedKeys(selectable.map((m) => m.key))}>
                全选
              </Button>
              <Button
                size="small"
                type="link"
                onClick={() =>
                  setCheckedKeys(selectable.filter((m) => !checkedKeys.includes(m.key)).map((m) => m.key))
                }
              >
                反选
              </Button>
            </Space>
          </Space>
          <Space direction="vertical" size={8} style={{ width: '100%', maxHeight: 400, overflowY: 'auto' }}>
            {models.map((m) => (
              <Checkbox
                key={m.key}
                disabled={m.exists}
                checked={m.exists || checkedKeys.includes(m.key)}
                onChange={(e) =>
                  setCheckedKeys((prev) =>
                    e.target.checked ? [...prev, m.key] : prev.filter((k) => k !== m.key),
                  )
                }
              >
                <Space size={6} wrap>
                  <Text code type={m.exists ? 'secondary' : undefined}>
                    {m.key}
                  </Text>
                  {m.label !== m.key && <span>{m.label}</span>}
                  <ModalityTag modality={m.modality} />
                  {m.exists && <Tag>已添加</Tag>}
                </Space>
              </Checkbox>
            ))}
          </Space>
        </>
      )}
    </Modal>
  );
}

/** ---------- 厂商卡片（含模型表格） ---------- */

function ProviderCard({
  provider,
  onEdit,
  onAddModel,
  onEditModel,
  onDiscover,
}: {
  provider: ProviderItem;
  onEdit: () => void;
  onAddModel: () => void;
  onEditModel: (model: ModelItem) => void;
  onDiscover: () => void;
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
  const hasApiKey = !!provider.apiKey;

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
          <Text type="secondary" style={{ fontSize: 12 }}>
            {provider.vendor}
          </Text>
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
          <Button size="small" icon={<ThunderboltOutlined />} loading={testProvider.isPending} onClick={handleTest}>
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
          {hasApiKey ? <Text code>{provider.apiKey}</Text> : <Tag color="warning">未设置</Tag>}
        </Descriptions.Item>
      </Descriptions>

      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
        <Text strong>模型列表</Text>
        <Space>
          <Tooltip title={hasApiKey ? undefined : '请先填写 API Key'}>
            <Button size="small" icon={<SearchOutlined />} disabled={!hasApiKey} onClick={onDiscover}>
              自动发现模型
            </Button>
          </Tooltip>
          <Button size="small" type="primary" ghost icon={<PlusOutlined />} onClick={onAddModel}>
            添加模型
          </Button>
        </Space>
      </Space>
      <Table<ModelItem>
        size="small"
        rowKey="id"
        loading={needFetchModels && modelsQuery.isLoading}
        dataSource={models}
        pagination={false}
        locale={{
          emptyText: (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模型，可点击「自动发现模型」或手动添加" />
          ),
        }}
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
            render: (v: Modality) => <ModalityTag modality={v} />,
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

/** 贴 key 一键接入卡片：自动识别平台 → 自动建卡导入模型 → 连通测试 */
function AutoConfigKeyCard() {
  const [key, setKey] = useState('');
  const autoConfig = useAutoConfigKey();
  const result = autoConfig.data;

  const handleSubmit = () => {
    const trimmed = key.trim();
    if (trimmed.length < 8) {
      message.warning('请粘贴完整的 API Key');
      return;
    }
    autoConfig.mutate(trimmed, {
      onSuccess: (r) => {
        if (r.matched) {
          setKey('');
          message.success(`已接入「${r.platform?.name}」`);
        }
      },
      onError: (err) => message.error(err.message),
    });
  };

  return (
    <Card size="small" style={{ marginBottom: 16 }} title="⚡ 一键接入：粘贴 API Key，自动识别平台并完成配置">
      <Space.Compact style={{ width: '100%' }}>
        <Input.Password
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="粘贴任意平台的 API Key（OpenRouter / 火山方舟 / 百炼 / DeepSeek / Kimi / 智谱 / Gemini…）"
          onPressEnter={handleSubmit}
          visibilityToggle={false}
        />
        <Button type="primary" loading={autoConfig.isPending} onClick={handleSubmit}>
          自动识别并接入
        </Button>
      </Space.Compact>
      {autoConfig.isPending && (
        <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
          正在向各平台探测这把 Key 的归属……
        </Text>
      )}
      {result && !autoConfig.isPending && (
        <Alert
          style={{ marginTop: 12 }}
          type={result.matched ? (result.test?.ok ? 'success' : 'warning') : 'error'}
          showIcon
          message={result.message}
          description={
            !result.matched && result.probed ? (
              <Space direction="vertical" size={2}>
                {result.probed.map((p) => (
                  <Text key={p.platform} type="secondary" style={{ fontSize: 12 }}>
                    {p.platform}：{p.status}
                  </Text>
                ))}
              </Space>
            ) : undefined
          }
        />
      )}
    </Card>
  );
}

export function ProvidersPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [editProvider, setEditProvider] = useState<ProviderItem | null>(null);
  const [modelModal, setModelModal] = useState<{ providerId: string; editing: ModelItem | null } | null>(null);
  const [discoverProvider, setDiscoverProvider] = useState<ProviderItem | null>(null);
  const { data: providers, isLoading } = useProviders();

  const list = providers ?? [];

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
        <Title level={4} style={{ margin: 0 }}>
          API 厂商配置
        </Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新增厂商
        </Button>
      </Space>
      <Alert
        type="info"
        showIcon
        closable
        message="一个平台只需配置一次：填入 API Key 后，其下各模态模型自动出现在对应功能位（分镜=图像、视频页=视频、剧本对话=文本）"
        style={{ marginBottom: 16 }}
      />
      <AutoConfigKeyCard />
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : list.length === 0 ? (
        <Empty description="暂无厂商，从平台预置模板开始">
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新增厂商
          </Button>
        </Empty>
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {list.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              onEdit={() => setEditProvider(provider)}
              onAddModel={() => setModelModal({ providerId: provider.id, editing: null })}
              onEditModel={(model) => setModelModal({ providerId: provider.id, editing: model })}
              onDiscover={() => setDiscoverProvider(provider)}
            />
          ))}
        </Space>
      )}

      {createOpen && <CreateProviderModal onClose={() => setCreateOpen(false)} />}
      {editProvider && <EditProviderModal provider={editProvider} onClose={() => setEditProvider(null)} />}
      {modelModal && (
        <ModelModal
          providerId={modelModal.providerId}
          editing={modelModal.editing}
          onClose={() => setModelModal(null)}
        />
      )}
      {discoverProvider && <DiscoverModal provider={discoverProvider} onClose={() => setDiscoverProvider(null)} />}
    </div>
  );
}
