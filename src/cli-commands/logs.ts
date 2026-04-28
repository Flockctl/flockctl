/**
 * `flockctl logs` — show / tail the daemon's own log file.
 *
 * The daemon writes stdout + stderr to `${FLOCKCTL_HOME}/flockctl.log`
 * (see `src/daemon.ts:getLogFile`). When something is wrong, the first
 * thing every operator wants is the last 50 lines of that file. This
 * command exists to spare them the `cat ~/flockctl/flockctl.log | tail`
 * dance, especially since FLOCKCTL_HOME may be relocated via env.
 *
 * Modes:
 *   default       — print the whole file
 *   --tail <n>    — print only the last N lines
 *   --follow      — print + watch for appends, exit on Ctrl-C
 *   --path        — just print the resolved log path and exit
 */
import type { Command } from "commander";
import { createReadStream, statSync, existsSync } from "fs";
import { join } from "path";
import { getFlockctlHome } from "../config/paths.js";

function getLogPath(): string {
  return join(getFlockctlHome(), "flockctl.log");
}

async function printTail(logPath: string, n: number): Promise<void> {
  // Read the file backwards-by-chunk until we have N newlines or hit BOF.
  const fileSize = statSync(logPath).size;
  const chunkSize = 64 * 1024;
  let pos = fileSize;
  let buf = "";
  let lineCount = 0;
  while (pos > 0 && lineCount <= n) {
    const start = Math.max(0, pos - chunkSize);
    const stream = createReadStream(logPath, { start, end: pos - 1 });
    const data: Buffer = await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer | string) =>
        chunks.push(typeof c === "string" ? Buffer.from(c) : c),
      );
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
    buf = data.toString("utf-8") + buf;
    lineCount = (buf.match(/\n/g) ?? []).length;
    pos = start;
  }
  const lines = buf.split("\n");
  const tail = lines.slice(Math.max(0, lines.length - n - 1));
  process.stdout.write(tail.join("\n"));
  if (!buf.endsWith("\n")) process.stdout.write("\n");
}

async function followStream(logPath: string): Promise<void> {
  // Naive append-poll. fs.watch is more elegant but flaky across platforms;
  // a 250 ms poll is fine for a human watching log output.
  let offset = existsSync(logPath) ? statSync(logPath).size : 0;
  for (;;) {
    if (existsSync(logPath)) {
      const size = statSync(logPath).size;
      if (size > offset) {
        const stream = createReadStream(logPath, { start: offset, end: size - 1 });
        await new Promise<void>((resolve, reject) => {
          stream.on("data", (chunk: Buffer | string) =>
            process.stdout.write(typeof chunk === "string" ? chunk : chunk),
          );
          stream.on("end", () => resolve());
          stream.on("error", reject);
        });
        offset = size;
      } else if (size < offset) {
        // The file was rotated/truncated; reset offset to 0.
        offset = 0;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("Print or follow the daemon's own log file (~/flockctl/flockctl.log).")
    .option("--tail <n>", "Print only the last N lines")
    .option("-f, --follow", "Follow the log; exit on Ctrl-C")
    .option("--path", "Print the resolved log file path and exit")
    .action(async (opts: { tail?: string; follow?: boolean; path?: boolean }) => {
      const logPath = getLogPath();
      if (opts.path) {
        console.log(logPath);
        return;
      }
      if (!existsSync(logPath)) {
        console.error(
          `Log file not found at ${logPath}. The daemon writes here on first start; ` +
            `run \`flockctl start\` first.`,
        );
        process.exit(1);
      }
      if (opts.tail !== undefined) {
        const n = parseInt(opts.tail, 10);
        if (!Number.isFinite(n) || n <= 0) {
          console.error(`Error: --tail expects a positive integer, got "${opts.tail}"`);
          process.exit(1);
        }
        await printTail(logPath, n);
        if (!opts.follow) return;
      } else if (!opts.follow) {
        // Whole file dump: stream-pipe to stdout.
        await new Promise<void>((resolve, reject) => {
          createReadStream(logPath)
            .on("data", (chunk: Buffer | string) =>
              process.stdout.write(typeof chunk === "string" ? chunk : chunk),
            )
            .on("end", () => resolve())
            .on("error", reject);
        });
        return;
      }
      await followStream(logPath);
    });
}
