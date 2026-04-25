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
        Extra paths Flockctl can add to the auto-managed block in{" "}
        <code>.gitignore</code>. All default off — toggling none keeps the
        current behaviour.
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

/** Convenience default used by create dialogs — all three flags start off. */
export const DEFAULT_GITIGNORE_TOGGLES: GitignoreTogglesValue = {
  gitignore_flockctl: false,
  gitignore_todo: false,
  gitignore_agents_md: false,
};
