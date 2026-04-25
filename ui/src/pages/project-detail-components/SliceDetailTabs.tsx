import * as React from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SliceDetailPanel } from "./SliceDetailPanel";

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

export interface SliceDetailTabsProps {
  sliceId?: string;
  /**
   * Project owning the selected slice — forwarded into the
   * {@link SliceDetailTabsContext} so the default `SliceDetailPanel`
   * can hit the shared `useProjectTree` cache.
   */
  projectId?: string;
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

  const ctx: SliceDetailTabsContext = { sliceId, projectId };

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
