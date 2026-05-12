import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Clock, Plus } from "lucide-react";
import { useAIKeys, useCreateSchedule, useTemplates } from "@/lib/hooks";
import { ScheduleType } from "@/lib/types";
import type { ScheduleCreate, TemplateScope } from "@/lib/types";
import type { TemplateFilter } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetStages,
  BottomSheetTitle,
  BottomSheetTrigger,
  type StagePill,
} from "@/components/design";

/**
 * Create-schedule dialog + its cron/scope helpers. Extracted from the
 * /schedules page so the page file only has to worry about the table view.
 * Also imported directly by the project-detail and workspace-detail pages,
 * which mount it inline with the `projectId` / `workspaceId` prop to lock the
 * scope to the current surface — keep those props stable.
 *
 * M27 refresh: surface migrated from a centered shadcn Dialog
 * (`sm:max-w-lg`) to the shared `BottomSheet` primitive — slides up
 * from the bottom edge of the viewport (~760px wide), with a stage
 * pills strip (Template → Frequency → Tuning → Review) and a 2-column
 * body (form + live "Summary" sidebar). Behaviour is preserved
 * verbatim: same `useCreateSchedule` mutation, same scope-locked
 * project/workspace bindings, same cron preset list, same
 * `assignedKeyId === "__auto__"` sentinel for "by priority".
 *
 * Field IDs preserved (`sched-scope`, `sched-template`, `sched-key`,
 * `sched-cron`, `sched-tz`, `sched-misfire`) so any selector-based
 * test harness keeps resolving.
 */

export function scopeLabel(s: TemplateScope): string {
  return s === "global" ? "Global" : s === "workspace" ? "Workspace" : "Project";
}

const CRON_PRESETS: { label: string; cron: string; group: string }[] = [
  { label: "Every 5 minutes", cron: "*/5 * * * *", group: "Frequent" },
  { label: "Every 15 minutes", cron: "*/15 * * * *", group: "Frequent" },
  { label: "Every 30 minutes", cron: "*/30 * * * *", group: "Frequent" },
  { label: "Every hour", cron: "0 * * * *", group: "Frequent" },
  { label: "Daily at midnight", cron: "0 0 * * *", group: "Daily" },
  { label: "Daily at 6 AM", cron: "0 6 * * *", group: "Daily" },
  { label: "Daily at noon", cron: "0 12 * * *", group: "Daily" },
  { label: "Daily at 6 PM", cron: "0 18 * * *", group: "Daily" },
  { label: "Weekly on Monday", cron: "0 0 * * 1", group: "Weekly" },
  { label: "Weekly on Friday", cron: "0 0 * * 5", group: "Weekly" },
  { label: "Custom cron...", cron: "__custom__", group: "Other" },
];

/** Encodes a template reference as a single select-value string and back. */
function encodeTemplateValue(scope: TemplateScope, name: string): string {
  return `${scope}::${name}`;
}
function decodeTemplateValue(
  value: string,
): { scope: TemplateScope; name: string } | null {
  const idx = value.indexOf("::");
  if (idx < 0) return null;
  const scope = value.slice(0, idx) as TemplateScope;
  const name = value.slice(idx + 2);
  if (!scope || !name) return null;
  return { scope, name };
}

export function CreateScheduleDialog({
  projectId,
  workspaceId,
  buttonSize,
}: {
  projectId?: string;
  workspaceId?: string;
  buttonSize?: "default" | "sm";
}) {
  const [open, setOpen] = useState(false);
  // Default scope based on the surface we're in.
  const defaultScope: TemplateScope = projectId
    ? "project"
    : workspaceId
      ? "workspace"
      : "global";
  const [scope, setScope] = useState<TemplateScope>(defaultScope);
  const [templateValue, setTemplateValue] = useState<string>("");
  const [assignedKeyId, setAssignedKeyId] = useState<string>("__auto__");
  const [cronExpression, setCronExpression] = useState("");
  const [cronPreset, setCronPreset] = useState("__custom__");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [misfireGrace, setMisfireGrace] = useState("");
  const [formError, setFormError] = useState("");

  const createSchedule = useCreateSchedule();

  const templateFilter: TemplateFilter = useMemo(() => {
    const f: TemplateFilter = { scope };
    if (scope === "project" && projectId) f.projectId = projectId;
    if (scope === "workspace" && workspaceId) f.workspaceId = workspaceId;
    return f;
  }, [scope, projectId, workspaceId]);

  const { data: templatesData } = useTemplates(0, 100, templateFilter);
  const { data: aiKeys } = useAIKeys();
  const activeKeys = (aiKeys ?? []).filter((k) => k.is_active);

  function resetForm() {
    setScope(defaultScope);
    setTemplateValue("");
    setAssignedKeyId("__auto__");
    setCronExpression("");
    setCronPreset("__custom__");
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setMisfireGrace("");
    setFormError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    const decoded = decodeTemplateValue(templateValue);
    if (!decoded) {
      setFormError("Template is required.");
      return;
    }

    if (!cronExpression.trim()) {
      setFormError("Cron expression is required.");
      return;
    }

    const data: ScheduleCreate = {
      template_scope: decoded.scope,
      template_name: decoded.name,
      schedule_type: ScheduleType.cron,
      cron_expression: cronExpression.trim(),
    };

    if (decoded.scope === "project" && projectId) {
      data.template_project_id = projectId;
    }
    if (decoded.scope === "workspace" && workspaceId) {
      data.template_workspace_id = workspaceId;
    }
    if (assignedKeyId && assignedKeyId !== "__auto__") {
      data.assigned_key_id = assignedKeyId;
    }

    if (timezone.trim()) data.timezone = timezone.trim();
    if (misfireGrace) {
      data.misfire_grace_seconds = Number(misfireGrace);
    }

    try {
      await createSchedule.mutateAsync(data);
      resetForm();
      setOpen(false);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create schedule",
      );
    }
  }

  const scopeLocked = !!projectId || !!workspaceId;

  // Stage-pills derived from form state.
  const decodedTemplate = decodeTemplateValue(templateValue);
  const templateDone = decodedTemplate !== null;
  const cronDone = cronExpression.trim().length > 0;
  const tuningDone = timezone.trim().length > 0;
  const allDone = templateDone && cronDone;
  const stages: StagePill[] = [
    { label: "Template", state: templateDone ? "done" : "active" },
    {
      label: "Frequency",
      state: !templateDone ? "todo" : cronDone ? "done" : "active",
    },
    {
      label: "Tuning",
      state: !templateDone || !cronDone
        ? "todo"
        : tuningDone
          ? "done"
          : "active",
    },
    { label: "Review", state: allDone ? "active" : "todo" },
  ];

  // Find the chosen template's display name and AI key label for the summary.
  const templateName = decodedTemplate?.name ?? null;
  const assignedKeyLabel =
    assignedKeyId === "__auto__"
      ? "Auto (by priority)"
      : activeKeys.find((k) => String(k.id) === assignedKeyId)?.name ??
        activeKeys.find((k) => String(k.id) === assignedKeyId)?.label ??
        `Key #${assignedKeyId}`;

  return (
    <BottomSheet
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetForm();
      }}
    >
      <BottomSheetTrigger asChild>
        <Button size={buttonSize ?? "sm"} data-testid="new-schedule-trigger">
          <Plus aria-hidden="true" />
          New schedule
        </Button>
      </BottomSheetTrigger>
      <BottomSheetContent className="p-0" data-testid="new-schedule-dialog">
        <BottomSheetHeader className="px-6 pt-2 pb-3">
          <BottomSheetTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-foreground/70" aria-hidden="true" />
            Create Schedule
          </BottomSheetTitle>
          <BottomSheetDescription>
            {projectId
              ? "Schedule a template bound to this project."
              : workspaceId
                ? "Schedule a template bound to this workspace."
                : "Schedule a template for automatic execution."}
          </BottomSheetDescription>
        </BottomSheetHeader>

        <BottomSheetStages stages={stages} data-testid="sched-stages" />

        <form
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col"
          data-testid="new-schedule-form"
        >
          <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[1fr_240px]">
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4">
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="sched-scope">Template scope *</Label>
                  <Select
                    value={scope}
                    onValueChange={(v) => {
                      if (scopeLocked) return;
                      setScope(v as TemplateScope);
                      setTemplateValue("");
                    }}
                    disabled={scopeLocked}
                  >
                    <SelectTrigger id="sched-scope">
                      <SelectValue placeholder="Select scope" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="global">Global</SelectItem>
                      <SelectItem value="workspace">Workspace</SelectItem>
                      <SelectItem value="project">Project</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="sched-template">Template *</Label>
                  <Select value={templateValue} onValueChange={setTemplateValue}>
                    <SelectTrigger id="sched-template">
                      <SelectValue placeholder="Select a template" />
                    </SelectTrigger>
                    <SelectContent>
                      {templatesData?.items?.map((tpl) => (
                        <SelectItem
                          key={encodeTemplateValue(tpl.scope, tpl.name)}
                          value={encodeTemplateValue(tpl.scope, tpl.name)}
                        >
                          {tpl.name}
                        </SelectItem>
                      ))}
                      {(!templatesData?.items ||
                        templatesData.items.length === 0) && (
                        <p className="px-2 py-1 text-xs text-muted-foreground">
                          No {scopeLabel(scope).toLowerCase()} templates.{" "}
                          <Link
                            to="/templates"
                            className="underline hover:text-foreground"
                          >
                            Create one on the Templates page
                          </Link>
                        </p>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="sched-key">AI Key</Label>
                  <Select value={assignedKeyId} onValueChange={setAssignedKeyId}>
                    <SelectTrigger id="sched-key">
                      <SelectValue placeholder="Auto (by priority)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__auto__">Auto (by priority)</SelectItem>
                      {activeKeys.map((k) => (
                        <SelectItem key={k.id} value={String(k.id)}>
                          {k.name ?? k.label ?? `Key #${k.id}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Cron Schedule *</Label>
                  <Select
                    value={cronPreset}
                    onValueChange={(value) => {
                      setCronPreset(value);
                      if (value !== "__custom__") {
                        const preset = CRON_PRESETS.find((p) => p.cron === value);
                        if (preset) setCronExpression(preset.cron);
                      }
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a schedule…" />
                    </SelectTrigger>
                    <SelectContent>
                      {["Frequent", "Daily", "Weekly", "Other"].map((group) => (
                        <SelectGroup key={group}>
                          <SelectLabel>{group}</SelectLabel>
                          {CRON_PRESETS.filter((p) => p.group === group).map(
                            (p) => (
                              <SelectItem key={p.cron} value={p.cron}>
                                {p.label}
                              </SelectItem>
                            ),
                          )}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                  {cronPreset === "__custom__" && (
                    <Input
                      id="sched-cron"
                      placeholder="*/5 * * * *"
                      value={cronExpression}
                      onChange={(e) => setCronExpression(e.target.value)}
                    />
                  )}
                  {cronExpression && (
                    <p className="text-xs font-mono text-muted-foreground">
                      Cron: {cronExpression}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="sched-tz">Timezone</Label>
                    <Select value={timezone} onValueChange={setTimezone}>
                      <SelectTrigger id="sched-tz">
                        <SelectValue placeholder="Select timezone" />
                      </SelectTrigger>
                      <SelectContent className="max-h-60">
                        {Intl.supportedValuesOf("timeZone").map((tz) => (
                          <SelectItem key={tz} value={tz}>
                            {tz.replace(/_/g, " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="sched-misfire">Misfire Grace (seconds)</Label>
                    <Input
                      id="sched-misfire"
                      type="number"
                      placeholder="optional"
                      value={misfireGrace}
                      onChange={(e) => setMisfireGrace(e.target.value)}
                    />
                  </div>
                </div>

                {formError && (
                  <p
                    className="text-sm text-destructive"
                    data-testid="new-schedule-error"
                  >
                    {formError}
                  </p>
                )}
              </div>
            </div>

            {/* Summary sidebar */}
            <aside
              className="hidden border-l border-zinc-200 bg-zinc-50/60 px-4 py-4 sm:flex sm:flex-col dark:border-zinc-800 dark:bg-zinc-900/40"
              aria-label="Summary"
            >
              <p className="text-[10.5px] font-semibold tracking-widest text-zinc-500 uppercase">
                Summary
              </p>
              <dl className="mt-3 space-y-3 text-[11.5px]">
                <div>
                  <dt className="text-zinc-500">Template</dt>
                  <dd className="mt-0.5 truncate font-medium text-zinc-900 dark:text-zinc-100">
                    {templateName ?? (
                      <span className="text-zinc-400 italic">none yet</span>
                    )}
                  </dd>
                  <p className="mt-0.5 truncate text-[10.5px] text-zinc-600 capitalize dark:text-zinc-400">
                    {scope}
                  </p>
                </div>
                <div>
                  <dt className="text-zinc-500">Cron</dt>
                  <dd className="mt-0.5 truncate font-mono font-medium text-zinc-900 dark:text-zinc-100">
                    {cronExpression.trim() || (
                      <span className="font-sans text-zinc-400 italic">
                        not set
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Timezone</dt>
                  <dd className="mt-0.5 truncate text-[10.5px] font-medium text-zinc-900 dark:text-zinc-100">
                    {timezone.trim() || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">AI key</dt>
                  <dd className="mt-0.5 truncate font-medium text-zinc-900 dark:text-zinc-100">
                    {assignedKeyLabel}
                  </dd>
                </div>
                {misfireGrace.trim() && (
                  <div>
                    <dt className="text-zinc-500">Misfire grace</dt>
                    <dd className="mt-0.5 font-mono font-medium text-zinc-900 dark:text-zinc-100">
                      {misfireGrace.trim()}s
                    </dd>
                  </div>
                )}
              </dl>

              <div className="mt-auto border-t border-zinc-200 pt-3 dark:border-zinc-800">
                <p className="text-[10.5px] font-semibold tracking-widest text-zinc-500 uppercase">
                  Side-effects
                </p>
                <ul className="mt-1.5 space-y-1 text-[10.5px] text-zinc-600 dark:text-zinc-400">
                  <li>
                    +1 row in <span className="font-mono">schedules</span>
                  </li>
                  <li>scheduler picks it up on next tick</li>
                  {cronExpression.trim() && (
                    <li>fires per cron expression</li>
                  )}
                </ul>
              </div>
            </aside>
          </div>

          <BottomSheetFooter>
            <Button
              type="submit"
              disabled={createSchedule.isPending}
              data-testid="new-schedule-submit"
            >
              {createSchedule.isPending ? "Creating…" : "Create"}
            </Button>
          </BottomSheetFooter>
        </form>
      </BottomSheetContent>
    </BottomSheet>
  );
}
