/**
 * `flockctl version` — print version info, optionally as JSON.
 *
 * Commander already wires `flockctl --version` from `program.version()`, but
 * that surface is plain-text-only and prints just the version string. This
 * subcommand exists because:
 *
 *   1. Bug reports want more than the bare semver — node version, install
 *      mode (global / local / source), platform / arch — so we don't have to
 *      ask follow-up questions.
 *   2. Scripts and CI want machine-readable output (`--json`).
 *   3. `flockctl version --remote` lets you check what version the daemon
 *      itself is running, in case it's an older binary than the CLI on
 *      $PATH (a common source of "feature not working" reports).
 *
 * The remote check goes through `/meta/version` (auth-gated, but loopback
 * works without a token). It is intentionally tolerant: if the daemon is
 * down we still print the local info and just note that the remote isn't
 * reachable — the local view is what the user usually wants anyway.
 */
import type { Command } from "commander";
import { createDaemonClient, DaemonError } from "../lib/daemon-client.js";
import { getPackageVersion, getInstallInfo } from "../lib/package-version.js";

interface RemoteVersionResponse {
  current: string;
  latest?: string;
  isOutdated?: boolean;
}

interface VersionOpts {
  json?: boolean;
  remote?: boolean;
}

interface VersionPayload {
  version: string;
  node: string;
  platform: NodeJS.Platform;
  arch: string;
  install: ReturnType<typeof getInstallInfo>;
  daemon?: RemoteVersionResponse | { error: string };
}

async function buildPayload(opts: VersionOpts): Promise<VersionPayload> {
  const payload: VersionPayload = {
    version: getPackageVersion(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    install: getInstallInfo(),
  };

  if (opts.remote) {
    try {
      const client = createDaemonClient();
      payload.daemon = await client.get<RemoteVersionResponse>("/meta/version");
    } catch (err) {
      payload.daemon = {
        error: err instanceof DaemonError ? err.message : String(err),
      };
    }
  }

  return payload;
}

function printHuman(p: VersionPayload): void {
  console.log(`flockctl ${p.version}`);
  console.log(`  node:     ${p.node}`);
  console.log(`  platform: ${p.platform}/${p.arch}`);
  console.log(`  install:  ${p.install.mode}${p.install.root ? ` (${p.install.root})` : ""}`);
  if (p.daemon) {
    if ("error" in p.daemon) {
      console.log(`  daemon:   unreachable (${p.daemon.error})`);
    } else {
      const tag = p.daemon.isOutdated ? ` — outdated, latest is ${p.daemon.latest}` : "";
      console.log(`  daemon:   ${p.daemon.current}${tag}`);
    }
  }
}

export function registerVersionCommand(program: Command): void {
  program
    .command("version")
    .description(
      "Print version info (CLI binary, node, platform, install mode). " +
        "Pass --remote to also query the running daemon's /meta/version.",
    )
    .option("--json", "Print as JSON instead of human-readable lines")
    .option("--remote", "Also report the version of the running daemon")
    .action(async (opts: VersionOpts) => {
      const payload = await buildPayload(opts);
      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printHuman(payload);
    });
}
