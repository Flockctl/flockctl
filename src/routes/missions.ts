// ─── Missions router ───
//
// CRUD + timeline + proposal-list endpoints for the supervisor's `missions`
// and `mission_events` tables (parent slice 11/02). Handles only the surface
// shape — the supervisor itself runs in the background via SupervisorService
// (src/services/missions/supervisor.ts) and writes timeline events through
// the guardedEvaluate composer; this router never mutates `mission_events`.
//
// Endpoints (mounted at `/missions`):
//
//   POST   /                  create a mission
//   GET    /:id               fetch a single mission
//   PATCH  /:id               update mutable fields (objective, status,
//                             autonomy, budget_*)
//   GET    /:id/events        paginated timeline scan (cap 1000/page)
//   GET    /:id/proposals     list of `remediation_proposed` events
//                             filtered by ?status=pending|dismissed|all
//
// Why `autonomy='auto'` is gated to 501 here:
//   Parent slice §04 ships the `manual` and `suggest` autonomy modes only;
//   `auto` requires a per-step approval bypass that has not yet been wired
//   through the executor. Surfacing it as `501 Not Implemented` (rather
//   than `422`) is the explicit caller-visible signal: the grammar is valid,
//   the feature isn't here yet. The UI's "auto" button is disabled in
//   parallel — see `ui/src/components/missions/autonomy-picker.tsx`.
//
// Body validation is centralized in `createSchema` / `updateSchema` (zod).
// The destructive-verb refinement on supervisor proposals lives elsewhere
// (`src/services/missions/proposal-schema.ts`); this router only enforces
// shape + range on operator-supplied fields.
//
// Pagination cap on `/events` is intentionally raised from the global
// 100/page default (see `src/lib/pagination.ts`) to 1000/page — the
// supervisor timeline is the one place in the API where a single mission
// may legitimately want to render thousands of events at once (forensics
// view, "load entire timeline" export). The cap stops a runaway query but
// otherwise stays out of the way.

import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq, and, sql, desc } from "drizzle-orm";
import { getDb, getRawDb } from "../db/index.js";
import { missions, missionEvents } from "../db/schema.js";
import { ValidationError } from "../lib/errors.js";
import { flattenZodError } from "../lib/zod-utils.js";
import { requireRow, getProjectOrThrow } from "../lib/db-helpers.js";
import { SUPERVISOR_PROMPT_VERSION } from "../services/missions/supervisor-prompt.js";
import {
  proposalSchema,
  type Proposal,
} from "../services/missions/proposal-schema.js";
import {
  createMilestone,
  createSlice,
  createPlanTask,
  findMilestoneBySlice,
} from "../services/plan-store/index.js";
import type { Context } from "hono";

export const missionRoutes = new Hono();

// ─── Constants ───

/**
 * Per-page cap on `/missions/:id/events`. Higher than the global 100/page
 * default because the supervisor timeline is the one surface where a single
 * mission can legitimately want to render thousands of events at once
 * (forensics export, "load entire timeline" view).
 */
const EVENTS_MAX_PER_PAGE = 1000;

/** The literal autonomy mode that has not yet been implemented (slice §04). */
const AUTONOMY_NOT_IMPLEMENTED = "auto" as const;

/**
 * Closed proposal-list filter values. `pending` is the default — operators
 * scrolling the approval queue almost always want "what's left to act on".
 */
const PROPOSAL_STATUS_VALUES = ["pending", "dismissed", "all"] as const;
type ProposalStatus = (typeof PROPOSAL_STATUS_VALUES)[number];

// ─── Zod schemas ───
//
// Mirror the DB CHECK constraints (status / autonomy enums, budget_* > 0)
// so a malformed body is rejected at the route boundary with a typed 422
// error instead of a raw SQLite CHECK-constraint string. Both schemas use
// `.strict()` to refuse unknown keys — keeps the API surface tight and
// surfaces typos in client code immediately.

/**
 * Closed mission status enum — must match `missions_status_check` in
 * migration 0043. PATCH callers may set any value; transitions are not
 * gated here (the executor + scheduler enforce lifecycle rules).
 */
const STATUS_VALUES = [
  "drafting",
  "active",
  "paused",
  "completed",
  "failed",
  "aborted",
] as const;

/**
 * Closed autonomy enum — must match `missions_autonomy_check`. `auto` is
 * accepted by zod (it's a valid grammar value) so we can return a precise
 * 501 from the handler rather than a generic 422.
 */
const AUTONOMY_VALUES = ["manual", "suggest", "auto"] as const;

/**
 * Hard caps on the integer budget fields. Mirrors the per-call MAX_INT32
 * gate in BudgetEnforcer.validateField — running totals are INT64 but a
 * single create/patch can never set a number larger than what an enforcer
 * delta would accept, otherwise the first increment would throw. > 0 is
 * the migration-level CHECK; we re-state it here for a friendlier message.
 */
const MAX_BUDGET = 2_147_483_647;

const budgetTokensSchema = z
  .number()
  .int("budgetTokens must be an integer")
  .positive("budgetTokens must be > 0")
  .max(MAX_BUDGET, `budgetTokens must be <= ${MAX_BUDGET}`);

const budgetCentsSchema = z
  .number()
  .int("budgetUsdCents must be an integer")
  .positive("budgetUsdCents must be > 0")
  .max(MAX_BUDGET, `budgetUsdCents must be <= ${MAX_BUDGET}`);

const createSchema = z
  .object({
    projectId: z
      .number()
      .int("projectId must be an integer")
      .positive("projectId must be > 0"),
    objective: z
      .string()
      .min(1, "objective is required")
      .max(8000, "objective is capped at 8000 chars"),
    autonomy: z.enum(AUTONOMY_VALUES).default("suggest"),
    status: z.enum(STATUS_VALUES).default("active"),
    budgetTokens: budgetTokensSchema,
    budgetUsdCents: budgetCentsSchema,
  })
  .strict();

const updateSchema = z
  .object({
    objective: z.string().min(1).max(8000).optional(),
    autonomy: z.enum(AUTONOMY_VALUES).optional(),
    status: z.enum(STATUS_VALUES).optional(),
    budgetTokens: budgetTokensSchema.optional(),
    budgetUsdCents: budgetCentsSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

/**
 * Body schema for `POST /missions/:id/proposals/:pid/dismiss`. The operator
 * may attach an optional free-text `reason` (cap 2000 chars — same upper
 * bound as `candidate.summary` in proposalSchema, so a dismissal note can
 * faithfully quote the proposal it's rejecting). `.strict()` rejects
 * unknown keys to surface client typos at the boundary.
 *
 * The body itself is optional — clients dismissing without a reason can
 * POST an empty body, `null`, or no body at all.
 */
const dismissBodySchema = z
  .object({
    reason: z
      .string()
      .max(2000, "reason is capped at 2000 chars")
      .optional(),
  })
  .strict();

// ─── Helpers ───

/**
 * Fetch a mission row by string id, throwing 404 with a stable resource
 * label. Centralized so every handler that needs the mission gets the
 * same error shape.
 */
function getMissionOrThrow(id: string) {
  const row = getDb().select().from(missions).where(eq(missions.id, id)).get();
  return requireRow(row, "Mission", id);
}

/**
 * Coerce a `?status=` query param into the closed `ProposalStatus` enum.
 * Missing / empty falls back to `pending` (the operator-friendly default —
 * see file header). Anything else is a 422.
 */
function parseProposalStatus(c: Context): ProposalStatus {
  const raw = c.req.query("status");
  if (raw === undefined || raw === "") return "pending";
  if ((PROPOSAL_STATUS_VALUES as readonly string[]).includes(raw)) {
    return raw as ProposalStatus;
  }
  throw new ValidationError(
    `invalid status — expected one of: ${PROPOSAL_STATUS_VALUES.join(", ")}`,
  );
}

/**
 * Variant of `paginationParams` with a 1000/page cap instead of the global
 * 100/page. Same query-param shape (`page` / `per_page` OR `offset` /
 * `limit`) so clients don't have to special-case this endpoint.
 */
function eventsPaginationParams(c: Context): {
  page: number;
  perPage: number;
  offset: number;
} {
  const offsetRaw = c.req.query("offset");
  const limitRaw = c.req.query("limit");

  if (offsetRaw !== undefined || limitRaw !== undefined) {
    const perPage = Math.min(
      EVENTS_MAX_PER_PAGE,
      Math.max(1, Number(limitRaw ?? 50)),
    );
    const offset = Math.max(0, Number(offsetRaw ?? 0));
    const page = Math.floor(offset / perPage) + 1;
    return { page, perPage, offset };
  }

  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const perPage = Math.min(
    EVENTS_MAX_PER_PAGE,
    Math.max(1, Number(c.req.query("per_page") ?? 50)),
  );
  return { page, perPage, offset: (page - 1) * perPage };
}

/**
 * Decode a `mission_events.payload` JSON blob defensively. Hand-decoded
 * (rather than `JSON.parse` inline) so a single malformed row does not poison
 * the whole list response — the supervisor writes payloads via guardedEvaluate
 * which always emits valid JSON, but the column is just TEXT and we keep this
 * boundary forgiving for forensics on partially-corrupted DBs.
 */
function safeParsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { _parse_error: true, raw };
  }
}

/** Shape returned to clients — `payload` is decoded JSON, not a raw string. */
interface MissionEventResponse {
  id: string;
  missionId: string;
  kind: string;
  payload: unknown;
  costTokens: number;
  costUsdCents: number;
  depth: number;
  createdAt: number;
}

function serializeEvent(row: typeof missionEvents.$inferSelect): MissionEventResponse {
  return {
    id: row.id,
    missionId: row.missionId,
    kind: row.kind,
    payload: safeParsePayload(row.payload),
    costTokens: row.costTokens,
    costUsdCents: row.costUsdCents,
    depth: row.depth,
    createdAt: row.createdAt,
  };
}

// ─── Routes ───

// POST /missions — create a mission.
// `autonomy='auto'` is gated to 501 here (see file header).
missionRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("invalid body", flattenZodError(parsed.error));
  }
  const data = parsed.data;

  if (data.autonomy === AUTONOMY_NOT_IMPLEMENTED) {
    return c.json({ error: "autonomy.auto not implemented in v1" }, 501);
  }

  // 422 if the project doesn't exist — a 500 from the FK constraint would
  // be technically correct but unhelpful to API clients.
  getProjectOrThrow(data.projectId);

  const id = randomUUID();
  const row = getDb()
    .insert(missions)
    .values({
      id,
      projectId: data.projectId,
      objective: data.objective,
      status: data.status,
      autonomy: data.autonomy,
      budgetTokens: data.budgetTokens,
      budgetUsdCents: data.budgetUsdCents,
      supervisorPromptVersion: SUPERVISOR_PROMPT_VERSION,
    })
    .returning()
    .get();

  return c.json(row, 201);
});

// GET /missions/:id — fetch a single mission row.
missionRoutes.get("/:id", (c) => {
  const id = c.req.param("id");
  if (!id) throw new ValidationError("missing :id");
  const row = getMissionOrThrow(id);
  return c.json(row);
});

// PATCH /missions/:id — update mutable fields.
// Same `autonomy='auto' → 501` rule as POST.
missionRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  if (!id) throw new ValidationError("missing :id");
  getMissionOrThrow(id);

  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("invalid body", flattenZodError(parsed.error));
  }
  const data = parsed.data;

  if (data.autonomy === AUTONOMY_NOT_IMPLEMENTED) {
    return c.json({ error: "autonomy.auto not implemented in v1" }, 501);
  }

  const patch: Partial<typeof missions.$inferInsert> = {
    updatedAt: sql`(unixepoch())` as unknown as number,
  };
  if (data.objective !== undefined) patch.objective = data.objective;
  if (data.status !== undefined) patch.status = data.status;
  if (data.autonomy !== undefined) patch.autonomy = data.autonomy;
  if (data.budgetTokens !== undefined) patch.budgetTokens = data.budgetTokens;
  if (data.budgetUsdCents !== undefined) patch.budgetUsdCents = data.budgetUsdCents;

  getDb().update(missions).set(patch).where(eq(missions.id, id)).run();

  const updated = getDb().select().from(missions).where(eq(missions.id, id)).get();
  return c.json(requireRow(updated, "Mission", id));
});

// GET /missions/:id/events — reverse-chronological timeline scan, paginated.
//
// Uses the `(mission_id, created_at DESC)` compound index from migration 0043
// so the LIMIT + OFFSET path stays within the ~50ms timeline scan target
// asserted by the supervisor's slice 03 edge tests.
missionRoutes.get("/:id/events", (c) => {
  const id = c.req.param("id");
  if (!id) throw new ValidationError("missing :id");
  getMissionOrThrow(id);

  const { page, perPage, offset } = eventsPaginationParams(c);
  const db = getDb();
  const where = eq(missionEvents.missionId, id);

  const rows = db
    .select()
    .from(missionEvents)
    .where(where)
    .orderBy(desc(missionEvents.createdAt))
    .limit(perPage)
    .offset(offset)
    .all();

  /* v8 ignore next — SQL count(*) always returns one row, so `?? 0` is unreachable */
  const total =
    db
      .select({ count: sql<number>`count(*)` })
      .from(missionEvents)
      .where(where)
      .get()?.count ?? 0;

  return c.json({
    items: rows.map(serializeEvent),
    total,
    page,
    perPage,
  });
});

// GET /missions/:id/proposals?status=pending|dismissed|all (default pending)
//
// A "proposal" is a `mission_events` row with kind='remediation_proposed'.
// Its lifecycle is recorded by *follow-up* events whose payload references
// the original proposal's id via `payload.proposal_event_id`:
//
//   pending   — a remediation_proposed row with no later
//               remediation_dismissed/approved row pointing at it.
//   dismissed — has a later remediation_dismissed row pointing at it.
//   all       — every remediation_proposed row, regardless of follow-up.
//
// We resolve "pending" / "dismissed" with a left join over a SELECT of
// follow-up event ids (json_extract on the JSON payload). SQLite's
// json_extract is well-indexed-friendly only on materialised values, but
// the proposals list is small in practice (low single digits per mission),
// so a full scan + filter is correct and cheap. If the volume ever grows
// we can add a generated column on payload.proposal_event_id.
missionRoutes.get("/:id/proposals", (c) => {
  const id = c.req.param("id");
  if (!id) throw new ValidationError("missing :id");
  getMissionOrThrow(id);

  const status = parseProposalStatus(c);
  const sqlite = getRawDb();

  // All proposals for this mission, newest first. We fetch the full set,
  // then filter against the follow-up event index in JS — keeps the SQL
  // straightforward and the json_extract usage minimal.
  type ProposalRow = {
    id: string;
    mission_id: string;
    kind: string;
    payload: string;
    cost_tokens: number;
    cost_usd_cents: number;
    depth: number;
    created_at: number;
  };
  const proposals = sqlite
    .prepare(
      `SELECT id, mission_id, kind, payload, cost_tokens, cost_usd_cents, depth, created_at
         FROM mission_events
        WHERE mission_id = ? AND kind = 'remediation_proposed'
        ORDER BY created_at DESC`,
    )
    .all(id) as ProposalRow[];

  // Build the set of proposal ids that have been dismissed / approved by a
  // later event. One query covers both kinds; we partition in JS.
  type FollowupRow = { kind: string; proposal_event_id: string | null };
  const followups = sqlite
    .prepare(
      `SELECT kind,
              json_extract(payload, '$.proposal_event_id') AS proposal_event_id
         FROM mission_events
        WHERE mission_id = ?
          AND kind IN ('remediation_dismissed','remediation_approved')`,
    )
    .all(id) as FollowupRow[];

  const dismissed = new Set<string>();
  const approved = new Set<string>();
  for (const f of followups) {
    if (typeof f.proposal_event_id !== "string") continue;
    if (f.kind === "remediation_dismissed") dismissed.add(f.proposal_event_id);
    else if (f.kind === "remediation_approved") approved.add(f.proposal_event_id);
  }

  const filtered = proposals.filter((p) => {
    if (status === "all") return true;
    if (status === "dismissed") return dismissed.has(p.id);
    // pending — neither dismissed nor approved
    return !dismissed.has(p.id) && !approved.has(p.id);
  });

  const items: MissionEventResponse[] = filtered.map((p) => ({
    id: p.id,
    missionId: p.mission_id,
    kind: p.kind,
    payload: safeParsePayload(p.payload),
    costTokens: p.cost_tokens,
    costUsdCents: p.cost_usd_cents,
    depth: p.depth,
    createdAt: p.created_at,
  }));

  return c.json({
    items,
    total: items.length,
    status,
  });
});

// ─── Approve / dismiss proposal handlers ───
//
// Both endpoints sit on the (mission, proposal) tuple — `:id` is the mission
// id, `:pid` is the `mission_events.id` of the proposal row (kind =
// 'remediation_proposed'). 404 fires if either is missing OR if `:pid`
// resolves to a non-proposal event on the same mission, so callers cannot
// approve a `task_observed` row by guessing its id.
//
// Why approve re-validates the STORED proposal payload (not the request
// body) against `proposalSchema`:
//   Parent slice §04 security invariant
//   `approve_handler_validates_payload_with_same_zod_as_plan_generator`
//   says the approval gate must run the SAME zod the supervisor ran when
//   it minted the proposal — so a future attacker who forges a
//   `mission_events` row with kind='remediation_proposed' but a malformed
//   payload (or a destructive verb sneaked past a stale schema) cannot
//   cash that row in for a real plan-store mutation. We reconstruct the
//   `proposalSchema`-shaped object from what the supervisor stored
//   (`payload.rationale` + `payload.proposal.{target_type,candidate}`)
//   and `safeParse` it. A failure → 422 with the zod issue list, no
//   entity created, no decision event written.
//
// Idempotency (parent slice §04 design decision: easier for clients
// retrying on network failure):
//   Re-approving the same proposal returns `200` with the existing
//   `decision_id` and a no-op `idempotent: true` flag. We detect prior
//   approval via a `json_extract(payload, '$.proposal_event_id')` lookup
//   — the proposals-list endpoint above uses the exact same key, so the
//   two views stay consistent. We mirror the same idempotency on dismiss
//   so the operator UI never accumulates duplicate timeline rows from a
//   double-click on the dismiss button.

interface ProposalEventRow {
  id: string;
  mission_id: string;
  kind: string;
  payload: string;
  cost_tokens: number;
  cost_usd_cents: number;
  depth: number;
  created_at: number;
}

/**
 * Fetch a proposal event scoped to `(missionId, proposalId)`. 404 if the
 * row does not exist OR is not a `remediation_proposed` event on this
 * mission — both failure modes are operator errors, not server errors.
 */
function getProposalEventOrThrow(
  missionId: string,
  proposalId: string,
): ProposalEventRow {
  const row = getRawDb()
    .prepare(
      `SELECT id, mission_id, kind, payload, cost_tokens, cost_usd_cents, depth, created_at
         FROM mission_events
        WHERE mission_id = ? AND id = ? AND kind = 'remediation_proposed'`,
    )
    .get(missionId, proposalId) as ProposalEventRow | undefined;
  return requireRow(row, "Proposal", proposalId);
}

/**
 * Lookup an existing decision event for `(missionId, proposalEventId, kind)`.
 * Returns the decision event's id (= the `decision_id` we hand to clients),
 * or `null` if no decision has been recorded yet. ORDER BY created_at ASC
 * + LIMIT 1 means even if a race somehow produced two decisions, we always
 * surface the same id on subsequent retries.
 */
function findExistingDecisionId(
  missionId: string,
  proposalEventId: string,
  kind: "remediation_approved" | "remediation_dismissed",
): string | null {
  const row = getRawDb()
    .prepare(
      `SELECT id
         FROM mission_events
        WHERE mission_id = ?
          AND kind = ?
          AND json_extract(payload, '$.proposal_event_id') = ?
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .get(missionId, kind, proposalEventId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Reconstruct a `proposalSchema`-shaped object from the supervisor-stored
 * event payload, then re-validate it. Returns the parsed `Proposal` on
 * success; throws `ValidationError` on schema failure (so the handler
 * surfaces a typed 422 with the zod issue list). The reconstruction
 * mirrors the shape the supervisor writes (see
 * `src/services/missions/supervisor.ts` — `proposal: { target_type,
 * candidate }` next to a top-level `rationale`).
 */
function reparseStoredProposal(rawPayload: string): Proposal {
  const stored = safeParsePayload(rawPayload);
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    throw new ValidationError("stored proposal payload is not an object");
  }
  const obj = stored as Record<string, unknown>;
  const inner = obj.proposal;
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
    throw new ValidationError(
      "stored proposal payload is missing 'proposal' object",
    );
  }
  const innerObj = inner as Record<string, unknown>;
  const reconstructed = {
    kind: "proposal" as const,
    rationale: obj.rationale,
    target_type: innerObj.target_type,
    candidate: innerObj.candidate,
  };
  const parsed = proposalSchema.safeParse(reconstructed);
  if (!parsed.success) {
    throw new ValidationError(
      "stored proposal failed schema validation",
      flattenZodError(parsed.error),
    );
  }
  return parsed.data;
}

/**
 * Resolve the on-disk plan directory for the mission's project. Mirrors
 * `getProjectPath()` in `routes/planning.ts` — keep them in lockstep so
 * approval + interactive plan-edit endpoints fail with the same error
 * shape on a path-less project.
 */
function getProjectPathForMission(missionRow: typeof missions.$inferSelect): string {
  const project = getProjectOrThrow(missionRow.projectId);
  if (!project.path) {
    throw new ValidationError("Project has no path configured");
  }
  return project.path;
}

interface CreatedEntity {
  entityKind: "milestone" | "slice" | "task";
  targetId: string;
  parentSliceSlug?: string;
  parentMilestoneSlug?: string;
}

/**
 * Materialize an approved proposal as a plan-store entity. Routes by
 * `target_type` to the existing creator function so the on-disk shape
 * matches what `POST /projects/:pid/...` would write — approval is just
 * a different entry point into the same authoring code path.
 *
 * `candidate.target_id` is the parent pointer:
 *   - milestone: ignored (the milestone has no parent)
 *   - slice:     parent milestone slug (REQUIRED — 422 if absent/unknown)
 *   - task:      parent slice slug; the milestone is resolved via
 *                `findMilestoneBySlice` (parent slice slugs are unique
 *                within a milestone but the milestone itself isn't
 *                supplied by the supervisor — see findMilestoneBySlice
 *                docs for the cross-milestone tie-breaker).
 *
 * Title is taken from `candidate.action`; the verbose `candidate.summary`
 * (when present) becomes the entity description so the operator-facing
 * "why this exists" text is preserved on disk.
 */
function createEntityFromProposal(
  projectPath: string,
  proposal: Proposal,
): CreatedEntity {
  const { target_type, candidate } = proposal;
  // candidate.action is capped at 500 chars by proposalSchema; keep titles
  // shorter so the on-disk slug (derived from title) stays readable.
  const title = candidate.action.slice(0, 200);
  const description = typeof candidate.summary === "string" ? candidate.summary : undefined;

  if (target_type === "milestone") {
    const m = createMilestone(projectPath, { title, description });
    return { entityKind: "milestone", targetId: m.slug };
  }

  if (target_type === "slice") {
    const milestoneSlug = candidate.target_id;
    if (!milestoneSlug) {
      throw new ValidationError(
        "proposal.candidate.target_id is required for target_type='slice' (parent milestone slug)",
      );
    }
    const s = createSlice(projectPath, milestoneSlug, { title, description });
    return {
      entityKind: "slice",
      targetId: s.slug,
      parentMilestoneSlug: milestoneSlug,
    };
  }

  // target_type === "task"
  const sliceSlug = candidate.target_id;
  if (!sliceSlug) {
    throw new ValidationError(
      "proposal.candidate.target_id is required for target_type='task' (parent slice slug)",
    );
  }
  const milestone = findMilestoneBySlice(projectPath, sliceSlug);
  if (!milestone) {
    throw new ValidationError(
      `parent milestone for slice '${sliceSlug}' not found`,
    );
  }
  const t = createPlanTask(projectPath, milestone.slug, sliceSlug, {
    title,
    description,
  });
  return {
    entityKind: "task",
    targetId: t.slug,
    parentSliceSlug: sliceSlug,
    parentMilestoneSlug: milestone.slug,
  };
}

/**
 * Single insert helper for decision events written by the approve / dismiss
 * handlers. We do NOT route these through `guardedEvaluate` — those
 * endpoints are operator-driven, not LLM-driven, so the budget / depth
 * gates don't apply (the operator already saw the proposal and is
 * spending their own attention, not model tokens). Cost is hard-coded
 * to {0, 0} because no provider call happened.
 */
function writeDecisionEvent(
  decisionId: string,
  missionId: string,
  kind: "remediation_approved" | "remediation_dismissed",
  payload: Record<string, unknown>,
  depth: number,
): void {
  getRawDb()
    .prepare(
      `INSERT INTO mission_events
         (id, mission_id, kind, payload, cost_tokens, cost_usd_cents, depth)
       VALUES (?, ?, ?, ?, 0, 0, ?)`,
    )
    .run(decisionId, missionId, kind, JSON.stringify(payload), depth);
}

// POST /missions/:id/proposals/:pid/approve
//
// Validates the STORED proposal against `proposalSchema`, creates the
// matching plan-store entity on disk, and records a `remediation_approved`
// event. Idempotent on retries (returns the same `decision_id`).
missionRoutes.post("/:id/proposals/:pid/approve", async (c) => {
  const id = c.req.param("id");
  const pid = c.req.param("pid");
  if (!id) throw new ValidationError("missing :id");
  if (!pid) throw new ValidationError("missing :pid");

  const mission = getMissionOrThrow(id);
  const proposalRow = getProposalEventOrThrow(id, pid);

  // Idempotent re-approve — short-circuit before mutating anything on
  // disk so a retry never creates a duplicate slice/task/milestone.
  const existingDecisionId = findExistingDecisionId(id, pid, "remediation_approved");
  if (existingDecisionId !== null) {
    return c.json(
      {
        decision_id: existingDecisionId,
        proposal_event_id: pid,
        idempotent: true,
      },
      200,
    );
  }

  // Body, if any, is consumed but not required — the source of truth
  // is the stored proposal payload. Accepting (and ignoring) a body
  // keeps clients that POST `{}` happy without a 415 / 400.
  await c.req.json().catch(() => null);

  // Re-validate the stored proposal with the same zod the supervisor
  // used when minting it (security invariant — see file header above).
  const proposal = reparseStoredProposal(proposalRow.payload);

  const projectPath = getProjectPathForMission(mission);
  const created = createEntityFromProposal(projectPath, proposal);

  const decisionId = randomUUID();
  writeDecisionEvent(
    decisionId,
    id,
    "remediation_approved",
    {
      proposal_event_id: pid,
      target_type: proposal.target_type,
      entity_kind: created.entityKind,
      target_id: created.targetId,
      ...(created.parentMilestoneSlug
        ? { parent_milestone_slug: created.parentMilestoneSlug }
        : {}),
      ...(created.parentSliceSlug
        ? { parent_slice_slug: created.parentSliceSlug }
        : {}),
    },
    proposalRow.depth,
  );

  return c.json(
    {
      decision_id: decisionId,
      proposal_event_id: pid,
      target_type: proposal.target_type,
      entity_kind: created.entityKind,
      target_id: created.targetId,
    },
    200,
  );
});

// POST /missions/:id/proposals/:pid/dismiss
//
// Records a `remediation_dismissed` event with an optional operator-
// supplied reason. No plan-store mutation. Idempotent on retries.
missionRoutes.post("/:id/proposals/:pid/dismiss", async (c) => {
  const id = c.req.param("id");
  const pid = c.req.param("pid");
  if (!id) throw new ValidationError("missing :id");
  if (!pid) throw new ValidationError("missing :pid");

  getMissionOrThrow(id);
  const proposalRow = getProposalEventOrThrow(id, pid);

  // Idempotent re-dismiss. Symmetric with approve so the operator UI
  // can retry blindly — a double-click on "dismiss" never produces two
  // timeline rows.
  const existingDecisionId = findExistingDecisionId(id, pid, "remediation_dismissed");
  if (existingDecisionId !== null) {
    return c.json(
      {
        decision_id: existingDecisionId,
        proposal_event_id: pid,
        idempotent: true,
      },
      200,
    );
  }

  // Empty / missing body is fine — `reason` is optional.
  const body = (await c.req.json().catch(() => ({}))) ?? {};
  const parsed = dismissBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError("invalid body", flattenZodError(parsed.error));
  }
  const { reason } = parsed.data;

  const decisionId = randomUUID();
  writeDecisionEvent(
    decisionId,
    id,
    "remediation_dismissed",
    {
      proposal_event_id: pid,
      ...(reason !== undefined ? { reason } : {}),
    },
    proposalRow.depth,
  );

  return c.json(
    {
      decision_id: decisionId,
      proposal_event_id: pid,
      ...(reason !== undefined ? { reason } : {}),
    },
    200,
  );
});
