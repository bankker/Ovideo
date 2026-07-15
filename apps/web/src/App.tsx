import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from './layouts/AppLayout';
import { ProjectsPage } from './pages/projects/ProjectsPage';
import { EpisodesPage } from './pages/projects/EpisodesPage';
import { WorkflowShell } from './pages/workflow/WorkflowShell';
import { ProvidersPage } from './pages/admin/ProvidersPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
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
