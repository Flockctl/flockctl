import * as React from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";

import { FlatCard } from "@/components/design";
import { cn } from "@/lib/utils";

/**
 * QuickLinks — dashboard sidebar shortcuts card (slice 23-01 T04).
 *
 * Layout matches `.flockctl/plan/ui-prototype.html` and the parent slice's
 * Tasks → T04 spec: a `<FlatCard>` with a "Quick links" header and three
 * full-width rows, each a `<button>` that hovers `bg-zinc-100 dark:bg-zinc-800`
 * with a right-aligned chevron.
 *
 * Why presentational
 * ------------------
 * Three of the link destinations are static (`/attention`,
 * `/analytics?view=by-model`); the only dynamic piece is the primary
 * project (the first pinned project) and the unread-attention count.
 * Both come in via props so the dashboard owns the data fan-out and
 * this surface stays trivially testable.
 *
 * Negative case — no primary project
 * ----------------------------------
 * When `primaryProject` is omitted, the "Open … in Code mode" row is
 * hidden entirely (per slice negative_test
 * `no projects pinned: first button hidden or disabled`). Hiding rather
 * than disabling avoids dangling a non-functional control on the
 * empty-state dashboard.
 */

export interface QuickLinksPrimaryProject {
  /** URL-safe slug used in the `/projects/{slug}` route. */
  slug: string;
  /** Human-readable name rendered into the button label. */
  name: string;
}

export interface QuickLinksProps {
  /**
   * The first pinned project. When omitted, the "Open … in Code mode"
   * row is hidden — see the rationale in the file-level docstring.
   */
  primaryProject?: QuickLinksPrimaryProject;
  /**
   * Count of items in the operator's attention inbox. Rendered into the
   * label literally — `0 items need attention` is allowed and signals
   * "you're caught up", which is informationally useful.
   */
  attentionCount: number;
  /** Optional class merge for the outer card. */
  className?: string;
}

export function QuickLinks({
  primaryProject,
  attentionCount,
  className,
}: QuickLinksProps): React.JSX.Element {
  const navigate = useNavigate();

  return (
    <FlatCard className={cn("flex flex-col", className)}>
      <div
        data-testid="quick-links-header"
        className="px-4 py-3"
      >
        <h3 className="text-sm font-semibold">Quick links</h3>
      </div>

      <div className="flex flex-col gap-1 px-2 pb-2">
        {primaryProject && (
          <QuickLinkRow
            testId="quick-links-row-code"
            label={`Open ${primaryProject.name} in Code mode`}
            onClick={() =>
              navigate(`/projects/${primaryProject.slug}?tab=code`)
            }
          />
        )}
        <QuickLinkRow
          testId="quick-links-row-attention"
          label={`${attentionCount} items need attention`}
          onClick={() => navigate("/attention")}
        />
        <QuickLinkRow
          testId="quick-links-row-analytics"
          label="Spend by model"
          onClick={() => navigate("/analytics?view=by-model")}
        />
      </div>
    </FlatCard>
  );
}

interface QuickLinkRowProps {
  testId: string;
  label: string;
  onClick: () => void;
}

function QuickLinkRow({
  testId,
  label,
  onClick,
}: QuickLinkRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="w-full flex items-center justify-between px-2 py-1.5 rounded text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
    >
      <span className="truncate">{label}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
    </button>
  );
}

export default QuickLinks;
