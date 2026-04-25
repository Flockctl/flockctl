/**
 * Minimal stdio MCP server used as a fixture by
 * `test-mcp-servers.ts`. Exposes a single tool `flockctl_live_ping` that
 * returns the sentinel string the live test grep-asserts on. Kept small and
 * dependency-light — uses the bundled `@modelcontextprotocol/sdk` already
 * pulled in transitively by `@anthropic-ai/claude-agent-sdk`, so the live
 * suite doesn't add a new top-level dep.
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

export const FIXTURE_SENTINEL = "PONG_FROM_MCP_FIXTURE";
export const FIXTURE_TOOL_NAME = "flockctl_live_ping";

const server = new Server(
  { name: "flockctl-live-test", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: FIXTURE_TOOL_NAME,
      description:
        "Test probe. Returns a fixed sentinel string. Call with no arguments and echo the returned text verbatim.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: FIXTURE_SENTINEL }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
