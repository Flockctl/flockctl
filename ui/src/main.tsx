import { Component, lazy, StrictMode, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useParams,
} from "react-router-dom";
import "./index.css";
import { NewShell } from "./components/shell/NewShell";
import {
  dashboardHandle,
  attentionHandle,
  workspacesHandle,
  workspaceDetailHandle,
  workspaceCommitDetailHandle,
  projectsHandle,
  projectDetailHandle,
  projectCommitDetailHandle,
  chatsHandle,
  chatDetailHandle,
  tasksHandle,
  taskDetailHandle,
  schedulesHandle,
  templatesHandle,
  skillsMcpHandle,
  analyticsHandle,
  incidentsHandle,
  incidentDetailHandle,
  missionDetailHandle,
  settingsHandle,
} from "./lib/route-handles";
import { ThemeProvider } from "./components/theme-provider";
import { ServerProvider } from "./contexts/server-context";

// Route-level code-splitting (audit finding: 20+ pages were eagerly
// imported → first-paint cost paid for every page on every load).
// Each `lazy()` call produces a separate Vite chunk that downloads on
// first visit; the dashboard route ships in the initial bundle alone.
const DashboardPage = lazy(() => import("./pages/dashboard"));
const TasksPage = lazy(() => import("./pages/tasks"));
const TaskDetailPage = lazy(() => import("./pages/task-detail"));
const TemplatesPage = lazy(() => import("./pages/templates"));
const SchedulesPage = lazy(() => import("./pages/schedules"));
const ProjectsPage = lazy(() => import("./pages/projects"));
const ProjectDetailPage = lazy(() => import("./pages/project-detail"));
const WorkspacesPage = lazy(() => import("./pages/workspaces"));
const WorkspaceDetailPage = lazy(() => import("./pages/workspace-detail"));
const ChatsPage = lazy(() => import("./pages/chats"));
const SettingsPage = lazy(() => import("./pages/settings"));
const SkillsMcpPage = lazy(() => import("./pages/skills-mcp"));
const AnalyticsPage = lazy(() => import("./pages/analytics"));
const AttentionPage = lazy(() => import("./pages/attention"));
const IncidentsPage = lazy(() => import("./pages/incidents"));
const IncidentDetailPage = lazy(() => import("./pages/incident-detail"));
const MissionDetailPage = lazy(() => import("./pages/mission-detail"));
const ProjectCommitDetailPage = lazy(() =>
  import("./pages/commit-detail").then((m) => ({ default: m.ProjectCommitDetailPage })),
);
const WorkspaceCommitDetailPage = lazy(() =>
  import("./pages/commit-detail").then((m) => ({ default: m.WorkspaceCommitDetailPage })),
);
// Dev-only preview pages — see also the import.meta.env.DEV branch
// in the route registration below. Wrapping in `lazy()` means the
// chunk never downloads in production (the route registration is
// stripped too, so this is a belt-and-braces guard).
const DevCodeEditorPreviewPage = lazy(() => import("./pages/dev-code-editor-preview"));
const DevTokensPreviewPage = lazy(() => import("./pages/dev-tokens-preview"));
import { FaviconBadgeRunner } from "./lib/hooks/use-favicon-badge";
import { NotificationDispatcherProvider } from "./lib/contexts/notification-dispatcher-context";
import { ChatQueueRunnerBoot } from "./lib/hooks/use-chat-queue-runner-boot";
import {
  tabStore as codeModeTabStore,
  useEditorTabsStore,
} from "./components/code-mode/tab-store";
import { useQuickOpenIndexStore } from "./components/code-mode/quick-open-store";

// Expose code-mode stores on `window` for the Playwright e2e harness.
// The harness drives Code-mode flows via direct store calls because the
// seeded backend ships `/tmp/<name>` stubs that have no real files for
// the FileTree to read — see `e2e/code-mode-tabs.spec.ts` for the
// driver. The exposure is a no-op outside the browser environment.
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__tabStore = codeModeTabStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__editorTabsStore = useEditorTabsStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__quickOpenIndexStore = useQuickOpenIndexStore;
}

// One-shot localStorage cleanup migration.
//
// `flockctl.ui.next` was the M21 feature flag that gated the new shell
// rollout. The flag was retired when the new shell became the
// unconditional chrome (see the route table below); the residual
// localStorage entry is now dead state on machines that flipped it
// during the rollout. Drop it on first boot. The check is idempotent:
// once removed, subsequent boots see `getItem(...) === null` and the
// branch is skipped.
if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
  try {
    if (localStorage.getItem("flockctl.ui.next") !== null) {
      localStorage.removeItem("flockctl.ui.next");
    }
  } catch {
    // Storage disabled / quota errors are non-fatal — the flag will
    // simply linger until the storage backend recovers.
  }
}

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

/**
 * Top-level error boundary. Without this, any thrown render error
 * (e.g. a malformed task row from a backend version skew) crashed
 * the entire app with a blank screen — a regression vector the audit
 * called out.
 *
 * Recovery: a "Reload" button does a hard refresh, which is the safe
 * default for an unknown failure mode. We deliberately do not try to
 * recover state in-place — if the render tree blew up, the cleanest
 * thing is a clean boot.
 */
class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Surface to the daemon's existing error pipeline via console; the
    // dispatcher's notifier listens on `unhandledrejection` separately.
    console.error("[RootErrorBoundary]", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "2rem",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", margin: 0 }}>Something went wrong.</h1>
        <pre
          style={{
            maxWidth: "60ch",
            whiteSpace: "pre-wrap",
            opacity: 0.7,
            fontSize: "0.85rem",
            margin: 0,
          }}
        >
          {this.state.error.message}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: "0.5rem 1rem",
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}

/**
 * Minimal route-level loading fallback shown while the next route's
 * lazy chunk is downloading. Intentionally featherweight — no flash
 * of layout shift since `<NewShell />` is already mounted around
 * `<Outlet />`.
 */
function RouteFallback() {
  return (
    <div
      aria-busy="true"
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: 0.6,
      }}
    />
  );
}

const router = createBrowserRouter([
  {
    // M21/02 final cut-over — the new shell is now the unconditional
    // chrome. The legacy layout + flag stack was deleted in this
    // slice; routes mount inside `<NewShell />` directly with no
    // gate.
    element: (
      <NewShell>
        <Suspense fallback={<RouteFallback />}>
          <Outlet />
        </Suspense>
      </NewShell>
    ),
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: "dashboard", element: <DashboardPage />, handle: { breadcrumb: dashboardHandle } },
      { path: "attention", element: <AttentionPage />, handle: { breadcrumb: attentionHandle } },
      { path: "tasks", element: <TasksPage />, handle: { breadcrumb: tasksHandle } },
      { path: "tasks/:taskId", element: <TaskDetailPage />, handle: { breadcrumb: taskDetailHandle } },
      { path: "templates", element: <TemplatesPage />, handle: { breadcrumb: templatesHandle } },
      { path: "schedules", element: <SchedulesPage />, handle: { breadcrumb: schedulesHandle } },
      { path: "projects", element: <ProjectsPage />, handle: { breadcrumb: projectsHandle } },
      { path: "projects/:projectId", element: <ProjectDetailPage />, handle: { breadcrumb: projectDetailHandle } },
      // Legacy settings URL — now lives inside the project-detail Config
      // tab. Preserve old bookmarks by redirecting to `?tab=config`.
      { path: "projects/:projectId/settings", element: <ProjectSettingsRedirect /> },
      // Commit-detail deep link. The History list inside the SCM panel
      // navigates here; the rendered pane is `CommitDetailTab` (file
      // list + lazy per-file diff editor).
      {
        path: "projects/:projectId/git/commit/:sha",
        element: <ProjectCommitDetailPage />,
        handle: { breadcrumb: projectCommitDetailHandle },
      },
      { path: "workspaces", element: <WorkspacesPage />, handle: { breadcrumb: workspacesHandle } },
      { path: "workspaces/:workspaceId", element: <WorkspaceDetailPage />, handle: { breadcrumb: workspaceDetailHandle } },
      {
        path: "workspaces/:workspaceId/git/commit/:sha",
        element: <WorkspaceCommitDetailPage />,
        handle: { breadcrumb: workspaceCommitDetailHandle },
      },
      // Legacy settings URL — now lives inside the workspace-detail Config
      // tab. Preserve old bookmarks by redirecting to `?tab=config`.
      { path: "workspaces/:workspaceId/settings", element: <WorkspaceSettingsRedirect /> },
      { path: "chats", element: <ChatsPage />, handle: { breadcrumb: chatsHandle } },
      { path: "chats/:chatId", element: <ChatsPage />, handle: { breadcrumb: chatDetailHandle } },
      { path: "skills-mcp", element: <SkillsMcpPage />, handle: { breadcrumb: skillsMcpHandle } },
      { path: "analytics", element: <AnalyticsPage />, handle: { breadcrumb: analyticsHandle } },
      { path: "incidents", element: <IncidentsPage />, handle: { breadcrumb: incidentsHandle } },
      { path: "incidents/:id", element: <IncidentDetailPage />, handle: { breadcrumb: incidentDetailHandle } },
      // Mission Detail (M20/01) — read-only timeline + budget panel.
      // Mutations (proposals/autonomy/abort) still live on the
      // project-detail mission tree panel.
      { path: "missions/:missionId", element: <MissionDetailPage />, handle: { breadcrumb: missionDetailHandle } },
      { path: "settings", element: <SettingsPage />, handle: { breadcrumb: settingsHandle } },
      // Dev-only preview routes — both gated by `import.meta.env.DEV` so
      // the page components AND their lazy chunks are stripped from
      // production builds. Previously the `dev/code-editor-preview`
      // route registration was unconditional, which kept the 44-line
      // dev preview reachable in shipped artefacts for no real purpose.
      ...(import.meta.env.DEV
        ? [
            { path: "dev/code-editor-preview", element: <DevCodeEditorPreviewPage /> },
            { path: "dev/tokens-preview", element: <DevTokensPreviewPage /> },
          ]
        : []),
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ServerProvider>
          <NotificationDispatcherProvider>
            {/*
              FaviconBadgeRunner mounts the useAttention-driven favicon-badge
              hook. It must sit inside QueryClientProvider + ServerProvider so
              useAttention has both a QueryClient and an active server id; it
              renders nothing, so its position relative to RouterProvider is
              inert from a layout standpoint.

              NotificationDispatcherProvider wraps both so the singleton
              Dispatcher's LeaderElection is shared across the whole app —
              `useLeaderStatus()` inside Settings must see the same election
              instance the dispatcher gates on.
            */}
            <FaviconBadgeRunner />
            {/*
              Background chat-queue runner — drains queued messages for
              chats the user is not currently viewing. Renders nothing;
              must sit inside QueryClientProvider so it can read /
              invalidate `chat(id)` rows. See ChatQueueRunnerBoot for
              the StrictMode-safety contract.
            */}
            <ChatQueueRunnerBoot />
            {/*
              The attention → notification pipeline runs from inside
              <Layout /> (mounted by RouterProvider) because its hook
              calls `useLocation()` for the self-poke suppression rule —
              that hook only resolves under the RouterProvider tree.
              Mounting here as a sibling of RouterProvider would crash
              with "useLocation must be used within Router".

              The task-terminal → notification pipeline rides alongside
              it inside <Layout />. It does not strictly need
              `useLocation()` (terminal events fire regardless of which
              route the user is on), but co-locating both runners keeps
              the per-tab baseline + WS subscription lifecycle symmetric
              and avoids opening a second global-WS connection just for
              this one consumer.
            */}
            <RouterProvider router={router} />
          </NotificationDispatcherProvider>
        </ServerProvider>
      </QueryClientProvider>
    </ThemeProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
