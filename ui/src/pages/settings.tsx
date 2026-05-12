import { useSearchParams } from "react-router-dom";

import {
  SETTINGS_TAB_IDS,
  SettingsTabs,
  type SettingsTabId,
} from "./settings-components/SettingsTabs";
import { AIKeysSection } from "./settings-components/AIKeysSection";
import { ServerSection } from "./settings-components/ServerSection";
import { SecretsSection } from "./settings-components/SecretsSection";
import { SkillsSection } from "./settings-components/SkillsSection";

/**
 * SettingsPage — top-level mount for `/settings`.
 *
 * Composition (top-down):
 *
 *   1. Page heading (h1 + lede paragraph).
 *   2. `<SettingsTabs />` segmented strip — owns the URL contract
 *      (`?tab=<id>`, default `account`). Also enforces the keyboard +
 *      ARIA model (see SettingsTabs.tsx).
 *   3. The active section component, swapped via a small dispatch
 *      keyed off the same `?tab=` query param the strip writes.
 *
 * The page is intentionally thin — every section component is
 * self-contained (its own hooks, mutations, and FlatCard chrome). This
 * means the page doesn't fan-out queries that the active tab doesn't
 * need; lazy-mounting one section at a time keeps initial render small
 * and matches the redesigned layout per the slice spec.
 *
 * URL contract (mirrors `SettingsTabs`):
 *   - Bare `/settings` and unknown `?tab=` values fall back to Account.
 *   - The whitelist is `SETTINGS_TAB_IDS` (re-used here so the dispatch
 *     stays in sync if the strip's tab list ever changes).
 */

function isSettingsTabId(value: string | null | undefined): value is SettingsTabId {
  return !!value && (SETTINGS_TAB_IDS as readonly string[]).includes(value);
}

const SECTION_TITLES: Record<SettingsTabId, string> = {
  "ai-keys": "AI Keys",
  server: "Server",
  secrets: "Secrets",
  skills: "Skills",
};

const SECTION_DESCRIPTIONS: Record<SettingsTabId, string> = {
  "ai-keys":
    "Claude Code profiles. Add one row per CLAUDE_CONFIG_DIR to run multiple Anthropic accounts in parallel.",
  server: "Daemon connection and updates.",
  secrets:
    "Manage shared secrets used by MCP servers. Values stay on the daemon.",
  skills: "Where Flockctl looks for skills at runtime.",
};

export default function SettingsPage() {
  const [searchParams] = useSearchParams();
  const raw = searchParams.get("tab");
  const active: SettingsTabId = isSettingsTabId(raw) ? raw : "ai-keys";

  return (
    <div data-testid="settings-page">
      <h1 className="text-[15px] font-semibold leading-tight">Settings</h1>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Manage your account, server connection, and per-device preferences.
      </p>

      <div className="mt-4">
        <SettingsTabs />
      </div>

      <section
        id={`settings-tabpanel-${active}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${active}`}
        data-testid={`settings-tabpanel-${active}`}
        className={
          // Tabs that host wide tables (AI keys → 6 cols, Server → server
          // list 4 cols + actions) overflow the default 768px width and
          // get their Status / Actions columns clipped. Give those tabs
          // more room; keep the form-style tabs narrow for readability.
          "mt-4 " +
          (active === "ai-keys" || active === "server" || active === "skills"
            ? "max-w-5xl"
            : "max-w-3xl")
        }
      >
        <header className="mb-3">
          <h2 className="text-[13px] font-semibold leading-tight">{SECTION_TITLES[active]}</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {SECTION_DESCRIPTIONS[active]}
          </p>
        </header>

        {active === "ai-keys" && <AIKeysSection />}
        {active === "server" && <ServerSection />}
        {active === "secrets" && <SecretsSection />}
        {active === "skills" && <SkillsSection />}
      </section>
    </div>
  );
}
