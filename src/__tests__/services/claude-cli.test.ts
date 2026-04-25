import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process to avoid actually calling claude binary
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

import { execFileSync, execSync } from "node:child_process";
import {
  isClaudeBinaryPresent,
  isClaudeCodeAuthed,
  isClaudeCodeReady,
  clearReadinessCache,
  CLAUDE_CODE_MODELS,
} from "../../services/claude/cli.js";

const mockExecFileSync = execFileSync as any;
const mockExecSync = execSync as any;

describe("claude-cli readiness", () => {
  beforeEach(() => {
    clearReadinessCache();
    mockExecFileSync.mockReset();
    mockExecSync.mockReset();
  });

  it("isClaudeBinaryPresent returns true when claude --version succeeds", () => {
    mockExecFileSync.mockReturnValue(Buffer.from("claude 1.0.0"));
    expect(isClaudeBinaryPresent()).toBe(true);
  });

  it("isClaudeBinaryPresent returns false when claude not found", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(isClaudeBinaryPresent()).toBe(false);
  });

  it("isClaudeCodeAuthed returns true when auth status is OK", () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from("claude 1.0.0"))  // version check
      .mockReturnValueOnce(Buffer.from("Logged in as user@example.com")); // auth check
    expect(isClaudeCodeAuthed()).toBe(true);
  });

  it("isClaudeCodeAuthed returns false when not logged in", () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from("claude 1.0.0"))
      .mockReturnValueOnce(Buffer.from("Not logged in"));
    expect(isClaudeCodeAuthed()).toBe(false);
  });

  it("isClaudeCodeAuthed returns false when binary missing", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(isClaudeCodeAuthed()).toBe(false);
  });

  it("isClaudeCodeReady returns true only when both binary and auth are OK", () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from("claude 1.0.0"))
      .mockReturnValueOnce(Buffer.from("Logged in"));
    expect(isClaudeCodeReady()).toBe(true);
  });

  it("isClaudeCodeReady returns false when auth fails", () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from("claude 1.0.0"))
      .mockImplementationOnce(() => { throw new Error("auth error"); });
    expect(isClaudeCodeReady()).toBe(false);
  });

  it("clearReadinessCache forces re-check", () => {
    // First call: binary present
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from("claude 1.0.0"))
      .mockReturnValueOnce(Buffer.from("Logged in"));
    expect(isClaudeBinaryPresent()).toBe(true);

    // Clear cache
    clearReadinessCache();

    // Second call: binary missing
    mockExecFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(isClaudeBinaryPresent()).toBe(false);
  });

  it("caches result within 30 seconds", () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from("claude 1.0.0"))
      .mockReturnValueOnce(Buffer.from("Logged in"));

    // First call — triggers check
    isClaudeBinaryPresent();
    const callCount = mockExecFileSync.mock.calls.length;

    // Second call — should use cache
    isClaudeBinaryPresent();
    expect(mockExecFileSync.mock.calls.length).toBe(callCount);
  });
});

describe("CLAUDE_CODE_MODELS", () => {
  it("has at least 3 models", () => {
    expect(CLAUDE_CODE_MODELS.length).toBeGreaterThanOrEqual(3);
  });

  it("each model has required fields", () => {
    for (const m of CLAUDE_CODE_MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxTokens).toBeGreaterThan(0);
    }
  });

  it("includes opus model", () => {
    expect(CLAUDE_CODE_MODELS.some(m => m.id.includes("opus"))).toBe(true);
  });

  it("includes sonnet model", () => {
    expect(CLAUDE_CODE_MODELS.some(m => m.id.includes("sonnet"))).toBe(true);
  });
});
