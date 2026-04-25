import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

import { homedir } from "os";
import { seedDefaultSkills } from "../../services/default-skills-seeder.js";

let fakeHome: string;
let originalHome: string | undefined;
let originalFlockctlHome: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "flockctl-default-skills-"));
  (homedir as any).mockReturnValue(fakeHome);
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  originalFlockctlHome = process.env.FLOCKCTL_HOME;
  process.env.FLOCKCTL_HOME = join(fakeHome, "flockctl");
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalFlockctlHome !== undefined) process.env.FLOCKCTL_HOME = originalFlockctlHome;
  else delete process.env.FLOCKCTL_HOME;
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

describe("seedDefaultSkills", () => {
  it("copies every default skill to ~/flockctl/skills/ on clean boot", () => {
    const result = seedDefaultSkills();

    expect(result.seeded).toContain("state-machine-driven-task");
    const dest = join(fakeHome, "flockctl", "skills", "state-machine-driven-task", "SKILL.md");
    expect(existsSync(dest)).toBe(true);
    const body = readFileSync(dest, "utf-8");
    expect(body).toContain("name: state-machine-driven-task");
  });

  it("does not overwrite user edits on second boot", () => {
    seedDefaultSkills();
    const dest = join(fakeHome, "flockctl", "skills", "state-machine-driven-task", "SKILL.md");
    // User modifies the seeded file
    writeFileSync(dest, "# my custom edit\n", "utf-8");

    const second = seedDefaultSkills();
    expect(second.seeded).not.toContain("state-machine-driven-task");
    expect(second.skipped).toContain("state-machine-driven-task");
    expect(readFileSync(dest, "utf-8")).toBe("# my custom edit\n");
  });

  it("preserves user deletions of individual files inside an existing skill dir", () => {
    // Pre-create the target dir empty — seeder must not recreate contents
    const skillsRoot = join(fakeHome, "flockctl", "skills");
    mkdirSync(join(skillsRoot, "state-machine-driven-task"), { recursive: true });

    const result = seedDefaultSkills();

    expect(result.skipped).toContain("state-machine-driven-task");
    const skillMd = join(skillsRoot, "state-machine-driven-task", "SKILL.md");
    expect(existsSync(skillMd)).toBe(false);
  });

  it("is idempotent — repeated calls leave the tree identical", () => {
    const first = seedDefaultSkills();
    const second = seedDefaultSkills();
    expect(first.seeded.length).toBeGreaterThan(0);
    expect(second.seeded.length).toBe(0);
    expect(second.skipped).toEqual(first.seeded);
  });
});
