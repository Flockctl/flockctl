/**
 * `flockctl skills ...` — manage SKILL.md docs at global / workspace /
 * project scope, plus the per-config `disable` toggle.
 *
 * Subcommands:
 *   list                       — list scope-local skills
 *   resolved -p <p>            — show the merged set for a project
 *   add  <name> -f <file|->    — write SKILL.md content
 *   rm   <name>                — delete the skill at the chosen scope
 *   disable <name> --level X   — disable an inherited skill (workspace / project only)
 *   enable  <name> --level X   — re-enable a previously disabled skill
 */
import type { Command } from "commander";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { createDaemonClient, exitWithDaemonError } from "../lib/daemon-client.js";
import { printJson } from "./_shared.js";
import { pickScope, resolveScopeId, scopeBucketPath, type ScopeOpts } from "./_scope.js";

interface SkillEntry {
  name: string;
  level: "global" | "workspace" | "project";
  content: string;
}

type DisableLevel = "global" | "workspace" | "project";

function readContent(path: string): string {
  if (path === "-") return readFileSync(0, "utf-8");
  return readFileSync(resolvePath(path), "utf-8");
}

export function registerSkillsCommand(program: Command): void {
  const cmd = program
    .command("skills")
    .description("Manage skills (SKILL.md docs) at global / workspace / project scope.");

  cmd
    .command("list")
    .description("List scope-local skills.")
    .option("-w, --workspace <idOrName>", "Workspace scope")
    .option("-p, --project <idOrName>", "Project scope")
    .option("--json", "Print as JSON")
    .action(async (opts: ScopeOpts & { json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const scope = pickScope(opts);
        const scopeId = await resolveScopeId(client, scope, opts);
        const skills = await client.get<SkillEntry[]>(scopeBucketPath("skills", scope, scopeId));
        if (opts.json) {
          printJson(skills);
          return;
        }
        if (skills.length === 0) {
          console.log("(no skills)");
          return;
        }
        for (const s of skills) {
          const firstLine = s.content.split("\n", 1)[0]?.replace(/^#+\s*/, "") ?? "";
          console.log(`  ${s.name}  —  ${firstLine}`);
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("resolved")
    .description("Show the merged skill set a project would actually receive.")
    .option("-p, --project <idOrName>", "Project to resolve for")
    .option("--json", "Print as JSON")
    .action(async (opts: { project?: string; json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const scopeId = await resolveScopeId(client, "project", opts);
        const skills = await client.get<SkillEntry[]>(`/skills/resolved`, {
          projectId: scopeId ?? undefined,
        });
        if (opts.json) {
          printJson(skills);
          return;
        }
        for (const s of skills) console.log(`  [${s.level}] ${s.name}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("add <name>")
    .description("Write a SKILL.md from a file (or stdin via `-`) at the chosen scope.")
    .requiredOption("-f, --file <path>", "Path to SKILL.md (use `-` for stdin)")
    .option("-w, --workspace <idOrName>", "Workspace scope")
    .option("-p, --project <idOrName>", "Project scope")
    .action(async (name: string, opts: ScopeOpts & { file: string }) => {
      try {
        const client = createDaemonClient();
        const scope = pickScope(opts);
        const scopeId = await resolveScopeId(client, scope, opts);
        const content = readContent(opts.file);
        await client.post(scopeBucketPath("skills", scope, scopeId), { name, content });
        console.log(`Saved ${scope} skill: ${name}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("rm <name>")
    .alias("remove")
    .description("Delete a skill at the chosen scope.")
    .option("-w, --workspace <idOrName>", "Workspace scope")
    .option("-p, --project <idOrName>", "Project scope")
    .action(async (name: string, opts: ScopeOpts) => {
      try {
        const client = createDaemonClient();
        const scope = pickScope(opts);
        const scopeId = await resolveScopeId(client, scope, opts);
        await client.del(`${scopeBucketPath("skills", scope, scopeId)}/${encodeURIComponent(name)}`);
        console.log(`Removed ${scope} skill: ${name}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  // disable / enable targets the *workspace* or *project* scope. The level
  // arg is "the level whose skill we're disabling" — e.g. you can disable
  // a `global` skill from `workspace` scope.
  for (const action of ["disable", "enable"] as const) {
    const isDisable = action === "disable";
    cmd
      .command(`${action} <name>`)
      .description(
        `${isDisable ? "Disable" : "Re-enable"} an inherited skill in workspace or project config.`,
      )
      .requiredOption(
        "--level <level>",
        "The skill's origin level: global | workspace | project",
      )
      .option("-w, --workspace <idOrName>", "Workspace scope (target config)")
      .option("-p, --project <idOrName>", "Project scope (target config)")
      .action(
        async (
          name: string,
          opts: ScopeOpts & { level: string },
        ) => {
          try {
            const level = opts.level as DisableLevel;
            if (!["global", "workspace", "project"].includes(level)) {
              console.error(`Error: --level must be global | workspace | project`);
              process.exit(1);
            }
            const client = createDaemonClient();
            const targetScope = pickScope(opts);
            if (targetScope === "global") {
              console.error(`Error: ${action} requires --workspace or --project`);
              process.exit(1);
            }
            const scopeId = await resolveScopeId(client, targetScope, opts);
            const path = `${scopeBucketPath("skills", targetScope, scopeId)}/disable`;
            if (isDisable) {
              await client.post(path, { name, level });
            } else {
              await client.request(path, { method: "DELETE", body: { name, level } });
            }
            console.log(`${isDisable ? "Disabled" : "Re-enabled"} skill: ${name} (level=${level})`);
          } catch (err) {
            exitWithDaemonError(err);
          }
        },
      );
  }
}
