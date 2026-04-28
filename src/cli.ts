#!/usr/bin/env node
import { Command } from "commander";
import { startDaemon, stopDaemon, statusDaemon } from "./daemon.js";
import {
  addRemoteAccessToken,
  getConfiguredTokens,
  removeRemoteAccessToken,
} from "./config/index.js";
import { generateRemoteAccessToken, tokenFingerprint } from "./lib/token.js";
import { getPackageVersion } from "./lib/package-version.js";
import { runCheck, formatViolations } from "./services/state-machines/sm-diff-analyzer.js";
import { registerProjectCommand } from "./cli-commands/project.js";
import { registerWorkspaceCommand } from "./cli-commands/workspace.js";
import { registerAgentsCommand } from "./cli-commands/agents.js";
import { registerRemoteBootstrapCommand } from "./cli-commands/remote-bootstrap.js";
import { registerVersionCommand } from "./cli-commands/version.js";
import { registerCompletionCommand } from "./cli-commands/completion.js";
import { registerTasksCommand } from "./cli-commands/tasks.js";
import { registerSecretsCommand } from "./cli-commands/secrets.js";
import { registerAiKeysCommand } from "./cli-commands/ai-keys.js";
import { registerDoctorCommand } from "./cli-commands/doctor.js";
import { registerMcpCommand } from "./cli-commands/mcp.js";
import { registerSchedulesCommand } from "./cli-commands/schedules.js";
import { registerSkillsCommand } from "./cli-commands/skills.js";
import { registerTemplatesCommand } from "./cli-commands/templates.js";
import { registerChatsCommand } from "./cli-commands/chats.js";
import { registerLogsCommand } from "./cli-commands/logs.js";
import { registerIncidentsCommand } from "./cli-commands/incidents.js";
import { registerMetricsCommand, registerUsageCommand } from "./cli-commands/metrics.js";
import { registerFsCommand } from "./cli-commands/fs.js";
import { registerConfigCommand } from "./cli-commands/config.js";
import { registerBackupCommand } from "./cli-commands/backup.js";
import { registerMigrateCommand } from "./cli-commands/migrate.js";
import { registerOpenCommand } from "./cli-commands/open.js";

const program = new Command();

program
  .name("flockctl")
  .description("Local AI task orchestration tool")
  .version(getPackageVersion());

program
  .command("start")
  .description("Start Flockctl web server in background")
  .option("-p, --port <number>", "Port to listen on", "52077")
  .option(
    "-H, --host <address>",
    "Interface to bind to. Default is 127.0.0.1 (loopback only). " +
      "Use 0.0.0.0 for remote access — requires an access token.",
    "127.0.0.1",
  )
  .option(
    "--allow-insecure-public",
    "Allow binding to a non-loopback interface WITHOUT a token. " +
      "Dangerous — anyone who can reach the address can run tasks on your machine.",
    false,
  )
  .action((opts) => {
    startDaemon({
      port: parseInt(opts.port, 10),
      host: opts.host,
      allowInsecurePublic: opts.allowInsecurePublic === true,
    });
  });

program
  .command("stop")
  .description("Stop Flockctl web server")
  .action(async () => {
    await stopDaemon();
  });

program
  .command("status")
  .description("Check if Flockctl is running")
  .action(() => {
    statusDaemon();
  });

const tokenCmd = program
  .command("token")
  .description("Manage remote access tokens");

tokenCmd
  .command("generate")
  .description("Generate a new remote access token")
  .option("-l, --label <name>", "Label for the new token", "default")
  .option(
    "--save",
    "Write the token into ~/.flockctlrc (otherwise just print it)",
    false,
  )
  .action((opts) => {
    const token = generateRemoteAccessToken();
    if (opts.save) {
      try {
        addRemoteAccessToken(opts.label, token);
        console.log(`Token saved to ~/.flockctlrc (label: ${opts.label})`);
        console.log(`\nUse this token in Authorization: Bearer <token> headers:\n`);
        console.log(`  ${token}\n`);
        console.log(
          `This is the only time the full token will be shown. Store it securely.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    } else {
      console.log(token);
      console.log(`\nTo save it:`);
      console.log(`  flockctl token generate --label ${opts.label} --save`);
      console.log(`\nOr add it manually to ~/.flockctlrc:`);
      console.log(
        `  "remoteAccessTokens": [{ "label": "${opts.label}", "token": "${token}" }]`,
      );
    }
  });

tokenCmd
  .command("list")
  .description("List configured remote access tokens (labels only)")
  .action(() => {
    const tokens = getConfiguredTokens();
    if (tokens.length === 0) {
      console.log("No remote access tokens configured.");
      console.log("Generate one with: flockctl token generate --save");
      return;
    }
    const labelWidth = Math.max(5, ...tokens.map((t) => t.label.length));
    console.log(`${"LABEL".padEnd(labelWidth)}  FINGERPRINT`);
    for (const t of tokens) {
      console.log(`${t.label.padEnd(labelWidth)}  ${tokenFingerprint(t.token)}`);
    }
  });

tokenCmd
  .command("revoke <label>")
  .description("Remove the token with the given label")
  .action((label: string) => {
    const removed = removeRemoteAccessToken(label);
    if (removed) {
      console.log(`Revoked token: ${label}`);
    } else {
      console.error(`No token found with label: ${label}`);
      process.exit(1);
    }
  });

const smCmd = program
  .command("state-machines")
  .description("Work with state-machine registries under .flockctl/state-machines/");

smCmd
  .command("check")
  .description(
    "Check the current git diff for state transitions that are not declared in the registry. " +
      "Exits 1 on violations (suitable for pre-commit hooks).",
  )
  .option(
    "-d, --diff <ref>",
    "Git ref to diff against (default: HEAD — i.e. `git diff HEAD`)",
    "HEAD",
  )
  .option(
    "-f, --files <glob>",
    "Restrict detection to files matching this glob (e.g. `src/models/**/*.ts`)",
  )
  .option("-C, --cwd <path>", "Run as if from this directory", process.cwd())
  .action((opts) => {
    try {
      const result = runCheck({
        cwd: opts.cwd,
        diffRef: opts.diff,
        files: opts.files,
      });
      if (result.violations.length === 0) {
        const n = result.detected.length;
        if (n === 0) {
          console.log("No state-machine transitions found in diff.");
        } else if (n === 1) {
          console.log("1 detected transition matches the registry.");
        } else {
          console.log(`${n} detected transitions match the registry.`);
        }
        return;
      }
      console.error(formatViolations(result.violations));
      process.exit(1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

registerVersionCommand(program);
registerCompletionCommand(program);
registerTasksCommand(program);
registerSecretsCommand(program);
registerAiKeysCommand(program);
registerDoctorCommand(program);
registerMcpCommand(program);
registerSchedulesCommand(program);
registerSkillsCommand(program);
registerTemplatesCommand(program);
registerChatsCommand(program);
registerLogsCommand(program);
registerIncidentsCommand(program);
registerMetricsCommand(program);
registerUsageCommand(program);
registerFsCommand(program);
registerConfigCommand(program);
registerBackupCommand(program);
registerMigrateCommand(program);
registerOpenCommand(program);
registerProjectCommand(program);
registerWorkspaceCommand(program);
registerAgentsCommand(program);
registerRemoteBootstrapCommand(program);

program.parse();
