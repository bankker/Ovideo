/** 任务面板（v2 §7 前端呈现）：轮询任务列表，支持取消/重试与状态筛选 */
import { useState, type ReactNode } from 'react';
import { Button, Empty, List, Popconfirm, Progress, Segmented, Space, Tag, Typography, message } from 'antd';
import { ReloadOutlined, StopOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { JobStatus } from '@ovideo/shared';
import { useCancelJob, useJobs, useRetryJob, type JobItem } from '../../api/admin-hooks';

const { Text } = Typography;

/** 任务类型中文名（未收录的原样展示） */
const JOB_TYPE_NAMES: Record<string, string> = {
  GENERATE_STORYBOARD: '生成分镜',
  GENERATE_IMAGE: '生成图片',
  GENERATE_VIDEO: '生成视频',
  GENERATE_TTS: '生成配音',
};

const STATUS_META: Record<JobStatus, { color: string; label: string }> = {
  QUEUED: { color: 'default', label: '排队中' },
  RUNNING: { color: 'processing', label: '执行中' },
  SUCCEEDED: { color: 'success', label: '已完成' },
  FAILED: { color: 'error', label: '失败' },
  CANCELED: { color: 'warning', label: '已取消' },
};

type FilterValue = 'ALL' | 'RUNNING' | 'FAILED';

export function JobsPanel({ projectId }: { projectId: string }) {
  const [filter, setFilter] = useState<FilterValue>('ALL');
  const { data: jobs, isLoading } = useJobs(projectId);
  const cancelJob = useCancelJob();
  const retryJob = useRetryJob();

  const list = (jobs ?? []).filter((job) => (filter === 'ALL' ? true : job.status === filter));

  const handleCancel = (job: JobItem) => {
    cancelJob.mutate(job.id, {
      onSuccess: () => message.success('任务已取消'),
      onError: (err) => message.error(err.message),
    });
  };

  const handleRetry = (job: JobItem) => {
    retryJob.mutate(job.id, {
      onSuccess: () => message.success('已重新排队'),
      onError: (err) => message.error(err.message),
    });
  };

  const renderActions = (job: JobItem) => {
    const actions: ReactNode[] = [];
    if (job.status === 'QUEUED') {
      actions.push(
        <Popconfirm
          key="cancel"
          title="确定取消该任务？"
          okText="取消任务"
          cancelText="再想想"
          onConfirm={() => handleCancel(job)}
        >
          <Button
            size="small"
            danger
            icon={<StopOutlined />}
            loading={cancelJob.isPending && cancelJob.variables === job.id}
          >
            取消
          </Button>
        </Popconfirm>,
      );
    }
    if (job.status === 'FAILED') {
      actions.push(
        <Button
          key="retry"
          size="small"
          type="primary"
          ghost
          icon={<ReloadOutlined />}
          loading={retryJob.isPending && retryJob.variables === job.id}
          onClick={() => handleRetry(job)}
        >
          重试
        </Button>,
      );
    }
    return actions;
  };

  return (
    <div>
      <Segmented<FilterValue>
        value={filter}
        onChange={setFilter}
        options={[
          { label: '全部', value: 'ALL' },
          { label: '执行中', value: 'RUNNING' },
          { label: '失败', value: 'FAILED' },
        ]}
        style={{ marginBottom: 12 }}
      />
      <List<JobItem>
        loading={isLoading}
        dataSource={list}
        rowKey={(job) => job.id}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务" /> }}
        renderItem={(job) => (
          <List.Item actions={renderActions(job)}>
            <List.Item.Meta
              title={
                <Space wrap>
                  <Text strong>{JOB_TYPE_NAMES[job.type] ?? job.type}</Text>
                  <Tag color={STATUS_META[job.status]?.color ?? 'default'}>
                    {STATUS_META[job.status]?.label ?? job.status}
                  </Tag>
                  {job.status === 'RUNNING' && (
                    <Progress percent={job.progress} size="small" style={{ width: 140, margin: 0 }} />
                  )}
                  {job.modelKey && <Tag>{job.modelKey}</Tag>}
                </Space>
              }
              description={
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    创建于 {dayjs(job.createdAt).format('MM-DD HH:mm:ss')}
                    {job.attempts > 1 ? `（第 ${job.attempts} 次尝试）` : ''}
                  </Text>
                  {job.error && (
                    <Text type="danger" style={{ fontSize: 12 }}>
                      {job.error}
                    </Text>
                  )}
                </Space>
              }
            />
          </List.Item>
        )}
      />
    </div>
  );
}
