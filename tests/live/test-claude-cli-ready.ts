/**
 * Verifies the Claude CLI is installed and authenticated on this machine —
 * without running a task. Exits 77 (skipped) if the binary is absent.
 */
import { execFileSync } from "node:child_process";

let version: string;
try {
  version = execFileSync("claude", ["--version"], { timeout: 5_000, stdio: "pipe" }).toString();
} catch {
  console.log("  (skipping: claude CLI not installed)");
  process.exit(77);
}
if (!/\d+\.\d+/.test(version)) {
  throw new Error(`unexpected 'claude --version' output: ${version}`);
}

let authOutput = "";
try {
  authOutput = execFileSync("claude", ["auth", "status"], { timeout: 5_000, stdio: "pipe" }).toString();
} catch (err) {
  throw new Error(`'claude auth status' failed: ${(err as Error).message}`);
}
if (/not logged in|no credentials|unauthenticated|not authenticated/i.test(authOutput)) {
  throw new Error(`claude CLI installed but not authenticated:\n${authOutput}`);
}
