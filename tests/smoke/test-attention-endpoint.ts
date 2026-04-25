import { startFlockctl, assert } from "./_harness.js";

const srv = await startFlockctl();
try {
  const r = await fetch(`${srv.baseUrl}/attention`);
  assert(r.status === 200, `/attention should return 200, got ${r.status}`);
  const body = (await r.json()) as { items: unknown; total: number };
  assert(Array.isArray(body.items), "items should be an array");
  assert(body.total === 0, `total should be 0 on a clean home, got ${body.total}`);
  assert(
    (body.items as unknown[]).length === 0,
    `items should be empty on a clean home, got ${(body.items as unknown[]).length}`,
  );
} finally {
  await srv.stop();
}
