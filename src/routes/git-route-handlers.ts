import type { Context } from "hono";
import { z } from "zod";
import { ValidationError } from "../lib/errors.js";
import { parseIdParam } from "../lib/route-params.js";
import { flattenZodError } from "../lib/zod-utils.js";
import {
  runGitPull,
  runGitCommit,
  runGitPush,
  runGitStatus,
  runGitLog,
  runGitDiscard,
  runGitFetch,
  runGitDiff,
  runGitBranchList,
  runGitCheckout,
  runGitBranchDelete,
  runGitShow,
  runGitStashPush,
  runGitStashList,
  runGitStashPop,
  runGitStashDrop,
} from "../services/git-operations.js";

/**
 * git-route-handlers — single source of truth for the three project-level
 * git endpoints (`/git-pull`, `/git-commit`, `/git-push`) that the project
 * router exposes today and the workspace router will exposes later.
 *
 * Both surfaces share the exact same response-shape contract:
 *   - HTTP 200 with a discriminated `{ ok, ... }` body. Failures are encoded
 *     in the body, NOT the status code, so `apiFetch` does not strip the
 *     structured `reason` / `stderr` fields when a git operation legitimately
 *     fails (dirty tree, no upstream, auth, non-fast-forward, etc.).
 *   - 4xx is reserved for the project-shape errors that fire BEFORE git is
 *     invoked: missing entity (404 via the caller's `getEntity`), missing
 *     path (422 via the `requirePath` guard below), malformed body (422 via
 *     the zod `safeParse` paths).
 *
 * The factory takes:
 *   - `resourceLabel` — used in the 422 message so an operator sees
 *     "Project has no path" vs "Workspace has no path" without us having to
 *     duplicate the route handler.
 *   - `getEntity` — synchronous lookup that MUST throw `NotFoundError` when
 *     the row is missing. The existing `getProjectOrThrow` /
 *     `getWorkspaceOrThrow` helpers already satisfy this contract.
 *   - `attribution` — maps the entity to the `{ projectId?, workspaceId? }`
 *     pair the audit-row writer expects. Factored out so the same handler
 *     can attribute a project-router invocation to `project_id` and a
 *     workspace-router invocation to `workspace_id` without any runtime
 *     branching inside the handler itself.
 */

export interface GitEntity {
  id: number;
  /** May be NULL on workspaces / projects that haven't picked an on-disk root. */
  path: string | null;
}

export interface GitAttribution {
  projectId?: number | string;
  workspaceId?: number | string;
}

export interface MakeGitRouteHandlersOptions<T extends GitEntity> {
  /** Resource label inserted into the 422 "no path" message. */
  resourceLabel: string;
  /** Look up the entity by id; MUST throw NotFoundError when missing. */
  getEntity: (id: number) => T;
  /** Map the entity to the audit-row attribution scope. */
  attribution: (entity: T) => GitAttribution;
}

// Shared validation schemas. Kept inline (not exported) because the only
// legitimate consumer is this factory — every git route in the daemon flows
// through here. Defensive bounds (counts-only audit payload, message length
// cap, paths cap) match the contracts pinned in the route tests.
const gitCommitBodySchema = z.object({
  message: z.string().min(1).max(4096),
  paths: z.array(z.string().min(1)).max(500).optional(),
});

// `.strict()` on the push schema is the canary: any future refactor that
// added an `all` / `mirror` / raw `force` field would have to also relax this
// guard, which the security tests on `buildPushArgs` would catch immediately.
const gitPushBodySchema = z
  .object({
    remote: z.string().min(1).max(100).optional(),
    setUpstream: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict();

// Query schema for GET /:id/git-log. Strings come off the URL — we coerce
// limit to a number (clamping in the service), and length-cap branch /
// cursor *here* so a 10MB query string can't OOM the validator before
// the service's own format checks run.
const gitLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(64).optional(),
  branch: z.string().min(1).max(255).optional(),
});

// POST /:id/git-discard body schema. Defensive bounds:
//  - paths must be a non-empty array (the service returns `no_paths` for
//    empty lists, but we reject at the validation layer too so a totally-
//    omitted body is a 422 rather than a structured `ok:false`).
//  - 500-path cap mirrors `gitCommitBodySchema` — a single button-press
//    asking us to discard half a million paths is almost certainly a bug.
//  - Per-path length cap (1024 bytes) keeps a malicious 10MB request from
//    OOM-ing the path validator before the service's own checks run.
//  - `.strict()` on the wrapper rejects `{ paths: [...], force: true }` —
//    no future refactor that adds a destructive flag escapes the schema.
const gitDiscardBodySchema = z
  .object({
    paths: z.array(z.string().min(1).max(1024)).min(1).max(500),
  })
  .strict();

// POST /:id/git-fetch body schema. Empty body is allowed — fetch defaults
// to `origin`. `.strict()` keeps the surface narrow: we don't want a
// future caller passing `{ all: true }` and silently inheriting the
// `--all` semantics; remote-name override is the only knob we expose.
const gitFetchBodySchema = z
  .object({
    remote: z.string().min(1).max(100).optional(),
  })
  .strict();

// Query schema for GET /:id/git-diff. `path` is required; `staged` is a
// string-coerced boolean (so the URL `?staged=true` round-trips); `base` /
// `head` are optional refs validated by the service against a conservative
// grammar. Length caps mirror `gitLogQuerySchema` so a 10MB query string
// can't OOM the validator before the service's own format checks run.
// ─── Branch operations: validation schemas ────────────────────────────────
//
// `BRANCH_NAME` is the public input regex pinned in the slice spec. It admits
// the four character classes a sane branch name needs: word chars, hyphen,
// dot, slash, plus the Cyrillic block so non-ASCII repos can still rename a
// branch. Everything else — quotes, semicolons, backticks, NUL, whitespace,
// shell metacharacters — is rejected at the wire boundary, before the value
// reaches simple-git. simple-git already invokes via execFile (no shell), so
// this regex is a defence-in-depth — a future refactor that introduces a
// `system(3)`-style call still cannot smuggle metacharacters through the API.
const BRANCH_NAME = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\w\-./а-яА-ЯёЁ]+$/u);

// POST /:id/git-checkout body. `.strict()` is the canary on "no future
// refactor accidentally re-enables `--all`-style sweep flags": every knob
// the route surfaces must be enumerated here, and an unknown field
// (including misspelled `forceCreate` etc.) is a 422.
const gitCheckoutBodySchema = z
  .object({
    branch: BRANCH_NAME,
    create: z.boolean().optional(),
    startPoint: BRANCH_NAME.optional(),
  })
  .strict();

// DELETE /:id/git-branches/:name body. Empty body is valid — `force`
// defaults to false in the service. `.strict()` rejects junk fields the
// same way `gitCheckoutBodySchema` does.
const gitBranchDeleteBodySchema = z
  .object({
    force: z.boolean().optional(),
  })
  .strict();

// Query schema for GET /:id/git-show. `sha` is the only knob; same hex
// grammar as `runGitLog`'s cursor (7..64 chars). Length-cap defends the
// validator from a 10MB query string before the service's own format
// check runs.
const gitShowQuerySchema = z.object({
  sha: z.string().min(7).max(64),
});

// ─── Stash operations: validation schemas ─────────────────────────────────
//
// Four endpoints, three schemas (list takes no body):
//   - POST   /:id/git-stash-push   body { message?, includeUntracked? }
//   - GET    /:id/git-stash-list   no body
//   - POST   /:id/git-stash-pop    body { ref:'stash@{N}' }
//   - DELETE /:id/git-stash/:ref   no body
//
// `STASH_REF` is the route-level mirror of the service's `STASH_REF_RE`
// (`/^stash@\{\d+\}$/`). Pinning the regex at the wire boundary means a
// future refactor that skips the service guard still cannot smuggle a
// non-canonical ref past the route — same defence-in-depth pattern as
// `BRANCH_NAME` above.
const STASH_REF = z
  .string()
  .min(1)
  .max(64)
  .regex(/^stash@\{\d+\}$/);

// POST /:id/git-stash-push body. `.strict()` rejects unknown fields the
// same way `gitDiscardBodySchema` / `gitFetchBodySchema` do — a future
// refactor that adds a `--keep-index` knob must update the schema
// deliberately. Message length cap mirrors `gitCommitBodySchema` (4096
// bytes); audit payload records `{ has_message }` only, so the cap here
// is purely a defence against an OOM-the-validator attack.
const gitStashPushBodySchema = z
  .object({
    message: z.string().min(1).max(4096).optional(),
    includeUntracked: z.boolean().optional(),
  })
  .strict();

// POST /:id/git-stash-pop body. `ref` is required and validated against
// the canonical `stash@{N}` form. `.strict()` rejects unknown fields.
const gitStashPopBodySchema = z
  .object({
    ref: STASH_REF,
  })
  .strict();

const gitDiffQuerySchema = z.object({
  path: z.string().min(1).max(4096),
  // We accept the raw string then coerce to bool below — zod's `boolean`
  // doesn't read URL strings, and `coerce.boolean` is too eager (it treats
  // `"false"` as truthy). The pattern matches `true` / `false` / `1` / `0`.
  staged: z
    .string()
    .min(1)
    .max(8)
    .regex(/^(?:true|false|1|0)$/i)
    .optional(),
  base: z.string().min(1).max(255).optional(),
  head: z.string().min(1).max(255).optional(),
  // `contents=true` opts the response into the dual-buffer shape Monaco's
  // DiffEditor needs (`originalContent` + `modifiedContent`). Off by default
  // so the existing commit-detail flow (which only needs the unified patch)
  // skips the extra git-show round-trip per call.
  contents: z
    .string()
    .min(1)
    .max(8)
    .regex(/^(?:true|false|1|0)$/i)
    .optional(),
});

export function makeGitRouteHandlers<T extends GitEntity>(
  opts: MakeGitRouteHandlersOptions<T>,
) {
  const requirePath = (
    entity: T,
    action:
      | "pull"
      | "commit"
      | "push"
      | "status"
      | "log"
      | "discard"
      | "fetch"
      | "diff"
      | "branch-list"
      | "checkout"
      | "branch-delete"
      | "show"
      | "stash-push"
      | "stash-list"
      | "stash-pop"
      | "stash-drop",
  ): string => {
    if (!entity.path) {
      throw new ValidationError(
        `${opts.resourceLabel} has no path — cannot run git ${action}`,
      );
    }
    return entity.path;
  };

  return {
    /**
     * GET /:id/git-status — read-only porcelain peek backing the Commit
     * dialog's stage-selection checklist.
     *
     * Skips the audit-row envelope because the operation is non-mutating
     * and gets called every time the dialog opens — putting it through
     * the audit log would drown the forensic signal in read traffic.
     * Response shape mirrors the mutating routes: HTTP 200 with a
     * discriminated `{ ok, ... }` body.
     */
    status: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "status");
      const result = await runGitStatus(cwd);
      return c.json(result);
    },

    /**
     * GET /:id/git-log — paginated commit-history walk for the entity's
     * working tree.
     *
     * Read-only by design: the underlying `runGitLog` runs `git log` only
     * (no checkout, no mutation) and writes a single audit row scoped to
     * the entity. Query parameters: `limit` (1..100, default 30), `cursor`
     * (hex SHA from a previous response's `nextCursor`), `branch`
     * (optional ref to walk from). When `cursor` is set, `branch` is
     * ignored — the cursor is a fully-qualified starting point and
     * layering a branch on top would silently change which side of the
     * DAG we walk.
     */
    log: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "log");

      // `c.req.query()` returns Record<string,string>; zod's `coerce.number`
      // takes care of the int conversion + range check. A malformed `limit`
      // (e.g. `?limit=abc`) is a 422 — same shape as the POST routes.
      const parsed = gitLogQuerySchema.safeParse(c.req.query());
      if (!parsed.success) {
        throw new ValidationError("invalid query", flattenZodError(parsed.error));
      }

      const attribution = opts.attribution(entity);
      const result = await runGitLog(cwd, {
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
        branch: parsed.data.branch,
        projectId: attribution.projectId,
        workspaceId: attribution.workspaceId,
      });
      return c.json(result);
    },

    /**
     * POST /:id/git-pull — fast-forward pull from origin.
     *
     * Wraps `git pull --ff-only` with pre-flight guardrails (clean working
     * tree, branch must have an upstream, must be a git repo) and structured
     * error reporting. See `src/services/git-operations.ts` for the full
     * contract — including why we deliberately refuse to merge or rebase
     * from this surface (terminal-grade decisions, not button-grade).
     */
    pull: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "pull");
      const attribution = opts.attribution(entity);
      // `runGitPull` writes a single audit row keyed on whichever attribution
      // scope this route surface owns: project routes pass `projectId` (and
      // `workspaceId` falls through), workspace routes pass `workspaceId`
      // (and `projectId` falls through). The CHECK constraint on
      // `git_audit_log` requires at least one of the two to be NOT NULL —
      // the factory's job is to make sure the right one is set.
      const result = await runGitPull(
        cwd,
        attribution.projectId,
        attribution.workspaceId,
      );
      return c.json(result);
    },

    /**
     * POST /:id/git-commit — stage and commit on the entity's branch.
     *
     * `paths` is optional — omitted means `git add -A` (the implicit "commit
     * everything that's changed" UX of the Commit button). When supplied,
     * the service validates each entry against `git status` and rejects
     * unknown paths with `reason: "unknown_path"`. Validation caps:
     * message ≤ 4096 bytes, up to 500 paths per call (defensive bounds —
     * the audit log payload is counts-only, never raw paths or message body).
     */
    commit: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "commit");

      const body = await c.req.json().catch(() => null);
      const parsed = gitCommitBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError("invalid body", flattenZodError(parsed.error));
      }

      const attribution = opts.attribution(entity);
      const result = await runGitCommit({
        cwd,
        message: parsed.data.message,
        paths: parsed.data.paths,
        projectId: attribution.projectId,
        workspaceId: attribution.workspaceId,
      });
      return c.json(result);
    },

    /**
     * POST /:id/git-push — push the current branch to a single remote.
     *
     * Body validation uses `.strict()` so unknown / dangerous fields
     * (`{ all: true, mirror: true, force: true }`) are rejected with 422
     * BEFORE they could ever reach the service. The service has its own
     * defence-in-depth invariants (`buildPushArgs` never emits `--all` /
     * `--mirror` / raw `--force`), but we don't want a future refactor that
     * loosens the schema to silently surface those flags — strict parsing
     * is the canary on that promise.
     */
    push: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "push");

      // Empty body is allowed — the service defaults to `{ remote: 'origin',
      // setUpstream: false, force: false }`. JSON-parse failures collapse
      // to `{}` for the same reason: an empty POST is a valid "push current
      // branch with defaults" call, and a malformed body should fail
      // validation downstream rather than 500-ing on the JSON parse.
      const body = await c.req.json().catch(() => ({}));
      const parsed = gitPushBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError("invalid body", flattenZodError(parsed.error));
      }

      const attribution = opts.attribution(entity);
      const result = await runGitPush({
        cwd,
        remote: parsed.data.remote,
        setUpstream: parsed.data.setUpstream,
        force: parsed.data.force,
        projectId: attribution.projectId,
        workspaceId: attribution.workspaceId,
      });
      return c.json(result);
    },

    /**
     * POST /:id/git-discard — revert uncommitted changes for a list of
     * tracked paths via `git checkout -- <paths…>`.
     *
     * Path validation happens in the service (per-entry: relative,
     * non-empty, no NUL byte, jailed to repo root), but we still pin a
     * defensive `min(1)/max(500)/.strict()` schema here so the wire
     * contract for "bad body" is a 422 consistent with `git-commit` and
     * `git-push`. Untracked paths surface as `reason: "unknown_path"` from
     * the service. The audit row records `{ paths_count }` only — never
     * the raw paths.
     */
    discard: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "discard");

      const body = await c.req.json().catch(() => null);
      const parsed = gitDiscardBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError("invalid body", flattenZodError(parsed.error));
      }

      const attribution = opts.attribution(entity);
      const result = await runGitDiscard(cwd, parsed.data.paths, {
        projectId: attribution.projectId,
        workspaceId: attribution.workspaceId,
      });
      return c.json(result);
    },

    /**
     * POST /:id/git-fetch — refresh remote-tracking refs without merging.
     *
     * Body is `{ remote?: string }`; defaults to `origin`. `.strict()`
     * schema keeps the surface narrow (no `all` / `prune` / `tags` knobs
     * yet — add them deliberately when needed). Network errors classify as
     * `network_error` via the same stderr-pattern set `runGitPull` uses, so
     * UI vocabulary stays consistent across the two surfaces.
     */
    fetch: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "fetch");

      // Empty body is allowed — service defaults to `origin`. JSON-parse
      // failures collapse to `{}` for the same reason `git-push` does:
      // an empty POST is a valid "fetch origin with defaults" call.
      const body = await c.req.json().catch(() => ({}));
      const parsed = gitFetchBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError("invalid body", flattenZodError(parsed.error));
      }

      const attribution = opts.attribution(entity);
      const result = await runGitFetch(cwd, parsed.data.remote, {
        projectId: attribution.projectId,
        workspaceId: attribution.workspaceId,
      });
      return c.json(result);
    },

    /**
     * GET /:id/git-diff?path=<rel>&staged=<bool>&base=<ref>&head=<ref>
     *
     * Read-only single-file diff backing the source-control rail's diff
     * viewer. Three modes picked by the query string (mutually-exclusive
     * combinations rejected upfront in the service):
     *   - `?staged=true`                 → index vs HEAD (`--cached`)
     *   - `?base=<ref>&head=<ref>`       → committed history between two refs
     *   - (default)                      → working tree vs index
     *
     * Always emits HTTP 200; failures (including `git_patch_too_large`)
     * are encoded in the discriminated body so `apiFetch` does not strip
     * the structured `reason` / `size` / `hint` fields. Missing entity is
     * the one 404; missing entity path / malformed query are 422.
     *
     * The audit row records the request-supplied relative path verbatim
     * (same precedent as `fs_audit_log.path`), but reduces ref values to
     * `has_base` / `has_head` flags so an in-flight feature branch name
     * doesn't leak into the audit table even with read access.
     */
    diff: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "diff");

      const parsed = gitDiffQuerySchema.safeParse(c.req.query());
      if (!parsed.success) {
        throw new ValidationError("invalid query", flattenZodError(parsed.error));
      }

      // Coerce the staged string to a real boolean. We've already validated
      // the regex, so `true` / `1` collapse to true and everything else
      // (`false` / `0`) to false. `undefined` stays undefined so the service
      // sees the absence-of-value rather than `false`.
      const stagedRaw = parsed.data.staged;
      const staged =
        stagedRaw === undefined
          ? undefined
          : /^(?:true|1)$/i.test(stagedRaw);
      const contentsRaw = parsed.data.contents;
      const includeContents =
        contentsRaw === undefined
          ? undefined
          : /^(?:true|1)$/i.test(contentsRaw);

      const attribution = opts.attribution(entity);
      const result = await runGitDiff(cwd, {
        path: parsed.data.path,
        staged,
        base: parsed.data.base,
        head: parsed.data.head,
        includeContents,
        projectId: attribution.projectId,
        workspaceId: attribution.workspaceId,
      });
      return c.json(result);
    },

    /**
     * GET /:id/git-branches — enumerate local + remote refs.
     *
     * Read-only walk over `git for-each-ref refs/heads refs/remotes` with
     * a pinned format string. Returns `{ ok, branches:[{name, current,
     * upstream, ahead, behind, isRemote}], detached:boolean }` — see
     * `runGitBranchList` for the parser. Audit row written under
     * action='branch_list'.
     */
    branchList: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "branch-list");
      const attribution = opts.attribution(entity);
      const result = await runGitBranchList(cwd, {
        projectId: attribution.projectId,
        workspaceId: attribution.workspaceId,
      });
      return c.json(result);
    },

    /**
     * POST /:id/git-checkout — switch to (or create) a branch.
     *
     * Body: `{ branch:string, create?:boolean, startPoint?:string }`.
     * Branch name + optional `startPoint` ref both validated via the
     * `BRANCH_NAME` regex (word chars, `-`, `.`, `/`, Cyrillic). `.strict()`
     * rejects unknown body fields. Pre-flight in the service refuses on a
     * dirty working tree (same guardrail as `git-pull`); response shape is
     * always HTTP 200 with a discriminated `{ ok, ... }` body.
     */
    checkout: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "checkout");

      const body = await c.req.json().catch(() => null);
      const parsed = gitCheckoutBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError("invalid body", flattenZodError(parsed.error));
      }

      const attribution = opts.attribution(entity);
      const result = await runGitCheckout({
        cwd,
        branch: parsed.data.branch,
        create: parsed.data.create,
        startPoint: parsed.data.startPoint,
        projectId: attribution.projectId,
        workspaceId: attribution.workspaceId,
      });
      return c.json(result);
    },

    /**
     * DELETE /:id/git-branches/:name — delete a local branch.
     *
     * Body: `{ force?:boolean }` (empty body OK; force defaults false).
     * Branch name re-validated against `BRANCH_NAME` here even though
     * route params bypass the body schema — Hono's `:name{.+}` wildcard
     * lets `feature/foo` through, but a path like `..%2F..` could try to
     * sneak through; the regex is the bright line.
     *
     * Protected-branch refusal (`main` / `master` without force) happens
     * inside the service BEFORE any git invocation, so the 200/`ok:false`
     * returns without writing an audit row in that branch.
     */
    branchDelete: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "branch-delete");

      // The route param is path-segment-decoded by Hono, so a wire
      // request like `…/git-branches/feature%2Ffoo` arrives here as
      // `feature/foo`. Validate against the same public regex used in
      // the body so URL-encoded shenanigans cannot escape the grammar.
      const rawName = c.req.param("name");
      const nameParsed = BRANCH_NAME.safeParse(rawName);
      if (!nameParsed.success) {
        throw new ValidationError(
          "invalid :name — branch names must match [A-Za-z0-9_./-] (Cyrillic also allowed)",
          flattenZodError(nameParsed.error),
        );
      }

      const body = await c.req.json().catch(() => ({}));
      const parsed = gitBranchDeleteBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError("invalid body", flattenZodError(parsed.error));
      }

      const attribution = opts.attribution(entity);
      const result = await runGitBranchDelete({
        cwd,
        branch: nameParsed.data,
        force: parsed.data.force,
        projectId: attribution.projectId,
        workspaceId: attribution.workspaceId,
      });
      return c.json(result);
    },

    /**
     * GET /:id/git-show?sha=<sha> — single-commit detail walk backing
     * the commit-detail tab.
     *
     * Read-only by design: the underlying `runGitShow` runs three
     * `git show` invocations (metadata + name-status + numstat) and
     * writes a single audit row scoped to the entity. The expensive
     * patch body is NEVER fetched here — per-file diffs are fetched
     * lazily by `/git-diff?base=<sha>~1&head=<sha>&path=<p>` as the
     * user clicks files in the UI.
     *
     * Query: `sha` (required, hex 7..64). Audit payload records only the
     * 12-char prefix — SHAs aren't leakable in-flight names (unlike
     * branch names) but a prefix keeps the table cheap on long-running
     * daemons.
     *
     * Always emits HTTP 200; failures (`bad_revision` for unknown SHAs,
     * `not_a_repo` for non-git paths) are encoded in the discriminated
     * body so `apiFetch` does not strip `reason` / `stderr` fields.
     */
    show: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "show");

      const parsed = gitShowQuerySchema.safeParse(c.req.query());
      if (!parsed.success) {
        throw new ValidationError("invalid query", flattenZodError(parsed.error));
      }

      const attribution = opts.attribution(entity);
      const result = await runGitShow(cwd, {
        sha: parsed.data.sha,
        projectId: attribution.projectId,
        workspaceId: attribution.workspaceId,
      });
      return c.json(result);
    },

    /**
     * POST /:id/git-stash-push — snapshot the working tree onto the stash
     * stack. Body: `{ message?: string, includeUntracked?: boolean }`.
     * `.strict()` rejects unknown fields (canary against future
     * `--keep-index` / `--patch` knobs slipping in unreviewed). Audit
     * payload records `{ has_message, include_untracked }` — never the
     * raw message body. The "no local changes to save" no-op surfaces as
     * `reason: "nothing_to_stash"` with `ok: true` so the UI can render
     * an "already clean" hint without us mis-classifying it as a failure.
     */
    stashPush: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "stash-push");

      // Empty body is allowed — service defaults to no message + no -u.
      // JSON-parse failures collapse to `{}` for the same reason
      // `git-push` / `git-fetch` do.
      const body = await c.req.json().catch(() => ({}));
      const parsed = gitStashPushBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError("invalid body", flattenZodError(parsed.error));
      }

      const attribution = opts.attribution(entity);
      const result = await runGitStashPush(cwd, {
        message: parsed.data.message,
        includeUntracked: parsed.data.includeUntracked,
        projectId: attribution.projectId,
        workspaceId: attribution.workspaceId,
      });
      return c.json(result);
    },

    /**
     * GET /:id/git-stash-list — read-only enumeration of stash entries.
     *
     * Returns `{ ok, stashes: [{ ref, hash, date, message }, …] }`. Empty
     * stack is `{ ok: true, stashes: [] }` — NOT an error. The audit row
     * is written under action='stash_list' to keep the forensic surface
     * symmetric with `branch_list` / `log` (operator can reconstruct
     * "operator opened the stash dropdown at time T" from the audit log).
     */
    stashList: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "stash-list");
      const attribution = opts.attribution(entity);
      const result = await runGitStashList(cwd, {
        projectId: attribution.projectId,
        workspaceId: attribution.workspaceId,
      });
      return c.json(result);
    },

    /**
     * POST /:id/git-stash-pop — apply + drop the named stash entry.
     *
     * Body: `{ ref: 'stash@{N}' }` where N is a non-negative integer. The
     * ref is validated against the canonical reflog-selector grammar at
     * the route layer AND re-validated by the service — defence in depth.
     * Conflicts surface as `ok: false, reason: 'git_stash_pop_conflict'`
     * (HTTP 200, body discriminator); the stash is left on the stack so
     * the operator can resolve and `git stash drop` deliberately. Empty
     * stash / out-of-range index surfaces as `not_found` instead of
     * conflict (more actionable for the operator).
     */
    stashPop: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "stash-pop");

      const body = await c.req.json().catch(() => null);
      const parsed = gitStashPopBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError("invalid body", flattenZodError(parsed.error));
      }

      const attribution = opts.attribution(entity);
      const result = await runGitStashPop({
        cwd,
        ref: parsed.data.ref,
        projectId: attribution.projectId,
        workspaceId: attribution.workspaceId,
      });
      return c.json(result);
    },

    /**
     * DELETE /:id/git-stash/:ref — forget a single stash entry.
     *
     * The route param is path-segment-decoded by Hono, so a wire request
     * like `…/git-stash/stash%40%7B0%7D` arrives here as `stash@{0}`.
     * Re-validate against the same `STASH_REF` regex used in the body
     * schemas so URL-encoded shenanigans cannot escape the canonical
     * `stash@{N}` grammar. There is no body — drop is metadata-only and
     * has no knobs to expose.
     */
    stashDrop: async (c: Context): Promise<Response> => {
      const id = parseIdParam(c);
      const entity = opts.getEntity(id);
      const cwd = requirePath(entity, "stash-drop");

      const rawRef = c.req.param("ref");
      const refParsed = STASH_REF.safeParse(rawRef);
      if (!refParsed.success) {
        throw new ValidationError(
          "invalid :ref — must match canonical 'stash@{N}' form",
          flattenZodError(refParsed.error),
        );
      }

      const attribution = opts.attribution(entity);
      const result = await runGitStashDrop({
        cwd,
        ref: refParsed.data,
        projectId: attribution.projectId,
        workspaceId: attribution.workspaceId,
      });
      return c.json(result);
    },
  };
}
