/**
 * `flockctl open` — open the daemon's web UI in the default browser.
 *
 * macOS:    `open <url>`
 * Linux:    `xdg-open <url>`
 *
 * No support for Windows here — see CLAUDE.md, rule 6 ("Windows is not
 * supported"). If `xdg-open` isn't installed on Linux, we fall back to
 * just printing the URL so the operator can copy-paste.
 *
 * The URL is derived from FLOCKCTL_HOST / FLOCKCTL_PORT, mirroring
 * `DaemonClient`. Pass `--url <path>` to open a specific deep link
 * (e.g. `--url /tasks`).
 */
import type { Command } from "commander";
import { spawn } from "child_process";

function pickOpener(): string | null {
  if (process.platform === "darwin") return "open";
  if (process.platform === "linux") return "xdg-open";
  return null;
}

function buildUrl(opts: { host?: string; port?: string; url?: string }): string {
  const host = opts.host ?? process.env.FLOCKCTL_HOST ?? "127.0.0.1";
  const port = opts.port ?? process.env.FLOCKCTL_PORT ?? "52077";
  const path = opts.url ?? "/";
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `http://${host}:${port}${cleanPath}`;
}

export function registerOpenCommand(program: Command): void {
  program
    .command("open")
    .description(
      "Open the Flockctl UI in the default browser. " +
        "Pass --url /tasks to deep-link a specific page.",
    )
    .option("-H, --host <host>", "Override host (default: 127.0.0.1 / FLOCKCTL_HOST)")
    .option("-p, --port <port>", "Override port (default: 52077 / FLOCKCTL_PORT)")
    .option("-u, --url <path>", "Path component to append (e.g. /tasks)")
    .option("--print", "Print the URL instead of opening it", false)
    .action((opts: { host?: string; port?: string; url?: string; print?: boolean }) => {
      const url = buildUrl(opts);
      if (opts.print) {
        console.log(url);
        return;
      }
      const opener = pickOpener();
      if (!opener) {
        console.log(`Open this URL in your browser: ${url}`);
        return;
      }
      try {
        const child = spawn(opener, [url], { stdio: "ignore", detached: true });
        child.on("error", () => {
          // The opener exists check happens lazily through spawn — if it
          // fails (e.g. xdg-open missing on a minimal Linux box), fall
          // back to printing the URL.
          console.log(`Open this URL in your browser: ${url}`);
        });
        child.unref();
      } catch {
        console.log(`Open this URL in your browser: ${url}`);
      }
    });
}
