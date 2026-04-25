import { buildCodebaseContext } from "./git-context.js";
import { getPlanDir } from "./plan-store/index.js";

/**
 * Build a prompt for plan generation. The agent has the `planning` skill
 * available via progressive disclosure — we direct it to load the correct
 * mode section itself rather than inlining the skill content.
 */
export async function buildPlanGenerationPrompt(
  projectId: number,
  projectPath: string,
  userDescription: string,
  mode: "quick" | "deep",
): Promise<string> {
  const codebaseCtx = await buildCodebaseContext(projectId);
  const planDir = getPlanDir(projectPath);

  const modeLabel = mode === "quick" ? "Quick" : "Deep";

  const parts: string[] = [
    `# Plan Generation — ${modeLabel} Mode`,
    `Use the \`planning\` skill to plan this project. Read the skill's SKILL.md, then follow the "## Mode: ${modeLabel}" section for structure, depth, and file format.`,
    `## User Description\n\n${userDescription}`,
    `## Target Directory\n\nCreate all plan files in: \`${planDir}\`\nProject root: \`${projectPath}\``,
  ];

  if (codebaseCtx) {
    parts.push(`## Codebase Context\n\n${codebaseCtx}`);
  }

  return parts.join("\n\n");
}
