/**
 * MCP-server resolution for `AgentSession`.
 *
 * Isolated so the MCP lookup (project > workspace > global precedence) +
 * `${secret:NAME}` substitution + shape mapping into the Claude Agent SDK's
 * `mcpServers` record live in one place, independent of the session loop.
 *
 * Why secrets must be resolved HERE (not just at `.mcp.json` reconcile time):
 * the Claude Agent SDK does not auto-read `.mcp.json` — when `mcpServers` is
 * passed via `query()` options it overrides the on-disk file entirely. So if
 * we hand the SDK raw configs with `${secret:NAME}` placeholders, the
 * spawned MCP child process gets literal `"${secret:GITHUB_TOKEN}"` strings
 * in its env and any auth-bearing tool silently fails. Reconcile-time
 * resolution covers the interactive `claude` CLI path (which DOES read
 * `.mcp.json`); this resolution covers the agent SDK path. Both paths must
 * stay in sync — see `resolveServerSecrets` in `claude/mcp-sync.ts`.
 *
 * The function swallows resolver errors (e.g. DB not initialised in narrow
 * unit tests) and returns `undefined` — callers then omit the field from SDK
 * options, preserving pre-fix behavior for any setup where MCP resolution
 * can't run.
 */
import type { AgentMcpServers } from "../agents/types.js";
import { resolveMcpServersForProject } from "../mcp.js";
import { resolveServerSecrets } from "../claude/mcp-sync.js";
import { resolveSecretValue } from "../secrets.js";

export function resolveMcpServersForSession(
  projectId: number | null | undefined,
  logPrefix: string,
): AgentMcpServers | undefined {
  try {
    const servers = resolveMcpServersForProject(projectId ?? null);
    if (!servers.length) return undefined;
    // Substitute `${secret:NAME}` placeholders against the same scope chain
    // (project > workspace > global) the reconcile path uses. Missing
    // secrets stay as placeholders + log a warning — same contract as the
    // `.mcp.json` writer, so behavior is consistent across both code paths.
    const resolved = resolveServerSecrets(servers, (name) =>
      resolveSecretValue(name, projectId ?? null),
    );
    const out: AgentMcpServers = {};
    for (const s of resolved) {
      out[s.name] = s.config as unknown as Record<string, unknown>;
    }
    console.log(
      `[agent-session] mcp.resolved count=${resolved.length} ref=${logPrefix}`,
    );
    return out;
  } catch (err) {
    console.warn(
      `[agent-session] mcp.resolved count=0 ref=${logPrefix} error=${(err as Error).message}`,
    );
    return undefined;
  }
}
