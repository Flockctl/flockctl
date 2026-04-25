import { startFlockctl, assert } from "./_harness.js";

const srv = await startFlockctl();
try {
  // Schedules now reference templates by (scope, name) and require the file
  // to exist on disk — the route validates this with `getTemplate()` before
  // inserting, to fail fast rather than skip silently at the next cron fire.
  const tmplRes = await fetch(`${srv.baseUrl}/templates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "smoke-tmpl",
      scope: "global",
      prompt: "smoke-test: no-op",
      agent: "claude-code",
    }),
  });
  assert(tmplRes.status === 201, `POST /templates should return 201, got ${tmplRes.status}`);

  const res = await fetch(`${srv.baseUrl}/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      templateScope: "global",
      templateName: "smoke-tmpl",
      scheduleType: "cron",
      cronExpression: "*/5 * * * *",
      timezone: "UTC",
    }),
  });
  assert(res.status === 201, `POST /schedules should return 201, got ${res.status}`);
  const schedule = (await res.json()) as {
    id: number;
    scheduleType: string;
    cronExpression: string;
    templateScope: string;
    templateName: string;
    nextFireTime: string | null;
  };
  assert(schedule.scheduleType === "cron", "type should be cron");
  assert(schedule.cronExpression === "*/5 * * * *", "cron should roundtrip");
  assert(schedule.templateScope === "global", "templateScope should roundtrip");
  assert(schedule.templateName === "smoke-tmpl", "templateName should roundtrip");
  assert(
    typeof schedule.nextFireTime === "string" && schedule.nextFireTime.length > 0,
    "nextFireTime should be computed",
  );

  const list = await fetch(`${srv.baseUrl}/schedules`);
  assert(list.status === 200, "GET /schedules should return 200");
  const { items } = (await list.json()) as { items: Array<{ id: number }> };
  assert(items.some((s) => s.id === schedule.id), "created schedule should be in list");
} finally {
  await srv.stop();
}
