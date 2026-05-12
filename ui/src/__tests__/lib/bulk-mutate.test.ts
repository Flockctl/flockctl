import { describe, it, expect, vi } from "vitest";

import { bulkMutate } from "@/lib/bulk-mutate";

/**
 * Contract tests for {@link bulkMutate} (slice 24-00 T03).
 *
 * The helper is the partial-success substrate under TasksBulkToolbar.
 * Each test pins exactly one promise:
 *
 *   - Empty input short-circuits with `{ ok: [], failed: [] }`.
 *   - All-success populates `ok[]` only, in input order.
 *   - All-failure populates `failed[]` only, in input order, preserving err.
 *   - Mixed (some-fulfilled, some-rejected) returns BOTH arrays — the
 *     "partial success" use case the toolbar amber toast keys off of.
 *   - Pre-aborted signal short-circuits without invoking mutateFn.
 *   - mutateFn receives the AbortSignal so per-item mutations can opt in.
 */

describe("bulkMutate / empty input", () => {
  it("returns empty ok/failed arrays without calling mutateFn", async () => {
    const mutateFn = vi.fn();
    const result = await bulkMutate({ items: [], mutateFn });
    expect(result).toEqual({ ok: [], failed: [] });
    expect(mutateFn).not.toHaveBeenCalled();
  });
});

describe("bulkMutate / all success", () => {
  it("populates ok[] in input order, leaves failed[] empty", async () => {
    const items = ["t-1", "t-2", "t-3"];
    const mutateFn = vi.fn().mockResolvedValue("done");

    const result = await bulkMutate({ items, mutateFn });

    expect(result.ok).toEqual(["t-1", "t-2", "t-3"]);
    expect(result.failed).toEqual([]);
    expect(mutateFn).toHaveBeenCalledTimes(3);
    expect(mutateFn).toHaveBeenNthCalledWith(1, "t-1", undefined);
    expect(mutateFn).toHaveBeenNthCalledWith(2, "t-2", undefined);
    expect(mutateFn).toHaveBeenNthCalledWith(3, "t-3", undefined);
  });
});

describe("bulkMutate / all failure", () => {
  it("populates failed[] in input order with each rejection captured", async () => {
    const items = ["t-1", "t-2"];
    const errA = new Error("forbidden");
    const errB = new Error("not found");
    const mutateFn = vi
      .fn<(id: string) => Promise<unknown>>()
      .mockRejectedValueOnce(errA)
      .mockRejectedValueOnce(errB);

    const result = await bulkMutate({ items, mutateFn });

    expect(result.ok).toEqual([]);
    expect(result.failed).toEqual([
      { id: "t-1", err: errA },
      { id: "t-2", err: errB },
    ]);
  });
});

describe("bulkMutate / partial success", () => {
  it("returns both ok and failed arrays preserving input order", async () => {
    const items = ["t-1", "t-2", "t-3", "t-4"];
    const err = new Error("permission denied");
    const mutateFn = vi
      .fn<(id: string) => Promise<unknown>>()
      .mockImplementation(async (id: string) => {
        if (id === "t-2" || id === "t-4") throw err;
        return "ok";
      });

    const result = await bulkMutate({ items, mutateFn });

    expect(result.ok).toEqual(["t-1", "t-3"]);
    expect(result.failed).toEqual([
      { id: "t-2", err },
      { id: "t-4", err },
    ]);
  });
});

describe("bulkMutate / abort signal", () => {
  it("short-circuits when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort(new Error("user cancelled"));

    const mutateFn = vi.fn();
    const result = await bulkMutate({
      items: ["t-1", "t-2"],
      mutateFn,
      signal: ac.signal,
    });

    expect(mutateFn).not.toHaveBeenCalled();
    expect(result.ok).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.id).toBe("t-1");
    expect(result.failed[1]?.id).toBe("t-2");
  });

  it("forwards the signal to mutateFn for in-flight cancellation opt-in", async () => {
    const ac = new AbortController();
    const mutateFn = vi.fn().mockResolvedValue("ok");

    await bulkMutate({
      items: ["t-1"],
      mutateFn,
      signal: ac.signal,
    });

    expect(mutateFn).toHaveBeenCalledTimes(1);
    expect(mutateFn).toHaveBeenCalledWith("t-1", ac.signal);
  });
});
