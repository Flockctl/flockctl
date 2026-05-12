import * as React from "react";

import { SecretsPanel } from "@/components/secrets-panel";

/**
 * SecretsSection — "Secrets" tab content for the new settings page.
 *
 * The secrets panel is a presentation primitive used at the global,
 * workspace, and project scopes — see [`secrets-panel.tsx`](../../components/secrets-panel.tsx).
 * Settings → Secrets is the global-scope mounting; this thin section
 * wraps the panel with the page-level intro copy and pins the scope.
 *
 * Why a wrapper instead of dropping `SecretsPanel` directly into
 * `settings.tsx`: the new settings layout uses one `<FlatCard>` per
 * conceptual section (Server, Secrets, …) and adds the
 * tab-level heading + description above the card. Centralising that
 * layout here keeps the page (`settings.tsx`) free of per-tab
 * boilerplate and matches the shape of `ServerSection`.
 *
 * Security note
 * -------------
 * The existing security model is preserved verbatim:
 *
 *   - The API never returns the secret *value* — only metadata
 *     (`name`, `description`, timestamps). See
 *     [`SecretRecord`](../../lib/types/secret.ts).
 *   - The UI consequently has no value to render. What we show is the
 *     placeholder reference (`${secret:NAME}`) that operators paste
 *     into MCP env — this is *not* the secret.
 *   - New / rotated values flow only through the explicit-input dialog
 *     (password input, no autocomplete) and are never logged or
 *     mirrored into the query cache.
 *   - At-rest persistence is `~/.flockctlrc` with `chmod 600`,
 *     enforced by the daemon.
 *
 * This wrapper does not introduce any new code path that could touch
 * a secret value — it only restyles the surrounding chrome.
 */
export interface SecretsSectionProps {
  className?: string;
}

export function SecretsSection({
  className,
}: SecretsSectionProps): React.JSX.Element {
  return (
    <div className={className} data-testid="secrets-section">
      <SecretsPanel scope="global" />
    </div>
  );
}

export default SecretsSection;
