/**
 * Vitest global setup — runs ONCE before the first test module loads.
 *
 * Why this exists: the suite has hundreds of tests that exercise HTTP routes
 * via `app.request(...)`. They don't pass a `c.env.incoming.socket.remoteAddress`
 * (no real socket in the in-memory request), so the `remoteAuth` middleware
 * sees a non-localhost caller. If the developer's real `~/.flockctlrc` has a
 * `remoteAccessTokens` entry, `hasRemoteAuth()` returns `true` and those
 * tests get 401s they never see in CI (where no rc exists).
 *
 * Fix: point `HOME` at a per-process temp dir before any module that captures
 * `homedir()` at import time (e.g. `src/config/paths.ts`'s `RC_FILE`) is
 * loaded. The rc file simply won't exist there, `loadRc()` returns `{}`, and
 * `hasRemoteAuth()` returns `false` — exactly the state CI sees.
 *
 * Tests that DO want to exercise rc-file behavior (see
 * `config/purge-legacy.test.ts`, `cli/remote-bootstrap-*.test.ts`) already
 * override `HOME` to their own tmp dir inside `beforeEach` — this setup does
 * not get in their way.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolatedHome = mkdtempSync(join(tmpdir(), "flockctl-test-home-"));
process.env.HOME = isolatedHome;
// os.homedir() on darwin/linux reads $HOME first; on some macOS setups a
// stale USERPROFILE can bleed through, so clear anything obviously wrong.
delete process.env.USERPROFILE;

// Ensure FLOCKCTL_HOME also points somewhere isolated by default. Individual
// tests that need a specific path still override this in their own setup.
if (!process.env.FLOCKCTL_HOME) {
  process.env.FLOCKCTL_HOME = join(isolatedHome, "flockctl");
}
