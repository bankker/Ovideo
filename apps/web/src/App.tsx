import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from './layouts/AppLayout';
import { ProjectsPage } from './pages/projects/ProjectsPage';
import { EpisodesPage } from './pages/projects/EpisodesPage';
import { WorkflowShell } from './pages/workflow/WorkflowShell';
import { ProvidersPage } from './pages/admin/ProvidersPage';
import { StoryboardWorkspace } from './pages/storyboard/StoryboardWorkspace';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/*
          分镜工作台刻意放在 AppLayout 之外：它自带顶栏并独占 100vh。
          套进 AppLayout 会同时得到两条顶栏、以及 Content 的 24px padding 与
          overflow:auto——外层先滚一次、内层再滚一次，三栏的高度链就断了。
          路由比 :stage 那条多一段，react-router 会优先匹配到这里，不必担心被吃掉。
        */}
        <Route
          path="/projects/:projectId/episodes/:episodeId/storyboard/workspace"
          element={<StoryboardWorkspace />}
        />
        <Route element={<AppLayout />}>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<EpisodesPage />} />
          <Route path="/projects/:projectId/episodes/:episodeId/:stage" element={<WorkflowShell />} />
          <Route path="/admin/providers" element={<ProvidersPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
