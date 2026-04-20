#!/usr/bin/env node
import { Command } from "commander";
import { randomBytes, createHash } from "crypto";
import { startDaemon, stopDaemon, statusDaemon } from "./daemon.js";
import {
  addRemoteAccessToken,
  getConfiguredTokens,
  removeRemoteAccessToken,
} from "./config.js";

const program = new Command();

program
  .name("flockctl")
  .description("Local AI task orchestration tool")
  .version("1.0.0");

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
  .action(() => {
    stopDaemon();
  });

program
  .command("status")
  .description("Check if Flockctl is running")
  .action(() => {
    statusDaemon();
  });

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

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
    const token = generateToken();
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
      console.log(`${t.label.padEnd(labelWidth)}  ${fingerprint(t.token)}`);
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

program.parse();
