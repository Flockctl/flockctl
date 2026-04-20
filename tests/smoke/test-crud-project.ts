import { startFlockctl, assert } from "./_harness.js";
import { join } from "node:path";

const srv = await startFlockctl();
try {
  // Create project with explicit path inside FLOCKCTL_HOME (isolated tmpdir)
  const projectPath = join(srv.home, "demo-proj");
  const create = await fetch(`${srv.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Demo Project", path: projectPath }),
  });
  assert(create.status === 201, `POST /projects should return 201, got ${create.status}`);
  const project = (await create.json()) as { id: number; name: string; path: string };
  assert(project.id > 0, "project should have id");
  assert(project.name === "Demo Project", "name should roundtrip");

  // Read back
  const get = await fetch(`${srv.baseUrl}/projects/${project.id}`);
  assert(get.status === 200, `GET /projects/:id should return 200, got ${get.status}`);
  const fetched = (await get.json()) as { id: number; path: string };
  assert(fetched.id === project.id, "id should match");

  // List
  const list = await fetch(`${srv.baseUrl}/projects`);
  assert(list.status === 200, `GET /projects should return 200`);
  const { items, total } = (await list.json()) as { items: Array<{ id: number }>; total: number };
  assert(total >= 1, "list total should be >= 1");
  assert(items.some((p) => p.id === project.id), "created project should be in list");

  // Delete
  const del = await fetch(`${srv.baseUrl}/projects/${project.id}`, { method: "DELETE" });
  assert(del.status === 200 || del.status === 204, `DELETE /projects/:id ok, got ${del.status}`);
} finally {
  await srv.stop();
}
