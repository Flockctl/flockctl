import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Vitest fallback for the M22 slice-02 ESLint guard.
 *
 * Why a Vitest test in addition to an ESLint rule?
 * ------------------------------------------------
 * The ESLint rule (in `ui/eslint.config.js`) blocks
 * `import … from "@/components/ui/card"` inside `src/pages/**`. ESLint is
 * the right tool for IDE feedback and PR-level enforcement, but two
 * properties make it insufficient as the *only* gate:
 *
 *   1. The flat config can be edited; an unrelated tweak could relax
 *      the rule without anyone noticing. A dedicated, named test fails
 *      loudly the moment the invariant is broken.
 *
 *   2. The rule currently runs at `severity: 'warn'` because ~19 pre-M23
 *      pages still import shadcn `<Card>` and migrate as part of M23–M25.
 *      A `'warn'`-level rule is invisible to CI; this test is the actual
 *      gate that prevents *new* drift.
 *
 * What it does
 * ------------
 * Scans every `*.tsx` under `ui/src/pages/**` for an import that resolves
 * to `@/components/ui/card`. A file is permitted to keep that import only
 * if it appears in `LEGACY_ALLOWLIST` below — the snapshot of pages still
 * mid-migration. The allowlist is meant to **shrink monotonically**: every
 * M23–M25 page-redesign PR removes one or more entries.
 *
 * When the allowlist hits zero, delete this allowlist + the legacy branch
 * and bump the ESLint rule severity to `'error'` (M26 cleanup task 03).
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// `ui/src/__tests__/lint/` → up three to reach `ui/`.
const UI_ROOT = path.resolve(__dirname, "..", "..", "..");
const PAGES_ROOT = path.join(UI_ROOT, "src", "pages");

/**
 * Snapshot of pre-M23 pages that still legitimately import the shadcn
 * `<Card>`. These migrate to `<FlatCard>` (from `@/components/design`)
 * during the M23–M25 page-redesign milestones. New entries should NOT
 * be added here — file the page redesign instead.
 *
 * Paths are relative to `ui/src/pages/` and use POSIX separators.
 */
const LEGACY_ALLOWLIST: ReadonlySet<string> = new Set([
  "dev-tokens-preview.tsx",
  "incident-detail.tsx",
  "project-detail-components/MilestoneCard.tsx",
  "project-detail-components/MissionControlKpiBar.tsx",
  "project-detail-components/PlanChatPanel.tsx",
  "project-detail-components/ProjectDetailTreeView.tsx",
  "project-detail-components/ProposedCard.tsx",
  "project-detail-components/RunsTab.tsx",
  "task-detail.tsx",
  "tasks-components/tasks-kanban.tsx",
  "workspace-detail-components/DependencyGraphCard.tsx",
  "workspace-detail-components/ProjectsAccordion.tsx",
  "workspace-detail-components/WorkspaceConfigTab.tsx",
  "workspace-detail-components/WorkspaceRunsTab.tsx",
]);

/**
 * Matches:
 *   import { Card } from "@/components/ui/card"
 *   import Card from "@/components/ui/card"
 *   import * as Card from '@/components/ui/card'
 *   } from "@/components/ui/card";          // line continuation
 *
 * The trailing `["']` enforces a string-literal close so we don't match
 * incidental occurrences in comments / JSX text.
 */
const SHADCN_CARD_IMPORT_RE = /from\s+["']@\/components\/ui\/card["']/;

async function* walkTsx(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTsx(full);
    } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
      yield full;
    }
  }
}

function relPosix(absPath: string): string {
  return path.relative(PAGES_ROOT, absPath).split(path.sep).join("/");
}

describe("no shadcn <Card> imports on page surfaces", () => {
  it("every src/pages/**/*.tsx file with a Card import is in LEGACY_ALLOWLIST", async () => {
    const offenders: string[] = [];

    for await (const file of walkTsx(PAGES_ROOT)) {
      const source = await fs.readFile(file, "utf8");
      if (!SHADCN_CARD_IMPORT_RE.test(source)) continue;

      const rel = relPosix(file);
      if (!LEGACY_ALLOWLIST.has(rel)) {
        offenders.push(rel);
      }
    }

    expect(
      offenders,
      `\nThe following page files import shadcn <Card> from \`@/components/ui/card\`:\n` +
        offenders.map((p) => `  - src/pages/${p}`).join("\n") +
        `\n\nUse \`<FlatCard>\` from \`@/components/design\` instead. ` +
        `If this page is mid-migration, add the relative path to ` +
        `LEGACY_ALLOWLIST in src/__tests__/lint/no-shadcn-card-on-page.test.ts ` +
        `— but the better answer is almost always to migrate the import.\n`,
    ).toEqual([]);
  });

  it("LEGACY_ALLOWLIST does not contain entries for files that no longer import Card (allowlist shrinks monotonically)", async () => {
    const stale: string[] = [];

    for (const rel of LEGACY_ALLOWLIST) {
      const full = path.join(PAGES_ROOT, rel);
      let source: string;
      try {
        source = await fs.readFile(full, "utf8");
      } catch {
        // File deleted entirely → entry is stale.
        stale.push(rel);
        continue;
      }
      if (!SHADCN_CARD_IMPORT_RE.test(source)) {
        stale.push(rel);
      }
    }

    expect(
      stale,
      `\nThe following entries in LEGACY_ALLOWLIST no longer import shadcn ` +
        `<Card> (or no longer exist) — please remove them from the ` +
        `allowlist in src/__tests__/lint/no-shadcn-card-on-page.test.ts:\n` +
        stale.map((p) => `  - ${p}`).join("\n") +
        `\n`,
    ).toEqual([]);
  });
});
