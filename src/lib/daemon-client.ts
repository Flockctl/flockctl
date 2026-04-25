/**
 * Minimal HTTP client for talking to the local Flockctl daemon from the CLI.
 *
 * Design notes:
 *  - Reads the daemon host/port from environment variables
 *    (`FLOCKCTL_PORT`, `FLOCKCTL_HOST`) so the same helper works whether the
 *    daemon was started with the default `127.0.0.1:52077` or an override.
 *  - For loopback (127.0.0.1 / ::1 / localhost) the server does not require
 *    authentication, so we only attach a Bearer token when:
 *      a) the caller passes one via `opts.token`, or
 *      b) the `FLOCKCTL_TOKEN` env var is set, or
 *      c) the target host is non-loopback AND at least one token is configured
 *         in `~/.flockctlrc` — we pick the first one.
 *  - Errors from the daemon come back as `{ error, details?, requestId }`;
 *    `DaemonError` exposes `statusCode` and `details` so commands can render a
 *    helpful message without re-parsing JSON.
 */
import { getConfiguredTokens } from "../config/index.js";

export interface DaemonClientOptions {
  host?: string;
  port?: number;
  token?: string;
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Override the default 30 s timeout for slow endpoints (e.g. git clone). */
  timeoutMs?: number;
}

export class DaemonError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
    public requestId?: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function resolveBaseUrl(opts: DaemonClientOptions): { baseUrl: string; host: string } {
  const host =
    opts.host ??
    process.env.FLOCKCTL_HOST ??
    "127.0.0.1";
  const port =
    opts.port ??
    (process.env.FLOCKCTL_PORT ? parseInt(process.env.FLOCKCTL_PORT, 10) : 52077);
  return { baseUrl: `http://${host}:${port}`, host };
}

function resolveToken(host: string, explicit: string | undefined): string | null {
  if (explicit) return explicit;
  if (process.env.FLOCKCTL_TOKEN) return process.env.FLOCKCTL_TOKEN;
  // Loopback works without a token — don't send one unless caller asked for it.
  if (isLoopback(host)) return null;
  const tokens = getConfiguredTokens();
  return tokens[0]?.token ?? null;
}

export class DaemonClient {
  readonly baseUrl: string;
  readonly host: string;
  private readonly token: string | null;
  private readonly defaultTimeoutMs: number;

  constructor(opts: DaemonClientOptions = {}) {
    const { baseUrl, host } = resolveBaseUrl(opts);
    this.baseUrl = baseUrl;
    this.host = host;
    this.token = resolveToken(host, opts.token);
    this.defaultTimeoutMs = opts.timeoutMs ?? 30_000;
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(
      path.startsWith("/") ? path : `/${path}`,
      this.baseUrl,
    );
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(opts.headers ?? {}),
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? this.defaultTimeoutMs,
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      if ((err as { name?: string })?.name === "AbortError") {
        throw new DaemonError(0, `Request to ${url} timed out`);
      }
      throw new DaemonError(
        0,
        `Cannot reach Flockctl daemon at ${this.baseUrl}: ${msg}. ` +
          `Is it running? Start with: flockctl start`,
      );
    }
    clearTimeout(timeout);

    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const body =
        parsed && typeof parsed === "object"
          ? (parsed as { error?: string; details?: unknown; requestId?: string })
          : undefined;
      throw new DaemonError(
        res.status,
        body?.error ?? `HTTP ${res.status} ${res.statusText}`,
        body?.details,
        body?.requestId,
      );
    }

    return parsed as T;
  }

  get<T = unknown>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>(path, { method: "GET", query });
  }

  post<T = unknown>(path: string, body?: unknown, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>(path, { method: "POST", body, query });
  }

  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: "PATCH", body });
  }

  del<T = unknown>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }
}

/** Convenience factory used by CLI command actions. */
export function createDaemonClient(opts: DaemonClientOptions = {}): DaemonClient {
  return new DaemonClient(opts);
}

/**
 * Print a daemon error the way a CLI command should: the server message, the
 * validation-detail map (if any), and a reminder when the daemon is
 * unreachable. Exits the process with code 1.
 */
export function exitWithDaemonError(err: unknown): never {
  if (err instanceof DaemonError) {
    if (err.statusCode === 0) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(`Error (${err.statusCode}): ${err.message}`);
      if (err.details && typeof err.details === "object") {
        for (const [field, messages] of Object.entries(err.details)) {
          const list = Array.isArray(messages) ? messages.join(", ") : String(messages);
          console.error(`  ${field}: ${list}`);
        }
      }
    }
  } else {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}
