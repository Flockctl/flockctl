import { describe, it, expect } from "vitest";
import {
  formatTimestamp,
  formatDateTime,
  formatLogTime,
} from "@/lib/format";

/**
 * The daemon emits timestamps in two shapes that must be treated as UTC:
 *
 *   - ISO with `Z`:           `"2026-04-20T12:00:00.000Z"`
 *   - Bare SQLite (no TZ):    `"2026-04-20 12:00:00"`
 *
 * `new Date(bareSqlite).toLocaleString()` parses the bare form as **local
 * time**, which under UTC+3 (Moscow) shifts the displayed wall-clock by 3
 * hours — the exact bug the user reported. The formatters must route
 * through `parseServerTimestamp` so both shapes land on the same epoch and
 * render the same local-TZ string. Comparing the two outputs makes this
 * test independent of the timezone the suite happens to run in.
 */
describe("timestamp formatters — bare SQLite vs ISO equivalence", () => {
  const ISO = "2026-04-20T12:00:00.000Z";
  const BARE = "2026-04-20 12:00:00";
  const ISO_NO_TZ = "2026-04-20T12:00:00";

  it("formatTimestamp treats bare SQLite as UTC", () => {
    expect(formatTimestamp(BARE)).toBe(formatTimestamp(ISO));
  });

  it("formatTimestamp treats ISO without TZ as UTC", () => {
    expect(formatTimestamp(ISO_NO_TZ)).toBe(formatTimestamp(ISO));
  });

  it("formatTimestamp returns sentinel for nullish/empty input", () => {
    expect(formatTimestamp(null)).toBe("-");
    expect(formatTimestamp(undefined)).toBe("-");
    expect(formatTimestamp("")).toBe("-");
  });

  it("formatDateTime treats bare SQLite as UTC", () => {
    expect(formatDateTime(BARE)).toBe(formatDateTime(ISO));
  });

  it("formatDateTime returns em-dash for nullish/unparseable input", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
  });

  it("formatLogTime treats bare SQLite as UTC", () => {
    expect(formatLogTime(BARE)).toBe(formatLogTime(ISO));
  });
});
