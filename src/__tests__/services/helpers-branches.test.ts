/**
 * Branch-coverage tests for `src/services/agent-session/helpers.ts`.
 * Targets the tiny truth-table inside `extractPromptText` (array form) and
 * every conditional `lines.push(...)` inside `formatIncidentsSection`.
 */
import { describe, it, expect } from "vitest";
import {
  extractPromptText,
  formatIncidentsSection,
} from "../../services/agent-session/helpers.js";

describe("extractPromptText — branches", () => {
  it("returns the string as-is for plain string content", () => {
    expect(extractPromptText("hello world")).toBe("hello world");
  });

  it("concatenates text blocks and ignores non-text blocks", () => {
    const content = [
      { type: "text", text: "alpha " },
      { type: "image", source: { type: "base64", data: "xxx" } } as any,
      { type: "text", text: "beta" },
      null as any,
      { type: "text" } as any, // missing text → "" fallback
    ];
    expect(extractPromptText(content as any)).toBe("alpha beta");
  });

  it("returns empty string for an array of only non-text blocks", () => {
    const content = [{ type: "image" } as any, { type: "tool_use" } as any];
    expect(extractPromptText(content as any)).toBe("");
  });
});

describe("formatIncidentsSection — branches", () => {
  it("includes every optional field when present", () => {
    const out = formatIncidentsSection([
      {
        id: 7,
        title: "DB down",
        tags: ["db", "outage"],
        symptom: "500s",
        rootCause: "OOM",
        resolution: "Restart",
      } as any,
    ]);
    expect(out).toContain("<past_incidents>");
    expect(out).toContain("### [#7] DB down");
    expect(out).toContain("- Tags: db, outage");
    expect(out).toContain("- Symptom: 500s");
    expect(out).toContain("- Root cause: OOM");
    expect(out).toContain("- Resolution: Restart");
    expect(out).toContain("</past_incidents>");
  });

  it("omits optional lines when fields are empty/undefined", () => {
    const out = formatIncidentsSection([
      {
        id: 1,
        title: "Bare",
        tags: [],
        symptom: "",
        rootCause: "",
        resolution: "",
      } as any,
    ]);
    expect(out).toContain("### [#1] Bare");
    expect(out).not.toContain("- Tags:");
    expect(out).not.toContain("- Symptom:");
    expect(out).not.toContain("- Root cause:");
    expect(out).not.toContain("- Resolution:");
  });

  it("omits optional lines when fields are undefined", () => {
    const out = formatIncidentsSection([
      { id: 2, title: "Undefined-fields" } as any,
    ]);
    expect(out).toContain("### [#2] Undefined-fields");
    expect(out).not.toContain("- Tags:");
    expect(out).not.toContain("- Symptom:");
  });

  it("handles empty matches array", () => {
    const out = formatIncidentsSection([]);
    expect(out.startsWith("<past_incidents>")).toBe(true);
    expect(out.trimEnd().endsWith("</past_incidents>")).toBe(true);
  });
});
