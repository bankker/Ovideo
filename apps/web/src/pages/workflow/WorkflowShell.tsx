import { useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, Drawer, Tabs } from 'antd';
import { ArrowLeftOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { JobsPanel } from '../jobs/JobsPanel';
import { useProjectJobs } from '../../api/workflow-hooks';
import { ScriptStage } from './ScriptStage';
import { StageStub } from './StageStub';

interface StageDef {
  key: string;
  label: string;
  /** script 之外的阶段所属里程碑（用于 StageStub 展示） */
  milestone?: 'M2' | 'M3';
}

const STAGES: StageDef[] = [
  { key: 'script', label: '剧本' },
  { key: 'design', label: '设计', milestone: 'M2' },
  { key: 'material', label: '素材', milestone: 'M2' },
  { key: 'dubbing', label: '配音', milestone: 'M2' },
  { key: 'storyboard', label: '分镜', milestone: 'M2' },
  { key: 'video', label: '视频', milestone: 'M2' },
  { key: 'enhance', label: '美化', milestone: 'M3' },
  { key: 'final', label: '成品', milestone: 'M3' },
  { key: 'library', label: '素材库', milestone: 'M2' },
  { key: 'history', label: '历史', milestone: 'M2' },
];

/** 工作流壳：阶段导航 + 任务抽屉，路由 /projects/:projectId/episodes/:episodeId/:stage */
export function WorkflowShell() {
  const { projectId = '', episodeId = '', stage = 'script' } = useParams();
  const navigate = useNavigate();
  const [jobsOpen, setJobsOpen] = useState(false);

  const jobsQuery = useProjectJobs(projectId);
  const activeJobCount = useMemo(
    () =>
      (jobsQuery.data ?? []).filter((j) => j.status === 'QUEUED' || j.status === 'RUNNING').length,
    [jobsQuery.data],
  );

  const current = STAGES.find((s) => s.key === stage);
  if (!current) {
    return <Navigate to={`/projects/${projectId}/episodes/${episodeId}/script`} replace />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '0 16px',
          borderBottom: '1px solid rgba(5,5,5,0.06)',
          background: '#fff',
        }}
      >
        <Button
          type="text"
          icon={<ArrowLeftOutlined />}
          onClick={() => navigate(`/projects/${projectId}`)}
        >
          返回分集
        </Button>
        <Tabs
          activeKey={stage}
          onChange={(key) => navigate(`/projects/${projectId}/episodes/${episodeId}/${key}`)}
          items={STAGES.map((s) => ({ key: s.key, label: s.label }))}
          style={{ flex: 1 }}
          tabBarStyle={{ marginBottom: 0 }}
        />
        <Badge count={activeJobCount} size="small" offset={[-4, 4]}>
          <Button icon={<ThunderboltOutlined />} onClick={() => setJobsOpen(true)}>
            任务
          </Button>
        </Badge>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {stage === 'script' ? (
          <ScriptStage />
        ) : (
          <StageStub title={current.label} milestone={current.milestone ?? 'M2'} />
        )}
      </div>

      <Drawer
        title="任务队列"
        placement="right"
        width={640}
        open={jobsOpen}
        onClose={() => setJobsOpen(false)}
        destroyOnClose
      >
        <JobsPanel projectId={projectId} />
      </Drawer>
    </div>
  );
}
