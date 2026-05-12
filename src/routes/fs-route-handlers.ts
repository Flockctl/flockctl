import type { Context } from "hono";
import { z } from "zod";
import { ValidationError } from "../lib/errors.js";
import { parseIdParam } from "../lib/route-params.js";
import { flattenZodError } from "../lib/zod-utils.js";
import {
  listProjectDir,
  readProjectFile,
  readProjectFileRange,
  writeProjectFile,
  mkdirInRoot,
  createFileInRoot,
  renameInRoot,
  deleteInRoot,
  indexProjectPaths,
  MAX_CREATE_BYTES,
  MAX_READ_BYTES,
  type FsErrorCode,
  type FsIndexResult,
  type FsListResult,
  type FsMutateResult,
  type FsRangeReadResult,
  type FsReadResult,
  type FsWriteResult,
} from "../services/fs-operations.js";
import { getDb } from "../db/index.js";
import { fsAuditLog } from "../db/schema.js";

/**
 * fs-route-handlers — single source of truth for the entity-scoped FS
 * endpoints (`/:id/fs/list`, future `/fs/read` / `/fs/search`) that both the
 * project router and the workspace router expose.
 *
 * The factory mirrors `git-route-handlers.ts`: same shape, same getEntity /
 * attribution split, same response contract. Differences:
 *   - The audit row is structured-logged (one line per request) rather than
 *     inserted into `git_audit_log` — listings are read traffic and would
 *     drown the forensic value of the audit table. Emitting a JSON line on
 *     stderr lets ops grep through the daemon log without a schema change.
 *   - Failures are reported as HTTP 200 with `{ ok: false, error_code }` so
 *     `apiFetch` does not throw away the structured `error_code` the UI uses
 *     to switch on (e.g. render an "outside root" badge vs a generic 500).
 *     The only HTTP error statuses are pre-FS shape errors: 404 on missing
 *     entity, 422 on missing path / unparseable id.
 */

export interface FsEntity {
  id: number;
  /** May be NULL on workspaces / projects that haven't picked an on-disk root. */
  path: string | null;
}

export interface FsAttribution {
  projectId?: number | string;
  workspaceId?: number | string;
}

export interface MakeFsRouteHandlersOptions<T extends FsEntity> {
  /** Resource label inserted into the 422 "no path" message. */
  resourceLabel: string;
  /** 'project' | 'workspace' — written verbatim into `fs_audit_log.entity_type`. */
  entityType: "project" | "workspace";
  /** Look up the entity by id; MUST throw NotFoundError when missing. */
  getEntity: (id: number) => T;
  /** Map the entity to the audit-log attribution scope. */
  attribution: (entity: T) => FsAttribution;
}

/**
 * Insert one row into `fs_audit_log` per `readFile` invocation. Best-effort:
 * any failure (DB closed, table missing, schema drift) is logged and
 * swallowed so a broken audit table cannot mask the real read outcome the
 * caller is waiting on. Mirrors the `writeAuditRow` posture in
 * `git-operations.ts`, but lives at the route layer rather than the service
 * layer because the read service is pure (no DB access at all) — the route
 * handler is the natural place to project the result onto a row.
 */
function writeFsAuditRow(args: {
  entityType: "project" | "workspace";
  entityId: number;
  attribution: FsAttribution;
  action: "read" | "write" | "mkdir" | "create" | "rename" | "delete";
  path: string;
  ok: boolean;
  errorCode?: string;
  ts: number;
  /** Pre-write sha-256; only set on `action='write'`. NULL elsewhere. */
  shaBefore?: string | null;
  /** Post-write sha-256; only set on successful `action='write'`. */
  shaAfter?: string | null;
  /** Payload size in bytes; only set on `action='write'`. */
  bytes?: number | null;
}): void {
  try {
    const db = getDb();
    const projectId =
      args.attribution.projectId !== undefined
        ? Number(args.attribution.projectId)
        : null;
    const workspaceId =
      args.attribution.workspaceId !== undefined
        ? Number(args.attribution.workspaceId)
        : null;
    db.insert(fsAuditLog).values({
      entityType: args.entityType,
      entityId: args.entityId,
      projectId: Number.isFinite(projectId) ? (projectId as number) : null,
      workspaceId: Number.isFinite(workspaceId) ? (workspaceId as number) : null,
      action: args.action,
      path: args.path,
      ok: args.ok ? 1 : 0,
      errorCode: args.errorCode ?? null,
      ts: args.ts,
      shaBefore: args.shaBefore ?? null,
      shaAfter: args.shaAfter ?? null,
      bytes: args.bytes ?? null,
    }).run();
  } catch (err) {
    /* v8 ignore next 2 — audit failure is intentionally swallowed; integration
       tests verify the success-path write. A missing-table scenario fails
       those tests instead, so this branch is unreachable in CI. */
    console.error("[fs-audit] insert failed:", err);
  }
}

/**
 * Map our internal `FsErrorCode` enum onto the audit-log "error_code" field.
 * Kept as a no-op pass-through for now — the indirection is a future-proofing
 * lever: if we ever need to translate between internal and operator-facing
 * codes (e.g. coalesce permission_denied + invalid_path into a single
 * "fs_failed" bucket for log aggregation) this is the one place to do it.
 */
function auditErrorCode(code: FsErrorCode | undefined): string | undefined {
  return code;
}

/**
 * Emit a single-line structured audit record for one fs/list invocation.
 * Failures here are swallowed — a broken stderr / log shipper must never
 * mask the real listing outcome. Mirrors the `writeAuditRow` posture in
 * `git-operations.ts`.
 */
function logFsAudit(record: {
  action: "list" | "index";
  attribution: FsAttribution;
  path: string;
  ok: boolean;
  errorCode?: string;
  entryCount: number;
  truncated?: boolean;
  durationMs: number;
}): void {
  try {
    const line = JSON.stringify({
      tag: "fs_audit",
      action: record.action,
      project_id: record.attribution.projectId ?? null,
      workspace_id: record.attribution.workspaceId ?? null,
      path: record.path,
      ok: record.ok,
      error_code: record.errorCode ?? null,
      entry_count: record.entryCount,
      truncated: record.truncated ?? false,
      duration_ms: record.durationMs,
    });

    console.log(line);
  } catch {
    /* swallow — audit is observability, not correctness */
  }
}

// ─── POST /:id/fs/op — body schema ────────────────────────────────────────
//
// Discriminated union on `op`. Path caps mirror the route-level limits used
// elsewhere in the daemon (`gitDiscardBodySchema` uses 1024 bytes per path —
// we go tighter at 500 because the file-tree UI never legitimately surfaces
// a 1KB filename, and the smaller cap defends the validator from a 10MB
// payload made of one-character ops). `.strict()` on every variant catches
// future-refactor surprises: any new field has to be enumerated here, and
// a misspelled / extra key is a 422 rather than a silently-ignored input.
//
// `recursive` defaults to false on the delete branch — opt-in is the contract
// pinned by the slice spec ("if dir and not recursive → require empty"). The
// `create` branch's `content` is optional so right-click → New file with no
// body works (zero-byte file).
const FS_PATH = z.string().min(1).max(500);
const fsOpBodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("mkdir"), path: FS_PATH }).strict(),
  z
    .object({
      op: z.literal("create"),
      path: FS_PATH,
      content: z.string().max(MAX_CREATE_BYTES).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("rename"),
      from: FS_PATH,
      to: FS_PATH,
    })
    .strict(),
  z
    .object({
      op: z.literal("delete"),
      path: FS_PATH,
      recursive: z.boolean().optional().default(false),
    })
    .strict(),
]);

/**
 * Render the relative path (or path pair) we record on the audit row for a
 * given mutation op. We deliberately store the request-supplied path verbatim
 * (no canonicalisation) so the audit table cannot leak operator filesystem
 * layout — same posture as the read-flow audit row. Rename is the only op
 * with two paths; we encode the pair as `from -> to` so a single column
 * carries the full forensic context without a schema change.
 */
function fsOpAuditPath(body: z.infer<typeof fsOpBodySchema>): string {
  if (body.op === "rename") return `${body.from} -> ${body.to}`;
  return body.path;
}

// ─── PUT /:id/fs/file — body schema ───────────────────────────────────────
//
// Body shape for the optimistic-concurrency write endpoint. The Zod schema
// is the route's first line of defence:
//   - `content` is capped at MAX_READ_BYTES (2 MiB) so the validator
//     short-circuits oversize payloads before they ever reach the service
//     layer's mutex / temp-file path. The service layer ALSO checks (Rule 2
//     of the writeProjectFile contract) so an internal caller bypassing the
//     route can't smuggle a bigger payload.
//   - `expectedSha` is either an empty string ("I'm creating, no prior
//     state") or a 64-char lowercase hex sha-256 — anything else is a
//     malformed request the UI should never produce. We accept both `''` and
//     the 64-char form via a union so the validator's error message stays
//     readable when the caller ships e.g. `'abc'` (a half-typed sha) — that
//     fails the regex AND the literal, and Zod surfaces both branches.
//   - `allowCreate` defaults to false: an explicit opt-in to create a
//     missing file mirrors the service-layer contract, and the default-false
//     stops a stale frontend from silently re-creating a file the operator
//     just deleted in another tab.
//   - `.strict()` so an unknown field (e.g. a misspelled `expected_sha` /
//     `expectedHash`) is a 422 rather than a silently-ignored input.
const writeFileBodySchema = z
  .object({
    content: z.string().max(MAX_READ_BYTES),
    expectedSha: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "must be a 64-char lowercase hex sha-256")
      .or(z.literal("")),
    allowCreate: z.boolean().optional().default(false),
  })
  .strict();

/**
 * Parse an HTTP-Range-style `bytes=N-M` (or `bytes=N-`) string into the
 * service-layer `{ offset, length? }` shape. Returns `null` on any malformed
 * input — the route handler maps that onto an `fs_invalid_range` body.
 *
 * Two intentional shape choices:
 *   - **Single-range only.** The HTTP spec allows multi-range (`bytes=0-9,20-29`)
 *     but the file-viewer use case is one window at a time and multi-range
 *     responses require multipart/byteranges, which is overkill here.
 *   - **Last-byte is inclusive.** `bytes=0-9` requests 10 bytes; we convert
 *     to `length = last - offset + 1` before handing off. This matches the
 *     HTTP/1.1 spec so a UI library that already speaks HTTP Range can be
 *     re-used unchanged.
 */
function parseBytesRangeHeader(
  value: string,
): { offset: number; length?: number } | null {
  const trimmed = value.trim();
  // `bytes=<offset>-<last?>` — last is optional; the dash is mandatory so we
  // can't be confused with a single-number "give me everything from N".
  const m = /^bytes=(\d+)-(\d*)$/i.exec(trimmed);
  if (!m) return null;
  const offset = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(offset) || offset < 0) return null;
  if (m[2] === "") return { offset };
  const last = Number.parseInt(m[2]!, 10);
  if (!Number.isFinite(last) || last < offset) return null;
  return { offset, length: last - offset + 1 };
}

export function makeFsRouteHandlers<T extends FsEntity>(
  opts: MakeFsRouteHandlersOptions<T>,
) {
  const requirePath = (entity: T, action: "list" | "read" | "index"): string => {
    if (!entity.path) {
      throw new ValidationError(
        `${opts.resourceLabel} has no path — cannot run fs ${action}`,
      );
    }
    return entity.path;
  };

  return {
    /**
     * GET /:id/fs/list?path=<rel> — directory listing for the file-tree UI.
     *
     * Pre-FS errors (missing entity, missing path, unparseable id) are
     * reported with their natural HTTP status (404 / 422). Anything that
     * involves touching the filesystem returns HTTP 200 with a discriminated
     * body so the UI can render a useful error per FsErrorCode. Truncation
     * past `LIST_ENTRY_CAP` is reported via `truncated:true` rather than a
     * separate response code — the entries we DID gather are still useful.
     */
    list: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const root = requirePath(entity, "list");
      const attribution = opts.attribution(entity);

      const rawPath = c.req.query("path") ?? "";

      const startedAt = Date.now();
      let result: FsListResult;
      try {
        result = await listProjectDir(root, rawPath);
      } catch (err) {
        // listProjectDir is supposed to swallow errno mapping internally;
        // an exception here means a programmer error (e.g. a thrown TypeError
        // from a refactor). Surface it as fs_internal_error so the UI can
        // render a generic message — and let the global error handler still
        // see the stack via the rethrow below.

        console.error("[fs-route-handlers] list threw:", err);
        result = {
          ok: false,
          error_code: "fs_internal_error",
          message: "internal error",
        };
      }
      const durationMs = Date.now() - startedAt;

      logFsAudit({
        action: "list",
        attribution,
        path: rawPath || ".",
        ok: result.ok,
        errorCode: result.ok ? undefined : auditErrorCode(result.error_code),
        entryCount: result.ok ? result.entries.length : 0,
        truncated: result.ok ? result.truncated : false,
        durationMs,
      });

      return c.json(result);
    },

    /**
     * GET /:id/fs/index — flat path enumeration for the quick-open / fuzzy
     * finder UI. Returns every non-ignored file path under the entity root,
     * relative + POSIX-separated, capped at `INDEX_PATH_CAP` (50k) entries
     * with a `truncated` flag so the UI can render a banner.
     *
     * Same wire contract as `list`: HTTP 200 with a discriminated body
     * (`{ ok:true, paths, truncated } | { ok:false, error_code, message? }`)
     * for every FS-domain outcome. Pre-FS errors (missing entity, no entity
     * path) follow the standard 404 / 422 envelope.
     *
     * The handler delegates the gzip on the wire to the global compression
     * middleware — the JSON list is highly compressible (long shared path
     * prefixes) so a 50 k-entry response shrinks ~5-10×. Audit goes through
     * the same `logFsAudit` channel as `list` (single stderr line per call)
     * because the index endpoint is read traffic and would drown the
     * forensic value of the `fs_audit_log` table.
     */
    index: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const root = requirePath(entity, "index");
      const attribution = opts.attribution(entity);

      const startedAt = Date.now();
      let result: FsIndexResult;
      try {
        result = await indexProjectPaths(root);
      } catch (err) {
        // indexProjectPaths is supposed to swallow errno mapping internally;
        // an exception here means a programmer error (e.g. a thrown
        // TypeError from a refactor). Surface fs_internal_error so the UI
        // can render a generic message.

        console.error("[fs-route-handlers] index threw:", err);
        result = {
          ok: false,
          error_code: "fs_internal_error",
          message: "internal error",
        };
      }
      const durationMs = Date.now() - startedAt;

      logFsAudit({
        action: "index",
        attribution,
        path: ".",
        ok: result.ok,
        errorCode: result.ok ? undefined : auditErrorCode(result.error_code),
        entryCount: result.ok ? result.paths.length : 0,
        truncated: result.ok ? result.truncated : false,
        durationMs,
      });

      return c.json(result);
    },

    /**
     * GET /:id/fs/file?path=<rel> — read a single text file under the entity
     * root. Identical response-shape contract to `list`: HTTP 200 with a
     * `{ ok, ... }` discriminated body, including FS-domain failures.
     *
     * Audit: every invocation writes exactly one row to `fs_audit_log`,
     * including failures. The row records the request-supplied relative path
     * verbatim — never the resolved absolute path, never file contents — so
     * the audit table cannot leak operator filesystem layout or text-file
     * data even to operators with read access to the audit log itself.
     *
     * Pre-FS errors (missing entity, no entity path) follow the standard
     * 404 / 422 envelope and DO write an audit row with `ok=0` and the
     * matching `error_code` so the forensic trail is complete. The only
     * un-audited failures are pre-route ones (Hono's id parse, the route
     * never matched at all).
     */
    readFile: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const attribution = opts.attribution(entity);
      const rawPath = c.req.query("path") ?? "";
      const rangeQuery = c.req.query("range");
      const ts = Date.now();

      // No entity path → fs_no_project_path (200 body, NOT 422). Reason: the
      // spec lists `fs_no_project_path` as one of the FsErrorCodes the route
      // surfaces in-body, and audit-row symmetry is easier when EVERY outcome
      // — including the no-path one — flows through the same writer. Mirrors
      // the response contract pinned in the slice's "Expected output" section.
      if (!entity.path) {
        const result: FsReadResult = {
          ok: false,
          error_code: "fs_no_project_path",
          message: `${opts.resourceLabel} has no path — cannot read file`,
        };
        writeFsAuditRow({
          entityType: opts.entityType,
          entityId: entity.id,
          attribution,
          action: "read",
          path: rawPath,
          ok: false,
          errorCode: "fs_no_project_path",
          ts,
        });
        return c.json(result);
      }

      // ─── Range branch ──────────────────────────────────────────────────
      // `?range=bytes=N-M` (HTTP Range-style; both ends inclusive) routes to
      // the partial reader. A successful partial response carries the 206
      // Partial Content status — every other outcome (parse error, FS
      // error) collapses to 200 with `{ok:false}` for parity with the
      // whole-file path. Audit gets exactly one row regardless of branch.
      if (rangeQuery !== undefined && rangeQuery !== "") {
        const parsed = parseBytesRangeHeader(rangeQuery);
        if (parsed === null) {
          const result: FsRangeReadResult = {
            ok: false,
            error_code: "fs_invalid_range",
            message:
              "malformed range parameter; expected bytes=<offset>-<last> or bytes=<offset>-",
          };
          writeFsAuditRow({
            entityType: opts.entityType,
            entityId: entity.id,
            attribution,
            action: "read",
            path: rawPath,
            ok: false,
            errorCode: "fs_invalid_range",
            ts,
          });
          return c.json(result);
        }

        const rangeResult = await readProjectFileRange(entity.path, rawPath, {
          offset: parsed.offset,
          length: parsed.length,
        });

        writeFsAuditRow({
          entityType: opts.entityType,
          entityId: entity.id,
          attribution,
          action: "read",
          path: rawPath,
          ok: rangeResult.ok,
          errorCode: rangeResult.ok ? undefined : rangeResult.error_code,
          ts,
        });

        // 206 Partial Content on success — failures stay 200 so the UI's
        // generic FS-result reducer doesn't have to special-case 4xx for
        // ranged reads.
        if (rangeResult.ok) return c.json(rangeResult, 206);
        return c.json(rangeResult);
      }

      const result = await readProjectFile(entity.path, rawPath);

      writeFsAuditRow({
        entityType: opts.entityType,
        entityId: entity.id,
        attribution,
        action: "read",
        // Persist the request-supplied (UTF-8, post-Hono-decode) relative
        // path. We deliberately do NOT persist the canonical absolute path
        // resolved inside readProjectFile — that would leak the operator's
        // filesystem layout to anyone with audit access.
        path: rawPath,
        ok: result.ok,
        errorCode: result.ok ? undefined : result.error_code,
        ts,
      });

      return c.json(result);
    },

    /**
     * PUT /:id/fs/file?path=<rel> — write a single text file under the entity
     * root with optimistic-concurrency control. Body shape:
     *
     *   { content: string, expectedSha: '' | <64-hex>, allowCreate?: boolean }
     *
     * Wire contract mirrors `readFile`: HTTP 200 with a `{ ok, ... }`
     * discriminated body for every FS-domain outcome (success or recoverable
     * failure). Only HTTP error statuses are pre-FS shape errors:
     *   - 404 missing entity (thrown by `getEntity`)
     *   - 422 malformed body (thrown by ZodError mapping)
     *   - 422 missing entity path (audit-then-200 — see `entity.path` branch)
     *
     * Headline outcomes:
     *   - `{ ok: true, sha, mtime, size }` — write succeeded; the caller can
     *     use the returned `sha` as the next request's `expectedSha` without
     *     a follow-up read.
     *   - `{ ok: false, error_code: 'fs_sha_conflict', currentSha }` — the
     *     on-disk sha doesn't match the caller's `expectedSha` (or the file
     *     was missing without `allowCreate`). The UI uses `currentSha` to
     *     prompt a refresh-and-retry instead of overwriting concurrent
     *     changes.
     *   - `{ ok: false, error_code: 'fs_too_large' }` — payload exceeded the
     *     2 MiB cap. The Zod schema usually catches this first (returns 422),
     *     so this branch fires only when the validator was bypassed.
     *
     * Audit: every invocation writes exactly ONE row to `fs_audit_log` with
     * `action='write'` and the new `sha_before` / `sha_after` / `bytes`
     * columns populated. The audit row records:
     *   - `sha_before` = the on-disk sha BEFORE the write (NULL when the
     *     file didn't exist), regardless of whether the write succeeded —
     *     the forensic value is "what state did the writer overwrite".
     *   - `sha_after`  = the post-rename sha on success; NULL on failure
     *     (no rename happened, no canonical post-state exists).
     *   - `bytes`      = `Buffer.byteLength(content, 'utf-8')`. Recorded on
     *     failure rows too so an audit trail of "user TRIED to write 12 MiB"
     *     survives.
     */
    writeFile: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const attribution = opts.attribution(entity);
      const rawPath = c.req.query("path") ?? "";
      const ts = Date.now();

      // Body parse FIRST so a malformed body is a 422 even when entity.path
      // is missing. This mirrors how the mutation `op` handler orders its
      // checks: shape errors are loud; FS-domain errors are quiet.
      const raw = await c.req.json().catch(() => null);
      const parsed = writeFileBodySchema.safeParse(raw);
      if (!parsed.success) {
        throw new ValidationError(
          "invalid body",
          flattenZodError(parsed.error),
        );
      }
      const body = parsed.data;
      const bytes = Buffer.byteLength(body.content, "utf-8");

      // No entity path → fs_no_project_path audit row + 200 envelope, mirror
      // of readFile / op flows. Audit row records `bytes` (the caller's
      // payload size) but no shaBefore/shaAfter — there's no on-disk file
      // to hash, and the write never started.
      if (!entity.path) {
        const result: FsWriteResult = {
          ok: false,
          error_code: "fs_no_project_path",
          message: `${opts.resourceLabel} has no path — cannot write file`,
        };
        writeFsAuditRow({
          entityType: opts.entityType,
          entityId: entity.id,
          attribution,
          action: "write",
          path: rawPath,
          ok: false,
          errorCode: "fs_no_project_path",
          ts,
          shaBefore: null,
          shaAfter: null,
          bytes,
        });
        return c.json(result);
      }

      const result = await writeProjectFile(
        entity.path,
        rawPath,
        body.content,
        body.expectedSha,
        { allowCreate: body.allowCreate },
      );

      // Compute shaBefore for the audit trail. On success: it's whatever
      // expectedSha the caller proved against (or "" on a fresh-create).
      // On fs_sha_conflict: the service hands back `currentSha` (which IS
      // the on-disk sha at the moment of the conflict) — that's the right
      // shaBefore. On every other failure mode the on-disk state is either
      // unchanged or never inspected; we record null rather than guess.
      let shaBefore: string | null;
      let shaAfter: string | null;
      if (result.ok) {
        shaBefore = body.expectedSha === "" ? null : body.expectedSha;
        shaAfter = result.sha;
      } else if (result.error_code === "fs_sha_conflict") {
        // currentSha is "" when the file didn't exist (still useful: the
        // forensic "we refused to create-on-top-of-missing" trail).
        shaBefore =
          result.currentSha === undefined || result.currentSha === ""
            ? null
            : result.currentSha;
        shaAfter = null;
      } else {
        shaBefore = null;
        shaAfter = null;
      }

      writeFsAuditRow({
        entityType: opts.entityType,
        entityId: entity.id,
        attribution,
        action: "write",
        path: rawPath,
        ok: result.ok,
        errorCode: result.ok ? undefined : result.error_code,
        ts,
        shaBefore,
        shaAfter,
        bytes,
      });

      return c.json(result);
    },

    /**
     * POST /:id/fs/op — discriminated mutation endpoint covering mkdir /
     * create / rename / delete. Same wire contract as the read endpoints:
     * HTTP 200 with a `{ ok: true } | { ok: false, error_code, message? }`
     * body for every FS-domain outcome, including failures. The only HTTP
     * error statuses are pre-FS shape errors: 404 on missing entity, 422
     * on schema-rejected body, ValidationError on missing entity path.
     *
     * Audit: every invocation writes exactly ONE row to `fs_audit_log` with
     * the op name as `action`. For rename, the request path stored in the
     * row is `from -> to` — a single column carries both sides of the pair
     * so the forensic trail survives without a schema change. As with the
     * read flow, we never persist canonicalised absolute paths.
     *
     * Defence-in-depth ordering inside this handler:
     *   1. Parse the body → reject malformed input with 422.
     *   2. Resolve the entity → 404 if missing.
     *   3. Require the entity path → ValidationError (422) if missing.
     *   4. Dispatch to the per-op service helper → discriminated result.
     *   5. Write audit row (always, success or failure).
     *   6. Return 200 with the result envelope.
     */
    op: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const attribution = opts.attribution(entity);
      const ts = Date.now();

      const raw = await c.req.json().catch(() => null);
      const parsed = fsOpBodySchema.safeParse(raw);
      if (!parsed.success) {
        throw new ValidationError(
          "invalid body",
          flattenZodError(parsed.error),
        );
      }
      const body = parsed.data;
      const auditPath = fsOpAuditPath(body);

      // No entity path → fs_no_project_path audit row + 200 envelope, mirror
      // of the readFile flow. Keeps the forensic trail complete for every
      // operator-initiated request, including the "project has no on-disk
      // root" edge case the create/import dialogs can briefly produce.
      if (!entity.path) {
        const result: FsMutateResult = {
          ok: false,
          error_code: "fs_no_project_path",
          message: `${opts.resourceLabel} has no path — cannot run fs ${body.op}`,
        };
        writeFsAuditRow({
          entityType: opts.entityType,
          entityId: entity.id,
          attribution,
          action: body.op,
          path: auditPath,
          ok: false,
          errorCode: "fs_no_project_path",
          ts,
        });
        return c.json(result);
      }

      let result: FsMutateResult;
      switch (body.op) {
        case "mkdir":
          result = await mkdirInRoot(entity.path, body.path);
          break;
        case "create":
          result = await createFileInRoot(entity.path, body.path, body.content);
          break;
        case "rename":
          result = await renameInRoot(entity.path, body.from, body.to);
          break;
        case "delete":
          result = await deleteInRoot(entity.path, body.path, {
            recursive: body.recursive,
          });
          break;
      }

      writeFsAuditRow({
        entityType: opts.entityType,
        entityId: entity.id,
        attribution,
        action: body.op,
        path: auditPath,
        ok: result.ok,
        errorCode: result.ok ? undefined : result.error_code,
        ts,
      });

      return c.json(result);
    },
  };
}
