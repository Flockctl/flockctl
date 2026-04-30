/**
 * Stdio MCP fixture that echoes a value pulled from its OWN process env back
 * to the agent. Used by `test-mcp-secrets.ts` to prove that a flockctl
 * secret stored encrypted in the DB → referenced via `${secret:NAME}` in an
 * MCP config → resolved by `resolveMcpServersForSession` → forwarded to the
 * SDK as `mcpServers` option → actually arrives in this child process's env
 * with the real (decrypted) value, NOT the placeholder string.
 *
 * Exposes one tool, `flockctl_live_echo_env`, that returns:
 *   - "MISSING" if the env var is not set,
 *   - "PLACEHOLDER" if the env var still contains a literal `${secret:` prefix
 *     (catches the regression where placeholders pass through unsubstituted),
 *   - "OK:<value>" otherwise.
 *
 * The live test asserts the returned text contains the exact secret value.
 *
 * NOT part of production. NOT imported by any runtime code. Only spawned by
 * the live test harness.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const SECRET_PROBE_ENV_VAR = "LIVE_SECRET_PROBE";
export const SECRET_PROBE_TOOL_NAME = "flockctl_live_echo_env";
export const SECRET_PROBE_PREFIX_OK = "OK:";
export const SECRET_PROBE_MISSING = "MISSING";
export const SECRET_PROBE_PLACEHOLDER = "PLACEHOLDER";

const server = new Server(
  { name: "flockctl-live-secret-probe", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: SECRET_PROBE_TOOL_NAME,
      description:
        "Test probe. Returns the value of the LIVE_SECRET_PROBE env var the MCP server received at spawn. " +
        "Call with no arguments and echo the returned text verbatim, including the leading \"OK:\" prefix.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => {
  const v = process.env[SECRET_PROBE_ENV_VAR];
  let body: string;
  if (v === undefined || v === "") {
    body = SECRET_PROBE_MISSING;
  } else if (v.startsWith("${secret:")) {
    // Critical canary: surfaces the bug where placeholders are forwarded to
    // the spawned MCP without substitution. Without this branch the test
    // would just see a "value" and pass even though the real secret never
    // arrived.
    body = SECRET_PROBE_PLACEHOLDER;
  } else {
    body = `${SECRET_PROBE_PREFIX_OK}${v}`;
  }
  return { content: [{ type: "text", text: body }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
