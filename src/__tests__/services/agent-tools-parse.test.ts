import { describe, it, expect } from "vitest";
import { parseAskUserQuestionInput } from "../../services/agent-tools.js";

describe("parseAskUserQuestionInput", () => {
  it("parses a full happy-path payload (3 options, multi_select=true, header)", () => {
    const result = parseAskUserQuestionInput({
      question: "Which deploy target?",
      header: "Deploy",
      multi_select: true,
      options: [
        { label: "staging", description: "pre-prod" },
        { label: "prod", description: "live", preview: "irreversible" },
        { label: "canary" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.question).toBe("Which deploy target?");
    expect(result.value.header).toBe("Deploy");
    expect(result.value.multi_select).toBe(true);
    expect(result.value.options).toHaveLength(3);
    expect(result.value.options?.[1]).toEqual({
      label: "prod",
      description: "live",
      preview: "irreversible",
    });
  });

  it("strips unknown top-level fields without error", () => {
    const result = parseAskUserQuestionInput({
      question: "ok?",
      foobar: 123,
      nested: { keep: "out" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("foobar");
    expect(result.value).not.toHaveProperty("nested");
    expect(result.value.question).toBe("ok?");
  });

  it("defaults multi_select to false when missing", () => {
    const result = parseAskUserQuestionInput({ question: "?" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.multi_select).toBe(false);
  });

  it("drops an empty options array entirely (treated as free-form)", () => {
    const result = parseAskUserQuestionInput({
      question: "free-form?",
      options: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("options");
  });

  it("rejects malformed options (option missing label)", () => {
    const result = parseAskUserQuestionInput({
      question: "pick one",
      options: [{ description: "no label here" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeDefined();
    expect(result.error.issues.length).toBeGreaterThan(0);
  });

  it("backward compat: parses { question } alone", () => {
    const result = parseAskUserQuestionInput({ question: "hi" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.question).toBe("hi");
    expect(result.value).not.toHaveProperty("options");
    expect(result.value).not.toHaveProperty("header");
  });

  it("rejects a 21-element options array (max 20)", () => {
    const options = Array.from({ length: 21 }, (_, i) => ({ label: `opt${i}` }));
    const result = parseAskUserQuestionInput({
      question: "too many",
      options,
    });
    expect(result.ok).toBe(false);
  });

  it("camel/snake interop: harness multiSelect → multi_select", () => {
    const result = parseAskUserQuestionInput({
      question: "?",
      multiSelect: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.multi_select).toBe(true);
  });

  it("collapses harness-style { questions: [...] } to the first element", () => {
    const result = parseAskUserQuestionInput({
      questions: [
        { question: "first?", header: "A" },
        { question: "second?", header: "B" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.question).toBe("first?");
    expect(result.value.header).toBe("A");
  });

  it("rejects an empty question string", () => {
    const result = parseAskUserQuestionInput({ question: "" });
    expect(result.ok).toBe(false);
  });
});
