import * as React from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SliceDetailPanel } from "./SliceDetailPanel";
import { SupervisorLogTab } from "./SupervisorLogTab";

/**
 * Context passed to every `TabDef.render`.
 *
 * Kept minimal on purpose: milestone 10 (Supervisor log tab) and any other
 * future tab only needs the slice id + the owning project id to fetch its
 * own data, so we don't leak the entire slice model through the registry.
 */
export interface SliceDetailTabsContext {
  sliceId?: string;
  /**
   * Project owning the selected slice. Tabs that need to hit
   * `/projects/:id/...` endpoints (e.g. the default `SliceDetailPanel`
   * reading from `useProjectTree(projectId)`) pull this off the ctx
   * instead of threading it through `SliceDetailTabsProps` per tab.
   */
  projectId?: string;
  /**
   * Mission owning the selected slice's parent milestone, when one
   * exists. Forwarded into the {@link SliceDetailTabsContext} so the
   * Supervisor log tab (milestone 10/06) can subscribe to the right
   * `mission_event` channel without a second `useMissions` call.
   *
   * Absent on milestones with no `mission_id` frontmatter — see
   * `getSliceDetailTabs` for the conditional registration that skips
   * the Supervisor log tab when this field is undefined.
   */
  missionId?: string;
}

/**
 * A single tab registration. New tabs plug in via `tabs={[...DEFAULT_SLICE_TABS, myTab]}`
 * without modifying this file — the corner case `slice_detail_tabs` covers.
 */
export interface TabDef {
  id: string;
  label: string;
  render: (ctx: SliceDetailTabsContext) => React.ReactNode;
}

/**
 * Default "Slice" tab — renders the real {@link SliceDetailPanel}.
 *
 * When `projectId` is absent (e.g. a storybook harness that mounts the
 * tabs without a project) we fall back to a muted hint rather than
 * booting the panel into an invalid `useProjectTree("")` query that
 * would stall the rail on a network error.
 */
function DefaultSliceTab(ctx: SliceDetailTabsContext) {
  if (!ctx.projectId) {
    return (
      <div
        data-slot="slice-detail-panel-placeholder"
        data-testid="slice-detail-panel-placeholder"
        className="text-sm text-muted-foreground"
      >
        Slice detail {ctx.sliceId ? `for ${ctx.sliceId}` : "(no slice selected)"}
      </div>
    );
  }
  return <SliceDetailPanel projectId={ctx.projectId} sliceId={ctx.sliceId} />;
}

/**
 * Default tab set — a single "Slice" tab. Exported so callers can spread it
 * and append additional `TabDef` entries (e.g. a Supervisor log tab in
 * milestone 10) without touching this file.
 */
export const DEFAULT_SLICE_TABS: TabDef[] = [
  {
    id: "slice-detail",
    label: "Slice",
    render: (ctx) => <DefaultSliceTab {...ctx} />,
  },
];

/**
 * Stable id for the Supervisor log tab. Exported so callers / tests can
 * target it via `tabs.find(t => t.id === SUPERVISOR_LOG_TAB_ID)` without
 * stringly-coupling to the literal.
 */
export const SUPERVISOR_LOG_TAB_ID = "supervisor-log" as const;

/**
 * `TabDef` factory for the Supervisor log tab. Closes over `missionId` so
 * the registered render function can mount {@link SupervisorLogTab}
 * without re-deriving the id from {@link SliceDetailTabsContext} —
 * keeping the closure narrow lets us register the tab once at the call
 * site and forget about wiring contexts through.
 *
 * Why a factory and not a static `TabDef`:
 *   The mission id is a per-mount value (different slices belong to
 *   milestones with different missions), so a static export would force
 *   every consumer to thread `ctx.missionId` through their own render
 *   wrapper. The factory keeps the registry pattern uniform — callers
 *   `.push(supervisorLogTab(missionId))` instead of conditional-renders.
 */
export function supervisorLogTab(missionId: string): TabDef {
  return {
    id: SUPERVISOR_LOG_TAB_ID,
    label: "Supervisor log",
    render: () => <SupervisorLogTab missionId={missionId} />,
  };
}

/**
 * Build the slice-detail tab registry for a given context. Returns
 * `DEFAULT_SLICE_TABS` when no mission is associated with the surface,
 * or `[...DEFAULT_SLICE_TABS, supervisorLogTab(missionId)]` when one
 * is — i.e. the Supervisor log tab is registered IFF the mission id
 * is present.
 *
 * This is the canonical extension point parent slice 10/06 references:
 * "DEFAULT_SLICE_TABS now includes [the Supervisor log tab] when mission
 * selected". Composing at this seam keeps {@link DEFAULT_SLICE_TABS}'s
 * own shape stable (so the `slice_detail_tabs` extension-point test
 * still pins a single-entry default), while letting consumers opt in
 * to the supervisor tab without touching {@link SliceDetailTabs}.
 */
export function getSliceDetailTabs(opts: { missionId?: string } = {}): TabDef[] {
  const { missionId } = opts;
  if (!missionId) return DEFAULT_SLICE_TABS;
  return [...DEFAULT_SLICE_TABS, supervisorLogTab(missionId)];
}

export interface SliceDetailTabsProps {
  sliceId?: string;
  /**
   * Project owning the selected slice — forwarded into the
   * {@link SliceDetailTabsContext} so the default `SliceDetailPanel`
   * can hit the shared `useProjectTree` cache.
   */
  projectId?: string;
  /**
   * Mission owning the selected slice's parent milestone, when one
   * exists. Forwarded into the {@link SliceDetailTabsContext} so a
   * caller composing the default tabs through {@link getSliceDetailTabs}
   * can pick up the same id from the ctx in a custom tab without a
   * second prop.
   */
  missionId?: string;
  /** Override the tab registry. Defaults to `DEFAULT_SLICE_TABS`. */
  tabs?: TabDef[];
  /** Optional controlled active tab id. */
  activeTabId?: string;
  /** Called when the active tab changes (controlled or uncontrolled). */
  onActiveTabChange?: (id: string) => void;
  className?: string;
}

/**
 * Tab registry component for the slice detail surface.
 *
 * - Internal state holds the active tab id (uncontrolled mode).
 * - Click on a tab trigger switches which panel is rendered.
 * - Consumers extend the registry by passing a `tabs` prop — no change to
 *   this file is required when a new `TabDef` entry is added.
 */
export function SliceDetailTabs({
  sliceId,
  projectId,
  missionId,
  tabs = DEFAULT_SLICE_TABS,
  activeTabId,
  onActiveTabChange,
  className,
}: SliceDetailTabsProps) {
  const firstId = tabs[0]?.id ?? "";
  const [internalActive, setInternalActive] = React.useState<string>(firstId);

  // Keep uncontrolled state sane if the registry changes under us and the
  // previously-active tab no longer exists.
  React.useEffect(() => {
    if (tabs.length === 0) return;
    if (!tabs.some((t) => t.id === internalActive) && tabs[0]) {
      setInternalActive(tabs[0].id);
    }
  }, [tabs, internalActive]);

  const active = activeTabId ?? internalActive;

  const handleChange = (id: string) => {
    if (activeTabId === undefined) setInternalActive(id);
    onActiveTabChange?.(id);
  };

  if (tabs.length === 0) return null;

  const ctx: SliceDetailTabsContext = { sliceId, projectId, missionId };

  return (
    <Tabs
      value={active}
      onValueChange={handleChange}
      className={className}
      data-slot="slice-detail-tabs"
    >
      <TabsList aria-label="Slice detail tabs" role="tablist">
        {tabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.id} value={t.id}>
          {t.render(ctx)}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export default SliceDetailTabs;
