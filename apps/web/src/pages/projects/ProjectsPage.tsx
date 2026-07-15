import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Dropdown,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from 'antd';
import type { MenuProps } from 'antd';
import { MoreOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { Project } from '../../api/hooks';
import { useCreateProject, useDeleteProject, useProjects, useUpdateProject } from '../../api/hooks';

type ProjectModalState = { mode: 'create' } | { mode: 'edit'; project: Project };

interface ProjectFormValues {
  name: string;
  description?: string;
}

/** 新建 / 编辑项目共用的 Modal（条件挂载，每次打开为全新表单） */
function ProjectFormModal({
  state,
  submitting,
  onSubmit,
  onClose,
}: {
  state: ProjectModalState;
  submitting: boolean;
  onSubmit: (values: ProjectFormValues) => void;
  onClose: () => void;
}) {
  const [form] = Form.useForm<ProjectFormValues>();
  const isEdit = state.mode === 'edit';
  return (
    <Modal
      open
      title={isEdit ? '编辑项目' : '新建项目'}
      okText={isEdit ? '保存' : '创建'}
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={
          isEdit
            ? { name: state.project.name, description: state.project.description }
            : { name: '', description: '' }
        }
        onFinish={onSubmit}
      >
        <Form.Item
          name="name"
          label="项目名称"
          rules={[
            { required: true, whitespace: true, message: '请输入项目名称' },
            { max: 100, message: '名称不能超过 100 字' },
          ]}
        >
          <Input placeholder="例如：都市异能第一季" maxLength={100} autoFocus />
        </Form.Item>
        <Form.Item
          name="description"
          label="项目描述"
          rules={[{ max: 2000, message: '描述不能超过 2000 字' }]}
        >
          <Input.TextArea rows={3} placeholder="选填，简要说明题材、风格等" maxLength={2000} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 项目卡片：点击进入分集页，右上角 Dropdown 承载编辑/归档/删除 */
function ProjectCard({
  project,
  deleting,
  onOpen,
  onEdit,
  onToggleArchive,
  onDelete,
}: {
  project: Project;
  deleting: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const menuItems: MenuProps['items'] = [
    { key: 'edit', label: '重命名 / 修改描述' },
    { key: 'archive', label: project.archived ? '取消归档' : '归档' },
    { type: 'divider' },
    { key: 'delete', label: '删除', danger: true },
  ];

  return (
    <Card
      hoverable
      onClick={onOpen}
      title={
        <Space>
          <Typography.Text strong ellipsis style={{ maxWidth: 160 }}>
            {project.name}
          </Typography.Text>
          {project.archived && <Tag color="orange">已归档</Tag>}
        </Space>
      }
      extra={
        <Popconfirm
          title="确认删除该项目？"
          description={
            <div style={{ maxWidth: 260 }}>
              删除后将级联删除项目下的全部分集、剧本、分镜、素材与任务记录，且不可恢复！
            </div>
          }
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true, loading: deleting }}
          open={confirmOpen}
          onOpenChange={(open) => {
            if (!open) setConfirmOpen(false);
          }}
          onConfirm={() => {
            setConfirmOpen(false);
            onDelete();
          }}
        >
          <Dropdown
            trigger={['click']}
            menu={{
              items: menuItems,
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === 'edit') onEdit();
                else if (key === 'archive') onToggleArchive();
                else if (key === 'delete') setConfirmOpen(true);
              },
            }}
          >
            <Button
              type="text"
              size="small"
              icon={<MoreOutlined />}
              onClick={(e) => e.stopPropagation()}
            />
          </Dropdown>
        </Popconfirm>
      }
    >
      <Typography.Paragraph type={project.description ? undefined : 'secondary'} ellipsis={{ rows: 2 }} style={{ minHeight: 44 }}>
        {project.description || '暂无描述'}
      </Typography.Paragraph>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        创建于 {dayjs(project.createdAt).format('YYYY-MM-DD HH:mm')}
      </Typography.Text>
    </Card>
  );
}

export function ProjectsPage() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [showArchived, setShowArchived] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [modalState, setModalState] = useState<ProjectModalState | null>(null);

  const projectsQuery = useProjects(showArchived);
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();

  const filteredProjects = useMemo(() => {
    const list = projectsQuery.data ?? [];
    const kw = keyword.trim().toLowerCase();
    return kw ? list.filter((p) => p.name.toLowerCase().includes(kw)) : list;
  }, [projectsQuery.data, keyword]);

  const handleModalSubmit = (values: ProjectFormValues) => {
    if (!modalState) return;
    const payload = {
      name: values.name.trim(),
      description: values.description?.trim() ?? '',
    };
    if (modalState.mode === 'create') {
      createProject.mutate(payload, {
        onSuccess: () => {
          message.success('项目创建成功');
          setModalState(null);
        },
        onError: (err) => message.error(err.message),
      });
    } else {
      updateProject.mutate(
        { id: modalState.project.id, data: payload },
        {
          onSuccess: () => {
            message.success('项目已更新');
            setModalState(null);
          },
          onError: (err) => message.error(err.message),
        },
      );
    }
  };

  const handleToggleArchive = (project: Project) => {
    updateProject.mutate(
      { id: project.id, data: { archived: !project.archived } },
      {
        onSuccess: () => message.success(project.archived ? '已取消归档' : '项目已归档'),
        onError: (err) => message.error(err.message),
      },
    );
  };

  const handleDelete = (project: Project) => {
    deleteProject.mutate(project.id, {
      onSuccess: () => message.success('项目已删除'),
      onError: (err) => message.error(err.message),
    });
  };

  return (
    <div>
      <Flex justify="space-between" align="center" wrap gap={12} style={{ marginBottom: 20 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          项目管理
        </Typography.Title>
        <Space wrap>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索项目名称"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 220 }}
          />
          <Space size={6}>
            <Switch size="small" checked={showArchived} onChange={setShowArchived} />
            <Typography.Text type="secondary">显示已归档</Typography.Text>
          </Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalState({ mode: 'create' })}>
            新建项目
          </Button>
        </Space>
      </Flex>

      {projectsQuery.isError ? (
        <Alert
          type="error"
          showIcon
          message="项目列表加载失败"
          description={(projectsQuery.error as Error).message}
          action={
            <Button size="small" onClick={() => void projectsQuery.refetch()}>
              重试
            </Button>
          }
        />
      ) : projectsQuery.isLoading ? (
        <Flex justify="center" style={{ padding: 80 }}>
          <Spin size="large" />
        </Flex>
      ) : filteredProjects.length === 0 ? (
        <Empty
          style={{ padding: 60 }}
          description={keyword.trim() ? '没有匹配的项目' : '还没有项目，点击右上角「新建项目」开始创作'}
        >
          {!keyword.trim() && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalState({ mode: 'create' })}>
              新建项目
            </Button>
          )}
        </Empty>
      ) : (
        <Row gutter={[16, 16]}>
          {filteredProjects.map((project) => (
            <Col key={project.id} xs={24} sm={12} md={8} lg={6}>
              <ProjectCard
                project={project}
                deleting={deleteProject.isPending && deleteProject.variables === project.id}
                onOpen={() => navigate(`/projects/${project.id}`)}
                onEdit={() => setModalState({ mode: 'edit', project })}
                onToggleArchive={() => handleToggleArchive(project)}
                onDelete={() => handleDelete(project)}
              />
            </Col>
          ))}
        </Row>
      )}

      {modalState && (
        <ProjectFormModal
          key={modalState.mode === 'edit' ? modalState.project.id : 'create'}
          state={modalState}
          submitting={createProject.isPending || updateProject.isPending}
          onSubmit={handleModalSubmit}
          onClose={() => setModalState(null)}
        />
      )}
    </div>
  );
}
