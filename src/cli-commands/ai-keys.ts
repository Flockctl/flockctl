/**
 * `flockctl ai-keys ...` — read-only inspection of the AI provider keys
 * registered with the daemon.
 *
 * Why no `add` / `set` here? The two providers we support — Claude Code
 * CLI and GitHub Copilot SDK — both authenticate via OAuth flows handled
 * inside their own CLIs (`claude login`, `gh auth login` /
 * `@github/copilot-sdk`). The flockctl daemon discovers those keys by
 * walking each agent's config dir. There is no API endpoint to inject
 * a key value, so the CLI doesn't pretend there's one. Provisioning is
 * documented in the UI and goes through the agent vendor.
 *
 * What the CLI *can* do, and is useful for headless setups:
 *   - `list`              — see which keys are registered (values redacted)
 *   - `show <id>`         — full row (still redacted), with config_dir
 *   - `status <provider>` — report installed / authenticated / ready,
 *                           plus the model list the agent advertises.
 *                           Maps to the `claude-cli` / `copilot` health
 *                           endpoints that `flockctl doctor` also calls.
 *   - `providers`         — dump the supported providers map.
 */
import type { Command } from "commander";
import { createDaemonClient, exitWithDaemonError } from "../lib/daemon-client.js";
import { printJson, type ListResponse } from "./_shared.js";

interface AiKeyRow {
  id: number;
  label: string;
  provider: string;
  keyValue: string | null; // already redacted by the daemon
  configDir: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ReadinessResponse {
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
  models: string[];
}

export function registerAiKeysCommand(program: Command): void {
  const cmd = program
    .command("ai-keys")
    .description("Inspect AI provider keys (Claude CLI / Copilot SDK). Read-only.");

  cmd
    .command("list")
    .description("List registered AI provider keys. Values are redacted.")
    .option("--json", "Print as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const res = await client.get<ListResponse<AiKeyRow>>("/keys", { perPage: 200 });
        if (opts.json) {
          printJson(res.items);
          return;
        }
        if (res.items.length === 0) {
          console.log("(no keys registered — run `claude login` or set up Copilot)");
          return;
        }
        const idW = Math.max(2, ...res.items.map((k) => String(k.id).length));
        const labelW = Math.max(5, ...res.items.map((k) => k.label.length));
        const provW = Math.max(8, ...res.items.map((k) => k.provider.length));
        console.log(
          `${"ID".padEnd(idW)}  ${"LABEL".padEnd(labelW)}  ${"PROVIDER".padEnd(provW)}  ACTIVE  KEY`,
        );
        for (const k of res.items) {
          console.log(
            [
              String(k.id).padEnd(idW),
              k.label.padEnd(labelW),
              k.provider.padEnd(provW),
              (k.isActive ? "yes" : "no").padEnd(6),
              k.keyValue ?? "(no value)",
            ].join("  "),
          );
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("show <id>")
    .description("Show one key's full record (value still redacted).")
    .option("--json", "Print as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const k = await client.get<AiKeyRow>(`/keys/${id}`);
        if (opts.json) {
          printJson(k);
          return;
        }
        console.log(`Key #${k.id}: ${k.label}`);
        console.log(`  provider:   ${k.provider}`);
        console.log(`  active:     ${k.isActive}`);
        console.log(`  configDir:  ${k.configDir ?? "(none)"}`);
        console.log(`  keyValue:   ${k.keyValue ?? "(no value)"}`);
        console.log(`  createdAt:  ${k.createdAt}`);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("providers")
    .description("List supported AI providers.")
    .option("--json", "Print as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = createDaemonClient();
        const providers = await client.get<Record<string, { name: string; apiType: string }>>(
          "/keys/providers",
        );
        if (opts.json) {
          printJson(providers);
          return;
        }
        const keyW = Math.max(...Object.keys(providers).map((k) => k.length));
        for (const [k, v] of Object.entries(providers)) {
          console.log(`  ${k.padEnd(keyW)}  ${v.name} (${v.apiType})`);
        }
      } catch (err) {
        exitWithDaemonError(err);
      }
    });

  cmd
    .command("status <provider>")
    .description(
      "Report installed/authenticated/ready for a provider. " +
        "Provider must be one of: claude-cli | copilot.",
    )
    .option("--json", "Print as JSON")
    .action(async (provider: string, opts: { json?: boolean }) => {
      try {
        const slug = provider === "claude" ? "claude-cli" : provider;
        if (slug !== "claude-cli" && slug !== "copilot") {
          console.error(`Error: unknown provider "${provider}". Try claude-cli or copilot.`);
          process.exit(1);
        }
        const client = createDaemonClient();
        const r = await client.get<ReadinessResponse>(`/keys/${slug}/status`);
        if (opts.json) {
          printJson(r);
          return;
        }
        console.log(`${slug}:`);
        console.log(`  installed:     ${r.installed}`);
        console.log(`  authenticated: ${r.authenticated}`);
        console.log(`  ready:         ${r.ready}`);
        console.log(`  models:        ${r.models.length === 0 ? "(none)" : r.models.join(", ")}`);
        if (!r.ready) process.exit(1);
      } catch (err) {
        exitWithDaemonError(err);
      }
    });
}
