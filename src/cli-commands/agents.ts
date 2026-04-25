/**
 * `flockctl agents ...` — inspect layered AGENTS.md guidance.
 *
 * The agent-guidance loader (`src/services/agent-session/agent-guidance-loader.ts`)
 * merges three AGENTS.md layers (user → workspace-public → project-public)
 * into a single string that gets injected into every agent session. This CLI
 * exposes the same view to humans so they can preview and debug what the
 * agent will actually see, without spinning up a session.
 *
 * Unlike the `project` / `workspace` command groups, this one is fully
 * filesystem-local: it does not talk to the daemon. A path is considered a
 * "known flockctl path" if it exists on disk and contains a `.flockctl/`
 * scaffold directory — the same marker the daemon writes when it scaffolds a
 * workspace or a project.
 *
 * Pipe-friendly by contract: no ANSI colours, no decoration, only errors and
 * explicit warnings go to stderr. Callers are free to `flockctl agents show
 * ... > AGENTS.resolved.md`.
 */
import type { Command } from "commander";
import {
  existsSync,
  statSync,
} from "fs";
import { dirname, join, parse, resolve as resolvePath } from "path";
import { getFlockctlHome } from "../config/paths.js";
import {
  loadAgentGuidance,
  loadWorkspaceAgentGuidance,
} from "../services/agent-session/agent-guidance-loader.js";

/**
 * Validate that `path` looks like a flockctl-managed directory of the given
 * kind — i.e. it exists, is a directory, and contains a `.flockctl/` subdir.
 * We deliberately don't hit the daemon: this command has to work while the
 * daemon is stopped, and the filesystem marker is the same one the daemon
 * writes at scaffold time.
 */
export function assertKnownFlockctlPath(
  path: string,
  kind: "workspace" | "project",
): void {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`Path not found: ${path}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`Path is not a directory: ${path}`);
  }
  const marker = join(path, ".flockctl");
  let markerSt;
  try {
    markerSt = statSync(marker);
  } catch {
    throw new Error(
      `Not a known flockctl ${kind}: ${path} (missing .flockctl/ scaffold). ` +
        `Run \`flockctl ${kind} add\` first.`,
    );
  }
  if (!markerSt.isDirectory()) {
    throw new Error(
      `Not a known flockctl ${kind}: ${path} (.flockctl exists but is not a directory)`,
    );
  }
}

/**
 * Walk up ancestors of `projectPath` looking for a directory that has its own
 * `.flockctl/` scaffold — that ancestor is the enclosing workspace. Returns
 * `null` if the project is standalone (no ancestor scaffold before filesystem
 * root). The workspace layer loader treats `null` as "skip workspace layers",
 * which is exactly what we want for standalone projects.
 *
 * Implementation detail: we never walk past the filesystem root. We also skip
 * `projectPath` itself — a project's own `.flockctl/` is not its workspace.
 */
export function resolveWorkspaceFor(projectPath: string): string | null {
  const root = parse(projectPath).root;
  let dir = dirname(projectPath);
  while (dir && dir !== root) {
    if (existsSync(join(dir, ".flockctl"))) {
      return dir;
    }
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

interface ShowOptions {
  workspace?: boolean;
  effective?: boolean;
  layers?: boolean;
}

export function registerAgentsCommand(program: Command): void {
  const agents = program
    .command("agents")
    .description(
      "Inspect the merged AGENTS.md guidance the agent session will see.",
    );

  agents
    .command("show <path>")
    .description(
      "Print the merged agent guidance (user → workspace → project layers) " +
        "for the given path. Defaults to treating <path> as a project root — " +
        "pass --workspace to render a workspace-scoped view instead.",
    )
    .option("--workspace", "treat path as a workspace root", false)
    .option("--effective", "print merged string (default)", false)
    .option(
      "--layers",
      "print JSON summary of per-layer byte sizes instead of the merged string",
      false,
    )
    .action((path: string, opts: ShowOptions) => {
      try {
        const resolved = resolvePath(path);
        const flockctlHome = getFlockctlHome();
        assertKnownFlockctlPath(resolved, opts.workspace ? "workspace" : "project");
        const guidance = opts.workspace
          ? loadWorkspaceAgentGuidance(resolved, flockctlHome)
          : loadAgentGuidance({
              projectPath: resolved,
              workspacePath: resolveWorkspaceFor(resolved),
              flockctlHome,
            });
        if (opts.layers) {
          const summary = {
            layers: guidance.layers.map((l) => ({
              layer: l.layer,
              path: l.path,
              bytes: l.bytes,
              truncated: l.truncated,
            })),
            totalBytes: guidance.totalBytes,
            truncatedLayers: guidance.truncatedLayers,
          };
          process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
        } else {
          process.stdout.write(guidance.mergedWithHeaders);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${msg}\n`);
        process.exit(1);
      }
    });
}
