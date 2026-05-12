import * as React from "react";

import { SectionHeader } from "@/components/design";
import { EmptyState } from "@/components/EmptyState";
import { Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";

import { SkillRow, type SkillRowData, type SkillScope } from "./SkillRow";

/**
 * SkillsPane — the left half of the prototype's two-pane Skills & MCP
 * surface (slice `25-ui-redesign-library-surfaces/01-skills-mcp` T01).
 *
 * Composition (top-down):
 *
 *   1. `<SectionHeader title="Skills" subtitle="{count}">` — flat section
 *      heading with hairline. Subtitle renders the visible (filtered)
 *      count, not the total — feedback for the user that their search
 *      / scope chip narrowed the list.
 *   2. **Search input.** Same pill styling as `TemplatesToolbar`'s
 *      search box. Filters case-insensitively across `name`,
 *      `description` and `tags[]`. Internal state — there's only one
 *      pane, but the parent can opt-in to controlled mode by passing
 *      `query` + `onQueryChange`.
 *   3. **Scope chips.** `All`, then `System`, `Project`, `User` — in
 *      the order the slice spec lists them. Single-select; clicking a
 *      chip narrows the list. Same pill styling as the `FilterChips`
 *      row on `/projects`. Internal state with optional controlled
 *      mode (`scope` + `onScopeChange`).
 *   4. **List of `SkillRow`.** One row per skill that survived the
 *      filter. Click on a row fires `onSkillClick(skill)` so the parent
 *      can open the skill detail / edit dialog (matching the existing
 *      route — negative test
 *      `skill-row.test.tsx::clicking opens skill detail (existing route)`).
 *      When the filter empties the list we render an `EmptyState` so
 *      the user doesn't see an unexplained blank pane.
 *
 * The pane is presentational — it neither owns the skill rows nor
 * fetches data. Parents pass in the merged `skills[]` (already
 * resolved via the `useGlobalSkills` / `useWorkspaceSkills` /
 * `useProjectSkills` hook trio in the page). Centralising filter
 * mechanics here means the page stays thin.
 */

export const SCOPE_ALL = "all";

const SCOPE_OPTIONS: ReadonlyArray<{ value: SkillScope; label: string }> = [
  { value: "system", label: "System" },
  { value: "project", label: "Project" },
  { value: "user", label: "User" },
];

const SEARCH_INPUT_CLASSES =
  "px-3 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded text-[12.5px] outline-none focus:border-indigo-500 w-full";

const CHIP_BASE_CLASSES =
  "px-2.5 py-1 rounded-full text-[12.5px] cursor-pointer transition-colors";
const CHIP_ACTIVE_CLASSES = "bg-zinc-200 dark:bg-zinc-800 font-medium";
const CHIP_INACTIVE_CLASSES =
  "hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600";

/**
 * Case-insensitive substring match across `name`, `description` and
 * `tags[]`. Exported so the parent / tests can apply the same predicate
 * the pane contracts for.
 */
export function filterSkillsByQuery<T extends SkillRowData>(
  rows: ReadonlyArray<T>,
  query: string,
): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [...rows];
  return rows.filter((row) => {
    const name = (row.name ?? "").toLowerCase();
    const description = (row.description ?? "").toLowerCase();
    if (name.includes(trimmed)) return true;
    if (description.includes(trimmed)) return true;
    const tags = row.tags ?? [];
    return tags.some((t) => t.toLowerCase().includes(trimmed));
  });
}

/**
 * Scope-chip predicate. `scope === SCOPE_ALL` keeps every row;
 * otherwise keeps only rows whose `scope` matches.
 */
export function filterSkillsByScope<T extends SkillRowData>(
  rows: ReadonlyArray<T>,
  scope: SkillScope | typeof SCOPE_ALL,
): T[] {
  if (scope === SCOPE_ALL) return [...rows];
  return rows.filter((row) => row.scope === scope);
}

interface ChipProps {
  active: boolean;
  label: string;
  onClick: () => void;
  testId?: string;
}

function Chip({ active, label, onClick, testId }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        CHIP_BASE_CLASSES,
        active ? CHIP_ACTIVE_CLASSES : CHIP_INACTIVE_CLASSES,
      )}
    >
      {label}
    </button>
  );
}

export interface SkillsPaneProps {
  /** Skills to render, already merged across global/workspace/project. */
  skills: ReadonlyArray<SkillRowData>;
  /** Header action slot — typically a `+ Create skill` button. */
  action?: React.ReactNode;
  /**
   * Controlled search query. Omit for uncontrolled / internal state.
   * When provided, `onQueryChange` is required.
   */
  query?: string;
  onQueryChange?: (next: string) => void;
  /**
   * Controlled scope filter. Omit for uncontrolled / internal state.
   * When provided, `onScopeChange` is required.
   */
  scope?: SkillScope | typeof SCOPE_ALL;
  onScopeChange?: (next: SkillScope | typeof SCOPE_ALL) => void;
  /**
   * Fired when the user clicks a row. Parent owns the skill detail /
   * edit dialog navigation.
   */
  onSkillClick?: (skill: SkillRowData) => void;
  /** Extra classes merged onto the pane root. */
  className?: string;
  /** Test hook. */
  "data-testid"?: string;
}

export function SkillsPane({
  skills,
  action,
  query: controlledQuery,
  onQueryChange,
  scope: controlledScope,
  onScopeChange,
  onSkillClick,
  className,
  "data-testid": testId,
}: SkillsPaneProps): React.JSX.Element {
  const isQueryControlled = controlledQuery !== undefined;
  const [internalQuery, setInternalQuery] = React.useState<string>("");
  const query = isQueryControlled ? controlledQuery : internalQuery;

  const isScopeControlled = controlledScope !== undefined;
  const [internalScope, setInternalScope] = React.useState<
    SkillScope | typeof SCOPE_ALL
  >(SCOPE_ALL);
  const scope = isScopeControlled ? controlledScope : internalScope;

  const setQuery = React.useCallback(
    (next: string) => {
      if (!isQueryControlled) setInternalQuery(next);
      onQueryChange?.(next);
    },
    [isQueryControlled, onQueryChange],
  );

  const setScope = React.useCallback(
    (next: SkillScope | typeof SCOPE_ALL) => {
      if (!isScopeControlled) setInternalScope(next);
      onScopeChange?.(next);
    },
    [isScopeControlled, onScopeChange],
  );

  const filtered = React.useMemo(() => {
    const byScope = filterSkillsByScope(skills, scope);
    return filterSkillsByQuery(byScope, query);
  }, [skills, scope, query]);

  return (
    <div
      data-testid={testId ?? "skills-pane"}
      className={cn("flex flex-col gap-3", className)}
    >
      <SectionHeader
        title="Skills"
        subtitle={`${filtered.length}`}
        size="section"
        action={action}
        data-testid="skills-pane-header"
      />

      <input
        type="text"
        role="searchbox"
        placeholder="Search skills…"
        aria-label="Search skills"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className={SEARCH_INPUT_CLASSES}
        data-testid="skills-pane-search"
      />

      <div
        className="flex items-center gap-1.5 flex-wrap"
        data-testid="skills-pane-scope-chips"
      >
        <Chip
          active={scope === SCOPE_ALL}
          label="All"
          onClick={() => setScope(SCOPE_ALL)}
          testId="skills-scope-chip-all"
        />
        {SCOPE_OPTIONS.map((opt) => (
          <Chip
            key={opt.value}
            active={scope === opt.value}
            label={opt.label}
            onClick={() => setScope(opt.value)}
            testId={`skills-scope-chip-${opt.value}`}
          />
        ))}
      </div>

      <div
        className="flex flex-col gap-2"
        data-testid="skills-pane-list"
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={Wand2}
            title={
              skills.length === 0
                ? "No skills configured"
                : "No skills match your filters"
            }
            description={
              skills.length === 0
                ? "Add a skill at any scope to get started."
                : "Try a different search or clear the scope filter."
            }
          />
        ) : (
          filtered.map((skill) => (
            <SkillRow
              key={skill.key}
              skill={skill}
              onClick={
                onSkillClick ? () => onSkillClick(skill) : undefined
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

export default SkillsPane;
