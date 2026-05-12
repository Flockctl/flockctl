/**
 * workspace-tone — deterministic colour-palette picker for workspace
 * avatars (slice 23-03 T01).
 *
 * The workspaces grid paints each `<WorkspaceCard>` with a 40×40
 * gradient-avatar tile whose colour is chosen from a small fixed palette.
 * The choice has to be **stable** across sessions — a workspace's avatar
 * cannot flicker between indigo and emerald between two renders or two
 * machines viewing the same workspace list — so the picker is a pure
 * function of the workspace name.
 *
 * Why a tiny palette and a name-hash, not a per-workspace stored colour?
 * --------------------------------------------------------------------
 *   - Zero schema cost: no new column, no migration, no UX for picking
 *     a colour. Operators with ten throwaway workspaces don't have to
 *     curate their palette.
 *   - Stable but cheap: the modulo-of-codepoint-sum hash is O(name.length)
 *     and produces the same bucket on every machine + every render. We
 *     don't need cryptographic spread — we need "two adjacent workspaces
 *     usually look different", which a 5-bucket palette over English
 *     names hits well enough.
 *   - Predictable contrast: every entry in the palette pairs a saturated
 *     400 / 500 swatch with white text, so the avatar reads at small
 *     sizes in both light and dark themes without any per-tone tuning.
 *
 * Caller contract
 * ---------------
 * `workspaceTone(name)` returns one of the literal strings in `TONES`.
 * Map it to Tailwind classes at the call site (see `WorkspaceCard.tsx`)
 * — keeping the mapping in the consumer means Tailwind's JIT picks up
 * the literal class strings during build, and a future palette swap
 * doesn't ripple through every consumer that re-uses the tone label.
 *
 * Empty / non-ASCII names
 * -----------------------
 * The reduce starts from 0, so an empty string maps to `TONES[0]`
 * ("indigo"). Non-ASCII codepoints contribute their `String.prototype`
 * codepoint sum the same way ASCII does — there's no special-cased
 * unicode normalisation. The point is determinism, not anti-collision.
 */

const TONES = ["indigo", "pink", "amber", "emerald", "blue"] as const;

export type WorkspaceTone = (typeof TONES)[number];

/**
 * Pick a tone from the fixed 5-colour palette using a stable hash of
 * `name`. Same input → same output, every render, every machine.
 */
export function workspaceTone(name: string): WorkspaceTone {
  const sum = [...name].reduce((s, c) => s + c.charCodeAt(0), 0);
  // The non-null assertion is safe: `sum % TONES.length` is in
  // `[0, TONES.length)` and TONES is a non-empty const tuple, so the
  // index is always defined. TypeScript's `noUncheckedIndexedAccess`
  // can't narrow that on its own.
  return TONES[sum % TONES.length]!;
}

/**
 * Tailwind gradient class pair for each tone — exposed so the card (and
 * any future consumer) can paint the avatar without re-deriving the
 * mapping. Kept here so the palette is a single source of truth.
 *
 * Each entry contains literal class strings so Tailwind's content
 * scanner picks them up at build time. Do NOT compose these via
 * template literals (`from-${tone}-400`) — the JIT scanner cannot see
 * dynamically-built class names.
 */
export const WORKSPACE_TONE_GRADIENT: Record<WorkspaceTone, string> = {
  indigo: "from-indigo-400 to-purple-500",
  pink: "from-pink-400 to-rose-500",
  amber: "from-amber-400 to-orange-500",
  emerald: "from-emerald-400 to-teal-500",
  blue: "from-blue-400 to-cyan-500",
};

export { TONES as WORKSPACE_TONES };
