# E2E Test Flows

Registry of Playwright end-to-end specs and the user-facing flows they
guard. Specs are grouped by where they run:

- **Local** — executed by `cd ui && npm run test:e2e` against a real
  daemon + Vite dev server on the contributor's machine and in CI
  ([.github/workflows/ci.yml](../../.github/workflows/ci.yml)). This is
  the default tier; new specs land here unless they are explicitly
  staging-only.
- **Staging** — flows that require a hosted backend, real provider
  keys, or production-like data. Run on demand against the staging
  environment; not part of the default `npm run test:e2e` pass.

Add new entries inline next to the related flows so the registry stays
sortable by feature surface rather than by spec filename.

## Local

### Workspaces

| Spec | Cases | Notes |
|---|---|---|
| `ui/e2e/workspaces.spec.ts` | lists a workspace created via API; workspace detail page renders after navigation; workspace settings page renders (legacy URL → `?tab=config` redirect); workspace-create Browse button opens the directory picker; **list row with attention renders a 3-waiting badge** (visual baseline `workspaces-list-row-with-waiting-badge.png`); **create-dialog scrolls inside a 1280×600 viewport** (visual baseline `workspaces-create-dialog-scrolled.png`); **Config tab save** surfaces the "Saved" badge and round-trips the edit via `GET /workspaces/:id`; **Config tab save failure** (`page.route` stubs PATCH → 500) flips the inline `workspace-config-error` paragraph and suppresses the "Saved" badge; **Danger Zone delete** confirms through the `ConfirmDialog`, navigates to `/workspaces`, and the backend 404s on the deleted id; visual baselines `workspace-detail-config-tab-full.png` (entire `workspace-config-tab` container, waited for every card / panel heading) and `workspace-detail-config-tab-danger-zone.png` (just the Danger Zone card via `workspace-config-danger-zone`) | List-page parity baselines, Create-dialog scroll guard, and Config-tab behaviour + visual baselines for the Workspaces UI alignment milestone. Config-tab selectors are role-based (`getByRole('tab', { name: /config/i })`, `getByRole('textbox', { name: /description/i })`) with no class-name coupling; component-level contract tests live under `ui/src/pages/workspace-detail-components/__tests__/WorkspaceConfigTab.test.tsx`. |
| `ui/e2e/workspace-detail-tabs.spec.ts` | clicking each tab writes the matching `?tab=` to the URL and flips Radix `data-state="active"`; deep-link `?tab=runs` survives a full reload; `?tab=<script>alert(1)</script>` silently falls back to Plan and the raw payload is never echoed into the tab container's text; **Plan tab renders the `ProjectsAccordion` for a seeded workspace with projects**; **Runs tab renders one per-project link Button whose `href` targets the project-side Runs tab**; **Templates tab renders the seeded workspace-scoped template row plus the Schedules stub**; visual baselines `workspace-detail-plan-tab-with-projects.png`, `workspace-detail-plan-tab-empty.png`, `workspace-detail-runs-tab-empty.png`, `workspace-detail-templates-tab.png` (all crop to the `workspace-detail-tabs` container so the header's "Created {timeAgo}" cell does not drift pixels; the Templates baseline additionally masks the table's "Updated" column to absorb `formatTime` drift) | Shell + panel-content parity for the tabbed workspace detail (Plan / Runs / Templates / Config). A `beforeAll`-seeded workspace (one project + one workspace-scoped template) backs the "with content" cases + two of the four visual baselines; empty-state baselines use per-test freshly-created workspaces. Tab state is persisted in `?tab=` via `useWorkspaceTab`; the hook's unit contract is covered in `ui/src/lib/__tests__/use-workspace-tab.test.ts`. |

### Projects

| Spec | Cases | Notes |
|---|---|---|
| `ui/e2e/projects.spec.ts` | list/detail navigation, create dialog | |
| `ui/e2e/project-detail.spec.ts` | tabbed project detail (Plan / Runs / Templates & Schedules / Config) | |
| `ui/e2e/project-detail-view-modes.spec.ts` | Board / Tree / Swimlane view modes (`?view=`) | |
| `ui/e2e/slice-board.spec.ts` | Mission Control board layout | |
| `ui/e2e/slice-detail-rail.spec.ts` | right-rail slice detail panel | |
| `ui/e2e/left-tree.spec.ts` | tree-view milestone/slice/task tree | |
| `ui/e2e/kpi-bar.spec.ts` | MissionControl KPI bar | |

### Tasks

| Spec | Cases | Notes |
|---|---|---|
| `ui/e2e/tasks.spec.ts` | tasks page, filters, status badges | |
| `ui/e2e/tasks-table.spec.ts` | per-project tasks table | |
| `ui/e2e/task-detail.spec.ts` | task detail page incl. rerun chain | |

### Chats

| Spec | Cases | Notes |
|---|---|---|
| `ui/e2e/chats.spec.ts` | chat list, composer, streaming | |
| `ui/e2e/chats-allow-list.spec.ts` | AI key allow-list filtering | |
| `ui/e2e/chats-incident.spec.ts` | save-as-incident flow | |
| `ui/e2e/chat-question-picker.spec.ts` | `AskUserQuestion` picker — single-/multi-select, free-form fallback, Other-override, long-label wrap, descriptions, 20-option mount budget, keyboard nav. Visual baselines `agent-question-prompt-radio-three-options`, `agent-question-prompt-checkbox-three-options`, `agent-question-prompt-textarea-fallback`, `agent-question-prompt-long-label-wrap` (M05 slice 06). | Seeds rows directly into `agent_questions` (M05 pattern from `attention.spec.ts`); the answer POST is stubbed via `page.route` because `chatExecutor.answerQuestion` requires a live in-memory `AgentSession`. |

### Settings & shell

| Spec | Cases | Notes |
|---|---|---|
| `ui/e2e/settings.spec.ts` | global Settings page (defaults, AI keys) | |
| `ui/e2e/agents-md-editor.spec.ts` | AGENTS.md editor (project & workspace scope) | |
| `ui/e2e/skills-disable.spec.ts` | per-row skill disable toggle | |
| `ui/e2e/skills-mcp.spec.ts` | MCP server config UI | |
| `ui/e2e/templates.spec.ts` | template authoring | |
| `ui/e2e/schedules.spec.ts` | cron schedule create/list | |
| `ui/e2e/server-switcher.spec.ts` | sidebar multi-backend switcher | |
| `ui/e2e/dashboard.spec.ts` | global dashboard | |
| `ui/e2e/analytics.spec.ts` | analytics page | |
| `ui/e2e/navigation.spec.ts` | top-level navigation / accordion sidebar | |
| `ui/e2e/attention.spec.ts` | global attention inbox | |
| `ui/e2e/inbox-questions.spec.ts` | `task_question` / `chat_question` rows in the global inbox — picker round-trips, real-time `attention_changed` removal, two-row independence, empty-state regression, 50-row layout smoke check, 409 stale-question handling, and pixel baselines (`inbox-row-task-question-picker.png`, `inbox-row-chat-question-picker.png`, `inbox-row-task-approval.png`, `inbox-row-chat-approval.png`, `inbox-50-row-layout.png`). DB-direct seed via `e2e/helpers/seed-questions.ts` (mock-AI env can't drive a real `AskUserQuestion` tool call); chat-side answer is intercepted via `page.route` because chats have no cold-path resolver. | |
| `ui/e2e/incident-detail.spec.ts` | `/incidents/:id` detail page | |

## Staging

_None registered yet._ Add specs that need a hosted daemon or real
provider keys here, with the env vars and credentials they expect.
