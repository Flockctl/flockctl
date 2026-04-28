import { describe, it, expect, vi, afterEach } from "vitest";
import { serializeQuestionRow } from "../../services/attention.js";

/**
 * Pure-serializer coverage for slice 02. This file deliberately does NOT
 * spin up a daemon, a DB, or an `AgentSession` — those paths are exercised
 * by the integration suite in the next slice. Here we only assert that the
 * three structural shapes a row can take (free-form, single-select with one
 * option, multi-select with multiple options) round-trip into the right
 * `task_question` / `chat_question` payload.
 *
 * Casing invariant: the on-wire shape is camelCase, while the DB row that
 * Drizzle hands the serializer uses camelCase too (the column-to-property
 * map lives in the schema). The fixture below feeds the serializer the
 * camelCase row directly so the test mirrors what `collectAttentionItems`
 * actually passes in.
 */

const FREE_FORM_ROW = {
  requestId: "req-free",
  question: "What should I do?",
  options: null,
  multiSelect: false,
  header: null,
  createdAt: "2026-04-26T12:00:00.000Z",
};

const SINGLE_SELECT_ROW = {
  requestId: "req-single",
  question: "Pick one",
  options: JSON.stringify([{ label: "yes", description: "go ahead" }]),
  multiSelect: false,
  header: "Confirm",
  createdAt: "2026-04-26T12:01:00.000Z",
};

const MULTI_SELECT_ROW = {
  requestId: "req-multi",
  question: "Pick any",
  options: JSON.stringify([
    { label: "alpha" },
    { label: "beta", preview: "preview text" },
    { label: "gamma", description: "third option" },
  ]),
  multiSelect: true,
  header: "Targets",
  createdAt: "2026-04-26T12:02:00.000Z",
};

describe("serializeQuestionRow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("free-form row → no options, no header (kind picked from surface)", () => {
    const taskOut = serializeQuestionRow(FREE_FORM_ROW, "task");
    expect(taskOut).toEqual({
      kind: "task_question",
      requestId: "req-free",
      question: "What should I do?",
      multiSelect: false,
      createdAt: "2026-04-26T12:00:00.000Z",
    });
    // `options` and `header` must be omitted entirely (not undefined keys),
    // mirroring the WS broadcaster's "absent === free-form" contract.
    expect(taskOut).not.toHaveProperty("options");
    expect(taskOut).not.toHaveProperty("header");

    const chatOut = serializeQuestionRow(FREE_FORM_ROW, "chat");
    expect(chatOut.kind).toBe("chat_question");
    expect(chatOut).not.toHaveProperty("options");
    expect(chatOut).not.toHaveProperty("header");
  });

  it("single-select row → header surfaced, options parsed and preserved", () => {
    const out = serializeQuestionRow(SINGLE_SELECT_ROW, "task");
    expect(out).toEqual({
      kind: "task_question",
      requestId: "req-single",
      question: "Pick one",
      multiSelect: false,
      createdAt: "2026-04-26T12:01:00.000Z",
      header: "Confirm",
      options: [{ label: "yes", description: "go ahead" }],
    });
  });

  it("multi-select row → multiSelect=true and full options array intact", () => {
    const out = serializeQuestionRow(MULTI_SELECT_ROW, "chat");
    expect(out.kind).toBe("chat_question");
    expect(out.multiSelect).toBe(true);
    expect(out.header).toBe("Targets");
    expect(out.options).toEqual([
      { label: "alpha" },
      { label: "beta", preview: "preview text" },
      { label: "gamma", description: "third option" },
    ]);
  });

  it("empty options array collapses to free-form (no `options` key)", () => {
    const row = { ...FREE_FORM_ROW, options: JSON.stringify([]) };
    const out = serializeQuestionRow(row, "task");
    expect(out).not.toHaveProperty("options");
  });

  it("malformed options JSON → logged and dropped, row still serialises", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = { ...FREE_FORM_ROW, options: "{not json" };
    const out = serializeQuestionRow(row, "task");
    expect(out).not.toHaveProperty("options");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to parse agent_questions.options for req-free"),
      expect.any(Error),
    );
  });

  it("null createdAt falls back to a fresh ISO timestamp", () => {
    const row = { ...FREE_FORM_ROW, createdAt: null };
    const out = serializeQuestionRow(row, "task");
    // Don't assert the literal timestamp — just that it parses as ISO.
    expect(typeof out.createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(out.createdAt))).toBe(false);
  });
});
