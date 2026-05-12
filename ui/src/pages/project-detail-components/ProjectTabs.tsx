import { useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";

import { cn } from "@/lib/utils";

/**
 * ProjectTabs — segmented tab strip for the project-detail page.
 *
 * Renders five tabs (Plan / Tree / Code / Runs / Config) styled as a
 * single rounded-lg pill containing flush buttons. The active tab lifts
 * via a white/zinc-900 background + shadow + bold text; inactive tabs
 * stay flat in zinc-500.
 *
 * Order: Plan first (planner mental model), Tree as the hierarchical
 * navigator, Code mid-strip (the dominant flow), then Runs (analytics)
 * and Config (settings). Templates & Schedules is intentionally NOT in
 * this strip — it's lower-frequency content that lives one layer down
 * off Config. The legacy "Board" tab was removed as redundant — Tree
 * now exposes the same drill-down all the way to tasks.
 *
 * URL contract: the active tab is mirrored into the `?tab=` search
 * param. The default is `plan` and a missing/unknown value normalises
 * back to `plan`. Selecting `plan` clears the param entirely so the
 * canonical project URL stays clean. We always use `replace: true`
 * so tab-flipping doesn't pollute browser history.
 *
 * Keyboard model (WAI-ARIA Authoring Practices for tabs):
 *   ArrowLeft / ArrowRight — move focus and activate the prev/next tab,
 *                            wrapping at the ends.
 *   Home / End             — jump to the first / last tab.
 */

export const PROJECT_TAB_IDS = [
  "plan",
  "tree",
  "code",
  "runs",
  "config",
] as const;

export type ProjectTabId = (typeof PROJECT_TAB_IDS)[number];

const TAB_LABELS: Record<ProjectTabId, string> = {
  plan: "Plan",
  tree: "Tree",
  code: "Code",
  runs: "Runs",
  config: "Config",
};

const DEFAULT_TAB: ProjectTabId = "plan";

function isProjectTabId(value: string | null | undefined): value is ProjectTabId {
  return !!value && (PROJECT_TAB_IDS as readonly string[]).includes(value);
}

export interface ProjectTabsProps {
  /**
   * Optional change hook fired after the URL has been updated. Useful
   * for parents that want to mirror the choice into local state or
   * fire a side-effect (analytics, etc.).
   */
  onTabChange?: (tab: ProjectTabId) => void;
  className?: string;
  "data-testid"?: string;
}

export function ProjectTabs({
  onTabChange,
  className,
  "data-testid": testId,
}: ProjectTabsProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("tab");
  const active: ProjectTabId = isProjectTabId(raw) ? raw : DEFAULT_TAB;

  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const setTab = useCallback(
    (next: ProjectTabId) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === DEFAULT_TAB) params.delete("tab");
          else params.set("tab", next);
          return params;
        },
        { replace: true },
      );
      onTabChange?.(next);
    },
    [setSearchParams, onTabChange],
  );

  const focusTabAt = useCallback((index: number) => {
    const node = buttonRefs.current[index];
    if (node) node.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const lastIndex = PROJECT_TAB_IDS.length - 1;
      let nextIndex: number;
      switch (event.key) {
        case "ArrowRight":
          nextIndex = index === lastIndex ? 0 : index + 1;
          break;
        case "ArrowLeft":
          nextIndex = index === 0 ? lastIndex : index - 1;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = lastIndex;
          break;
        default:
          return;
      }
      event.preventDefault();
      const nextTab = PROJECT_TAB_IDS[nextIndex];
      if (!nextTab) return;
      setTab(nextTab);
      focusTabAt(nextIndex);
    },
    [setTab, focusTabAt],
  );

  const tabs = useMemo(
    () =>
      PROJECT_TAB_IDS.map((id) => ({
        id,
        label: TAB_LABELS[id],
      })),
    [],
  );

  return (
    <div
      role="tablist"
      aria-label="Project sections"
      data-testid={testId ?? "project-tabs"}
      className={cn(
        "inline-flex rounded-lg bg-zinc-100 dark:bg-zinc-800 p-0.5",
        className,
      )}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              buttonRefs.current[index] = node;
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`project-tabpanel-${tab.id}`}
            id={`project-tab-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            data-tab-id={tab.id}
            data-active={isActive ? "true" : undefined}
            data-testid={`project-tab-${tab.id}`}
            onClick={() => setTab(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              "px-3 py-1.5 rounded-md text-[13px] transition-colors",
              isActive
                ? "bg-white dark:bg-zinc-900 shadow-sm font-semibold"
                : "text-zinc-500",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export default ProjectTabs;
