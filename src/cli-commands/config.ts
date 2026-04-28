/**
 * `flockctl config ...` — inspect / mutate `~/.flockctlrc` and friends.
 *
 * The rc file is a JSON object that holds:
 *   - `home`                 — override FLOCKCTL_HOME
 *   - `remoteAccessTokens[]` — labelled bearer tokens (managed via `token …`)
 *   - arbitrary user-set keys
 *
 * This command exposes safe access to the rc file:
 *   path            — print the file path + resolved FLOCKCTL_HOME
 *   get <key>       — print the value for `key` (top-level only)
 *   set <key> <val> — write a top-level scalar (refuses to mutate
 *                     `remoteAccessTokens`, that has its own command)
 *   list            — dump every top-level key (values redacted for
 *                     known-secret keys like remoteAccessTokens)
 */
import type { Command } from "commander";
import { loadRc, saveRc, RC_FILE } from "../config/paths.js";
import { getFlockctlHome } from "../config/paths.js";
import { printJson } from "./_shared.js";

const PROTECTED_KEYS = new Set(["remoteAccessTokens"]);

function redactValue(key: string, value: unknown): unknown {
  if (key === "remoteAccessTokens" && Array.isArray(value)) {
    return value.map((t: { label?: string }) => ({
      label: t.label ?? "(unlabelled)",
      token: "<redacted>",
    }));
  }
  return value;
}

function coerceScalar(raw: string): string | number | boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  const n = Number(raw);
  if (Number.isFinite(n) && raw.trim() !== "" && !/[a-zA-Z]/.test(raw)) return n;
  return raw;
}

export function registerConfigCommand(program: Command): void {
  const cmd = program
    .command("config")
    .description("Inspect / mutate ~/.flockctlrc (CLI-side configuration).");

  cmd
    .command("path")
    .description("Print the rc file path and resolved FLOCKCTL_HOME.")
    .option("--json", "Print as JSON")
    .action((opts: { json?: boolean }) => {
      const out = { rc: RC_FILE, home: getFlockctlHome() };
      if (opts.json) {
        printJson(out);
        return;
      }
      console.log(`rc:   ${out.rc}`);
      console.log(`home: ${out.home}`);
    });

  cmd
    .command("list")
    .description("Print every top-level rc key (secrets are redacted).")
    .option("--json", "Print as JSON")
    .action((opts: { json?: boolean }) => {
      const rc = loadRc();
      const safe: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rc)) safe[k] = redactValue(k, v);
      if (opts.json) {
        printJson(safe);
        return;
      }
      for (const [k, v] of Object.entries(safe)) {
        console.log(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
      }
    });

  cmd
    .command("get <key>")
    .description("Print one rc key's value.")
    .action((key: string) => {
      const rc = loadRc();
      const val = rc[key];
      if (val === undefined) {
        console.error(`Error: no rc key "${key}".`);
        process.exit(1);
      }
      const safe = redactValue(key, val);
      if (typeof safe === "object") {
        console.log(JSON.stringify(safe, null, 2));
      } else {
        console.log(safe);
      }
    });

  cmd
    .command("set <key> <value>")
    .description(
      "Set a top-level rc key. Refuses to overwrite `remoteAccessTokens` " +
        "(use the `token` command instead). Strings of the form true/false/null/<number> " +
        "are coerced to their typed value.",
    )
    .action((key: string, value: string) => {
      if (PROTECTED_KEYS.has(key)) {
        console.error(
          `Error: refusing to mutate "${key}" via \`config set\`. Use \`flockctl token\`.`,
        );
        process.exit(1);
      }
      const rc = loadRc();
      rc[key] = coerceScalar(value);
      saveRc(rc);
      console.log(`Set ${key} = ${rc[key]}`);
    });

  cmd
    .command("unset <key>")
    .description("Remove an rc key.")
    .action((key: string) => {
      if (PROTECTED_KEYS.has(key)) {
        console.error(`Error: refusing to clear "${key}" via \`config unset\`.`);
        process.exit(1);
      }
      const rc = loadRc();
      if (!(key in rc)) {
        console.error(`Error: no rc key "${key}".`);
        process.exit(1);
      }
      delete rc[key];
      saveRc(rc);
      console.log(`Removed ${key}`);
    });
}
