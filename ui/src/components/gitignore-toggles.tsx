import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

/**
 * Shape of the three gitignore toggles on `Project` / `Workspace`.
 *
 * Lives in a tiny shared type because the backend persists these identically
 * on both entities (migration 0038) and both create dialogs + both settings
 * pages render the same UI control. Keeping the definition in one place
 * means a renamed flag fails to compile everywhere at once rather than
 * drifting silently between screens.
 */
export interface GitignoreTogglesValue {
  gitignore_flockctl: boolean;
  gitignore_todo: boolean;
  gitignore_agents_md: boolean;
}

interface GitignoreTogglesProps {
  value: GitignoreTogglesValue;
  onChange: (next: GitignoreTogglesValue) => void;
  /**
   * Rendered as a section heading. Lets callers distinguish "Gitignore" on
   * create forms from a settings-page heading when a richer context is
   * already present (e.g. the project name just above).
   */
  title?: string;
  /** Disable all checkboxes — used by settings pages while a save is in flight. */
  disabled?: boolean;
  /** `id` prefix so multiple instances on one page keep stable htmlFor links. */
  idPrefix?: string;
}

const OPTIONS: Array<{
  key: keyof GitignoreTogglesValue;
  label: string;
  hint: string;
}> = [
  {
    key: "gitignore_flockctl",
    label: "Ignore the whole .flockctl/ directory",
    hint: "Adds `.flockctl/` to .gitignore. Skips listing individual sub-paths to avoid duplicates.",
  },
  {
    key: "gitignore_todo",
    label: "Ignore TODO.md",
    hint: "Adds root-level `TODO.md` to .gitignore.",
  },
  {
    key: "gitignore_agents_md",
    label: "Ignore AGENTS.md and CLAUDE.md",
    hint: "Adds both `AGENTS.md` and `CLAUDE.md` to .gitignore (Flockctl treats them as a paired file).",
  },
];

export function GitignoreToggles({
  value,
  onChange,
  title = "Gitignore",
  disabled = false,
  idPrefix = "gitignore",
}: GitignoreTogglesProps) {
  return (
    <div className="space-y-2">
      <Label>{title}</Label>
      <p className="text-xs text-muted-foreground">
        Paths Flockctl writes into the auto-managed block in{" "}
        <code>.git/info/exclude</code> (local-only — never committed). The
        first two are on by default so a fresh project leaves no Flockctl
        traces in git except <code>AGENTS.md</code>; uncheck any toggle to
        let that path show up in <code>git status</code>.
      </p>
      <div className="flex flex-col gap-2 rounded-md border p-3">
        {OPTIONS.map((opt) => {
          const id = `${idPrefix}-${opt.key}`;
          const checked = value[opt.key];
          return (
            <label key={opt.key} htmlFor={id} className="flex items-start gap-2 text-sm">
              <Checkbox
                id={id}
                checked={checked}
                disabled={disabled}
                onCheckedChange={(next) =>
                  onChange({ ...value, [opt.key]: next === true })
                }
              />
              <span className="flex-1">
                <span className="block leading-tight">{opt.label}</span>
                <span className="block text-xs text-muted-foreground">{opt.hint}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Default seed for create dialogs. Mirror of the API-level defaults applied
 * by POST /projects and POST /workspaces:
 *
 *   gitignore_flockctl  → true   (hide internal `.flockctl/` from git)
 *   gitignore_todo      → true   (root-level scratchpad — local-only)
 *   gitignore_agents_md → false  (AGENTS.md is the single Flockctl trace
 *                                operators want their teammates to see)
 *
 * The user can flip any of these in the create dialog before submitting.
 */
export const DEFAULT_GITIGNORE_TOGGLES: GitignoreTogglesValue = {
  gitignore_flockctl: true,
  gitignore_todo: true,
  gitignore_agents_md: false,
};
