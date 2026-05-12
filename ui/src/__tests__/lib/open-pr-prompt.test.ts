import { describe, it, expect } from "vitest";
import { buildOpenPrPrompt } from "@/lib/open-pr-prompt";

/**
 * Contract: the prompt the "Open PR" button drops into the chat queue
 * has invariants the agent relies on. Pin them so a thoughtless edit
 * (the kind that "tightens the wording") doesn't accidentally remove
 * a hard rule and let an agent force-push to main.
 */

describe("buildOpenPrPrompt", () => {
  it("includes the canonical PR-creation steps an agent needs", () => {
    const out = buildOpenPrPrompt("");
    // 1. State verification before mutation.
    expect(out).toContain("git rev-parse --abbrev-ref HEAD");
    expect(out).toContain("git status --short");
    // 2. Push step: explicit `-u origin HEAD`, no force-push.
    expect(out).toContain("git push -u origin HEAD");
    // 3. PR creation: explicit title/body, no `--no-edit` shortcut.
    expect(out).toContain("gh pr create");
    expect(out).toContain("Do NOT pass `--no-edit`");
    // 4. Body shape: ## Summary + ## Test plan with checkboxes.
    expect(out).toContain("## Summary");
    expect(out).toContain("## Test plan");
    expect(out).toContain("- [ ]");
    // 5. Output: PR URL back to the operator.
    expect(out).toContain("Reply with the PR URL");
  });

  it("emits the hard-rules clause that prevents force-push / hook-skipping / unprompted amends", () => {
    const out = buildOpenPrPrompt("");
    // These four guards are the reason the prompt exists; they MUST
    // survive any future copy-edit. If a refactor relaxes them the
    // operator inherits an agent that will happily corrupt the
    // operator's branch state.
    expect(out).toMatch(/never skip commit hooks/i);
    expect(out).toMatch(/never bypass GPG signing/i);
    expect(out).toMatch(/never force-push/i);
    expect(out).toMatch(/never amend an existing commit/i);
  });

  it("appends the operator's extra context under a labelled section when provided", () => {
    const out = buildOpenPrPrompt("Closes #42. Reviewer: @alice.");
    expect(out).toContain("Context from the operator:");
    expect(out).toContain("Closes #42. Reviewer: @alice.");
    // The context block sits at the very end so it doesn't disrupt
    // the numbered step list above it.
    const idx = out.indexOf("Context from the operator:");
    const lastStep = out.lastIndexOf("Reply with the PR URL");
    expect(idx).toBeGreaterThan(lastStep);
  });

  it("drops the context section entirely when input is empty / whitespace-only", () => {
    expect(buildOpenPrPrompt("")).not.toContain("Context from the operator:");
    expect(buildOpenPrPrompt("   \n\t ")).not.toContain(
      "Context from the operator:",
    );
  });

  it("trims surrounding whitespace from the context block", () => {
    const out = buildOpenPrPrompt("\n\n  Closes #1.  \n  ");
    expect(out).toContain("Closes #1.");
    // Leading whitespace is stripped — otherwise the rendered prompt
    // would show a stray blank line above the operator's note.
    expect(out).not.toContain("\n\n  Closes #1.");
  });
});
