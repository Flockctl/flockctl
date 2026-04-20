import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
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
import ProjectSettingsPage from "./pages/project-settings";
import WorkspacesPage from "./pages/workspaces";
import WorkspaceDetailPage from "./pages/workspace-detail";
import WorkspaceSettingsPage from "./pages/workspace-settings";
import ExecutionDashboardPage from "./pages/execution-dashboard";
import ChatsPage from "./pages/chats";
import DashboardPage from "./pages/dashboard";
import SettingsPage from "./pages/settings";
import SkillsMcpPage from "./pages/skills-mcp";
import AnalyticsPage from "./pages/analytics";

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
      { path: "tasks", element: <TasksPage /> },
      { path: "tasks/:taskId", element: <TaskDetailPage /> },
      { path: "templates", element: <TemplatesPage /> },
      { path: "schedules", element: <SchedulesPage /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "projects/:projectId", element: <ProjectDetailPage /> },
      { path: "projects/:projectId/settings", element: <ProjectSettingsPage /> },
      { path: "workspaces", element: <WorkspacesPage /> },
      { path: "workspaces/:workspaceId", element: <WorkspaceDetailPage /> },
      { path: "workspaces/:workspaceId/settings", element: <WorkspaceSettingsPage /> },
      { path: "projects/:projectId/execution/:milestoneId", element: <ExecutionDashboardPage /> },
      { path: "chats", element: <ChatsPage /> },
      { path: "chats/:chatId", element: <ChatsPage /> },
      { path: "skills-mcp", element: <SkillsMcpPage /> },
      { path: "analytics", element: <AnalyticsPage /> },
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
