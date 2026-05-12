# UI Pages — Per-page Reference

A field guide to every routed page under `ui/src/pages/`. Each entry
captures the four things you need to navigate the page from cold:

- **File** — the page module on disk.
- **Route** — the URL path registered in [`ui/src/main.tsx`](../ui/src/main.tsx).
- **Main hooks** — the data + URL-state hooks that drive the view (skip
  generic React hooks like `useEffect`/`useState`).
- **Deep-link contract** — query-string keys the page reads/writes via
  `useSearchParams`. Anything not listed here is not part of the
  contract; reset it freely.
- **Visual baselines** — Playwright screenshot names under
  `ui/e2e/__screenshots__/<spec>.spec.ts/`. Use these as the diff
  target when re-baselining.

This file is hand-maintained — there is no generator. When you add a
new page, add the row here in the same change.

For the design system itself (tokens, primitives, layout rules) see
[`ui/CONTRIBUTING-DESIGN.md`](../ui/CONTRIBUTING-DESIGN.md). For the
agent-facing project rules see [`AGENTS.md`](../AGENTS.md). For the
testing tier ladder see [`docs/TESTING.md`](TESTING.md).

---

## Top-level pages

### Dashboard
- **File:** [`ui/src/pages/dashboard.tsx`](../ui/src/pages/dashboard.tsx)
- **Route:** `/dashboard` (also the index → redirects from `/`)
- **Main hooks:** `useTasks`, `useChats`, `useProjects`, `useMissions`, `useUsageSummary`, `useAttention`, `useTimeRange`
- **Deep-link contract:** none.
- **Visual baselines:** `dashboard.spec.ts/` (currently no committed
  baselines — the spec exercises behaviour, not pixels).

### Attention
- **File:** [`ui/src/pages/attention.tsx`](../ui/src/pages/attention.tsx)
- **Route:** `/attention`
- **Main hooks:** `useAttentionInbox` (composes `attention-sources`)
- **Deep-link contract:** none.
- **Visual baselines:** `attention.spec.ts/attention-{default,critical-only,empty}-{dark,light}.png`

### Tasks (list)
- **File:** [`ui/src/pages/tasks.tsx`](../ui/src/pages/tasks.tsx)
- **Route:** `/tasks`
- **Main hooks:** `useTasks`, `useProjects`, `useTaskStats`, `useCancelTask`, `useTasksProjectFilter`, `useTasksRangeFilter`, `useTasksSearchQuery`, `useTasksStatusFilter`
- **Deep-link contract:** filter state lives in URL via the
  `useTasks*Filter` hooks (status, project, range, search query).
- **Visual baselines:** `tasks.spec.ts/tasks-{default,empty,filtered-failed}-*.png`, `tasks-bulk-selected.png`

### Task Detail
- **File:** [`ui/src/pages/task-detail.tsx`](../ui/src/pages/task-detail.tsx)
- **Route:** `/tasks/:taskId`
- **Main hooks:** `useTask`, `useProject`, `useTaskLogStream` (SSE), `useAgentQuestions`, `useAnswerAgentQuestion`, `useApproveTask` / `useRejectTask`, `useCancelTask`, `useRerunTask`, `useUpdateTask`, `useUpdateProject`, `useTrackRecent`
- **Deep-link contract:** `:taskId` only; no query params.
- **Visual baselines:** none committed (covered by `task-detail.spec.ts`
  via DOM assertions).

### Templates
- **File:** [`ui/src/pages/templates.tsx`](../ui/src/pages/templates.tsx)
- **Route:** `/templates`
- **Main hooks:** `useTemplates`, `useDeleteTemplate`, `useUpdateTemplate`, `useCreateChat`, `useConfirmDialog`
- **Deep-link contract:** none.
- **Visual baselines:** `templates.spec.ts/templates-{empty,grid-{dark,light},new-dialog-{dark,light}}.png`

### Schedules
- **File:** [`ui/src/pages/schedules.tsx`](../ui/src/pages/schedules.tsx)
- **Route:** `/schedules`
- **Main hooks:** `useSchedules`, `useScheduleMutation`, `usePauseSchedule`, `useResumeSchedule`, `useTriggerSchedule`, `useDeleteSchedule`, `useConfirmDialog`
- **Deep-link contract:** none.
- **Visual baselines:** `schedules.spec.ts/schedules-{default,empty}-{dark,light}.png`

### Projects (list)
- **File:** [`ui/src/pages/projects.tsx`](../ui/src/pages/projects.tsx)
- **Route:** `/projects`
- **Main hooks:** `useProjects`, `useWorkspaces`, `useProjectsView`, `useDeleteProject`, `useAttention`, `useConfirmDialog`
- **Deep-link contract:**
  - `q` — search query
  - `filter` — preset filter chip (`all`, `standalone`, …)
  - View toggle (cards vs table) is persisted via `useProjectsView`.
- **Visual baselines:** `projects.spec.ts/projects-{cards,table}-{dark,light}.png`, `projects-filtered-{empty,standalone}.png`

### Project Detail
- **File:** [`ui/src/pages/project-detail.tsx`](../ui/src/pages/project-detail.tsx)
- **Route:** `/projects/:projectId`
- **Main hooks:** `useProject`, `useProjectConfig`, `useProjectTree`, `useKpiData`, `useCreateChat`, `useSelection`, `useAttention`, `useTrackRecent`
- **Deep-link contract:**
  - `tab` — which `ProjectTabId` is active (`plan`, `code`, `runs`,
    `templates`, `config`, …). Validated by `isTabId`; unknown values
    fall back to the default tab.
  - The legacy `/projects/:projectId/settings` URL redirects to
    `?tab=config` via `ProjectSettingsRedirect`.
- **Visual baselines:** `project-detail.spec.ts/project-detail-{plan,code,runs,templates,config}-*.png`, `project-detail-empty-milestones.png`

### Project Commit Detail
- **File:** [`ui/src/pages/commit-detail.tsx`](../ui/src/pages/commit-detail.tsx)
- **Route:** `/projects/:projectId/git/commit/:sha`
- **Main hooks:** see `commit-detail.tsx`; reuses the SCM commit-detail
  pane (file list + lazy per-file diff).
- **Deep-link contract:** `:projectId` and `:sha` only.
- **Visual baselines:** none committed.

### Workspaces (list)
- **File:** [`ui/src/pages/workspaces.tsx`](../ui/src/pages/workspaces.tsx)
- **Route:** `/workspaces`
- **Main hooks:** `useWorkspaces`, `useProjects`, `useDeleteWorkspace`, `useConfirmDialog`
- **Deep-link contract:** none.
- **Visual baselines:** `workspaces.spec.ts/workspaces-{empty,grid-{dark,light},new-dialog,create-dialog-scrolled}.png`

### Workspace Detail
- **File:** [`ui/src/pages/workspace-detail.tsx`](../ui/src/pages/workspace-detail.tsx)
- **Route:** `/workspaces/:workspaceId`
- **Main hooks:** `useWorkspace`, `useWorkspaceDashboard`, `useChats`, `useCreateChat`, `useAttention`, `useWorkspaceTab`, `useTrackRecent`
- **Deep-link contract:** active tab via `useWorkspaceTab` (URL-backed
  helper in [`ui/src/lib/use-workspace-tab.ts`](../ui/src/lib/use-workspace-tab.ts)).
  Legacy `/workspaces/:workspaceId/settings` redirects to the Config tab.
- **Visual baselines:** `workspaces.spec.ts/workspace-detail-config-tab-{full,danger-zone}.png`, `workspace-detail-header-chat-button-matches-project.png`, plus per-tab specs in `workspace-detail-tabs.spec.ts`.

### Workspace Commit Detail
- **File:** see `WorkspaceCommitDetailPage` import in `main.tsx`
- **Route:** `/workspaces/:workspaceId/git/commit/:sha`
- **Visual baselines:** none committed.

### Chats
- **File:** [`ui/src/pages/chats.tsx`](../ui/src/pages/chats.tsx)
- **Routes:** `/chats` (list) and `/chats/:chatId` (detail in same page)
- **Main hooks:** `useChats`, `useChat`, `useCreateChat`, `useDeleteChat`, `useChatListLiveState`, `useChatReadMap`, `useProjects`, `useTrackRecent`, `useConfirmDialog`
- **Deep-link contract:**
  - `q` — search query
  - `group` — grouping mode for the list pane
  - `:chatId` selects the active conversation.
- **Visual baselines:** `chats.spec.ts/chats-{empty,filtered-empty,grouped-{dark,light},list-{dark,light}}.png`. Conversation-internal visuals in `chat-conversation.spec.ts/`.

### Skills & MCP
- **File:** [`ui/src/pages/skills-mcp.tsx`](../ui/src/pages/skills-mcp.tsx)
- **Route:** `/skills-mcp`
- **Main hooks:** `useGlobalSkills`, `useGlobalMcpServers`, `useWorkspaces`, `useWorkspaceSkills`, `useWorkspaceMcpServers`, `useProjects`, `useProjectSkills`, `useProjectMcpServers`
- **Deep-link contract:** none.
- **Visual baselines:** `skills-mcp.spec.ts/skills-mcp-{default-{dark,light},empty}.png`

### Analytics
- **File:** [`ui/src/pages/analytics.tsx`](../ui/src/pages/analytics.tsx)
- **Route:** `/analytics`
- **Main hooks:** `useMetricsOverview`, `useUsageBreakdown`, `useTasks`, `useAnalyticsRange`
- **Deep-link contract:** range filter via `useAnalyticsRange`
  (URL-backed; e.g. `range=7d`).
- **Visual baselines:** none committed (component-level Vitest tests
  cover the KPI row, charts, and by-project table).

### Incidents (list)
- **File:** [`ui/src/pages/incidents.tsx`](../ui/src/pages/incidents.tsx)
- **Route:** `/incidents`
- **Main hooks:** `useIncidents`, `useDeleteIncident`, `useConfirmDialog`
- **Deep-link contract:** none.
- **Visual baselines:** `incidents.spec.ts/incidents-{list,detail,empty}-{dark,light}.png`

### Incident Detail
- **File:** [`ui/src/pages/incident-detail.tsx`](../ui/src/pages/incident-detail.tsx)
- **Route:** `/incidents/:id`
- **Main hooks:** `useIncident`, `useUpdateIncident`, `useDeleteIncident`, `useConfirmDialog`
- **Deep-link contract:** `:id` only.

### Mission Detail
- **File:** [`ui/src/pages/mission-detail.tsx`](../ui/src/pages/mission-detail.tsx)
- **Route:** `/missions/:missionId`
- **Main hooks:** `useMission`, `useMissionEvents`, `useMissionProposals`, `useTrackRecent`
- **Deep-link contract:** `:missionId` only. Read-only view —
  proposal/autonomy/abort mutations live on the project-detail
  Mission tree panel.
- **Visual baselines:** `mission-detail.spec.ts/mission-detail-{default,completed,budget-warning,empty-proposals}-{dark,light}.png`

### Settings
- **File:** [`ui/src/pages/settings.tsx`](../ui/src/pages/settings.tsx)
- **Route:** `/settings`
- **Main hooks:** `useSearchParams` (the page is a thin tab router; the
  data hooks live inside each `settings-components/*Section.tsx`).
- **Deep-link contract:** `tab` — one of `account`, `secrets`, `server`,
  `skills`, `ui`. Unknown values fall back to the default tab.
- **Visual baselines:** `settings.spec.ts/settings-{account,secrets,server,skills,ui}-{dark,light}.png`

---

## Dev-only routes

These are registered in `main.tsx` but not part of the user-facing
nav. Production builds skip the `tokens-preview` registration so the
route 404s in shipped artefacts.

### Code Editor Preview
- **File:** [`ui/src/pages/dev-code-editor-preview.tsx`](../ui/src/pages/dev-code-editor-preview.tsx)
- **Route:** `/dev/code-editor-preview`
- **Why it exists:** smoke surface for the Monaco-backed `CodeEditor`
  wrapper; also keeps Vite from tree-shaking the lazy `monaco` chunk.

### Tokens Preview (dev-only)
- **File:** [`ui/src/pages/dev-tokens-preview.tsx`](../ui/src/pages/dev-tokens-preview.tsx)
- **Route:** `/dev/tokens-preview` (dev builds only)
- **Visual baselines:** `tokens-preview.spec.ts/tokens-preview-{default,primitives,utilities}-{dark,light}.png`

---

## Cross-cutting visual baselines

Some specs cover chrome shared across pages — re-baseline them when
you change the shell, breadcrumb, or palette:

- **Shell chrome:** `shell.spec.ts/shell-{sidebar,sidebar-hover,titlebar,breadcrumb-*}-*.png`
- **Legacy snapshots:** `visual-legacy-pages.spec.ts/legacy-*.png` — a
  one-shot baseline per page at full viewport, used to catch
  large-area regressions during the M21/M22 shell + palette migration.
  Safe to re-baseline after intentional layout work; investigate if it
  changes by accident.
