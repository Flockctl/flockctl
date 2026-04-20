import { startFlockctl, assert } from "./_harness.js";

const srv = await startFlockctl();
try {
  const r = await fetch(`${srv.baseUrl}/meta`);
  assert(r.status === 200, `/meta should return 200, got ${r.status}`);
  const body = (await r.json()) as {
    agents: Array<{ id: string; name: string; available: boolean }>;
    models: Array<{ id: string; name: string; agent: string }>;
    defaults: { model: string; agent: string };
  };
  assert(Array.isArray(body.agents), "agents must be an array");
  assert(Array.isArray(body.models), "models must be an array");
  assert(typeof body.defaults?.agent === "string", "defaults.agent must be a string");
  assert(body.agents.length > 0, "at least one agent should be registered");
} finally {
  await srv.stop();
}
