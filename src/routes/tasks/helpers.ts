import { z } from "zod";
import { tasks } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";

// ─── Spec field caps ───
// Caps are enforced at the API boundary so invalid payloads never reach the
// DB. `decisionTable` is a JSON object whose `rules` array is capped so the
// spec can be rendered without pagination in the UI.
export const SPEC_MAX_ACCEPTANCE_CRITERIA_ITEMS = 50;
export const SPEC_MAX_ACCEPTANCE_CRITERION_CHARS = 500;
export const SPEC_MAX_DECISION_TABLE_RULES = 50;

const acceptanceCriteriaSchema = z
  .array(
    z
      .string()
      .max(
        SPEC_MAX_ACCEPTANCE_CRITERION_CHARS,
        `each acceptance criterion must be ≤ ${SPEC_MAX_ACCEPTANCE_CRITERION_CHARS} characters`,
      ),
  )
  .max(
    SPEC_MAX_ACCEPTANCE_CRITERIA_ITEMS,
    `acceptanceCriteria must contain ≤ ${SPEC_MAX_ACCEPTANCE_CRITERIA_ITEMS} items`,
  );

// `rules` is the only field we cap. Other keys are preserved untouched so the
// caller can attach metadata (e.g. `version`, `columns`) without triggering a
// schema update on every additive change.
const decisionTableSchema = z
  .object({
    rules: z
      .array(z.unknown())
      .max(
        SPEC_MAX_DECISION_TABLE_RULES,
        `decisionTable.rules must contain ≤ ${SPEC_MAX_DECISION_TABLE_RULES} entries`,
      )
      .optional(),
  })
  .passthrough();

export const taskSpecSchema = z.object({
  acceptanceCriteria: acceptanceCriteriaSchema.nullable().optional(),
  decisionTable: decisionTableSchema.nullable().optional(),
});

export function parseSpecFieldsOrThrow(body: unknown): z.infer<typeof taskSpecSchema> {
  const parsed = taskSpecSchema.safeParse(body);
  if (!parsed.success) {
    // Collapse zod issues into a ValidationError-compatible `details` map so
    // the client can highlight the offending field.
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.length > 0 ? String(issue.path[0]) : "_";
      (details[key] ||= []).push(issue.message);
    }
    throw new AppError(400, "Invalid task spec fields", details);
  }
  return parsed.data;
}

export function parseJsonOrNull<T>(value: string | null | undefined): T | null {
  if (value == null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function serializeSpec(row: typeof tasks.$inferSelect) {
  return {
    acceptanceCriteria: parseJsonOrNull<string[]>(row.acceptanceCriteria),
    decisionTable: parseJsonOrNull<Record<string, unknown>>(row.decisionTable),
  };
}
