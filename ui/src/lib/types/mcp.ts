// --- MCP Servers ---

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  [key: string]: unknown;
}

export interface McpServer {
  name: string;
  level: "global" | "workspace" | "project";
  config: McpServerConfig;
}
