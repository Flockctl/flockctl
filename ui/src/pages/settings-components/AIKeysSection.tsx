import * as React from "react";
import { Plus } from "lucide-react";

import { FlatCard } from "@/components/design";
import { Button } from "@/components/ui/button";
import { useAIKeys } from "@/lib/hooks";

import { AIKeyTable } from "./AIKeyTable";
import { CreateAIKeyDialog } from "./CreateAIKeyDialog";

/**
 * AIKeysSection — "AI Keys" tab content for /settings.
 *
 * Mounts the existing `AIKeyTable` (rename / verify / enable / delete per
 * row) inside a `FlatCard`, and offers an "Add key" button that opens
 * `CreateAIKeyDialog`. Both components are pre-existing — this section
 * is the missing wire-up after the v0.0.1-rc.2 settings refactor split
 * the monolithic settings page into per-tab components but left the
 * AI-keys UI orphaned.
 *
 * Provider scope: Claude Code only. The dialog and the backend
 * `POST /keys` route both reject anything other than `claude_cli`. If
 * additional providers are re-enabled, restore the provider switcher in
 * `CreateAIKeyDialog.tsx` from git history rather than adding a parallel
 * section here.
 *
 * Multi-key model: every row maps to one `CLAUDE_CONFIG_DIR`, so adding
 * several rows with distinct `Config Directory` values gives you
 * parallel Anthropic accounts (Personal / Work / Org). The Account
 * column resolves each one against `api.anthropic.com/api/oauth/profile`
 * to confirm which underlying account a key actually authenticates as.
 */
export interface AIKeysSectionProps {
  className?: string;
}

export function AIKeysSection({
  className,
}: AIKeysSectionProps): React.JSX.Element {
  const { data: keys, isLoading, error } = useAIKeys();
  const [dialogOpen, setDialogOpen] = React.useState(false);

  return (
    <div className={className} data-testid="ai-keys-section">
      <FlatCard className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Claude Code Keys</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Each row is one Claude Code profile (one{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                CLAUDE_CONFIG_DIR
              </code>
              ). Add several to run multiple Anthropic accounts in parallel.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => setDialogOpen(true)}
            data-testid="ai-keys-add-button"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            Add key
          </Button>
        </div>

        <div className="mt-4 overflow-x-auto">
          <AIKeyTable
            keys={keys}
            isLoading={isLoading}
            error={error as Error | null}
          />
        </div>
      </FlatCard>

      <CreateAIKeyDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

export default AIKeysSection;
