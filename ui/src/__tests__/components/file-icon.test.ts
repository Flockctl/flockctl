import { describe, expect, it } from "vitest";
import {
  Braces,
  File as FileGlyph,
  FileCode,
  FileText,
  KeyRound,
  Lock,
  Palette,
  Terminal,
} from "lucide-react";

import { fileIcon } from "@/components/file-tree/file-icon";

/**
 * Boundary tests for {@link fileIcon}. We intentionally do NOT test the
 * private mapping object — only the public function — so the table can
 * be reorganised internally (alphabetised, split, lazy-loaded) without
 * rewriting the suite.
 *
 * What the suite locks down:
 *   - Top-15 extension coverage with the exact tailwind colour-class
 *     contract (regression on any of these would flicker every file
 *     tree row in the app).
 *   - Basename allowlist beats extension lookup (`.env` is BOTH an
 *     entry in the basename table and resolves to `env` after dot
 *     stripping; precedence matters).
 *   - Case-insensitive extension matching (`Foo.TS` → tsx-style ts).
 *   - Unknown extensions, dotless names, dotfiles without an entry,
 *     and the empty string all return the neutral fallback — they do
 *     not throw.
 */

describe("fileIcon", () => {
  describe("known extensions", () => {
    it.each([
      ["index.ts", FileCode, "text-blue-500"],
      ["App.tsx", FileCode, "text-blue-400"],
      ["bundle.js", FileCode, "text-yellow-500"],
      ["Form.jsx", FileCode, "text-yellow-400"],
      ["package.json", Braces, "text-orange-500"],
      ["README.md", FileText, "text-muted-foreground"],
      ["ci.yml", FileText, "text-purple-500"],
      ["compose.yaml", FileText, "text-purple-500"],
      ["styles.css", Palette, "text-blue-300"],
      ["index.html", FileCode, "text-orange-400"],
      ["script.py", FileCode, "text-green-500"],
      ["main.go", FileCode, "text-cyan-500"],
      ["main.rs", FileCode, "text-orange-600"],
      ["build.sh", Terminal, "text-green-400"],
      ["pyproject.toml", FileText, "text-orange-500"],
      ["package-lock.lock", Lock, "text-muted-foreground"],
    ])(
      "maps %s to the documented icon + colour",
      (name, expectedIcon, expectedColor) => {
        const spec = fileIcon(name);
        expect(spec.icon).toBe(expectedIcon);
        expect(spec.colorClass).toBe(expectedColor);
      },
    );

    it("matches extensions case-insensitively", () => {
      // Real users land here when a `Component.TSX` (Windows-y casing)
      // ships from a sibling project — the icon should still pick up.
      expect(fileIcon("Component.TSX").icon).toBe(FileCode);
      expect(fileIcon("script.PY").icon).toBe(FileCode);
    });

    it("uses the LAST dot for compound extensions", () => {
      // `archive.tar.gz` should resolve to the `gz` extension (which is
      // not in the table), NOT to `tar.gz` and not to `tar`.
      // We assert the fallback rather than gz mapping because gz is
      // intentionally out-of-table.
      const spec = fileIcon("archive.tar.gz");
      expect(spec.icon).toBe(FileGlyph);
    });
  });

  describe("basename allowlist", () => {
    it("matches Makefile by basename, not extension", () => {
      const spec = fileIcon("Makefile");
      expect(spec.icon).toBe(Terminal);
      expect(spec.colorClass).toBe("text-orange-500");
    });

    it("matches Dockerfile by basename", () => {
      const spec = fileIcon("Dockerfile");
      expect(spec.icon).toBe(FileCode);
      expect(spec.colorClass).toBe("text-blue-400");
    });

    it("matches .gitignore by basename", () => {
      const spec = fileIcon(".gitignore");
      expect(spec.icon).toBe(FileText);
      expect(spec.colorClass).toBe("text-muted-foreground");
    });

    it("matches .env by basename (precedence over extension lookup)", () => {
      // `.env` would also resolve to extension `env` — we lock down
      // that the basename branch wins so users don't see two different
      // colours depending on whether the file has further suffixes.
      const spec = fileIcon(".env");
      expect(spec.icon).toBe(KeyRound);
      expect(spec.colorClass).toBe("text-yellow-300");
    });

    it("does NOT match basename case-insensitively", () => {
      // `makefile` (lowercase) is not the conventional spelling — fall
      // through to the fallback rather than guess. This keeps the
      // allowlist a tight whitelist instead of a fuzzy matcher.
      const spec = fileIcon("makefile");
      expect(spec.icon).toBe(FileGlyph);
    });
  });

  describe("fallback", () => {
    it("returns neutral icon for unknown extensions", () => {
      const spec = fileIcon("data.xyz");
      expect(spec.icon).toBe(FileGlyph);
      expect(spec.colorClass).toBe("text-muted-foreground");
    });

    it("returns neutral icon for dotless filenames", () => {
      const spec = fileIcon("LICENSE");
      expect(spec.icon).toBe(FileGlyph);
      expect(spec.colorClass).toBe("text-muted-foreground");
    });

    it("returns neutral icon for unknown dotfiles", () => {
      // `.editorconfig` isn't on the allowlist — should not crash, and
      // should not pick up an "editorconfig" extension lookup.
      const spec = fileIcon(".editorconfig");
      expect(spec.icon).toBe(FileGlyph);
    });

    it("returns neutral icon for filenames ending in a dot", () => {
      // Pathological input — `foo.` has a dot but no extension chars
      // after it. We must not throw on slicing.
      const spec = fileIcon("foo.");
      expect(spec.icon).toBe(FileGlyph);
    });

    it("returns neutral icon for the empty string", () => {
      const spec = fileIcon("");
      expect(spec.icon).toBe(FileGlyph);
      expect(spec.colorClass).toBe("text-muted-foreground");
    });
  });
});
