// Mission approval-flow smoke spec.
//
// End-to-end exercise of the parent slice §04 contract:
//   create mission → seed a remediation proposal → POST approve →
//   verify the milestone / slice YAML lands on disk under the project.
//
// The supervisor LLM loop is NOT wired into `server-entry.ts` yet, so a
// real "fail a task → wait for proposal" cycle isn't reachable from a
// smoke test today. We bridge that gap by writing the
// `remediation_proposed` event directly into the daemon's SQLite file —
// this is exactly what `guardedEvaluate` would have written if a
// supervisor had run, so the approve handler sees an indistinguishable
// row and exercises the same code path. When the supervisor wiring slice
// lands, swap the direct-insert for a real LLM round-trip; the assertions
// past that point (HTTP approve + on-disk YAML) remain unchanged.
//
// Naming: this file is `*.spec.ts`, not `test-*.ts`, because the brief
// asked for the former. To slot it into the existing `npm run test:smoke`
// loop without a runner change, run it directly:
//
//   npx tsx tests/smoke/mission-approval-flow.spec.ts
//
// (The `tests/smoke/run.ts` entrypoint globs `test-*.ts` only — symlink
// or rename if you want it to ride the same `npm run test:smoke` pass.)

import { startFlockctl, assert, seedActiveKey } from "./_harness.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const srv = await startFlockctl();
try {
  // ─── 1. Create a project on disk ───────────────────────────
  // The `_allowed-keys.ts` middleware mandates at least one active key
  // even though this flow never actually calls the provider — the
  // supervisor stub lives in our hand-injected mission_events row, and
  // approve only reads from disk + DB. Seed a placeholder key to clear
  // the gate.
  const keyId = await seedActiveKey(srv);
  const projectPath = join(srv.home, "mission-flow-proj");
  const projRes = await fetch(`${srv.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Mission Flow Project",
      path: projectPath,
      allowedKeyIds: [keyId],
    }),
  });
  if (projRes.status !== 201) {
    throw new Error(`create project failed (${projRes.status}): ${await projRes.text()}`);
  }
  const project = (await projRes.json()) as { id: number };

  // ─── 2. Create a mission via HTTP (route-validated path) ───
  const missionRes = await fetch(`${srv.baseUrl}/missions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      objective: "Smoke: ship the launcher",
      budgetTokens: 10_000,
      budgetUsdCents: 1_000,
    }),
  });
  if (missionRes.status !== 201) {
    throw new Error(`create mission failed (${missionRes.status}): ${await missionRes.text()}`);
  }
  const mission = (await missionRes.json()) as { id: string };

  // ─── 3. Inject a remediation proposal directly into the DB ─
  // This is the "fail a task → supervisor proposes" stand-in. We open a
  // second connection to the same DB file (WAL mode lets the daemon and
  // the test share writers without DB-level locking issues for a single
  // INSERT) and write the row.
  const dbPath = join(srv.home, "flockctl.db");
  const sideDb = new Database(dbPath);
  const proposalEventId = `e-${randomUUID().slice(0, 8)}`;
  const proposalPayload = {
    rationale:
      "Observed the launcher tests failing — propose a billing milestone to cover the missing path",
    proposal: {
      target_type: "slice",
      candidate: {
        action: "Add a billing milestone with the gateway slice",
        // We need a parent milestone slug for slice creation; create the
        // milestone first via the planning route so the slug exists.
        target_id: "PLACEHOLDER_MILESTONE",
        summary: "Wire the credit-card gateway end-to-end so launches don't stall on payments",
      },
    },
  };
  // First create the parent milestone via the planning route — so we can
  // reference its slug as the slice's parent.
  const milestoneRes = await fetch(
    `${srv.baseUrl}/projects/${project.id}/milestones`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Billing",
        description: "Parent milestone for the proposed slice",
      }),
    },
  );
  if (milestoneRes.status !== 201) {
    throw new Error(`create milestone failed (${milestoneRes.status}): ${await milestoneRes.text()}`);
  }
  const milestone = (await milestoneRes.json()) as { slug: string };
  proposalPayload.proposal.candidate.target_id = milestone.slug;

  sideDb
    .prepare(
      `INSERT INTO mission_events (id, mission_id, kind, payload)
       VALUES (?, ?, 'remediation_proposed', ?)`,
    )
    .run(proposalEventId, mission.id, JSON.stringify(proposalPayload));
  sideDb.close();

  // ─── 4. Confirm the proposal surfaces in the pending queue ─
  const proposalsRes = await fetch(
    `${srv.baseUrl}/missions/${mission.id}/proposals`,
  );
  assert(
    proposalsRes.status === 200,
    `GET proposals failed (${proposalsRes.status})`,
  );
  const proposalsBody = (await proposalsRes.json()) as {
    items: Array<{ id: string }>;
    total: number;
    status: string;
  };
  assert(proposalsBody.status === "pending", "default status filter");
  assert(
    proposalsBody.items.some((p) => p.id === proposalEventId),
    "injected proposal must appear in pending list",
  );

  // ─── 5. Approve via the public HTTP surface ────────────────
  const approveRes = await fetch(
    `${srv.baseUrl}/missions/${mission.id}/proposals/${proposalEventId}/approve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  if (approveRes.status !== 200) {
    throw new Error(`approve failed (${approveRes.status}): ${await approveRes.text()}`);
  }
  const approveBody = (await approveRes.json()) as {
    decision_id: string;
    proposal_event_id: string;
    target_type: string;
    entity_kind: string;
    target_id: string;
  };
  assert(approveBody.proposal_event_id === proposalEventId, "decision references proposal");
  assert(approveBody.entity_kind === "slice", "approval materialised a slice");
  assert(typeof approveBody.target_id === "string" && approveBody.target_id.length > 0, "target_id");
  assert(typeof approveBody.decision_id === "string", "decision_id");

  // ─── 6. Verify the slice YAML lands on disk ────────────────
  const slicePath = join(
    projectPath,
    ".flockctl",
    "plan",
    milestone.slug,
    approveBody.target_id,
    "slice.md",
  );
  assert(
    existsSync(slicePath),
    `slice file not created on disk at ${slicePath}`,
  );
  const sliceContent = readFileSync(slicePath, "utf8");
  assert(
    sliceContent.includes("title:"),
    `slice file should contain YAML frontmatter with a title field; got:\n${sliceContent}`,
  );
  assert(
    sliceContent.includes("Add a billing milestone with the gateway slice"),
    `slice file should carry the proposal's action as the title; got:\n${sliceContent}`,
  );

  // ─── 7. Idempotency on the public surface ──────────────────
  const reApprove = await fetch(
    `${srv.baseUrl}/missions/${mission.id}/proposals/${proposalEventId}/approve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  assert(
    reApprove.status === 200,
    `re-approve should be idempotent 200, got ${reApprove.status}`,
  );
  const reBody = (await reApprove.json()) as {
    decision_id: string;
    idempotent?: boolean;
  };
  assert(
    reBody.decision_id === approveBody.decision_id,
    "second approve must echo the original decision_id",
  );
  assert(reBody.idempotent === true, "second approve must flag idempotent");

  // ─── 8. Pending queue should now be empty ──────────────────
  const afterRes = await fetch(
    `${srv.baseUrl}/missions/${mission.id}/proposals`,
  );
  const afterBody = (await afterRes.json()) as { items: Array<{ id: string }> };
  assert(
    !afterBody.items.some((p) => p.id === proposalEventId),
    "approved proposal should drop out of the pending queue",
  );

  console.log("mission-approval-flow: ok");
} finally {
  await srv.stop();
}
