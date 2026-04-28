/**
 * `flockctl fs ls <path>` — browse the local filesystem through the
 * daemon's loopback-jailed `/fs/browse` endpoint.
 *
 * The endpoint is intentionally restricted to $HOME and refuses
 * symlink-escapes, so this CLI mostly exists for SSH-tunnel scenarios
 * where you want a quick directory listing of the remote machine
 * without having to SSH again. Local users can just `ls`.
 */
import type { Command } from "commander";
import { resolve as resolvePath } from "path";
import { createDaemonClient, exitWithDaemonError } from "../lib/daemon-client.js";
import { printJson } from "./_shared.js";

interface FsEntry {
  name: string;
  type: "file" | "dir" | "symlink" | string;
  size?: number;
  mtime?: string;
}

interface BrowseResponse {
  entries: FsEntry[];
  isHome: boolean;
  isRoot: boolean;
}

export function registerFsCommand(program: Command): void {
  const cmd = program.command("fs").description("Browse the local filesystem (loopback-jailed).");

  cmd
    .command("ls <path>")
    .description("List directory contents at <path>. Path is resolved to absolute.")
    .option("-a, --all", "Include hidden (dotfile) entries")
    .option("--json", "Print as JSON")
    .action(async (path: string, opts: { all?: boolean; json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const abs = resolvePath(path);
        const res = await client.get<BrowseResponse>("/fs/browse", {
          path: abs,
          show_hidden: opts.all ? "1" : "0",
        });
        if (opts.json) {
          printJson(res);
          return;
        }
        if (res.entries.length === 0) {
          console.log("(empty)");
          return;
        }
        const nameW = Math.max(...res.entries.map((e) => e.name.length));
        for (const e of res.entries) {
          const tag = e.type === "dir" ? "d" : e.type === "symlink" ? "l" : "-";
          const size = e.size !== undefined ? String(e.size) : "";
          console.log(`  ${tag}  ${e.name.padEnd(nameW)}  ${size}`);
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });
}
