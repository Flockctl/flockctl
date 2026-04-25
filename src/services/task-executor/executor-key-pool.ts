import { selectKeyForTask, type KeySelection } from "../ai/key-selection.js";
import type { tasks } from "../../db/schema.js";

/**
 * Per-key concurrency bookkeeping for TaskExecutor. Each AI Provider Key has
 * an independent slot budget (`maxConcurrentPerKey`); when saturated, the
 * executor enqueues the task rather than starting a session that would race
 * for shared rate-limit quota.
 */
export class KeyPool {
  private maxConcurrentPerKey = 5;
  private keySlotUsage = new Map<number, number>();
  private reservedKeyByTask = new Map<number, number>();

  setMax(n: number): void {
    this.maxConcurrentPerKey = n;
  }

  reserve(taskId: number, keyId: number): void {
    const used = this.keySlotUsage.get(keyId) ?? 0;
    this.keySlotUsage.set(keyId, used + 1);
    this.reservedKeyByTask.set(taskId, keyId);
  }

  release(taskId: number): void {
    const keyId = this.reservedKeyByTask.get(taskId);
    if (keyId === undefined) return;

    this.reservedKeyByTask.delete(taskId);
    const used = this.keySlotUsage.get(keyId) ?? 0;
    if (used <= 1) {
      this.keySlotUsage.delete(keyId);
    } else {
      this.keySlotUsage.set(keyId, used - 1);
    }
  }

  async reserveForTask(
    taskId: number,
    task: typeof tasks.$inferSelect,
    opts: { excludeKeyIds?: number[] } = {},
  ): Promise<{ key: KeySelection | null; enqueue: boolean }> {
    const saturatedKeyIds: number[] = [...(opts.excludeKeyIds ?? [])];
    while (true) {
      let selectedKey: KeySelection | null;
      try {
        selectedKey = await selectKeyForTask(task, { excludeKeyIds: saturatedKeyIds });
      } catch (err) {
        // At least one candidate key exists but all are saturated right now.
        if (saturatedKeyIds.length > 0) return { key: null, enqueue: true };
        throw err;
      }

      // selectKeyForTask may resolve to null (e.g. mocked in tests, or a
      // future implementation that permits key-less runs). Proceed without
      // a reserved key — the task will just not be metered against any
      // provider key.
      if (!selectedKey) return { key: null, enqueue: false };

      const used = this.keySlotUsage.get(selectedKey.id) ?? 0;
      if (used >= this.maxConcurrentPerKey) {
        saturatedKeyIds.push(selectedKey.id);
        continue;
      }

      this.reserve(taskId, selectedKey.id);
      return { key: selectedKey, enqueue: false };
    }
  }
}
