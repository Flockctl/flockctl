import { startFlockctl, assert } from "./_harness.js";

const srv = await startFlockctl();
try {
  const res = await fetch(`${srv.baseUrl}/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
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
    nextFireTime: string | null;
  };
  assert(schedule.scheduleType === "cron", "type should be cron");
  assert(schedule.cronExpression === "*/5 * * * *", "cron should roundtrip");
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
