/**
 * `flockctl doctor` — environment health check.
 *
 * One screen of diagnostics that answers the questions support tickets
 * keep asking:
 *
 *   1. Is the daemon running and reachable on the configured port?
 *   2. Is `~/.flockctlrc` permissions tight (chmod 600)?
 *   3. Are the agent CLIs (`claude`, the Copilot SDK) installed and
 *      authenticated?
 *   4. Does the FLOCKCTL_HOME directory exist? Is it writable?
 *   5. Did we discover at least one AI provider key?
 *
 * Each check prints a coloured-status-free line so the output is safe
 * for log capture and grep:
 *
 *   ok   — passes
 *   warn — non-fatal issue, daemon will work but with caveat
 *   fail — blocking issue
 *
 * Exit code:
 *   0 if every check is ok or warn
 *   1 if any check is fail
 *
 * The command always finishes — a daemon being down is a `fail` line,
 * not an exception. That's deliberate: doctor is the *first* thing you
 * run when nothing else works.
 */
import type { Command } from "commander";
import { existsSync, statSync, accessSync, constants } from "fs";
import { createDaemonClient, DaemonError } from "../lib/daemon-client.js";
import { checkRcPermissions, getFlockctlHome } from "../config/paths.js";
import { getPackageVersion, getInstallInfo } from "../lib/package-version.js";

type Status = "ok" | "warn" | "fail";

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
}

interface ListResp<T> {
  items: T[];
  total: number;
}

async function checkDaemon(): Promise<CheckResult> {
  try {
    const client = createDaemonClient({ timeoutMs: 3000 });
    const v = await client.get<{ current: string }>("/meta/version");
    return {
      name: "daemon",
      status: "ok",
      detail: `running, version ${v.current} on ${client.baseUrl}`,
    };
  } catch (err) {
    if (err instanceof DaemonError && err.statusCode === 0) {
      return {
        name: "daemon",
        status: "fail",
        detail: "not reachable — start with `flockctl start`",
      };
    }
    return {
      name: "daemon",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkFlockctlrc(): CheckResult {
  const r = checkRcPermissions();
  if (r.secure) {
    return { name: "~/.flockctlrc", status: "ok", detail: "permissions ok or file absent" };
  }
  return {
    name: "~/.flockctlrc",
    status: "warn",
    detail: r.message ?? "permissions weaker than 600",
  };
}

function checkFlockctlHome(): CheckResult {
  const home = getFlockctlHome();
  if (!existsSync(home)) {
    return {
      name: "FLOCKCTL_HOME",
      status: "warn",
      detail: `${home} does not exist (will be created on first use)`,
    };
  }
  try {
    const st = statSync(home);
    if (!st.isDirectory()) {
      return { name: "FLOCKCTL_HOME", status: "fail", detail: `${home} is not a directory` };
    }
    accessSync(home, constants.W_OK);
    return { name: "FLOCKCTL_HOME", status: "ok", detail: home };
  } catch (err) {
    return {
      name: "FLOCKCTL_HOME",
      status: "fail",
      detail: `${home} not writable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkAgents(): Promise<CheckResult[]> {
  const client = createDaemonClient({ timeoutMs: 3000 });
  const out: CheckResult[] = [];
  for (const slug of ["claude-cli", "copilot"] as const) {
    try {
      const r = await client.get<{ installed: boolean; authenticated: boolean; ready: boolean; models: string[] }>(
        `/keys/${slug}/status`,
      );
      let status: Status = "ok";
      let detail = `installed=${r.installed} authenticated=${r.authenticated} ready=${r.ready}`;
      if (!r.installed) {
        status = "warn";
        detail = "not installed";
      } else if (!r.authenticated) {
        status = "warn";
        detail = "installed but not authenticated";
      } else if (r.models.length === 0) {
        status = "warn";
        detail = "authenticated but no models advertised";
      } else {
        detail = `${r.models.length} model(s) available`;
      }
      out.push({ name: `agent:${slug}`, status, detail });
    } catch (err) {
      out.push({
        name: `agent:${slug}`,
        status: "warn",
        detail: `daemon unreachable for status check: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return out;
}

async function checkAtLeastOneKey(): Promise<CheckResult> {
  try {
    const client = createDaemonClient({ timeoutMs: 3000 });
    const res = await client.get<ListResp<{ id: number; isActive: boolean }>>("/keys", { perPage: 200 });
    if (res.total === 0) {
      return {
        name: "ai-keys",
        status: "warn",
        detail: "no keys registered — agent runs will fail. Run `claude login` or set up Copilot.",
      };
    }
    const active = res.items.filter((k) => k.isActive).length;
    if (active === 0) {
      return {
        name: "ai-keys",
        status: "warn",
        detail: `${res.total} key(s) registered but none active`,
      };
    }
    return { name: "ai-keys", status: "ok", detail: `${active}/${res.total} active` };
  } catch (err) {
    return {
      name: "ai-keys",
      status: "warn",
      detail: `daemon unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkBinary(): CheckResult {
  const info = getInstallInfo();
  return {
    name: "flockctl",
    status: "ok",
    detail: `version ${getPackageVersion()} (install: ${info.mode})`,
  };
}

function printChecks(checks: CheckResult[]): { hadFailure: boolean } {
  const labelW = Math.max(...checks.map((c) => c.name.length));
  let hadFailure = false;
  for (const c of checks) {
    if (c.status === "fail") hadFailure = true;
    const tag = c.status.toUpperCase().padEnd(4);
    console.log(`  [${tag}]  ${c.name.padEnd(labelW)}  ${c.detail}`);
  }
  return { hadFailure };
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description(
      "Run environment health checks: daemon reachable, ~/.flockctlrc " +
        "permissions, FLOCKCTL_HOME writable, AI agents installed/authenticated, " +
        "at least one key active. Exits non-zero on any `fail`.",
    )
    .option("--json", "Print results as JSON instead of a table")
    .action(async (opts: { json?: boolean }) => {
      const checks: CheckResult[] = [];
      checks.push(checkBinary());
      checks.push(checkFlockctlrc());
      checks.push(checkFlockctlHome());
      checks.push(await checkDaemon());
      // Skip /keys-based checks if the daemon is down — they'll just spam
      // the same "unreachable" message. The `daemon` line already told
      // the operator what to do.
      const daemonOk = checks.find((c) => c.name === "daemon")?.status === "ok";
      if (daemonOk) {
        checks.push(...(await checkAgents()));
        checks.push(await checkAtLeastOneKey());
      }
      if (opts.json) {
        console.log(JSON.stringify(checks, null, 2));
        if (checks.some((c) => c.status === "fail")) process.exit(1);
        return;
      }
      const { hadFailure } = printChecks(checks);
      if (hadFailure) process.exit(1);
    });
}
