// ─── Milestone YAML frontmatter schema ───
//
// Lightweight validators for fields that the rest of the plan-store reader
// can't handle on its own — i.e. fields that need a regex / shape check
// before they're trusted further downstream. The bulk of milestone YAML is
// still mapped pass-through in `milestoneFromFile`; this file only narrows
// the shape for fields we actively defend.
//
// Today the only such field is `mission_id`: a short opaque id that links a
// milestone to a mission record elsewhere. It's optional (existing plans
// authored before the field existed must keep parsing without a rewrite),
// but when present it must match `MISSION_ID_REGEX`. A malformed value is
// rejected on read so the rest of the system doesn't have to re-validate.

/**
 * Hex-like opaque id: lowercase alphanumeric, 8–40 characters.
 *
 * Anchored on both ends so a value with extra whitespace or trailing junk
 * fails fast. Case-insensitive — agents often emit uppercase short shas.
 */
export const MISSION_ID_REGEX = /^[a-f0-9]{8,40}$/i;

/**
 * Validate a raw `mission_id` value pulled from milestone frontmatter.
 *
 * - `undefined` / missing key → returns `undefined` (back-compat: existing
 *   milestones authored before the field existed must keep parsing).
 * - String that matches `MISSION_ID_REGEX` → returns the string unchanged.
 * - Anything else (wrong type, malformed string) → throws.
 *
 * Throwing on read is intentional: a malformed `mission_id` is a data
 * integrity bug, not a recoverable input. Callers that want to tolerate it
 * should catch and fall back explicitly.
 */
export function parseMissionId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error(`mission_id must be a string, got ${typeof raw}`);
  }
  if (!MISSION_ID_REGEX.test(raw)) {
    throw new Error(`mission_id "${raw}" does not match ${MISSION_ID_REGEX}`);
  }
  return raw;
}
