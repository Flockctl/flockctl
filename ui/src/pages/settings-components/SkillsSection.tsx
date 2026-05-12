import * as React from "react";

import { FlatCard } from "@/components/design";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * SkillsSection — "Skills" tab content for the new settings page.
 *
 * Layout
 * ------
 * One `<FlatCard>` containing three rows — one per skill source dir.
 * Each row uses the spec's `grid grid-cols-[200px_1fr_auto] gap-4
 * items-center` template:
 *
 *   ┌───────────┬──────────────────────────────────────┬────────┐
 *   │ Source    │ Path                                 │ Toggle │
 *   ├───────────┼──────────────────────────────────────┼────────┤
 *   │ System    │ Bundled with Flockctl                │  [X]   │
 *   │ User      │ ~/flockctl/skills                    │  [X]   │
 *   │ Project   │ <project>/.flockctl/skills           │  [ ]   │
 *   └───────────┴──────────────────────────────────────┴────────┘
 *
 * The three sources mirror the daemon's runtime resolution layers
 * (see `src/services/skills.ts`):
 *
 *   1. **System** — bundled with the Flockctl binary
 *      (`src/bundled-skills/`).
 *   2. **User** — global at `~/flockctl/skills/`
 *      (`getGlobalSkillsDir()`).
 *   3. **Project** — per-project at `<project>/.flockctl/skills/`.
 *
 * Toggle persistence
 * ------------------
 * Each toggle is persisted to `localStorage` under the
 * `flockctl.skills.source.<scope>` key prefix (boolean-as-string).
 * Defaults: every source is enabled when no preference has been set.
 * No backend mutation today; when one is added (skills source
 * preferences become daemon state), swap the local state hook for a
 * TanStack `useMutation` here without reshaping the layout.
 *
 * Toggle primitive
 * ----------------
 * The shadcn library currently in this project does not ship a
 * `<Switch>` component, so we render a small accessible button with
 * `role="switch"` and `aria-checked`. Same affordance / keyboard
 * model as a Radix Switch — clicking toggles, Space/Enter toggles,
 * the "thumb" slides between two positions via CSS transforms.
 */

const STORAGE_KEY_PREFIX = "flockctl.skills.source.";

type SourceId = "system" | "user" | "project";

interface SourceDef {
  id: SourceId;
  label: string;
  path: string;
  description: string;
}

const SOURCES: ReadonlyArray<SourceDef> = [
  {
    id: "system",
    label: "System",
    path: "Bundled with Flockctl",
    description: "Always-available skills shipped with the daemon.",
  },
  {
    id: "user",
    label: "User",
    path: "~/flockctl/skills",
    description: "Global skills you author for every project.",
  },
  {
    id: "project",
    label: "Project",
    path: "<project>/.flockctl/skills",
    description:
      "Per-project skills checked into the repo (when present).",
  },
];

function readToggle(id: SourceId): boolean {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${id}`);
  if (raw === null) return true;
  return raw === "true";
}

function writeToggle(id: SourceId, value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    `${STORAGE_KEY_PREFIX}${id}`,
    value ? "true" : "false",
  );
}

export interface SkillsSectionProps {
  className?: string;
}

export function SkillsSection({
  className,
}: SkillsSectionProps): React.JSX.Element {
  const [enabled, setEnabled] = React.useState<Record<SourceId, boolean>>({
    system: true,
    user: true,
    project: true,
  });

  // Hydrate from localStorage on mount only — keep first paint deterministic.
  React.useEffect(() => {
    setEnabled({
      system: readToggle("system"),
      user: readToggle("user"),
      project: readToggle("project"),
    });
  }, []);

  const toggle = React.useCallback((id: SourceId) => {
    setEnabled((prev) => {
      const next = !prev[id];
      writeToggle(id, next);
      return { ...prev, [id]: next };
    });
  }, []);

  return (
    <div className={cn("space-y-4", className)} data-testid="skills-section">
      <FlatCard className="p-4">
        <h2 className="text-base font-semibold">Skill sources</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Where Flockctl looks for skills at runtime. Disable a source to
          hide its skills from every chat and task on this device.
        </p>

        <div className="mt-4 space-y-3">
          {SOURCES.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              checked={enabled[source.id]}
              onChange={() => toggle(source.id)}
            />
          ))}
        </div>
      </FlatCard>
    </div>
  );
}

interface SourceRowProps {
  source: SourceDef;
  checked: boolean;
  onChange: () => void;
}

function SourceRow({ source, checked, onChange }: SourceRowProps) {
  const inputId = `skills-source-${source.id}`;
  return (
    <div
      className="grid grid-cols-[200px_1fr_auto] gap-4 items-center"
      data-testid={`skills-source-row-${source.id}`}
    >
      <Label htmlFor={inputId} className="text-sm">
        {source.label}
      </Label>

      <div className="min-w-0">
        <code
          className="block truncate rounded bg-muted px-2 py-1 font-mono text-xs"
          data-testid={`skills-source-path-${source.id}`}
          title={source.path}
        >
          {source.path}
        </code>
        <p className="mt-1 text-xs text-muted-foreground">
          {source.description}
        </p>
      </div>

      <SwitchControl
        id={inputId}
        checked={checked}
        onChange={onChange}
        ariaLabel={`Enable ${source.label} skills`}
        data-testid={`skills-source-toggle-${source.id}`}
      />
    </div>
  );
}

interface SwitchControlProps {
  id: string;
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
  "data-testid"?: string;
}

/**
 * Minimal accessible switch — `role="switch"` + `aria-checked`, with
 * Enter/Space activation handled implicitly by the native `<button>`.
 */
function SwitchControl({
  id,
  checked,
  onChange,
  ariaLabel,
  "data-testid": testId,
}: SwitchControlProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid={testId}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        checked
          ? "bg-primary"
          : "bg-zinc-200 dark:bg-zinc-700",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export default SkillsSection;
