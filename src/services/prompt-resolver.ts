/**
 * Resolve the effective prompt for an execution task.
 * If `promptFile` is set, reads the md file (frontmatter + body) and builds the prompt.
 * Otherwise falls back to the inline `prompt` column.
 */
import { readFileSync, existsSync } from "fs";
import { parseMd } from "./plan-store/index.js";

interface TaskRow {
  prompt: string | null;
  promptFile: string | null;
}

export function resolveTaskPrompt(task: TaskRow): string {
  if (task.promptFile) {
    return readPromptFromFile(task.promptFile);
  }
  return task.prompt ?? "";
}

function readPromptFromFile(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Prompt file not found: ${filePath}`);
  }

  const { frontmatter, body } = parseMd(filePath);

  // Build prompt from frontmatter + body. `frontmatter` is now typed
  // `Record<string, unknown>` (audit-round-8 type-safety tightening);
  // narrow each access site with `typeof` guards so TS knows the value
  // is a string before we concat it into the output.
  const parts: string[] = [];

  if (typeof frontmatter.title === "string" && frontmatter.title) {
    parts.push(frontmatter.title);
  }

  if (body) {
    parts.push(body);
  }

  if (typeof frontmatter.verify === "string" && frontmatter.verify) {
    parts.push(`Verification: ${frontmatter.verify}`);
  }

  if (frontmatter.files && Array.isArray(frontmatter.files)) {
    parts.push(`Files: ${frontmatter.files.join(", ")}`);
  }

  if (frontmatter.expected_output && Array.isArray(frontmatter.expected_output)) {
    parts.push(`Expected output: ${frontmatter.expected_output.join(", ")}`);
  }

  return parts.join("\n\n");
}
