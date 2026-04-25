import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DaemonClient,
  DaemonError,
  createDaemonClient,
  exitWithDaemonError,
} from "../../lib/daemon-client.js";

type FetchArgs = [URL | string, RequestInit | undefined];

interface StubResponse {
  status?: number;
  ok?: boolean;
  statusText?: string;
  body?: unknown; // if string, returned as-is; if object, stringified; if undefined, ""
}

/**
 * Minimal fetch stub that captures each call and returns a programmed
 * response. Each entry in `queue` is consumed in order; if the queue is
 * empty the test fails on purpose.
 */
function installFetchStub(queue: StubResponse[], calls: FetchArgs[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init?: RequestInit): Promise<Response> => {
      calls.push([url, init]);
      const next = queue.shift();
      if (!next) throw new Error(`fetch stub: no queued response for ${url}`);
      const body =
        next.body === undefined
          ? ""
          : typeof next.body === "string"
            ? next.body
            : JSON.stringify(next.body);
      return {
        ok: next.ok ?? ((next.status ?? 200) < 400),
        status: next.status ?? 200,
        statusText: next.statusText ?? "OK",
        async text() {
          return body;
        },
      } as unknown as Response;
    }),
  );
}

describe("DaemonClient", () => {
  beforeEach(() => {
    delete process.env.FLOCKCTL_PORT;
    delete process.env.FLOCKCTL_HOST;
    delete process.env.FLOCKCTL_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("defaults to http://127.0.0.1:52077", () => {
    const client = new DaemonClient();
    expect(client.baseUrl).toBe("http://127.0.0.1:52077");
    expect(client.host).toBe("127.0.0.1");
  });

  it("respects FLOCKCTL_PORT and FLOCKCTL_HOST env vars", () => {
    process.env.FLOCKCTL_PORT = "8080";
    process.env.FLOCKCTL_HOST = "192.168.1.10";
    const client = new DaemonClient();
    expect(client.baseUrl).toBe("http://192.168.1.10:8080");
  });

  it("constructor opts override env vars", () => {
    process.env.FLOCKCTL_PORT = "8080";
    const client = new DaemonClient({ port: 9999 });
    expect(client.baseUrl).toBe("http://127.0.0.1:9999");
  });

  it("GET request sends method + Accept header, no Authorization on loopback", async () => {
    const calls: FetchArgs[] = [];
    installFetchStub([{ status: 200, body: { ok: true } }], calls);
    const client = new DaemonClient();
    const out = await client.get<{ ok: boolean }>("/projects");
    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const [, init] = calls[0];
    expect(init?.method).toBe("GET");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/json");
    expect(headers.Authorization).toBeUndefined();
  });

  it("POST sends JSON body and Content-Type header", async () => {
    const calls: FetchArgs[] = [];
    installFetchStub([{ status: 201, body: { id: 1 } }], calls);
    const client = new DaemonClient();
    const out = await client.post<{ id: number }>("/projects", { name: "x" });
    expect(out).toEqual({ id: 1 });
    const [, init] = calls[0];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ name: "x" }));
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("attaches Bearer token from FLOCKCTL_TOKEN env even on loopback", async () => {
    process.env.FLOCKCTL_TOKEN = "secret-token";
    const calls: FetchArgs[] = [];
    installFetchStub([{ status: 200, body: {} }], calls);
    const client = new DaemonClient();
    await client.get("/projects");
    const [, init] = calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-token");
  });

  it("encodes query params on the URL", async () => {
    const calls: FetchArgs[] = [];
    installFetchStub([{ status: 200, body: { items: [] } }], calls);
    const client = new DaemonClient();
    await client.get("/projects", { perPage: 500, page: 2 });
    const [url] = calls[0];
    const s = url.toString();
    expect(s).toContain("perPage=500");
    expect(s).toContain("page=2");
  });

  it("query-param via POST helper goes on URL, not body", async () => {
    const calls: FetchArgs[] = [];
    installFetchStub([{ status: 200, body: {} }], calls);
    const client = new DaemonClient();
    await client.post("/workspaces/1/projects", undefined, { project_id: 42 });
    const [url, init] = calls[0];
    expect(url.toString()).toContain("project_id=42");
    expect(init?.body).toBeUndefined();
  });

  it("throws DaemonError with statusCode + details from error body", async () => {
    installFetchStub(
      [
        {
          ok: false,
          status: 422,
          statusText: "Unprocessable Entity",
          body: {
            error: "name is required",
            details: { name: ["required"] },
            requestId: "abc123",
          },
        },
      ],
      [],
    );
    const client = new DaemonClient();
    await expect(client.post("/projects", {})).rejects.toMatchObject({
      name: "DaemonError",
      statusCode: 422,
      message: "name is required",
      details: { name: ["required"] },
      requestId: "abc123",
    });
  });

  it("throws DaemonError with statusCode=0 when fetch fails (daemon unreachable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const client = new DaemonClient();
    await expect(client.get("/health")).rejects.toMatchObject({
      statusCode: 0,
      message: expect.stringContaining("Cannot reach Flockctl daemon"),
    });
  });

  it("DaemonError surfaces fields for formatters", () => {
    const err = new DaemonError(404, "Project #1 not found", undefined, "req-1");
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe("Project #1 not found");
    expect(err.requestId).toBe("req-1");
  });

  it("patch() sends PATCH with JSON body", async () => {
    const calls: FetchArgs[] = [];
    installFetchStub([{ status: 200, body: { ok: true } }], calls);
    const client = new DaemonClient();
    await client.patch("/projects/1", { name: "y" });
    const [, init] = calls[0];
    expect(init?.method).toBe("PATCH");
    expect(init?.body).toBe(JSON.stringify({ name: "y" }));
  });

  it("del() sends DELETE with no body", async () => {
    const calls: FetchArgs[] = [];
    installFetchStub([{ status: 200, body: { deleted: true } }], calls);
    const client = new DaemonClient();
    await client.del("/projects/1");
    const [, init] = calls[0];
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
  });

  it("returns parsed text when body is not valid JSON", async () => {
    installFetchStub([{ status: 200, body: "hello world" }], []);
    const client = new DaemonClient();
    const out = await client.get<string>("/plain");
    expect(out).toBe("hello world");
  });

  it("returns null for empty response bodies", async () => {
    installFetchStub([{ status: 204, body: undefined }], []);
    const client = new DaemonClient();
    const out = await client.get("/no-content");
    expect(out).toBeNull();
  });

  it("throws a timeout DaemonError when fetch aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err: Error & { name: string } = Object.assign(
          new Error("aborted"),
          { name: "AbortError" },
        );
        throw err;
      }),
    );
    const client = new DaemonClient();
    await expect(client.get("/slow")).rejects.toMatchObject({
      statusCode: 0,
      message: expect.stringContaining("timed out"),
    });
  });

  it("falls back to HTTP status text when error body is non-JSON", async () => {
    installFetchStub(
      [
        {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          body: "crash",
        },
      ],
      [],
    );
    const client = new DaemonClient();
    await expect(client.get("/boom")).rejects.toMatchObject({
      statusCode: 500,
      message: "HTTP 500 Internal Server Error",
    });
  });

  it("createDaemonClient factory returns a DaemonClient", () => {
    const client = createDaemonClient({ port: 1234 });
    expect(client).toBeInstanceOf(DaemonClient);
    expect(client.baseUrl).toBe("http://127.0.0.1:1234");
  });

  it("explicit token via constructor overrides env and loopback default", async () => {
    // Exercises resolveToken's first `if (explicit) return explicit` branch.
    const calls: FetchArgs[] = [];
    installFetchStub([{ status: 200, body: {} }], calls);
    const client = new DaemonClient({ token: "caller-supplied" });
    await client.get("/projects");
    const [, init] = calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer caller-supplied");
  });

  it("prefixes the path with '/' when the caller omits the leading slash", async () => {
    // Covers the `path.startsWith('/') ? path : \`/${path}\`` branch.
    const calls: FetchArgs[] = [];
    installFetchStub([{ status: 200, body: {} }], calls);
    const client = new DaemonClient();
    await client.request("projects/42");
    expect(calls[0][0].toString()).toBe("http://127.0.0.1:52077/projects/42");
  });

  it("skips undefined query params instead of serializing 'undefined'", async () => {
    // Exercises the `if (v === undefined) continue` branch in query serializer.
    const calls: FetchArgs[] = [];
    installFetchStub([{ status: 200, body: {} }], calls);
    const client = new DaemonClient();
    await client.get("/projects", { keep: "yes", drop: undefined });
    const url = calls[0][0].toString();
    expect(url).toContain("keep=yes");
    expect(url).not.toContain("drop=");
  });

  it("defaults to GET when request() is called with no method", async () => {
    // request() without opts.method → `opts.method ?? "GET"`.
    const calls: FetchArgs[] = [];
    installFetchStub([{ status: 200, body: {} }], calls);
    const client = new DaemonClient();
    await client.request("/x");
    expect(calls[0][1]?.method).toBe("GET");
  });

  it("stringifies non-Error throwables from fetch into the DaemonError message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "plain-string-failure";
      }),
    );
    const client = new DaemonClient();
    await expect(client.get("/boom")).rejects.toMatchObject({
      statusCode: 0,
      message: expect.stringContaining("plain-string-failure"),
    });
  });
});

describe("exitWithDaemonError", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("prints status-code + message + details and exits 1 on DaemonError", () => {
    const err = new DaemonError(422, "name is required", { name: ["required"] });
    exitWithDaemonError(err);
    expect(errSpy).toHaveBeenCalledWith("Error (422): name is required");
    expect(errSpy).toHaveBeenCalledWith("  name: required");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prints the bare message for connectivity errors (statusCode=0)", () => {
    const err = new DaemonError(0, "Cannot reach Flockctl daemon at ...");
    exitWithDaemonError(err);
    expect(errSpy).toHaveBeenCalledWith(
      "Error: Cannot reach Flockctl daemon at ...",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("falls back to generic formatter for non-DaemonError errors", () => {
    exitWithDaemonError(new Error("boom"));
    expect(errSpy).toHaveBeenCalledWith("Error: boom");
  });

  it("stringifies non-Error throwables", () => {
    exitWithDaemonError("oops");
    expect(errSpy).toHaveBeenCalledWith("Error: oops");
  });

  it("handles scalar details by stringifying them", () => {
    const err = new DaemonError(400, "bad", { count: 2 });
    exitWithDaemonError(err);
    expect(errSpy).toHaveBeenCalledWith("  count: 2");
  });

  it("skips the details loop when DaemonError.details is undefined", () => {
    // Exercises the `if (err.details && typeof err.details === 'object')`
    // branch when details is plain undefined — prints only the top-line msg.
    const err = new DaemonError(500, "kaboom");
    exitWithDaemonError(err);
    expect(errSpy).toHaveBeenCalledWith("Error (500): kaboom");
    // No "  field: ..." style detail line should appear.
    const detailLineLogged = errSpy.mock.calls.some(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).startsWith("  "),
    );
    expect(detailLineLogged).toBe(false);
  });
});
