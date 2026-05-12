import { ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * InlinePermissionPrompt — an in-log row for `pending_approval`-style
 * permission requests (M19/02).
 *
 * The component is a thin presentational wrapper over the existing
 * permission-request data shape — it does NOT call
 * `respondToPermission` itself, mirroring the audit's "click handlers
 * call the same hooks as before" contract. The page wires the
 * actual mutation via `onAllow` / `onDeny`.
 *
 * Visually lives inline as a banded amber row so the operator's eye
 * snaps to it in a long log scroll.
 */

export interface InlinePermissionPromptProps {
  /** Tool / capability the agent is requesting (e.g. "shell.exec"). */
  tool: string;
  /** Free-form summary the agent provided when raising the request. */
  description?: string | null;
  /** Allow scope choices — at least "once" must be supported. */
  scopes?: ReadonlyArray<"once" | "task" | "project" | "workspace">;
  pending?: boolean;
  onAllow: (scope: "once" | "task" | "project" | "workspace") => void;
  onDeny: () => void;
}

const SCOPE_LABEL: Record<"once" | "task" | "project" | "workspace", string> = {
  once: "Allow once",
  task: "Allow for task",
  project: "Allow for project",
  workspace: "Allow for workspace",
};

export function InlinePermissionPrompt({
  tool,
  description,
  scopes = ["once", "task"],
  pending,
  onAllow,
  onDeny,
}: InlinePermissionPromptProps) {
  return (
    <div
      role="alertdialog"
      aria-label={`Permission request for ${tool}`}
      data-testid="inline-permission-prompt"
      className="flex flex-col gap-2 border-y border-amber-500/30 bg-amber-50 px-3 py-2.5 text-sm dark:bg-amber-950/20"
    >
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[12.5px] font-semibold text-amber-900 dark:text-amber-100">
            Permission request: {tool}
          </div>
          {description && (
            <div className="mt-0.5 text-[12.5px] text-amber-800/80 dark:text-amber-100/80">
              {description}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {scopes.map((s) => (
          <Button
            key={s}
            variant="default"
            size="sm"
            disabled={pending}
            onClick={() => onAllow(s)}
            data-testid={`inline-permission-allow-${s}`}
          >
            {SCOPE_LABEL[s]}
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={onDeny}
          data-testid="inline-permission-deny"
        >
          <ShieldX className="mr-1 h-3.5 w-3.5" />
          Deny
        </Button>
      </div>
    </div>
  );
}

export default InlinePermissionPrompt;
