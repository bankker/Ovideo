import { useMemo, useState, type ComponentType } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, Drawer, Tabs } from 'antd';
import { ArrowLeftOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { JobsPanel } from '../jobs/JobsPanel';
import { useProjectJobs } from '../../api/workflow-hooks';
import { ScriptStage } from './ScriptStage';
import { DesignStage } from './DesignStage';
import { MaterialStage } from './MaterialStage';
import { DubbingStage } from './DubbingStage';
import { StoryboardStage } from './StoryboardStage';
import { VideoStage } from './VideoStage';
import { EnhanceStage } from './EnhanceStage';
import { FinalStage } from './FinalStage';
import { LibraryPage } from '../library/LibraryPage';
import { HistoryPage } from '../library/HistoryPage';

interface StageDef {
  key: string;
  label: string;
  component: ComponentType;
}

const STAGES: StageDef[] = [
  { key: 'script', label: '剧本', component: ScriptStage },
  { key: 'design', label: '设计', component: DesignStage },
  { key: 'material', label: '素材', component: MaterialStage },
  { key: 'dubbing', label: '配音', component: DubbingStage },
  { key: 'storyboard', label: '分镜', component: StoryboardStage },
  { key: 'video', label: '视频', component: VideoStage },
  { key: 'enhance', label: '美化', component: EnhanceStage },
  { key: 'final', label: '成品', component: FinalStage },
  { key: 'library', label: '素材库', component: LibraryPage },
  { key: 'history', label: '历史', component: HistoryPage },
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
  const StageComponent = current.component;

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
        <StageComponent />
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
