import * as React from "react";

import { FlatCard, StatusPill } from "@/components/design";
import type { StatusPillTone } from "@/components/design";
import { cn } from "@/lib/utils";

/**
 * SkillRow — single skill tile in the skills pane (slice
 * `25-ui-redesign-library-surfaces/01-skills-mcp` T01). Mirrors the
 * prototype's two-pane skill row:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ planning                                          SYSTEM  │
 *   │ Decompose features into milestone → slice → task plans.   │
 *   │ plan  decompose  milestone  slice                         │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Design notes
 * ------------
 *   - **Presentational only.** The parent `SkillsPane` derives the
 *     `name`, `description`, `scope` and `tags` from a `Skill` row plus
 *     workspace/project context. Keeping the row hook-free means the
 *     test suite doesn't have to mock react-query and the component is
 *     trivially reusable from other surfaces (search, command palette).
 *
 *   - **Three scope tones — zinc / indigo / emerald.** Distinct StatusPill
 *     tones for the three skill scopes:
 *
 *       system  → neutral (zinc)   — shipped with Flockctl, built-in.
 *       user    → info    (indigo) — workspace-level, owned by the user.
 *       project → success (emerald) — project-scoped, narrowest reach.
 *
 *     The three tones must remain visually distinct (negative test
 *     `skill-row.test.tsx::scope tones distinct: zinc/indigo/emerald.`).
 *
 *   - **Click anywhere** on the row body fires `onClick` — typically the
 *     parent opens the existing skill detail / edit dialog. When
 *     `onClick` is omitted the row is non-interactive; no
 *     `role="button"`, no hover lift.
 *
 *   - **Truncate everywhere a string can be long.** `name` carries the
 *     `truncate` class under a `min-w-0` flex parent; `description`
 *     uses `line-clamp-2`. Tags `flex-wrap` rather than truncate
 *     because they carry filterable metadata — dropping any of them is
 *     wrong (matches the prototype's tags row).
 */

export type SkillScope = "system" | "user" | "project";

const SCOPE_TONE: Record<SkillScope, StatusPillTone> = {
  system: "neutral",
  user: "info",
  project: "success",
};

const SCOPE_LABEL: Record<SkillScope, string> = {
  system: "system",
  user: "user",
  project: "project",
};

export interface SkillRowData {
  /** Stable identifier. Typically `${scope}:${name}`. */
  key: string;
  /** Display name. Slug-like — rendered in mono. */
  name: string;
  /** Optional one-line description. Truncates to two lines when long. */
  description?: string | null;
  /** Scope tone (system/user/project). */
  scope: SkillScope;
  /** Tag strings rendered as monospaced chips. Empty/undefined hides the row. */
  tags?: string[];
}

export interface SkillRowProps {
  skill: SkillRowData;
  /**
   * Optional row-body click handler (e.g. open the skill detail dialog).
   * When omitted, the row is non-interactive — no `role="button"`, no
   * keyboard activation, no hover lift.
   */
  onClick?: () => void;
  /** Extra classes merged onto the FlatCard root. */
  className?: string;
}

export function SkillRow({
  skill,
  onClick,
  className,
}: SkillRowProps): React.JSX.Element {
  const tone = SCOPE_TONE[skill.scope];
  const tags = skill.tags ?? [];
  const interactive = onClick !== undefined;

  return (
    <FlatCard
      interactive={interactive}
      onClick={onClick}
      className={cn("p-4", className)}
    >
      <div
        data-testid="skill-row"
        data-skill-key={skill.key}
        data-scope={skill.scope}
      >
        {/* Top row: name (mono) + scope StatusPill, pinned right. */}
        <div className="flex items-start gap-2 mb-2">
          <div className="min-w-0 flex-1">
            <div
              data-testid="skill-row-name"
              className="font-semibold text-[13px] mono truncate"
              title={skill.name}
            >
              {skill.name}
            </div>
          </div>
          <StatusPill
            tone={tone}
            size="sm"
            data-testid="skill-row-scope"
            data-scope={skill.scope}
          >
            {SCOPE_LABEL[skill.scope]}
          </StatusPill>
        </div>

        {/* Description: line-clamp-2 so a long blurb doesn't blow up the row. */}
        {skill.description && (
          <div
            data-testid="skill-row-description"
            className="text-[12.5px] text-zinc-500 leading-relaxed line-clamp-2 mb-2"
          >
            {skill.description}
          </div>
        )}

        {/* Tag row: mono badges — flex-wrap so 10+ tags spill to next row. */}
        {tags.length > 0 && (
          <div
            data-testid="skill-row-tags"
            className="flex flex-wrap gap-1 text-[10.5px]"
          >
            {tags.map((tag) => (
              <span
                key={tag}
                data-testid="skill-row-tag"
                className="mono px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </FlatCard>
  );
}

export default SkillRow;
