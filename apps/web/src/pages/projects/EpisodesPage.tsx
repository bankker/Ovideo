import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App,
  Breadcrumb,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Space,
  Spin,
  Tooltip,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { Episode } from '../../api/hooks';
import {
  useCreateEpisode,
  useDeleteEpisode,
  useEpisodes,
  useProject,
  useUpdateEpisode,
} from '../../api/hooks';

type EpisodeModalState = { mode: 'create'; defaultTitle: string } | { mode: 'rename'; episode: Episode };

/** 新建 / 重命名分集共用 Modal（条件挂载，每次打开为全新表单） */
function EpisodeFormModal({
  state,
  submitting,
  onSubmit,
  onClose,
}: {
  state: EpisodeModalState;
  submitting: boolean;
  onSubmit: (values: { title: string }) => void;
  onClose: () => void;
}) {
  const [form] = Form.useForm<{ title: string }>();
  const isRename = state.mode === 'rename';
  return (
    <Modal
      open
      title={isRename ? '重命名分集' : '新建分集'}
      okText={isRename ? '保存' : '创建'}
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ title: isRename ? state.episode.title : state.defaultTitle }}
        onFinish={onSubmit}
      >
        <Form.Item
          name="title"
          label="分集标题"
          rules={[
            { required: true, whitespace: true, message: '请输入分集标题' },
            { max: 100, message: '标题不能超过 100 字' },
          ]}
        >
          <Input placeholder="例如：第 1 集" maxLength={100} autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function EpisodesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [modalState, setModalState] = useState<EpisodeModalState | null>(null);

  const projectQuery = useProject(projectId);
  const episodesQuery = useEpisodes(projectId);
  const createEpisode = useCreateEpisode();
  const updateEpisode = useUpdateEpisode();
  const deleteEpisode = useDeleteEpisode();

  const episodes = episodesQuery.data ?? [];

  const openCreateModal = () => {
    setModalState({ mode: 'create', defaultTitle: `第 ${episodes.length + 1} 集` });
  };

  const handleModalSubmit = (values: { title: string }) => {
    if (!modalState || !projectId) return;
    const title = values.title.trim();
    if (modalState.mode === 'create') {
      createEpisode.mutate(
        { projectId, data: { title } },
        {
          onSuccess: () => {
            message.success('分集创建成功');
            setModalState(null);
          },
          onError: (err) => message.error(err.message),
        },
      );
    } else {
      updateEpisode.mutate(
        { id: modalState.episode.id, projectId, data: { title } },
        {
          onSuccess: () => {
            message.success('分集已重命名');
            setModalState(null);
          },
          onError: (err) => message.error(err.message),
        },
      );
    }
  };

  const handleDelete = (episode: Episode) => {
    if (!projectId) return;
    deleteEpisode.mutate(
      { id: episode.id, projectId },
      {
        onSuccess: () => message.success('分集已删除'),
        onError: (err) => message.error(err.message),
      },
    );
  };

  const loading = projectQuery.isLoading || episodesQuery.isLoading;
  const queryError = (projectQuery.error ?? episodesQuery.error) as Error | null;

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[
          { title: <Link to="/">项目管理</Link> },
          { title: projectQuery.data?.name ?? '加载中…' },
        ]}
      />

      <Flex justify="space-between" align="center" wrap gap={12} style={{ marginBottom: 20 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {projectQuery.data ? `${projectQuery.data.name} · 分集列表` : '分集列表'}
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
          新建分集
        </Button>
      </Flex>

      {queryError ? (
        <Alert
          type="error"
          showIcon
          message="数据加载失败"
          description={queryError.message}
          action={
            <Button
              size="small"
              onClick={() => {
                void projectQuery.refetch();
                void episodesQuery.refetch();
              }}
            >
              重试
            </Button>
          }
        />
      ) : loading ? (
        <Flex justify="center" style={{ padding: 80 }}>
          <Spin size="large" />
        </Flex>
      ) : episodes.length === 0 ? (
        <Empty style={{ padding: 60 }} description="还没有分集，创建第一集开始制作吧">
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
            新建分集
          </Button>
        </Empty>
      ) : (
        <Row gutter={[16, 16]}>
          {episodes.map((episode) => (
            <Col key={episode.id} xs={24} sm={12} md={8} lg={6}>
              <Card
                title={
                  <Typography.Text strong ellipsis style={{ maxWidth: 200 }}>
                    {episode.title}
                  </Typography.Text>
                }
                actions={[
                  <Tooltip key="rename" title="重命名">
                    <EditOutlined onClick={() => setModalState({ mode: 'rename', episode })} />
                  </Tooltip>,
                  <Popconfirm
                    key="delete"
                    title="确认删除该分集？"
                    description={
                      <div style={{ maxWidth: 240 }}>
                        将删除该分集下的剧本、分镜等全部内容，不可恢复！
                      </div>
                    }
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => handleDelete(episode)}
                  >
                    <DeleteOutlined style={{ color: '#ff4d4f' }} />
                  </Popconfirm>,
                ]}
              >
                <Space direction="vertical" style={{ width: '100%' }} size={12}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    创建于 {dayjs(episode.createdAt).format('YYYY-MM-DD HH:mm')}
                  </Typography.Text>
                  <Button
                    type="primary"
                    block
                    icon={<ThunderboltOutlined />}
                    onClick={() =>
                      navigate(`/projects/${projectId}/episodes/${episode.id}/script`)
                    }
                  >
                    流程化制作
                  </Button>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {modalState && (
        <EpisodeFormModal
          key={modalState.mode === 'rename' ? modalState.episode.id : 'create'}
          state={modalState}
          submitting={createEpisode.isPending || updateEpisode.isPending}
          onSubmit={handleModalSubmit}
          onClose={() => setModalState(null)}
        />
      )}
    </div>
  );
}
