import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

/**
 * Authoritative profile for a Claude Code key — resolved by asking
 * `https://api.anthropic.com/api/oauth/profile` under the OAuth token that
 * Claude Code stored for a given `CLAUDE_CONFIG_DIR`.
 *
 * This is deliberately stronger than `claude auth status`, which sometimes
 * shows cached/local labels: the Anthropic API is the source of truth for
 * which account/org/subscription a token actually belongs to.
 */
export interface ClaudeIdentity {
  /** True if we successfully resolved a profile from Anthropic. */
  loggedIn: boolean;
  email?: string;
  accountUuid?: string;
  organizationUuid?: string;
  organizationName?: string;
  /** e.g. `"claude_max"`, `"claude_team"`. */
  organizationType?: string;
  /** e.g. `"default_claude_max_20x"`, `"default_claude_max_5x"`. */
  rateLimitTier?: string;
  hasClaudeMax?: boolean;
  hasClaudePro?: boolean;
  subscriptionStatus?: string;
  /** Populated when loggedIn is false — machine-readable hint for the UI. */
  error?: string;
}

/** @internal — override for tests. */
export interface IdentityDeps {
  /** Stringified HTTP client (tests mock this). */
  fetchImpl?: typeof fetch;
  /**
   * Access-token reader. Receives the resolved absolute config dir plus the
   * effective platform (so tests can simulate Linux behaviour on a macOS
   * host, or vice versa).
   */
  readToken?: (absConfigDir: string, platform: NodeJS.Platform) => Promise<string | null>;
  /** Platform override (tests). Default: `process.platform`. */
  platform?: NodeJS.Platform;
}

const ANTHROPIC_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const FETCH_TIMEOUT_MS = 5_000;
const SECURITY_TIMEOUT_MS = 2_000;

/**
 * Thrown by the macOS token reader when `security` cannot access a keychain
 * item because the calling binary isn't on the item's ACL — i.e. the user
 * hasn't clicked "Always Allow" yet, or denied the prompt. This is distinct
 * from "item not found" (Claude Code was never logged in here) because the
 * fix is different: the user should grant access, not re-login.
 */
export class KeychainAclError extends Error {
  constructor(public readonly stderr: string) {
    // Keep the message user-facing — it bubbles up to the UI Account column.
    super(
      'macOS keychain access denied — grant Flockctl "Always Allow" in the Security prompt, then click Verify again.',
    );
    this.name = "KeychainAclError";
  }
}

/**
 * Match the stderr text that `security(1)` emits when the ACL check fails.
 * We deliberately look at stderr rather than the numeric exit code because
 * the CLI normalizes most errSec* codes to exit 44/45/51 and the only
 * reliable discriminator is the human-readable message.
 *
 * Known patterns (macOS 13–15):
 *   - "User interaction is not allowed."            (headless/daemon, ACL gate)
 *   - "The user name or passphrase you entered is not correct."  (prompt denied)
 *   - "SecKeychainSearchCopyNext: ... -128"         (errSecUserCanceled)
 *   - "errSecAuthFailed"                            (generic ACL fail)
 */
/* v8 ignore start — sole caller (readMacKeychain) is itself v8-ignored as
   an OS-specific shell-out; this helper's branches only exercise with real
   `security(1)` stderr payloads we can't reproduce in CI. */
function isKeychainAclStderr(stderr: string): boolean {
  return (
    /User interaction is not allowed/i.test(stderr) ||
    /errSecAuthFailed/i.test(stderr) ||
    /errSecUserCanceled/i.test(stderr) ||
    /-128\b/.test(stderr) ||
    /The user name or passphrase you entered is not correct/i.test(stderr)
  );
}
/* v8 ignore stop */

/**
 * Resolve the Anthropic OAuth profile for a given Claude Code `CLAUDE_CONFIG_DIR`.
 *
 * - `configDir` may be `null`/`undefined` (default `~/.claude`) or an absolute
 *   path / a `~/…`-prefixed path.
 * - Returns `{ loggedIn: false, error }` on any failure so callers can render
 *   the error in the UI without try/catch.
 */
export async function getClaudeIdentity(
  configDir: string | null | undefined,
  deps: IdentityDeps = {},
): Promise<ClaudeIdentity> {
  const absDir = expandDir(configDir);
  const readToken = deps.readToken ?? defaultReadToken;
  const platform = deps.platform ?? process.platform;
  const fetchImpl = deps.fetchImpl ?? fetch;

  let token: string | null;
  try {
    token = await readToken(absDir, platform);
  } catch (e) {
    // Surface ACL-denial with its own user-facing message; "failed to read
    // token" is too generic and made users think the key wasn't logged in.
    if (e instanceof KeychainAclError) {
      return { loggedIn: false, error: e.message };
    }
    return { loggedIn: false, error: `failed to read token: ${errMsg(e)}` };
  }

  if (!token) {
    return {
      loggedIn: false,
      error: platform === "darwin"
        ? `no OAuth token in Keychain (service "${keychainServiceFor(absDir)}") and no .credentials.json fallback in ${absDir}`
        : `no .credentials.json in ${absDir}`,
    };
  }

  try {
    const res = await fetchImpl(ANTHROPIC_PROFILE_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { loggedIn: false, error: `anthropic returned HTTP ${res.status}` };
    }
    const j = (await res.json()) as AnthropicProfileResponse;
    return {
      loggedIn: true,
      email: j.account?.email,
      accountUuid: j.account?.uuid,
      organizationUuid: j.organization?.uuid,
      organizationName: j.organization?.name,
      organizationType: j.organization?.organization_type,
      rateLimitTier: j.organization?.rate_limit_tier,
      hasClaudeMax: j.account?.has_claude_max,
      hasClaudePro: j.account?.has_claude_pro,
      subscriptionStatus: j.organization?.subscription_status,
    };
  } catch (e) {
    return { loggedIn: false, error: `fetch failed: ${errMsg(e)}` };
  }
}

/**
 * Compute the macOS Keychain service name Claude Code uses for a given
 * absolute config directory.
 *
 * - Default `~/.claude` → `Claude Code-credentials`.
 * - Any other dir      → `Claude Code-credentials-<sha256(absDir).slice(0,8)>`.
 *
 * Exported for tests only.
 *
 * @internal
 */
export function keychainServiceFor(absDir: string): string {
  const defaultDir = join(homedir(), ".claude");
  if (absDir === defaultDir) return "Claude Code-credentials";
  const hash = createHash("sha256").update(absDir).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

function expandDir(configDir: string | null | undefined): string {
  if (!configDir || configDir === "") return join(homedir(), ".claude");
  if (configDir === "~") return homedir();
  if (configDir.startsWith("~/")) return join(homedir(), configDir.slice(2));
  return configDir;
}

/**
 * Default token reader: macOS Keychain first, then `<absDir>/.credentials.json`.
 * Returns `null` (not throws) when nothing is found — callers convert to
 * a readable error message.
 */
async function defaultReadToken(absDir: string, platform: NodeJS.Platform): Promise<string | null> {
  /* v8 ignore next 4 — darwin dispatch is a one-liner into the Keychain
     wrapper that is itself istanbul-ignored as an OS-specific shell-out. */
  if (platform === "darwin") {
    const fromKeychain = await readMacKeychain(keychainServiceFor(absDir));
    if (fromKeychain) return fromKeychain;
  }
  // Fall through to file-based fallback so that a user who moved their
  // creds to a file (e.g. via `ANTHROPIC_USE_FILE_CREDENTIALS`) still works,
  // and so Linux/Windows have a codepath at all.
  return readCredentialsFile(absDir);
}

/* v8 ignore start — thin wrapper around macOS `security`; covered by
   integration use, impractical to mock without also mocking child_process
   at the module graph level. */
async function readMacKeychain(service: string): Promise<string | null> {
  const user = process.env.USER ?? "";
  if (!user) return null;
  try {
    const { stdout } = await pExecFile(
      "security",
      ["find-generic-password", "-s", service, "-a", user, "-w"],
      { timeout: SECURITY_TIMEOUT_MS, windowsHide: true },
    );
    const blob = stdout.trim();
    if (!blob) return null;
    const parsed = JSON.parse(blob) as MacKeychainBlob;
    return parsed?.claudeAiOauth?.accessToken ?? null;
  } catch (e) {
    // `security` surfaces ACL denial through stderr; discriminate that from
    // "item not found" so getClaudeIdentity can tell the user what to do.
    const stderr = typeof (e as { stderr?: unknown })?.stderr === "string"
      ? (e as { stderr: string }).stderr
      : "";
    if (stderr && isKeychainAclStderr(stderr)) {
      throw new KeychainAclError(stderr);
    }
    // Item missing / malformed JSON / timeout — fall back to file reader.
    return null;
  }
}
/* v8 ignore stop */

async function readCredentialsFile(absDir: string): Promise<string | null> {
  try {
    const blob = await readFile(join(absDir, ".credentials.json"), "utf-8");
    const parsed = JSON.parse(blob) as MacKeychainBlob;
    return parsed?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  /* v8 ignore next — non-Error throws are vanishingly rare in practice */
  return String(e);
}

// ─── Anthropic API response shape (narrow — we only read what we expose) ───

interface AnthropicProfileResponse {
  account?: {
    uuid?: string;
    email?: string;
    has_claude_max?: boolean;
    has_claude_pro?: boolean;
  };
  organization?: {
    uuid?: string;
    name?: string;
    organization_type?: string;
    rate_limit_tier?: string;
    subscription_status?: string;
  };
}

interface MacKeychainBlob {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}
