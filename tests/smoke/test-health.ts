import { startFlockctl, assert } from "./_harness.js";

const srv = await startFlockctl();
try {
  const r = await fetch(`${srv.baseUrl}/health`);
  assert(r.status === 200, `/health should return 200, got ${r.status}`);
  const body = (await r.json()) as { status: string; version: string; hostname: string };
  assert(body.status === "ok", `status should be 'ok', got ${body.status}`);
  assert(typeof body.hostname === "string", "hostname should be a string");
} finally {
  await srv.stop();
}
