/**
 * bulk-mutate — partial-success-aware parallel mutation helper.
 *
 * Slice 24-00 T03 (TasksBulkToolbar). The slice intentionally does NOT add a
 * server-side `POST /api/tasks/bulk-cancel` endpoint — instead the UI fires
 * the per-item mutation N times in parallel so the existing per-item authz
 * path still gates each call. This helper is the small primitive that keeps
 * the toolbar code free of `Promise.allSettled` boilerplate.
 *
 * Contract
 * --------
 *   bulkMutate({ items, mutateFn, signal? })
 *     → Promise<{ ok: ID[]; failed: { id: ID; err: unknown }[] }>
 *
 *   - `items`     — ids the toolbar wants to mutate.
 *   - `mutateFn`  — async per-item mutation. May reject; the rejection is
 *                   captured into `failed[]` rather than bubbled.
 *   - `signal`    — optional `AbortSignal`. When the caller aborts BEFORE
 *                   `bulkMutate` is invoked, every item is reported as failed
 *                   with the abort reason and `mutateFn` is never called.
 *                   When the caller aborts mid-flight the in-flight mutations
 *                   continue (they already got the signal in their own
 *                   invocation context); we do NOT cancel them ourselves.
 *
 * Order
 * -----
 *   `ok[]` and `failed[]` preserve the input order of `items`. Callers that
 *   render result toasts depend on this for "Cancelled 3 of 5 (failed: id1,
 *   id3)" summaries that read in the same order the user selected.
 *
 * Empty input
 * -----------
 *   Returns `{ ok: [], failed: [] }` synchronously-resolved. Callers can
 *   short-circuit the toast in that case.
 */

export interface BulkMutateInput<ID> {
  items: ReadonlyArray<ID>;
  mutateFn: (id: ID, signal?: AbortSignal) => Promise<unknown>;
  signal?: AbortSignal;
}

export interface BulkMutateFailure<ID> {
  id: ID;
  err: unknown;
}

export interface BulkMutateResult<ID> {
  ok: ID[];
  failed: BulkMutateFailure<ID>[];
}

export async function bulkMutate<ID>({
  items,
  mutateFn,
  signal,
}: BulkMutateInput<ID>): Promise<BulkMutateResult<ID>> {
  if (items.length === 0) {
    return { ok: [], failed: [] };
  }

  // Pre-aborted: short-circuit and report every item as failed with the
  // abort reason. We do not call mutateFn at all — the toolbar can roll
  // back optimistic UI without firing N rejected mutations at the network.
  if (signal?.aborted) {
    return {
      ok: [],
      failed: items.map((id) => ({ id, err: signal.reason ?? abortError() })),
    };
  }

  const settled = await Promise.allSettled(
    items.map((id) => mutateFn(id, signal)),
  );

  const ok: ID[] = [];
  const failed: BulkMutateFailure<ID>[] = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i] as PromiseSettledResult<unknown>;
    const id = items[i] as ID;
    if (result.status === "fulfilled") {
      ok.push(id);
    } else {
      failed.push({ id, err: result.reason });
    }
  }

  return { ok, failed };
}

function abortError(): Error {
  // DOMException is available in jsdom + browsers; node has it from 17+.
  // Fall back to a plain Error so the helper is portable across runtimes
  // without the test harness needing a global polyfill.
  if (typeof DOMException !== "undefined") {
    return new DOMException("Aborted before bulkMutate ran", "AbortError");
  }
  const err = new Error("Aborted before bulkMutate ran");
  err.name = "AbortError";
  return err;
}
