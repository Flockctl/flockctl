import * as React from "react";
import { FileCode2, MessageSquarePlus } from "lucide-react";

import { FlatCard, StatusPill } from "@/components/design";
import type { StatusPillTone } from "@/components/design";
import { Button } from "@/components/ui/button";
import { cn, timeAgo } from "@/lib/utils";

/**
 * TemplateCard — single template tile in the templates grid (slice
 * `25-ui-redesign-library-surfaces/00-templates` T00). Mirrors the
 * prototype:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ ▣  template-name                                          │
 *   │ tag tag tag                                               │
 *   │                                                           │
 *   │ One-line description, leading-relaxed.                    │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ Open in chat →                                  2h ago    │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Design notes
 * ------------
 *   - Presentational only. The parent page derives `tags`, `lastUsedAt`
 *     and the `onOpenInChat` callback from a `TaskTemplate` row plus its
 *     own mutation hooks. Keeping the card hook-free means the test
 *     suite doesn't have to mock react-query and the component is
 *     trivially reusable from other surfaces (search, command palette).
 *   - Click anywhere on the card body fires `onClick` (parent decides:
 *     edit dialog, navigate, etc.). The "Open in chat" footer button
 *     stops propagation so it never doubles as a card-body click.
 *   - Icon-tile tone is deterministic: `pickTileTone(name)` hashes the
 *     name into one of five canonical tones. The `TILE_TONE_BG` and
 *     `TILE_TONE_TEXT` maps materialise the literal Tailwind classes so
 *     the JIT scanner picks them up at build time.
 *   - Tags use a deterministic tone-cycle by the tag's own hash so a
 *     given tag string keeps the same colour across renders. Long tag
 *     lists `flex-wrap` onto multiple rows rather than truncate — tags
 *     carry filterable metadata, so dropping any of them is wrong.
 *   - Truncate everywhere a string can be long: name uses `truncate`
 *     under a `min-w-0` flex parent; description uses `line-clamp-2`.
 */

const TILE_TONES = ["indigo", "emerald", "amber", "rose", "blue"] as const;
type TileTone = (typeof TILE_TONES)[number];

// Materialised tone classes so the Tailwind JIT scanner sees literals.
const TILE_TONE_BG: Record<TileTone, string> = {
  indigo: "bg-indigo-500/15",
  emerald: "bg-emerald-500/15",
  amber: "bg-amber-500/15",
  rose: "bg-rose-500/15",
  blue: "bg-blue-500/15",
};

const TILE_TONE_TEXT: Record<TileTone, string> = {
  indigo: "text-indigo-600 dark:text-indigo-400",
  emerald: "text-emerald-600 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  rose: "text-rose-600 dark:text-rose-400",
  blue: "text-blue-600 dark:text-blue-400",
};

/** Sum of charCodes mod TILE_TONES.length — same hash spec as workspaceTone. */
export function pickTileTone(name: string): TileTone {
  let sum = 0;
  for (let i = 0; i < name.length; i += 1) sum += name.charCodeAt(i);
  return TILE_TONES[sum % TILE_TONES.length] as TileTone;
}

// Cycle through the StatusPill semantic tones for tag chips. Skipping
// `danger` so a tag never looks like an error.
const TAG_TONES: StatusPillTone[] = ["info", "success", "warning", "neutral"];

/** Deterministic StatusPill tone for a given tag string. */
export function pickTagTone(tag: string): StatusPillTone {
  let sum = 0;
  for (let i = 0; i < tag.length; i += 1) sum += tag.charCodeAt(i);
  return TAG_TONES[sum % TAG_TONES.length] as StatusPillTone;
}

export interface TemplateCardData {
  /** Stable identifier — typically `templateKey(template)`. */
  key: string;
  /** Display name. Drives the icon-tile tone and the avatar fallback. */
  name: string;
  /** Optional one-line description. Truncates to two lines when long. */
  description?: string | null;
  /** Tag strings rendered as StatusPills (cycle tones). */
  tags?: string[];
  /**
   * ISO-8601 timestamp of the last time the template was used (or
   * updated, when "used" isn't tracked). Rendered via `timeAgo` in the
   * footer right.
   */
  lastUsedAt?: string | null;
  /**
   * Optional Lucide icon component override. Defaults to `FileCode2` —
   * the prototype's default for "template/recipe" surfaces.
   */
  icon?: React.ComponentType<{ className?: string }>;
}

export interface TemplateCardProps {
  template: TemplateCardData;
  /** Footer button click — parent kicks off the instantiate-as-chat flow. */
  onOpenInChat: () => void;
  /**
   * Optional card-body click handler (e.g. open the edit dialog). When
   * omitted, the card body is non-interactive — only the footer button
   * is. The footer button always stops propagation so it never doubles
   * as a card-body click.
   */
  onClick?: () => void;
  /** Extra classes merged onto the FlatCard root. */
  className?: string;
}

function TemplateCardImpl({
  template,
  onOpenInChat,
  onClick,
  className,
}: TemplateCardProps): React.JSX.Element {
  const tone = pickTileTone(template.name);
  const Icon = template.icon ?? FileCode2;
  const tags = template.tags ?? [];

  const interactive = onClick !== undefined;

  // Footer is a separate slot — wired into FlatCard's `footer` prop so
  // the top hairline divider is painted by FlatCard itself. The
  // wrapper stops the card-level click from firing when the user
  // intentionally aims at the button.
  const footer = (
    <div
      data-testid="template-card-footer"
      className="flex items-center justify-between"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-[12px] gap-1.5"
        onClick={onOpenInChat}
        data-testid="template-card-open-in-chat"
      >
        <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
        Open in chat
      </Button>
      <span
        data-testid="template-card-last-used"
        className="text-[11.5px] text-zinc-500"
      >
        {timeAgo(template.lastUsedAt)}
      </span>
    </div>
  );

  return (
    <FlatCard
      interactive={interactive}
      onClick={onClick}
      footer={footer}
      className={cn("p-4", className)}
    >
      <div
        data-testid="template-card"
        data-template-key={template.key}
        data-tone={tone}
      >
        {/* Top row: icon-tile + name */}
        <div className="flex items-start gap-3 mb-2">
          <div
            data-testid="template-card-icon"
            className={cn(
              "h-9 w-9 shrink-0 rounded-lg grid place-items-center",
              TILE_TONE_BG[tone],
              TILE_TONE_TEXT[tone],
            )}
            aria-hidden="true"
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div
              data-testid="template-card-name"
              className="font-semibold text-[13px] truncate"
              title={template.name}
            >
              {template.name}
            </div>
          </div>
        </div>

        {/* Tag row: StatusPills — flex-wrap so 10+ tags spill to next row. */}
        {tags.length > 0 && (
          <div
            data-testid="template-card-tags"
            className="flex flex-wrap gap-1 mb-2"
          >
            {tags.map((tag) => (
              <StatusPill
                key={tag}
                tone={pickTagTone(tag)}
                size="sm"
                data-testid="template-card-tag"
              >
                {tag}
              </StatusPill>
            ))}
          </div>
        )}

        {/* Description: line-clamp-2 so a long blob doesn't blow up the row. */}
        {template.description && (
          <div
            data-testid="template-card-description"
            className="text-[12.5px] text-zinc-500 leading-relaxed line-clamp-2"
          >
            {template.description}
          </div>
        )}
      </div>
    </FlatCard>
  );
}

/**
 * Memoised (audit-round-5) — templates list re-renders on every page
 * refetch; with stable prop identity from the parent's `useMemo` over
 * the items array, this lets unchanged cards skip re-render.
 */
export const TemplateCard = React.memo(TemplateCardImpl);
export default TemplateCard;
