import { startFlockctl, assert } from "./_harness.js";
import { join } from "node:path";

const srv = await startFlockctl();
try {
  const projectPath = join(srv.home, "task-proj");
  const projRes = await fetch(`${srv.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Task Project", path: projectPath }),
  });
  assert(projRes.status === 201, `create project failed (${projRes.status})`);
  const project = (await projRes.json()) as { id: number };

  // Cancel immediately so the executor doesn't keep the process alive
  const taskRes = await fetch(`${srv.baseUrl}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      prompt: "smoke-test: no-op",
      agent: "claude-code",
      workingDir: projectPath,
    }),
  });
  assert(taskRes.status === 201, `POST /tasks should return 201, got ${taskRes.status}`);
  const task = (await taskRes.json()) as { id: number; status: string; projectId: number };
  assert(task.id > 0, "task should have id");
  assert(task.projectId === project.id, "task.projectId should match");
  assert(
    ["queued", "running", "assigned"].includes(task.status),
    `expected queued/running/assigned, got ${task.status}`,
  );

  // Cancel so the background executor stops
  await fetch(`${srv.baseUrl}/tasks/${task.id}/cancel`, { method: "POST" });

  const stats = await fetch(`${srv.baseUrl}/tasks/stats`);
  assert(stats.status === 200, `GET /tasks/stats should return 200`);
  const body = (await stats.json()) as { total: number };
  assert(body.total >= 1, "stats total should include the created task");
} finally {
  await srv.stop();
}
