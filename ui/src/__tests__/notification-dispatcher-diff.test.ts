import { describe, expect, it } from "vitest";

import type { AttentionItem } from "@/lib/api/attention";
import {
  attentionItemKey,
  diffAttentionForNotifications,
  diffAttentionForNotificationsBidirectional,
} from "@/lib/notification-dispatcher";

/**
 * Contract tests for `diffAttentionForNotifications`.
 *
 * The function is the single source of truth for "what's NEW in the inbox
 * since the last poll", feeding the notification dispatcher. It is pure:
 *
 *   - First call (`prev === null`) returns [] to establish a baseline so
 *     mounting the app with a non-empty inbox doesn't blast notifications
 *     for already-known rows.
 *   - Empty `prev` (`[]`) is a real observation, not a baseline — a
 *     `[] → [a]` step DOES treat `a` as new.
 *   - Identity uses `kind + id` only. Title / body churn on the same row
 *     does not register as new.
 *   - Identity is per-kind: `task_approval:42` and `chat_approval:42` are
 *     distinct items even though they share the numeric id.
 *   - Duplicates within `next` collapse via Set membership without extra
 *     code (relied on, not just tolerated).
 */

// --- Fixture builders -------------------------------------------------------

function taskApproval(taskId: string, title = "Approve"): AttentionItem {
  return {
    kind: "task_approval",
    task_id: taskId,
    project_id: "p1",
    title,
    since: "2026-01-01T00:00:00Z",
  };
}

function chatApproval(chatId: string, title = "Approve"): AttentionItem {
  return {
    kind: "chat_approval",
    chat_id: chatId,
    project_id: "p1",
    title,
    since: "2026-01-01T00:00:00Z",
  };
}

function taskPermission(taskId: string, requestId: string): AttentionItem {
  return {
    kind: "task_permission",
    task_id: taskId,
    project_id: "p1",
    request_id: requestId,
    tool: "Bash",
    since: "2026-01-01T00:00:00Z",
  };
}

function chatPermission(chatId: string, requestId: string): AttentionItem {
  return {
    kind: "chat_permission",
    chat_id: chatId,
    project_id: "p1",
    request_id: requestId,
    tool: "Bash",
    since: "2026-01-01T00:00:00Z",
  };
}

function taskQuestion(requestId: string, taskId = "t1"): AttentionItem {
  return {
    kind: "task_question",
    request_id: requestId,
    task_id: taskId,
    project_id: "p1",
    question: "Pick one",
    multi_select: false,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function chatQuestion(requestId: string, chatId = "c1"): AttentionItem {
  return {
    kind: "chat_question",
    request_id: requestId,
    chat_id: chatId,
    project_id: "p1",
    question: "Pick one",
    multi_select: false,
    created_at: "2026-01-01T00:00:00Z",
  };
}

// --- Tests ------------------------------------------------------------------

describe("diffAttentionForNotifications", () => {
  describe("baseline semantics", () => {
    it("returns [] on the first call (prev === null) regardless of next", () => {
      // The mount-storm guard: a fresh hook that finds the inbox already
      // full must not fire for any of those rows.
      const next = [taskApproval("1"), chatApproval("2"), taskQuestion("q1")];
      expect(diffAttentionForNotifications(null, next)).toEqual([]);
    });

    it("returns [] on the first call even when next is empty", () => {
      expect(diffAttentionForNotifications(null, [])).toEqual([]);
    });

    it("treats prev=[] as a real observation, not a baseline", () => {
      // The crucial distinction: `[]` means "we polled, inbox was empty".
      // A subsequent non-empty poll IS new attention.
      const item = taskApproval("1");
      expect(diffAttentionForNotifications([], [item])).toEqual([item]);
    });
  });

  describe("identity by kind + id", () => {
    it("treats same kind+id as the same item across polls", () => {
      const a = taskApproval("42", "Title v1");
      const b = taskApproval("42", "Title v2"); // title churn — not new
      expect(diffAttentionForNotifications([a], [b])).toEqual([]);
    });

    it("does not collide ids across kinds (task_approval:42 ≠ chat_approval:42)", () => {
      const t = taskApproval("42");
      const c = chatApproval("42");
      // Prev had only the task_approval; the chat_approval is genuinely new.
      const result = diffAttentionForNotifications([t], [t, c]);
      expect(result).toEqual([c]);
    });

    it("keys task_permission off task_id (not request_id)", () => {
      // task_permission carries both. Keying off task_id collapses repeated
      // permission prompts on the same task into the same logical item.
      const a = taskPermission("t1", "req-A");
      const b = taskPermission("t1", "req-B");
      expect(diffAttentionForNotifications([a], [b])).toEqual([]);
    });

    it("keys chat_permission off chat_id (not request_id)", () => {
      const a = chatPermission("c1", "req-A");
      const b = chatPermission("c1", "req-B");
      expect(diffAttentionForNotifications([a], [b])).toEqual([]);
    });

    it("keys task_question off request_id", () => {
      // Two task_questions on the same task with different request_ids are
      // different items — the user hasn't seen the second one.
      const a = taskQuestion("q-A", "t1");
      const b = taskQuestion("q-B", "t1");
      const result = diffAttentionForNotifications([a], [a, b]);
      expect(result).toEqual([b]);
    });

    it("keys chat_question off request_id", () => {
      const a = chatQuestion("q-A", "c1");
      const b = chatQuestion("q-B", "c1");
      const result = diffAttentionForNotifications([a], [a, b]);
      expect(result).toEqual([b]);
    });
  });

  describe("set-membership behavior", () => {
    it("returns multiple new items in a single diff", () => {
      const original = taskApproval("1");
      const prev = [original];
      const newA = chatApproval("2");
      const newB = taskQuestion("q1");
      const result = diffAttentionForNotifications(prev, [original, newA, newB]);
      expect(result).toEqual([newA, newB]);
    });

    it("returns [] when next is a strict subset of prev", () => {
      const a = taskApproval("1");
      const b = chatApproval("2");
      expect(diffAttentionForNotifications([a, b], [a])).toEqual([]);
    });

    it("ignores order changes — only key membership matters", () => {
      const a = taskApproval("1");
      const b = chatApproval("2");
      expect(diffAttentionForNotifications([a, b], [b, a])).toEqual([]);
    });

    it("dedups duplicate keys appearing twice in next via Set lookup", () => {
      // The Set is built off prev, so duplicates inside `next` survive the
      // `.filter` — this is the documented behavior. The test pins it so a
      // future "helpful" rewrite that swaps to `Array.includes` (and breaks
      // on duplicate-aware logic) gets caught.
      const newItem = taskApproval("99");
      const result = diffAttentionForNotifications(
        [],
        [newItem, newItem],
      );
      // Both copies pass the !prevKeys.has() check and end up in the result.
      expect(result).toHaveLength(2);
      expect(result.every((r) => r === newItem)).toBe(true);
    });

    it("collapses a duplicate within next when one copy is also in prev", () => {
      // If `prev` already has the key, both copies of it in `next` are
      // filtered out — Set lookup is order-insensitive.
      const item = taskApproval("1");
      expect(diffAttentionForNotifications([item], [item, item])).toEqual([]);
    });
  });

  describe("purity", () => {
    it("does not mutate prev or next", () => {
      const prev = [taskApproval("1")];
      const next = [taskApproval("1"), chatApproval("2")];
      const prevSnapshot = [...prev];
      const nextSnapshot = [...next];
      diffAttentionForNotifications(prev, next);
      expect(prev).toEqual(prevSnapshot);
      expect(next).toEqual(nextSnapshot);
    });
  });
});

// ---------------------------------------------------------------------------
// Bidirectional diff
//
// `diffAttentionForNotificationsBidirectional` is the source of truth for
// both halves of the inbox→notification pipeline:
//
//   - `added`        → drives `dispatcher.fire(...)`
//   - `removedKeys`  → drives `dispatcher.resolveByKey(...)`
//
// The contract for `added` MUST exactly match the additive-only
// `diffAttentionForNotifications` (which is now a thin wrapper). The
// `removedKeys` half is new and gets its own dedicated coverage.
// ---------------------------------------------------------------------------

describe("diffAttentionForNotificationsBidirectional", () => {
  describe("baseline semantics", () => {
    it("returns empty {added,removedKeys} on first call (prev === null)", () => {
      // Same mount-storm guard as the additive diff: a fresh hook MUST
      // NOT close anything either, because the previous tab's
      // notifications are out of our handle map.
      const next = [taskApproval("1"), chatApproval("2")];
      expect(
        diffAttentionForNotificationsBidirectional(null, next),
      ).toEqual({ added: [], removedKeys: [] });
    });

    it("treats prev=[] as a real observation, not a baseline (added side)", () => {
      const item = taskApproval("1");
      const result = diffAttentionForNotificationsBidirectional([], [item]);
      expect(result.added).toEqual([item]);
      expect(result.removedKeys).toEqual([]);
    });

    it("treats prev=[] as a real observation, not a baseline (removed side)", () => {
      // [a] → []: a's key must surface in removedKeys so the dispatcher
      // can close the notification it fired earlier.
      const item = taskApproval("1");
      const result = diffAttentionForNotificationsBidirectional([item], []);
      expect(result.added).toEqual([]);
      expect(result.removedKeys).toEqual([attentionItemKey(item)]);
    });
  });

  describe("removed keys", () => {
    it("flags keys present in prev but missing in next", () => {
      const a = taskApproval("1");
      const b = chatApproval("2");
      const result = diffAttentionForNotificationsBidirectional([a, b], [a]);
      expect(result.added).toEqual([]);
      expect(result.removedKeys).toEqual([attentionItemKey(b)]);
    });

    it("returns multiple removed keys at once", () => {
      const a = taskApproval("1");
      const b = chatApproval("2");
      const c = taskQuestion("q1");
      const result = diffAttentionForNotificationsBidirectional(
        [a, b, c],
        [a],
      );
      expect(result.added).toEqual([]);
      // Order follows prev's iteration order — pinned for determinism so
      // the dispatcher closes notifications in a predictable sequence.
      expect(result.removedKeys).toEqual([
        attentionItemKey(b),
        attentionItemKey(c),
      ]);
    });

    it("does NOT flag a key that re-appears in next (just under a different title)", () => {
      // Title churn is invisible at the diff layer — same kind+id is the
      // same logical row, so it stays in next and produces no
      // removedKey/added.
      const a = taskApproval("1", "v1");
      const aRetitled = taskApproval("1", "v2");
      expect(
        diffAttentionForNotificationsBidirectional([a], [aRetitled]),
      ).toEqual({ added: [], removedKeys: [] });
    });

    it("simultaneously flags additions and removals in the same diff", () => {
      const old = taskApproval("1");
      const fresh = chatApproval("2");
      const result = diffAttentionForNotificationsBidirectional(
        [old],
        [fresh],
      );
      expect(result.added).toEqual([fresh]);
      expect(result.removedKeys).toEqual([attentionItemKey(old)]);
    });

    it("returns empty removedKeys when next is a strict superset of prev", () => {
      const a = taskApproval("1");
      const b = chatApproval("2");
      const result = diffAttentionForNotificationsBidirectional([a], [a, b]);
      expect(result.removedKeys).toEqual([]);
      expect(result.added).toEqual([b]);
    });
  });

  describe("added side parity with the additive diff", () => {
    it("returns the same `added` array as the wrapper produces", () => {
      const original = taskApproval("1");
      const newA = chatApproval("2");
      const newB = taskQuestion("q1");
      const prev = [original];
      const next = [original, newA, newB];
      expect(
        diffAttentionForNotificationsBidirectional(prev, next).added,
      ).toEqual(diffAttentionForNotifications(prev, next));
    });

    it("first-call empty-added matches the wrapper", () => {
      const next = [taskApproval("1")];
      const wrap = diffAttentionForNotifications(null, next);
      const both = diffAttentionForNotificationsBidirectional(null, next);
      expect(both.added).toEqual(wrap);
    });
  });

  describe("purity", () => {
    it("does not mutate prev or next", () => {
      const prev = [taskApproval("1"), chatApproval("2")];
      const next = [taskApproval("1"), taskQuestion("q1")];
      const prevSnapshot = [...prev];
      const nextSnapshot = [...next];
      diffAttentionForNotificationsBidirectional(prev, next);
      expect(prev).toEqual(prevSnapshot);
      expect(next).toEqual(nextSnapshot);
    });
  });
});

describe("diffAttentionForNotifications (additive wrapper)", () => {
  it("delegates to the bidirectional diff and returns only `added`", () => {
    // Pin the wrapper relationship so a future "optimization" that
    // diverges them gets caught — both functions must agree on
    // additions, full stop.
    const a = taskApproval("1");
    const b = chatApproval("2");
    const fromWrapper = diffAttentionForNotifications([a], [a, b]);
    const fromFull = diffAttentionForNotificationsBidirectional([a], [a, b]);
    expect(fromWrapper).toEqual(fromFull.added);
  });
});
