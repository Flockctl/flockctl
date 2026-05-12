import { describe, it, expect } from "vitest";
import {
  classifyLimit,
  nextEstimatedDelayMs,
  _internals,
} from "../../../services/agents/rate-limit-classifier.js";

const NOW = 1_700_000_000_000; // fixed clock so resumeAtMs is deterministic
const fixedNow = () => NOW;

describe("classifyLimit", () => {
  describe("returns null for non-limit errors", () => {
    it("plain Error", () => {
      expect(classifyLimit(new Error("boom"), { now: fixedNow })).toBeNull();
    });
    it("string error", () => {
      expect(classifyLimit("totally unrelated", { now: fixedNow })).toBeNull();
    });
    it("AbortError lookalike", () => {
      const e = Object.assign(new Error("aborted"), { name: "AbortError" });
      expect(classifyLimit(e, { now: fixedNow })).toBeNull();
    });
    it("network error with status 500", () => {
      const e = Object.assign(new Error("internal"), { status: 500 });
      expect(classifyLimit(e, { now: fixedNow })).toBeNull();
    });
    it("undefined", () => {
      expect(classifyLimit(undefined, { now: fixedNow })).toBeNull();
    });
  });

  describe("Anthropic 429 with retry-after-ms (preferred header)", () => {
    it("uses retry-after-ms exactly", () => {
      const headers = new Map<string, string>([["retry-after-ms", "12345"]]);
      const e = Object.assign(new Error("rate limited"), { status: 429, headers });
      const r = classifyLimit(e, { now: fixedNow });
      expect(r).not.toBeNull();
      expect(r!.kind).toBe("rate_limit");
      expect(r!.confidence).toBe("exact");
      expect(r!.resumeAtMs).toBe(NOW + 12345);
    });

    it("works with plain-object headers shape", () => {
      const headers = { "retry-after-ms": "9999" };
      const e = Object.assign(new Error("rate limited"), { status: 429, headers });
      const r = classifyLimit(e, { now: fixedNow });
      expect(r!.resumeAtMs).toBe(NOW + 9999);
    });

    it("works with native Headers via .get()", () => {
      const headers = new Headers({ "retry-after-ms": "5000" });
      const e = Object.assign(new Error("rate limited"), { status: 429, headers });
      const r = classifyLimit(e, { now: fixedNow });
      expect(r!.resumeAtMs).toBe(NOW + 5000);
    });
  });

  describe("Anthropic 429 with retry-after seconds", () => {
    it("multiplies by 1000", () => {
      const headers = new Map<string, string>([["retry-after", "30"]]);
      const e = Object.assign(new Error("rate limited"), { status: 429, headers });
      const r = classifyLimit(e, { now: fixedNow });
      expect(r!.confidence).toBe("exact");
      expect(r!.resumeAtMs).toBe(NOW + 30_000);
    });

    it("parses HTTP-date form", () => {
      const future = new Date(NOW + 60_000).toUTCString();
      const headers = new Map<string, string>([["retry-after", future]]);
      const e = Object.assign(new Error("rate limited"), { status: 429, headers });
      const r = classifyLimit(e, { now: fixedNow });
      // Date.parse on UTCString rounds to the second; allow a small tolerance.
      expect(Math.abs(r!.resumeAtMs - (NOW + 60_000))).toBeLessThan(1000);
    });

    it("clamps past HTTP-date to 0 delay", () => {
      const past = new Date(NOW - 60_000).toUTCString();
      const headers = new Map<string, string>([["retry-after", past]]);
      const e = Object.assign(new Error("rate limited"), { status: 429, headers });
      const r = classifyLimit(e, { now: fixedNow });
      expect(r!.resumeAtMs).toBe(NOW);
    });
  });

  describe("Anthropic 429 with no retry-after header", () => {
    it("falls back to a defensive small delay marked estimated", () => {
      const e = Object.assign(new Error("rate limited"), { status: 429, headers: {} });
      const r = classifyLimit(e, { now: fixedNow });
      expect(r!.confidence).toBe("estimated");
      expect(r!.resumeAtMs).toBe(NOW + _internals.DEFAULT_RATE_LIMIT_FALLBACK_MS);
    });
  });

  describe("Anthropic usage_limit / weekly cap (CLI text path)", () => {
    it("recognises 'Claude AI usage limit reached'", () => {
      const e = new Error("Claude AI usage limit reached");
      const r = classifyLimit(e, { now: fixedNow });
      expect(r).not.toBeNull();
      expect(r!.kind).toBe("usage_limit");
      expect(r!.confidence).toBe("estimated");
      expect(r!.provider).toBe("anthropic");
      expect(r!.resumeAtMs).toBe(NOW + _internals.MIN_ESTIMATED_DELAY_MS);
    });

    it("recognises billing_error type", () => {
      const e = Object.assign(new Error("plan exhausted"), { type: "billing_error" });
      const r = classifyLimit(e, { now: fixedNow });
      expect(r!.kind).toBe("usage_limit");
    });

    it("recognises 'weekly limit'", () => {
      const e = new Error("You have hit your weekly limit; try again later.");
      const r = classifyLimit(e, { now: fixedNow });
      expect(r!.kind).toBe("usage_limit");
    });

    it("recognises Claude Code CLI 'hit your limit · resets …' wording and parses the reset time", () => {
      // Verbatim shape produced by client.ts:432 wrapping the CLI's stderr
      // for a session-cap hit. NOW is 2023-11-14T22:13:20Z, Istanbul is
      // UTC+3 (no DST since 2016) so the operator's wall-clock is
      // 2023-11-15T01:13:20. 9:30pm Istanbul on 2023-11-15 is
      // 2023-11-15T18:30:00Z — i.e. NOW + 73,000,000 ms, plus the 30s
      // grace buffer the parser adds.
      const e = new Error(
        "AI stream error: Claude Code returned an error result: You've hit your limit · resets 9:30pm (Europe/Istanbul)",
      );
      const r = classifyLimit(e, { now: fixedNow });
      expect(r).not.toBeNull();
      expect(r!.kind).toBe("usage_limit");
      expect(r!.provider).toBe("anthropic");
      expect(r!.confidence).toBe("exact");
      expect(r!.resumeAtMs).toBe(NOW + 73_000_000 + _internals.RESET_TIME_GRACE_MS);
    });

    it("rolls reset time over to tomorrow when it has already passed today", () => {
      // NOW Istanbul wall-clock is 01:13:20 on 2023-11-15. A reset advertised
      // as "12:30am (Europe/Istanbul)" already happened at 00:30 today, so
      // the target must be 00:30 on 2023-11-16 = 2023-11-15T21:30:00Z.
      const e = new Error(
        "You've hit your limit · resets 12:30am (Europe/Istanbul)",
      );
      const r = classifyLimit(e, { now: fixedNow });
      expect(r!.confidence).toBe("exact");
      // From 22:13:20 UTC → 21:30:00 UTC the next day = 23h 16m 40s = 83,800,000 ms.
      expect(r!.resumeAtMs).toBe(NOW + 83_800_000 + _internals.RESET_TIME_GRACE_MS);
    });

    it("falls back to estimated when timezone is missing", () => {
      // No "(TZ)" suffix → wall-clock is ambiguous. Must NOT silently assume UTC.
      const e = new Error("You've hit your limit · resets 10:50pm");
      const r = classifyLimit(e, { now: fixedNow });
      expect(r!.confidence).toBe("estimated");
      expect(r!.resumeAtMs).toBe(NOW + _internals.MIN_ESTIMATED_DELAY_MS);
    });

    it("falls back to estimated when timezone is unknown to ICU", () => {
      const e = new Error(
        "You've hit your limit · resets 10:50pm (Mars/Olympus_Mons)",
      );
      const r = classifyLimit(e, { now: fixedNow });
      expect(r!.confidence).toBe("estimated");
      expect(r!.resumeAtMs).toBe(NOW + _internals.MIN_ESTIMATED_DELAY_MS);
    });

    it("accepts the bare-hour shape 'resets 10pm (TZ)' without minutes", () => {
      const e = new Error("You've hit your limit · resets 10pm (Europe/Istanbul)");
      const r = classifyLimit(e, { now: fixedNow });
      expect(r!.confidence).toBe("exact");
      // 10pm Istanbul on 2023-11-15 = 2023-11-15T19:00:00Z. From NOW
      // (2023-11-14T22:13:20Z) → 20h 46m 40s = 74,800,000 ms.
      expect(r!.resumeAtMs).toBe(NOW + 74_800_000 + _internals.RESET_TIME_GRACE_MS);
    });

    it("recognises nested .error.type === billing_error", () => {
      const e = Object.assign(new Error("nested"), {
        error: { type: "billing_error" },
      });
      const r = classifyLimit(e, { now: fixedNow });
      expect(r!.kind).toBe("usage_limit");
    });
  });

  describe("Anthropic rate_limit text path (no 429 status)", () => {
    it("recognises message-level 'rate limit' wording", () => {
      const e = new Error("AI stream error: rate_limit_error: too many requests");
      const r = classifyLimit(e, { now: fixedNow });
      expect(r!.kind).toBe("rate_limit");
      expect(r!.confidence).toBe("estimated");
    });
  });

  describe("Copilot quota errors", () => {
    it("recognises Copilot SDK error with quota wording", () => {
      const e = new Error("Copilot SDK error: premium request quota exhausted");
      const r = classifyLimit(e, { now: fixedNow });
      expect(r).not.toBeNull();
      expect(r!.kind).toBe("quota");
      expect(r!.provider).toBe("copilot");
    });

    it("does NOT classify a generic Copilot SDK error", () => {
      const e = new Error("Copilot SDK error: connection reset");
      const r = classifyLimit(e, { now: fixedNow });
      expect(r).toBeNull();
    });

    it("does NOT classify a non-Copilot quota message", () => {
      const e = new Error("some other quota issue");
      const r = classifyLimit(e, { now: fixedNow });
      expect(r).toBeNull();
    });
  });

  it("preserves the raw message verbatim", () => {
    const e = new Error("Claude AI usage limit reached — retry in 4 hours");
    const r = classifyLimit(e, { now: fixedNow });
    expect(r!.rawMessage).toBe("Claude AI usage limit reached — retry in 4 hours");
  });

  it("handles 429 in statusCode field too", () => {
    const e = Object.assign(new Error("rl"), {
      statusCode: 429,
      headers: { "retry-after": "5" },
    });
    const r = classifyLimit(e, { now: fixedNow });
    expect(r!.resumeAtMs).toBe(NOW + 5000);
  });
});

describe("nextEstimatedDelayMs", () => {
  it("first attempt is 15 min", () => {
    expect(nextEstimatedDelayMs(0)).toBe(15 * 60 * 1000);
  });

  it("second attempt is 30 min", () => {
    expect(nextEstimatedDelayMs(1)).toBe(30 * 60 * 1000);
  });

  it("third+ attempts hold at 60 min cap", () => {
    expect(nextEstimatedDelayMs(2)).toBe(60 * 60 * 1000);
    expect(nextEstimatedDelayMs(5)).toBe(60 * 60 * 1000);
    expect(nextEstimatedDelayMs(100)).toBe(60 * 60 * 1000);
  });

  it("never exceeds the documented cap", () => {
    for (let i = 0; i < 10; i++) {
      expect(nextEstimatedDelayMs(i)).toBeLessThanOrEqual(_internals.MAX_ESTIMATED_DELAY_MS);
    }
  });
});
