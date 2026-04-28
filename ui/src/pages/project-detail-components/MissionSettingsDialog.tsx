import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useUpdateMission,
  type Mission,
  type MissionAutonomy,
  type MissionUpdate,
} from "@/lib/hooks/missions";

/**
 * MissionSettingsDialog — operator-facing editor for mutable mission fields.
 *
 * Renders three controls:
 *
 *   1. Objective       — `<Textarea>`, free text up to 8000 chars
 *      (matches `updateSchema.objective.max(8000)` in
 *      `src/routes/missions.ts`).
 *   2. Budget          — two `<Input type="number">`s for `budget_tokens`
 *      and `budget_usd_cents`, validated client-side as positive integers
 *      (mirrors the `.int().positive().max(MAX_BUDGET)` constraint on
 *      both fields). Negative / zero / non-integer / overflow values are
 *      rejected before submit so the operator gets immediate feedback
 *      rather than waiting for a 422 round-trip.
 *   3. Autonomy        — three radio inputs (`manual`, `suggest`, `auto`).
 *      `auto` is `disabled` and rendered with a tooltip ("Not available
 *      in v1") because the executor side of the autonomy=auto path has
 *      not been implemented yet (parent slice §04 — the server returns
 *      501 if the value is forced through). We keep the radio in the DOM
 *      (rather than hiding it) so screen-reader users discover the
 *      eventual third option and can read the disabled-tooltip rationale.
 *
 * Why no shadcn `RadioGroup`:
 *   The `ui/components/ui/` directory does not currently ship a
 *   `radio-group.tsx` (shadcn import surface is the smaller subset
 *   `badge / button / dialog / dropdown-menu / input / label / select /
 *   textarea / …`). Native `<input type="radio">` rendered with the
 *   project's existing Tailwind utility classes keeps the bundle slim
 *   and matches the form-input language used elsewhere
 *   (e.g. `permission-mode-select.tsx` — also a custom radio-style
 *   picker without a wrapping component).
 *
 * Submit semantics:
 *   The dialog only PATCHes fields that actually changed — the
 *   `updateSchema.refine((v) => Object.keys(v).length > 0)` rejects an
 *   empty body, but more importantly it keeps the audit-log noise low.
 *   If the operator opens the dialog and clicks "Save" without changing
 *   anything, we no-op and close.
 */

interface MissionSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mission: Mission;
}

const AUTONOMY_OPTIONS: ReadonlyArray<{
  value: MissionAutonomy;
  label: string;
  description: string;
  disabled?: boolean;
  disabledReason?: string;
}> = [
  {
    value: "manual",
    label: "Manual",
    description:
      "Supervisor never proposes — operator drives every milestone, slice, and task.",
  },
  {
    value: "suggest",
    label: "Suggest",
    description:
      "Supervisor proposes remediation; operator approves before any plan-store mutation.",
  },
  {
    value: "auto",
    label: "Auto",
    description:
      "Supervisor approves its own proposals (not available in v1).",
    disabled: true,
    disabledReason: "Not available in v1",
  },
];

/**
 * Validate a stringified positive integer. Returns the parsed number on
 * success, `null` on failure. We accept exactly the values the server
 * accepts: integers in `[1, 2_147_483_647]` (matches `MAX_BUDGET` in
 * `src/routes/missions.ts`).
 */
function parsePositiveInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // Reject decimals up-front — `parseInt` would silently truncate.
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  if (n > 2_147_483_647) return null;
  return n;
}

export function MissionSettingsDialog({
  open,
  onOpenChange,
  mission,
}: MissionSettingsDialogProps) {
  // Form state lives in the inner `<MissionSettingsForm>` so it remounts
  // every open/close cycle — no `useEffect`-driven state reset needed
  // (and no `react-hooks/set-state-in-effect` warning to suppress). The
  // Dialog primitive unmounts content when `open=false`, so a fresh
  // `useState` initializer fires the next time the operator opens it.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        data-testid="mission-settings-dialog"
      >
        <DialogHeader>
          <DialogTitle>Mission settings</DialogTitle>
          <DialogDescription>
            Edit the objective, budget, and autonomy for this mission.
          </DialogDescription>
        </DialogHeader>
        <MissionSettingsForm mission={mission} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function MissionSettingsForm({
  mission,
  onClose,
}: {
  mission: Mission;
  onClose: () => void;
}) {
  const [objective, setObjective] = useState(mission.objective);
  const [budgetTokens, setBudgetTokens] = useState(String(mission.budget_tokens));
  const [budgetUsdCents, setBudgetUsdCents] = useState(
    String(mission.budget_usd_cents),
  );
  const [autonomy, setAutonomy] = useState<MissionAutonomy>(mission.autonomy);
  const [formError, setFormError] = useState("");

  const updateMission = useUpdateMission(mission.id);

  const tokensValid = parsePositiveInt(budgetTokens);
  const centsValid = parsePositiveInt(budgetUsdCents);
  const objectiveTrimmed = objective.trim();

  function buildPatch(): MissionUpdate | null {
    const patch: MissionUpdate = {};
    if (objectiveTrimmed !== mission.objective) {
      patch.objective = objectiveTrimmed;
    }
    if (tokensValid !== null && tokensValid !== mission.budget_tokens) {
      patch.budget_tokens = tokensValid;
    }
    if (centsValid !== null && centsValid !== mission.budget_usd_cents) {
      patch.budget_usd_cents = centsValid;
    }
    if (autonomy !== mission.autonomy) {
      patch.autonomy = autonomy;
    }
    return Object.keys(patch).length === 0 ? null : patch;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    if (!objectiveTrimmed) {
      setFormError("Objective is required.");
      return;
    }
    if (tokensValid === null) {
      setFormError("Budget tokens must be a positive integer.");
      return;
    }
    if (centsValid === null) {
      setFormError("Budget USD cents must be a positive integer.");
      return;
    }
    // Slice §04 gate: surface the not-implemented state at the boundary
    // rather than letting the (disabled) radio leak through. Defense in
    // depth — the radio's `disabled` attribute prevents this in normal
    // flow, but a forced submit (devtools, scripted) still hits 501 from
    // the server. Failing fast with a friendlier message is kinder.
    if (autonomy === "auto") {
      setFormError("Autonomy 'auto' is not available in v1.");
      return;
    }

    const patch = buildPatch();
    if (patch === null) {
      // Nothing changed — close silently.
      onClose();
      return;
    }

    try {
      await updateMission.mutateAsync(patch);
      onClose();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to update mission",
      );
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="ms-objective">Objective</Label>
            <Textarea
              id="ms-objective"
              data-testid="mission-objective"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              rows={3}
              maxLength={8000}
              placeholder="What should the supervisor pursue?"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="ms-budget-tokens">Budget tokens</Label>
              <Input
                id="ms-budget-tokens"
                data-testid="mission-budget-tokens"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={budgetTokens}
                onChange={(e) => setBudgetTokens(e.target.value)}
                aria-invalid={tokensValid === null ? "true" : "false"}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ms-budget-cents">Budget USD cents</Label>
              <Input
                id="ms-budget-cents"
                data-testid="mission-budget-cents"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={budgetUsdCents}
                onChange={(e) => setBudgetUsdCents(e.target.value)}
                aria-invalid={centsValid === null ? "true" : "false"}
              />
            </div>
          </div>

          <fieldset
            className="space-y-2"
            role="radiogroup"
            aria-label="Autonomy"
            data-testid="mission-autonomy-group"
          >
            <legend className="text-sm font-medium">Autonomy</legend>
            <div className="flex flex-col gap-2">
              {AUTONOMY_OPTIONS.map((opt) => {
                const id = `ms-autonomy-${opt.value}`;
                const isDisabled = !!opt.disabled;
                return (
                  <label
                    key={opt.value}
                    htmlFor={id}
                    title={isDisabled ? opt.disabledReason : undefined}
                    className={
                      "flex items-start gap-2 rounded-md border p-2 text-sm " +
                      (isDisabled
                        ? "cursor-not-allowed opacity-60"
                        : "cursor-pointer hover:bg-muted/50")
                    }
                  >
                    <input
                      id={id}
                      type="radio"
                      name="ms-autonomy"
                      value={opt.value}
                      data-testid={`mission-autonomy-${opt.value}`}
                      checked={autonomy === opt.value}
                      disabled={isDisabled}
                      onChange={() => {
                        if (!isDisabled) setAutonomy(opt.value);
                      }}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <div className="font-medium">
                        {opt.label}
                        {isDisabled && (
                          <span
                            className="ml-2 text-xs text-muted-foreground"
                            data-testid={`mission-autonomy-${opt.value}-tooltip`}
                          >
                            ({opt.disabledReason})
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {opt.description}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {formError && (
            <p
              className="text-sm text-destructive"
              role="alert"
              data-testid="mission-settings-error"
            >
              {formError}
            </p>
          )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={updateMission.isPending}
          data-testid="mission-settings-save"
        >
          {updateMission.isPending ? "Saving..." : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
