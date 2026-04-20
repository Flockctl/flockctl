/**
 * Shared formatters for tool_call / tool_result events emitted by AgentSession.
 * Tasks and chats both render them the same way, so the logic lives here.
 */

function parseToolInput(raw: any): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null) return raw;
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function formatToolCall(name: string, rawInput: any): string {
  const input = parseToolInput(rawInput);

  switch (name) {
    case "Bash":
    case "bash": {
      const cmd = String(input.command ?? "");
      return `$ ${truncate(cmd.replace(/\n/g, " && "), 300)}`;
    }
    case "Read":
    case "read": {
      const file = String(input.file_path ?? input.filePath ?? "");
      return `📄 Read ${file}`;
    }
    case "Write":
    case "write": {
      const file = String(input.file_path ?? input.filePath ?? "");
      return `✏️ Write ${file}`;
    }
    case "Edit":
    case "edit": {
      const file = String(input.file_path ?? input.filePath ?? "");
      return `✏️ Edit ${file}`;
    }
    case "Glob":
    case "glob":
    case "ListDir":
    case "list_dir":
      return `📂 ${name} ${String(input.pattern ?? input.path ?? "")}`;
    case "Grep":
    case "grep":
      return `🔍 Grep "${truncate(String(input.pattern ?? input.query ?? ""), 100)}"`;
    case "Skill":
    case "skill": {
      const skillName = String(input.name ?? input.skill ?? "unknown");
      const args = input.args ? ` — ${truncate(String(input.args), 120)}` : "";
      return `📚 Skill: ${skillName}${args}`;
    }
    default:
      return `🔧 ${name} ${truncate(JSON.stringify(input), 200)}`;
  }
}

export function formatToolResult(name: string, output: string): string {
  if (!output) return `✓ ${name || "done"}`;
  return `✓ ${name ? name + ": " : ""}${truncate(output.replace(/\n/g, " "), 300)}`;
}
