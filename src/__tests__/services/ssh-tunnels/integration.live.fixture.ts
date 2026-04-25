/**
 * Subprocess fixture for `sigterm_parent_cleans_children`.
 *
 * NOT a test file (does not match `*.test.ts`). Spawned by
 * {@link ./integration.live.test.ts} via `npx tsx` when the live-test
 * gate is open.
 *
 * Protocol with the parent test process:
 *   1. Start a tunnel against 127.0.0.1 using the SshTunnelManager.
 *   2. On `status === 'ready'`, print a single JSON line to stdout
 *      with `{ ready: true, parentPid, sshPid }` and flush.
 *   3. Sit idle on a 60 s timer, waiting to be killed.
 *   4. On SIGTERM, intentionally DO NOT call `mgr.shutdown()` — the
 *      whole point of the scenario is to observe whether the grand-
 *      child ssh process is cleaned up when the Node parent dies
 *      without an explicit graceful-shutdown call. A bare
 *      `process.exit(0)` is installed so the process actually exits
 *      rather than continuing to run the idle timer.
 *
 * Exits non-zero with a diagnostic on any error so the parent test
 * sees a clean failure rather than a 5 s timeout.
 */

import { SshTunnelManager } from "../../../services/ssh-tunnels/manager.js";
import type { RemoteServerConfig } from "../../../services/ssh-tunnels/types.js";

async function main(): Promise<void> {
  const mgr = new SshTunnelManager();
  const server: RemoteServerConfig = {
    id: "fixture-1",
    name: "fixture-1",
    ssh: { host: "127.0.0.1" },
  };

  const handle = await mgr.start(server);
  if (handle.status !== "ready") {
    process.stderr.write(
      `fixture: tunnel never became ready (status=${handle.status}, rawStderr=${handle.rawStderr ?? ""})\n`,
    );
    process.exit(1);
  }

  const sshChild = mgr._canonicalChild(server.id);
  const sshPid = sshChild?.pid;
  if (typeof sshPid !== "number") {
    process.stderr.write("fixture: ssh child has no pid\n");
    process.exit(1);
  }

  // Signal readiness to the parent via a single JSON line.
  process.stdout.write(
    JSON.stringify({ ready: true, parentPid: process.pid, sshPid }) + "\n",
  );

  // Intentionally no mgr.shutdown() in the SIGTERM handler — we want
  // the parent-death path to be observable by the test.
  process.on("SIGTERM", () => {
    process.exit(0);
  });

  // Keep the event loop alive long enough for the test to send SIGTERM.
  await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
  // If we get here the test didn't kill us in time — exit non-zero so
  // the failure mode is obvious rather than a zombie subprocess.
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`fixture: ${String(err?.stack ?? err)}\n`);
  process.exit(1);
});
