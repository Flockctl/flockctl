import { useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";

import { cn } from "@/lib/utils";

/**
 * SettingsTabs — segmented tab strip for the settings page.
 *
 * Renders four tabs (AI Keys / Server / Secrets / Skills) styled
 * as a single rounded-lg pill containing flush buttons. The active tab
 * lifts via a white/zinc-900 background + shadow + bold text; inactive
 * tabs stay flat in zinc-500.
 *
 * URL contract: the active tab is mirrored into the `?tab=` search
 * param. The default is `ai-keys` and a missing/unknown value
 * normalises back to `ai-keys`. Selecting `ai-keys` clears the param
 * entirely so the canonical settings URL stays clean. We always use
 * `replace: true` so tab-flipping doesn't pollute browser history.
 *
 * The shape mirrors `ProjectTabs` deliberately — keeping the two
 * segmented tab strips structurally identical means the same audit
 * tests, keyboard contract, and visual language carry across the app.
 *
 * Keyboard model (WAI-ARIA Authoring Practices for tabs):
 *   ArrowLeft / ArrowRight — move focus and activate the prev/next tab,
 *                            wrapping at the ends.
 *   Home / End             — jump to the first / last tab.
 */

export const SETTINGS_TAB_IDS = [
  "ai-keys",
  "server",
  "secrets",
  "skills",
] as const;

export type SettingsTabId = (typeof SETTINGS_TAB_IDS)[number];

const TAB_LABELS: Record<SettingsTabId, string> = {
  "ai-keys": "AI Keys",
  server: "Server",
  secrets: "Secrets",
  skills: "Skills",
};

const DEFAULT_TAB: SettingsTabId = "ai-keys";

function isSettingsTabId(value: string | null | undefined): value is SettingsTabId {
  return !!value && (SETTINGS_TAB_IDS as readonly string[]).includes(value);
}

export interface SettingsTabsProps {
  /**
   * Optional change hook fired after the URL has been updated. Useful
   * for parents that want to mirror the choice into local state or
   * fire a side-effect (analytics, etc.).
   */
  onTabChange?: (tab: SettingsTabId) => void;
  className?: string;
  "data-testid"?: string;
}

export function SettingsTabs({
  onTabChange,
  className,
  "data-testid": testId,
}: SettingsTabsProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("tab");
  const active: SettingsTabId = isSettingsTabId(raw) ? raw : DEFAULT_TAB;

  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const setTab = useCallback(
    (next: SettingsTabId) => {
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
      const lastIndex = SETTINGS_TAB_IDS.length - 1;
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
      const nextTab = SETTINGS_TAB_IDS[nextIndex];
      if (!nextTab) return;
      setTab(nextTab);
      focusTabAt(nextIndex);
    },
    [setTab, focusTabAt],
  );

  const tabs = useMemo(
    () =>
      SETTINGS_TAB_IDS.map((id) => ({
        id,
        label: TAB_LABELS[id],
      })),
    [],
  );

  return (
    <div
      role="tablist"
      aria-label="Settings sections"
      data-testid={testId ?? "settings-tabs"}
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
            aria-controls={`settings-tabpanel-${tab.id}`}
            id={`settings-tab-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            data-tab-id={tab.id}
            data-active={isActive ? "true" : undefined}
            data-testid={`settings-tab-${tab.id}`}
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

export default SettingsTabs;
