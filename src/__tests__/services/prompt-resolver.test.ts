import { describe, it, expect, afterAll } from "vitest";
import { resolveTaskPrompt } from "../../services/prompt-resolver.js";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("resolveTaskPrompt", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "prompt-resolver-test-"));

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns inline prompt when promptFile is null", () => {
    const result = resolveTaskPrompt({ prompt: "Do something", promptFile: null });
    expect(result).toBe("Do something");
  });

  it("returns empty string when both are null", () => {
    const result = resolveTaskPrompt({ prompt: null, promptFile: null });
    expect(result).toBe("");
  });

  it("reads prompt from md file with frontmatter", () => {
    const filePath = join(tempDir, "task.md");
    writeFileSync(filePath, `---
title: Fix the bug
verify: npm test
files:
  - src/main.ts
  - src/utils.ts
---

Detailed description of the task to perform.
`, "utf-8");

    const result = resolveTaskPrompt({ prompt: null, promptFile: filePath });
    expect(result).toContain("Fix the bug");
    expect(result).toContain("Detailed description of the task to perform.");
    expect(result).toContain("Verification: npm test");
    expect(result).toContain("Files: src/main.ts, src/utils.ts");
  });

  it("reads prompt from md file without frontmatter", () => {
    const filePath = join(tempDir, "plain.md");
    writeFileSync(filePath, "Just a plain prompt without frontmatter\n", "utf-8");

    const result = resolveTaskPrompt({ prompt: null, promptFile: filePath });
    expect(result.trim()).toBe("Just a plain prompt without frontmatter");
  });

  it("prefers promptFile over inline prompt", () => {
    const filePath = join(tempDir, "preferred.md");
    writeFileSync(filePath, `---
title: From file
---

File content here.
`, "utf-8");

    const result = resolveTaskPrompt({ prompt: "Inline prompt", promptFile: filePath });
    expect(result).toContain("From file");
    expect(result).toContain("File content here.");
    expect(result).not.toContain("Inline prompt");
  });

  it("throws if promptFile does not exist", () => {
    expect(() => resolveTaskPrompt({
      prompt: null,
      promptFile: "/nonexistent/path/task.md",
    })).toThrow("Prompt file not found");
  });

  it("handles md file with expected_output", () => {
    const filePath = join(tempDir, "with-output.md");
    writeFileSync(filePath, `---
title: Build feature
expected_output:
  - API endpoint works
  - Tests pass
---

Build the new feature.
`, "utf-8");

    const result = resolveTaskPrompt({ prompt: null, promptFile: filePath });
    expect(result).toContain("Expected output: API endpoint works, Tests pass");
  });
});
