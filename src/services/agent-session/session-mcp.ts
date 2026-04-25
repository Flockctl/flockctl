/**
 * MCP-server resolution for `AgentSession`.
 *
 * Isolated so the MCP lookup (project > workspace > global precedence) +
 * the shape mapping into the Claude Agent SDK's `mcpServers` record live
 * in one place, independent of the session loop. The function swallows
 * resolver errors (e.g. DB not initialised in narrow unit tests) and
 * returns `undefined` — callers then omit the field from SDK options,
 * preserving pre-fix behavior for any setup where MCP resolution can't run.
 */
import type { AgentMcpServers } from "../agents/types.js";
import { resolveMcpServersForProject } from "../mcp.js";

export function resolveMcpServersForSession(
  projectId: number | null | undefined,
  logPrefix: string,
): AgentMcpServers | undefined {
  try {
    const servers = resolveMcpServersForProject(projectId ?? null);
    if (!servers.length) return undefined;
    const out: AgentMcpServers = {};
    for (const s of servers) {
      out[s.name] = s.config as unknown as Record<string, unknown>;
    }
    console.log(
      `[agent-session] mcp.resolved count=${servers.length} ref=${logPrefix}`,
    );
    return out;
  } catch (err) {
    console.warn(
      `[agent-session] mcp.resolved count=0 ref=${logPrefix} error=${(err as Error).message}`,
    );
    return undefined;
  }
}
