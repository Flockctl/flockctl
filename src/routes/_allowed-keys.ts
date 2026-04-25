import { inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { aiProviderKeys } from "../db/schema.js";
import { ValidationError } from "../lib/errors.js";

/**
 * Parse and validate `allowedKeyIds` for workspace/project create requests.
 *
 * Contract: at least one active AI-provider key MUST be selected when
 * creating a workspace or project. This is the signal "this scope is
 * allowed to run with these keys"; an empty selection would mean "nothing
 * can run here", which is not a useful default.
 *
 * Returns a normalized, deduplicated array of numeric IDs — safe to JSON-
 * stringify into the `allowed_key_ids` column.
 *
 * Throws `ValidationError` on:
 *   - missing / non-array input
 *   - empty array
 *   - non-numeric entries
 *   - IDs that do not exist in ai_provider_keys
 *   - IDs that exist but are currently `is_active=false`
 *
 * PATCH routes enforce the same rule when the caller sends `allowedKeyIds`
 * explicitly — see `parseRequiredAllowedKeyIdsOnUpdate` below. Omitting
 * the field is how you "leave it as-is." Clearing is no longer permitted;
 * without that the create-time gate could be bypassed one PATCH later.
 */
export function parseRequiredAllowedKeyIdsOnCreate(raw: unknown): number[] {
  return validateAllowedKeyIds(raw, "allowedKeyIds is required: pick at least one active AI provider key");
}

/**
 * Same contract as `parseRequiredAllowedKeyIdsOnCreate`, but tailored for
 * PATCH routes where the field is OPTIONAL (may be absent = leave current
 * value untouched). When the caller explicitly sends `allowedKeyIds`, the
 * same "must be a non-empty array of active known key IDs" rule applies —
 * the Settings page is the other place users change their key allow-list,
 * so relaxing it on update would create a back door around the create-time
 * gate.
 *
 * Returns:
 *   - `undefined` if the field wasn't provided (caller should skip the write)
 *   - a normalized number[] if the field was provided and valid
 *
 * Throws `ValidationError` on the same cases as the create variant, plus
 * when the caller explicitly passes `null` / `[]` to clear the allow-list —
 * clearing is no longer allowed.
 */
export function parseRequiredAllowedKeyIdsOnUpdate(
  raw: unknown,
  hasField: boolean,
): number[] | undefined {
  if (!hasField) return undefined;
  return validateAllowedKeyIds(
    raw,
    "allowedKeyIds must contain at least one active AI provider key — clearing the allow-list is no longer permitted",
  );
}

function validateAllowedKeyIds(raw: unknown, missingMsg: string): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError(missingMsg);
  }

  const ids: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ValidationError("allowedKeyIds must contain positive numeric IDs");
    }
    if (!ids.includes(n)) ids.push(n);
  }

  const db = getDb();
  const rows = db
    .select({ id: aiProviderKeys.id, isActive: aiProviderKeys.isActive })
    .from(aiProviderKeys)
    .where(inArray(aiProviderKeys.id, ids))
    .all();

  const foundIds = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new ValidationError(
      `allowedKeyIds contains unknown key IDs: ${missing.join(", ")}`,
    );
  }

  const inactive = rows.filter((r) => !r.isActive).map((r) => r.id);
  if (inactive.length > 0) {
    throw new ValidationError(
      `allowedKeyIds contains inactive keys: ${inactive.join(", ")}`,
    );
  }

  return ids;
}
