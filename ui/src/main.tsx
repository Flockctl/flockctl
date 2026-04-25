import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  useParams,
} from "react-router-dom";
import "./index.css";
import Layout from "./components/layout";
import { ThemeProvider } from "./components/theme-provider";
import { ServerProvider } from "./contexts/server-context";
import TasksPage from "./pages/tasks";
import TaskDetailPage from "./pages/task-detail";
import TemplatesPage from "./pages/templates";
import SchedulesPage from "./pages/schedules";
import ProjectsPage from "./pages/projects";
import ProjectDetailPage from "./pages/project-detail";
import WorkspacesPage from "./pages/workspaces";
import WorkspaceDetailPage from "./pages/workspace-detail";
import ChatsPage from "./pages/chats";
import DashboardPage from "./pages/dashboard";
import SettingsPage from "./pages/settings";
import SkillsMcpPage from "./pages/skills-mcp";
import AnalyticsPage from "./pages/analytics";
import AttentionPage from "./pages/attention";
import IncidentDetailPage from "./pages/incident-detail";

/**
 * Redirect helper for the retired `/projects/:projectId/settings` route.
 * The former ProjectSettingsPage has been folded into the ConfigTab inside
 * project-detail, so we forward any deep link to `?tab=config` and keep
 * existing bookmarks working.
 */
function ProjectSettingsRedirect() {
  const { projectId } = useParams<{ projectId: string }>();
  return <Navigate to={`/projects/${projectId}?tab=config`} replace />;
}

/**
 * Redirect helper for the retired `/workspaces/:workspaceId/settings`
 * route. The former WorkspaceSettingsPage has been folded into the
 * Config tab inside workspace-detail, so we forward any deep link to
 * `?tab=config` and keep existing bookmarks working.
 */
function WorkspaceSettingsRedirect() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return <Navigate to={`/workspaces/${workspaceId}?tab=config`} replace />;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: "dashboard", element: <DashboardPage /> },
      { path: "attention", element: <AttentionPage /> },
      { path: "tasks", element: <TasksPage /> },
      { path: "tasks/:taskId", element: <TaskDetailPage /> },
      { path: "templates", element: <TemplatesPage /> },
      { path: "schedules", element: <SchedulesPage /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "projects/:projectId", element: <ProjectDetailPage /> },
      // Legacy settings URL — now lives inside the project-detail Config
      // tab. Preserve old bookmarks by redirecting to `?tab=config`.
      { path: "projects/:projectId/settings", element: <ProjectSettingsRedirect /> },
      { path: "workspaces", element: <WorkspacesPage /> },
      { path: "workspaces/:workspaceId", element: <WorkspaceDetailPage /> },
      // Legacy settings URL — now lives inside the workspace-detail Config
      // tab. Preserve old bookmarks by redirecting to `?tab=config`.
      { path: "workspaces/:workspaceId/settings", element: <WorkspaceSettingsRedirect /> },
      { path: "chats", element: <ChatsPage /> },
      { path: "chats/:chatId", element: <ChatsPage /> },
      { path: "skills-mcp", element: <SkillsMcpPage /> },
      { path: "analytics", element: <AnalyticsPage /> },
      { path: "incidents/:id", element: <IncidentDetailPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ServerProvider>
          <RouterProvider router={router} />
        </ServerProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
