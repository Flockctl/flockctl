import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getPlanDir,
  createMilestone,
  getMilestone,
  updateMilestone,
  listMilestones,
  parseMd,
  MISSION_ID_REGEX,
  parseMissionId,
} from "../../services/plan-store/index.js";

describe("milestone_yaml_schema mission_id wiring", () => {
  let projectPath: string;
  let planDir: string;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), "plan-store-mission-"));
    planDir = getPlanDir(projectPath);
    mkdirSync(planDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  // ── unit ─────────────────────────────────────────────────────────────────

  it("milestone_yaml_schema: regex accepts hex-like ids and rejects junk", () => {
    expect(MISSION_ID_REGEX.test("abcd1234")).toBe(true);
    expect(MISSION_ID_REGEX.test("ABCD1234")).toBe(true);
    expect(MISSION_ID_REGEX.test("0123456789abcdef")).toBe(true);

    expect(MISSION_ID_REGEX.test("short")).toBe(false);          // <8 chars
    expect(MISSION_ID_REGEX.test("not-hex!")).toBe(false);       // bad chars
    expect(MISSION_ID_REGEX.test("abcd1234 ")).toBe(false);      // trailing space
    expect(MISSION_ID_REGEX.test("g".repeat(8))).toBe(false);    // out of hex range
  });

  it("milestone_yaml_schema: parseMissionId tolerates missing value", () => {
    expect(parseMissionId(undefined)).toBeUndefined();
    expect(parseMissionId(null)).toBeUndefined();
  });

  it("milestone_yaml_schema: parseMissionId rejects malformed value", () => {
    expect(() => parseMissionId("nope!")).toThrow(/mission_id/);
    expect(() => parseMissionId(12345678)).toThrow(/string/);
    expect(() => parseMissionId({})).toThrow(/string/);
  });

  // ── integration: round-trip ─────────────────────────────────────────────

  it("milestone_yaml_schema: round-trips mission_id through read → write → read", () => {
    // 1. Hand-author a milestone YAML with `mission_id: abcd1234`.
    const slug = "00-test_milestone";
    const dir = join(planDir, slug);
    mkdirSync(dir, { recursive: true });
    const mdPath = join(dir, "milestone.md");
    writeFileSync(
      mdPath,
      `---\ntitle: Test Milestone\nstatus: pending\norder: 0\nmission_id: abcd1234\n---\n\nbody\n`,
      "utf-8",
    );

    // 2. Read via the plan-store helpers — mission_id should surface.
    const m = getMilestone(projectPath, slug);
    expect(m).not.toBeNull();
    expect(m!.missionId).toBe("abcd1234");

    // 3. Serialise back via updateMilestone (changes title; mission_id must
    //    survive the merge).
    const updated = updateMilestone(projectPath, slug, { title: "Renamed" });
    expect(updated.missionId).toBe("abcd1234");

    // 4. Read again from disk.
    const reread = getMilestone(projectPath, slug);
    expect(reread!.missionId).toBe("abcd1234");
    expect(reread!.title).toBe("Renamed");

    // And the raw YAML still carries the key.
    const { frontmatter } = parseMd(mdPath);
    expect(frontmatter.mission_id).toBe("abcd1234");
  });

  it("milestone_yaml_schema: createMilestone with mission_id writes it to YAML", () => {
    const m = createMilestone(projectPath, { title: "New", missionId: "deadbeef" });
    expect(m.missionId).toBe("deadbeef");

    const onDisk = readFileSync(join(planDir, m.slug, "milestone.md"), "utf-8");
    expect(onDisk).toMatch(/mission_id:\s*deadbeef/);
  });

  // ── back-compat ──────────────────────────────────────────────────────────

  it("existing_milestones_without_mission_id parse without crashing", () => {
    // Simulate a milestone authored before mission_id existed: no key in YAML.
    const slug = "00-legacy";
    const dir = join(planDir, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "milestone.md"),
      `---\ntitle: Legacy Milestone\nstatus: pending\norder: 0\n---\n\nold body\n`,
      "utf-8",
    );

    const m = getMilestone(projectPath, slug);
    expect(m).not.toBeNull();
    expect(m!.title).toBe("Legacy Milestone");
    expect(m!.missionId).toBeUndefined();

    // listMilestones must also not crash.
    const all = listMilestones(projectPath);
    expect(all).toHaveLength(1);
    expect(all[0]!.missionId).toBeUndefined();
  });

  it("existing_milestones_without_mission_id stay clean on round-trip (no key written)", () => {
    const slug = "00-legacy2";
    const dir = join(planDir, slug);
    mkdirSync(dir, { recursive: true });
    const mdPath = join(dir, "milestone.md");
    writeFileSync(
      mdPath,
      `---\ntitle: Legacy\nstatus: pending\norder: 0\n---\n\nbody\n`,
      "utf-8",
    );

    updateMilestone(projectPath, slug, { title: "Touched" });

    const onDisk = readFileSync(mdPath, "utf-8");
    expect(onDisk).not.toMatch(/mission_id:/);
  });

  // ── failure mode ─────────────────────────────────────────────────────────

  it("milestone_yaml_schema: malformed mission_id on disk throws on read", () => {
    const slug = "00-bad";
    const dir = join(planDir, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "milestone.md"),
      `---\ntitle: Bad\nstatus: pending\norder: 0\nmission_id: "not valid!"\n---\n\nbody\n`,
      "utf-8",
    );

    expect(() => getMilestone(projectPath, slug)).toThrow(/mission_id/);
  });
});
