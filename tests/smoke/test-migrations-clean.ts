/**
 * Confirms the server boots against a fresh FLOCKCTL_HOME (no stale DB),
 * meaning migrations apply cleanly end-to-end.
 */
import { startFlockctl, assert } from "./_harness.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

const srv = await startFlockctl();
try {
  const r = await fetch(`${srv.baseUrl}/health`);
  assert(r.status === 200, `/health should return 200 after fresh migrations`);
  assert(existsSync(join(srv.home, "flockctl.db")), "DB file should be created in fresh FLOCKCTL_HOME");

  // Meta route exercises the DB (selects from ai_provider_keys)
  const meta = await fetch(`${srv.baseUrl}/meta`);
  assert(meta.status === 200, `/meta should work on fresh DB`);
  const body = (await meta.json()) as { keys: unknown[] };
  assert(Array.isArray(body.keys), "keys should be an array on fresh DB (possibly empty)");
} finally {
  await srv.stop();
}
