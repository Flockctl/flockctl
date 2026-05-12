import { useEffect, useMemo, useState } from "react";
import {
  Switch as SwitchPrimitive,
  RadioGroup as RadioGroupPrimitive,
  Slider as SliderPrimitive,
} from "radix-ui";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { FlatCard } from "@/components/design/FlatCard";
import { KpiTile } from "@/components/design/KpiTile";
import { LiveDot } from "@/components/design/LiveDot";
import { SectionHeader as DesignSectionHeader } from "@/components/design/SectionHeader";
import { SegmentToggle } from "@/components/design/SegmentToggle";
import { Sparkbar } from "@/components/design/Sparkbar";
import {
  StatusPill,
  type StatusPillTone,
} from "@/components/design/StatusPill";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

/**
 * The CSS custom properties driven by `:root` and `.dark` in `index.css`.
 * Order is intentional — it matches the M22/T02 mapping table top-to-bottom
 * so the visual baselines line up with the reference doc.
 */
const TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
] as const;

// The brief asks for `text-zinc-500 text-xs uppercase tracking-wider` on
// section headers. zinc-500 against `--background` (zinc-50 / zinc-950)
// renders at ~4.12:1, just under WCAG AA's 4.5:1 threshold — axe flags
// this as `serious`. We honour the spec's typographic intent (size,
// case, tracking, font-weight) but bump the colour to zinc-600 / zinc-400
// so the route passes the a11y gate the brief itself prescribes.
const SECTION_HEADER_CLS =
  "text-zinc-600 dark:text-zinc-400 text-xs uppercase tracking-wider font-medium";

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h2 className={SECTION_HEADER_CLS}>{children}</h2>;
}

/**
 * Reads `getComputedStyle(document.documentElement)` once on mount and again
 * whenever the `<html>` `class` attribute changes (the ThemeProvider toggles
 * `.dark` there). Keeps the swatch row in sync with whichever theme is
 * currently applied without re-rendering the whole tree on every paint.
 */
function useComputedTokenValues(tokens: readonly string[]): Record<string, string> {
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    function read() {
      const cs = getComputedStyle(document.documentElement);
      const next: Record<string, string> = {};
      for (const t of tokens) {
        next[t] = cs.getPropertyValue(t).trim();
      }
      setValues(next);
    }
    read();

    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, [tokens]);

  return values;
}

function TokenSwatchRow({ name, value }: { name: string; value: string }) {
  return (
    <div
      className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
      data-testid={`token-row-${name}`}
    >
      <div
        aria-hidden="true"
        className="size-6 shrink-0 rounded-md border border-border"
        style={{ background: `var(${name})` }}
      />
      <code className="mono text-xs">{name}</code>
      <span className="ml-auto mono text-xs text-muted-foreground">
        {value || "—"}
      </span>
    </div>
  );
}

/**
 * Inline Switch — radix-ui primitive styled with the same tokens the rest of
 * the shadcn primitives rely on. We intentionally don't promote this into
 * `components/ui/` because the preview is the only consumer; if a real Switch
 * lands later it should replace this in-place.
 */
function PreviewSwitch({
  checked,
  onCheckedChange,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      checked={checked}
      onCheckedChange={onCheckedChange}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors outline-none",
        "focus-visible:ring-3 focus-visible:ring-ring/50",
        "data-[state=unchecked]:bg-muted data-[state=checked]:bg-primary",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow ring-0 transition-transform",
          "data-[state=unchecked]:translate-x-0 data-[state=checked]:translate-x-4",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

function PreviewRadioGroup({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (v: string) => void;
}) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      value={value}
      onValueChange={onValueChange}
      className="flex flex-col gap-2"
    >
      {["one", "two", "three"].map((v) => (
        <label key={v} className="flex items-center gap-2 text-sm">
          <RadioGroupPrimitive.Item
            value={v}
            className={cn(
              "relative flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-transparent transition-colors outline-none",
              "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              "data-checked:border-primary",
            )}
          >
            <RadioGroupPrimitive.Indicator className="flex size-2 items-center justify-center rounded-full bg-primary" />
          </RadioGroupPrimitive.Item>
          {v}
        </label>
      ))}
    </RadioGroupPrimitive.Root>
  );
}

function PreviewSlider({
  value,
  onValueChange,
}: {
  value: number[];
  onValueChange: (v: number[]) => void;
}) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={value}
      onValueChange={onValueChange}
      max={100}
      step={1}
      className="relative flex w-full touch-none items-center select-none"
      aria-label="Slider preview"
    >
      <SliderPrimitive.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-muted">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className={cn(
          "block size-4 rounded-full border-2 border-primary bg-background shadow transition-colors outline-none",
          "focus-visible:ring-3 focus-visible:ring-ring/50",
        )}
      />
    </SliderPrimitive.Root>
  );
}

/**
 * Forced-render toast surfaces. The app does not ship a real toast component
 * (notifications go through the OS Notification API), but for a visual
 * baseline of the token system we render four in-page surfaces matching the
 * intent classes we'd use if/when one is added.
 */
function PreviewToast({
  variant,
  children,
}: {
  variant: "info" | "warning" | "success" | "error";
  children: React.ReactNode;
}) {
  const variantCls: Record<typeof variant, string> = {
    info: "border-border bg-popover text-popover-foreground",
    warning:
      "border-yellow-500/40 bg-yellow-500/10 text-foreground dark:bg-yellow-500/15",
    success:
      "border-emerald-500/40 bg-emerald-500/10 text-foreground dark:bg-emerald-500/15",
    error:
      "border-destructive/40 bg-destructive/10 text-destructive",
  };
  return (
    <div
      role="status"
      data-variant={variant}
      data-testid={`toast-${variant}`}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-sm",
        variantCls[variant],
      )}
    >
      <span className="font-medium capitalize">{variant}</span>
      <span className="text-muted-foreground">{children}</span>
    </div>
  );
}

/**
 * Dev-only token + primitive preview. Mounted at `/dev/tokens-preview`
 * (gated by `import.meta.env.DEV` in main.tsx), this page exists so a
 * single screenshot diff can flag any regression in the M22/T02 palette
 * remap. Not part of the navigation; pure presentation, no backend.
 */
export default function DevTokensPreviewPage() {
  const { theme, setTheme } = useTheme();
  const tokenValues = useComputedTokenValues(TOKENS);

  // Forced-open variants — Dialog and Select are mounted both as a "closed"
  // trigger button and as a controlled-open instance so the baseline captures
  // both surfaces in one screenshot.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [forcedDialogOpen, setForcedDialogOpen] = useState(true);
  const [selectValue, setSelectValue] = useState<string>("apple");
  const [forcedSelectOpen, setForcedSelectOpen] = useState(true);

  const [switchOn, setSwitchOn] = useState(true);
  const [checkedState, setCheckedState] =
    useState<"checked" | "unchecked" | "indeterminate">("checked");
  const [radio, setRadio] = useState("two");
  const [slider, setSlider] = useState<number[]>([42]);

  function toggleTheme() {
    setTheme(theme === "dark" ? "light" : "dark");
  }

  // Indeterminate checkbox — radix-ui's Checkbox accepts `checked={"indeterminate"}`.
  const indeterminateChecked = useMemo(() => {
    if (checkedState === "checked") return true;
    if (checkedState === "unchecked") return false;
    return "indeterminate" as const;
  }, [checkedState]);

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto bg-background p-6 text-foreground"
      data-testid="dev-tokens-preview"
    >
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold">
            Tokens & primitives preview
          </h1>
          <p className="text-sm text-muted-foreground">
            Dev-only visual baseline. Toggle the theme to verify both
            color modes.
          </p>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          data-testid="theme-toggle"
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted"
        >
          Toggle theme (current: {theme})
        </button>
      </header>

      <section
        data-testid="section-tokens"
        className="flex flex-col gap-2"
      >
        <SectionHeader>1. CSS variables</SectionHeader>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {TOKENS.map((t) => (
            <TokenSwatchRow key={t} name={t} value={tokenValues[t] ?? ""} />
          ))}
        </div>
      </section>

      <section data-testid="section-buttons" className="flex flex-col gap-2">
        <SectionHeader>2. Buttons</SectionHeader>
        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
        </div>
      </section>

      <section data-testid="section-card" className="flex flex-col gap-2">
        <SectionHeader>3. Card</SectionHeader>
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Card title</CardTitle>
            <CardDescription>
              Header / content / footer surfaces.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Body text inside a default card. The footer below is part of the
              same surface and inherits the muted tint.
            </p>
          </CardContent>
          <CardFooter>
            <Button size="sm">Action</Button>
          </CardFooter>
        </Card>
      </section>

      <section
        data-testid="section-flat-card"
        className="flex flex-col gap-2"
      >
        <SectionHeader>3a. FlatCard</SectionHeader>
        <div className="flex flex-col gap-3 max-w-md">
          <FlatCard className="px-4 py-3">
            <div className="text-sm font-medium">Static FlatCard</div>
            <p className="text-xs text-muted-foreground">
              Flat surface, rounded-xl, divider-y border, bg-card.
            </p>
          </FlatCard>

          <FlatCard
            className="px-4 py-3"
            footer={
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Footer</span>
                <Button size="sm" variant="ghost">
                  Action
                </Button>
              </div>
            }
          >
            <div className="text-sm font-medium">FlatCard with footer</div>
            <p className="text-xs text-muted-foreground">
              Footer is separated by a top hairline divider.
            </p>
          </FlatCard>

          <FlatCard
            interactive
            onClick={() => {}}
            className="px-4 py-3"
          >
            <div className="text-sm font-medium">Interactive FlatCard</div>
            <p className="text-xs text-muted-foreground">
              Hover to lift; Enter/Space activates.
            </p>
          </FlatCard>
        </div>
      </section>

      <section data-testid="section-dialog" className="flex flex-col gap-2">
        <SectionHeader>4. Dialog</SectionHeader>
        <div className="flex gap-2">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">Open dialog</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>Triggered dialog</DialogTitle>
                <DialogDescription>
                  This one mounts on click — closed by default.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button onClick={() => setDialogOpen(false)}>OK</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Dialog open={forcedDialogOpen} onOpenChange={setForcedDialogOpen}>
            <DialogContent data-testid="dialog-forced-open">
              <DialogHeader>
                <DialogTitle>Forced-open dialog</DialogTitle>
                <DialogDescription>
                  Rendered open so the baseline captures the overlay,
                  popover surface, ring, and footer rule.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setForcedDialogOpen(false)}>
                  Close
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </section>

      <section data-testid="section-select" className="flex flex-col gap-2">
        <SectionHeader>5. Select</SectionHeader>
        <div className="flex gap-2">
          <Select value={selectValue} onValueChange={setSelectValue}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Pick one" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="apple">Apple</SelectItem>
              <SelectItem value="banana">Banana</SelectItem>
              <SelectItem value="cherry">Cherry</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={selectValue}
            onValueChange={setSelectValue}
            open={forcedSelectOpen}
            onOpenChange={setForcedSelectOpen}
          >
            <SelectTrigger className="w-40" data-testid="select-forced-open">
              <SelectValue placeholder="Pick one" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="apple">Apple</SelectItem>
              <SelectItem value="banana">Banana</SelectItem>
              <SelectItem value="cherry">Cherry</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      <section data-testid="section-inputs" className="flex flex-col gap-2">
        <SectionHeader>6. Inputs</SectionHeader>
        <div className="grid max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
          <Input placeholder="Default" />
          <Input placeholder="Auto-focus" autoFocus />
          <Input placeholder="Disabled" disabled />
          <Input
            placeholder="Error"
            aria-invalid="true"
            defaultValue="Bad value"
          />
        </div>
      </section>

      <section data-testid="section-textarea" className="flex flex-col gap-2">
        <SectionHeader>7. Textarea</SectionHeader>
        <Textarea
          className="max-w-xl"
          placeholder="Multiline input"
          defaultValue={"Line one\nLine two\nLine three"}
        />
      </section>

      <section data-testid="section-tabs" className="flex flex-col gap-2">
        <SectionHeader>8. Tabs</SectionHeader>
        <Tabs defaultValue="one" className="max-w-md">
          <TabsList>
            <TabsTrigger value="one">One</TabsTrigger>
            <TabsTrigger value="two">Two</TabsTrigger>
            <TabsTrigger value="three">Three</TabsTrigger>
          </TabsList>
          <TabsContent value="one" className="rounded-md border border-border p-3 text-sm">
            Content for tab one.
          </TabsContent>
          <TabsContent value="two" className="rounded-md border border-border p-3 text-sm">
            Content for tab two.
          </TabsContent>
          <TabsContent value="three" className="rounded-md border border-border p-3 text-sm">
            Content for tab three.
          </TabsContent>
        </Tabs>
      </section>

      <section data-testid="section-toast" className="flex flex-col gap-2">
        <SectionHeader>9. Toast</SectionHeader>
        <div className="flex max-w-xl flex-col gap-2">
          <PreviewToast variant="info">Heads-up — your task started.</PreviewToast>
          <PreviewToast variant="warning">Approaching budget limit.</PreviewToast>
          <PreviewToast variant="success">Run completed.</PreviewToast>
          <PreviewToast variant="error">Run failed: timeout.</PreviewToast>
        </div>
      </section>

      <section data-testid="section-skeleton" className="flex flex-col gap-2">
        <SectionHeader>10. Skeleton</SectionHeader>
        <div className="flex max-w-xl flex-col gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-6 w-72" />
        </div>
      </section>

      <section data-testid="section-badge" className="flex flex-col gap-2">
        <SectionHeader>11. Badge</SectionHeader>
        <div className="flex flex-wrap gap-2">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="destructive">Destructive</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="ghost">Ghost</Badge>
        </div>
      </section>

      <section data-testid="section-switch" className="flex flex-col gap-2">
        <SectionHeader>12. Switch</SectionHeader>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <PreviewSwitch checked={switchOn} onCheckedChange={setSwitchOn} />
            On
          </label>
          <label className="flex items-center gap-2 text-sm">
            <PreviewSwitch checked={false} onCheckedChange={() => {}} />
            Off
          </label>
        </div>
      </section>

      <section data-testid="section-checkbox" className="flex flex-col gap-2">
        <SectionHeader>13. Checkbox</SectionHeader>
        <div className="flex items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox
              checked={indeterminateChecked}
              onCheckedChange={(v) => {
                if (v === "indeterminate") setCheckedState("indeterminate");
                else setCheckedState(v ? "checked" : "unchecked");
              }}
            />
            {checkedState}
          </label>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCheckedState("checked")}
          >
            Check
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCheckedState("unchecked")}
          >
            Uncheck
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCheckedState("indeterminate")}
          >
            Indeterminate
          </Button>
          {/* A second always-rendered checkbox so the indeterminate dash
              isn't the only checkbox under test in the unit assertion. */}
          <Checkbox checked={false} aria-label="static-unchecked" />
          <Checkbox
            checked="indeterminate"
            aria-label="static-indeterminate"
          />
        </div>
      </section>

      <section data-testid="section-radio" className="flex flex-col gap-2">
        <SectionHeader>14. RadioGroup</SectionHeader>
        <PreviewRadioGroup value={radio} onValueChange={setRadio} />
      </section>

      <section data-testid="section-slider" className="flex max-w-xl flex-col gap-2">
        <SectionHeader>15. Slider</SectionHeader>
        <PreviewSlider value={slider} onValueChange={setSlider} />
        <span className="mono text-xs text-muted-foreground">
          value: {slider[0]}
        </span>
      </section>

      {/* M22 slice 02 / T05 — preview surface for the .editor-line / .ln /
          .tok-* / .diff-* utilities ported verbatim from the prototype
          (docs/prototypes/*.html lines 33–43). The first two rows exercise
          token colour spans on a normal hovered editor row; the second two
          exercise the diff-add / diff-rem background + gutter-marker
          combination. */}
      <section
        data-testid="section-editor-utilities"
        className="flex max-w-2xl flex-col gap-2"
      >
        <SectionHeader>16. Editor / token / diff utilities</SectionHeader>
        <div
          className="mono overflow-hidden rounded-md border border-border bg-card text-sm"
          data-testid="editor-utilities-block"
        >
          <div className="editor-line" data-testid="editor-line-token-1">
            <span className="ln">1</span>
            <span>
              <span className="tok-kw">function</span>{" "}
              <span className="tok-fn">greet</span>
              {"("}
              <span className="tok-type">name</span>
              {": "}
              <span className="tok-type">string</span>
              {") {"}
            </span>
          </div>
          <div className="editor-line" data-testid="editor-line-token-2">
            <span className="ln">2</span>
            <span>
              {"  "}
              <span className="tok-com">// answer = 42</span>{" "}
              <span className="tok-kw">return</span>{" "}
              <span className="tok-str">"hello, "</span> + name +{" "}
              <span className="tok-num">42</span>;
            </span>
          </div>
          <div
            className="editor-line diff-add"
            data-testid="editor-line-diff-add"
          >
            <span className="ln diff-add-marker">+</span>
            <span>
              <span className="tok-kw">const</span> answer ={" "}
              <span className="tok-num">42</span>;
            </span>
          </div>
          <div
            className="editor-line diff-rem"
            data-testid="editor-line-diff-rem"
          >
            <span className="ln diff-rem-marker">-</span>
            <span>
              <span className="tok-kw">const</span> answer ={" "}
              <span className="tok-num">41</span>;
            </span>
          </div>
        </div>
      </section>

      {/* Activity affordances — three pulse dots (running / waiting / idle)
          plus one agent-glow block over a sample assistant message. The
          underlying CSS lives in `index.css` (see `@keyframes pulse-dot`
          and `@keyframes glow`). The Playwright reduced-motion spec
          asserts `el.getAnimations().length === 0` against `.pulse-dot`
          when the browser context advertises `reducedMotion: 'reduce'`. */}
      <section
        data-testid="section-activity"
        className="flex max-w-xl flex-col gap-3"
      >
        <SectionHeader>17. Activity affordances</SectionHeader>
        <div
          className="flex items-center gap-6"
          data-testid="activity-dots"
        >
          <span className="flex items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              data-testid="dot-running"
              className="pulse-dot inline-block size-2.5 rounded-full bg-emerald-500"
            />
            running
          </span>
          <span className="flex items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              data-testid="dot-waiting"
              className="pulse-dot inline-block size-2.5 rounded-full bg-amber-500"
            />
            waiting
          </span>
          <span className="flex items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              data-testid="dot-idle"
              className="pulse-dot inline-block size-2.5 rounded-full bg-zinc-400 dark:bg-zinc-500"
            />
            idle
          </span>
        </div>
        <div
          data-testid="agent-glow-sample"
          className="agent-glow rounded-md border border-border bg-card px-4 py-3 text-sm"
        >
          <span className="mono text-xs text-muted-foreground">agent</span>
          <p className="mt-1 text-foreground">
            Spinning up a fresh worktree and running the smoke tier — back
            in a few seconds.
          </p>
        </div>
      </section>

      {/* Custom utilities preview — exercises `.divider-y` (auto-themed
          hairline that re-tints with light/dark) and `.mono` (JetBrains
          Mono Variable + ligature reset) on a representative sample.
          Three rows are stacked with `border-b divider-y`; the trailing
          row drops `border-b` so the section doesn't end with a dangling
          rule. The mono span renders a version + ISO timestamp so the
          screenshot baseline catches a real glyph mix (digits, punctuation,
          uppercase/lowercase letters, dot operator). */}
      <section
        data-testid="section-custom-utilities"
        className="flex max-w-xl flex-col gap-2"
      >
        <SectionHeader>18. Custom utilities → divider-y / mono</SectionHeader>
        <div
          className="rounded-md border border-border"
          data-testid="divider-y-stack"
        >
          <div className="border-b divider-y px-3 py-2 text-sm">
            Row one — themed via <code className="mono">var(--border)</code>.
          </div>
          <div className="border-b divider-y px-3 py-2 text-sm">
            Row two — toggle the theme to verify the divider re-tints.
          </div>
          <div className="px-3 py-2 text-sm">
            Row three — last row, no trailing divider.
          </div>
        </div>
        <span className="mono" data-testid="mono-sample">
          v0.0.4 · 2024-05-07T14:32:11Z
        </span>
      </section>

      {/* Surface-polish utilities — `.card-hover` and `.tab-active`.

          The card mounts with a baseline border + bg so the hover transition
          has a visible starting state for `border-color` to interpolate from
          and the indigo glow has a surface to land on. The tab strip mounts
          with a real bottom border so the ::after underline pinned to
          `bottom: -1px` overlaps it — the whole reason the brief forbids
          `border-b-2` for activation (a real bottom border would push the
          tab content up by 2px on selection). Playwright captures both:
          the e2e spec hovers the card via `hover()` then snapshots the
          lift, and snapshots the tab strip statically since the active tab
          has `aria-selected="true"` from mount. */}
      <section
        data-testid="section-utilities"
        className="flex max-w-xl flex-col gap-3"
      >
        <SectionHeader>19. Surface-polish utilities</SectionHeader>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div
            data-testid="utility-card-hover"
            className="card-hover cursor-pointer rounded-lg border border-border bg-card p-4 text-card-foreground"
          >
            <div className="text-sm font-medium">Hoverable card</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Hover to see the -1px lift, indigo border at 50% alpha, and
              indigo glow shadow — all three transitioning together over
              150ms.
            </p>
          </div>
          <div
            data-testid="utility-tab-strip"
            role="tablist"
            className="flex items-end gap-4 self-end border-b border-border"
          >
            <button
              type="button"
              role="tab"
              aria-selected="true"
              data-testid="utility-tab-active"
              className="tab-active px-1 pb-2 text-sm font-medium text-foreground"
            >
              Active
            </button>
            <button
              type="button"
              role="tab"
              aria-selected="false"
              className="px-1 pb-2 text-sm text-muted-foreground"
            >
              Two
            </button>
            <button
              type="button"
              role="tab"
              aria-selected="false"
              className="px-1 pb-2 text-sm text-muted-foreground"
            >
              Three
            </button>
          </div>
        </div>
      </section>

      {/* Sparkbar + bar chart-strip utilities. Two strips share the section
          so a single screenshot diff captures both:
            - the sparkline row inherits its tone from the parent
              `text-emerald-500` span (proves `currentColor` wiring — if a
              regression hard-codes a fill, the strip stops following the
              parent's text-* class),
            - the column-bar row exercises both gradient endpoints — the
              `.light .bar` override is what the theme toggle flips between.

          Heights are intentionally non-uniform so a regression that drops
          a property (e.g. `vertical-align: bottom` on `.sparkbar`) reads
          visually as a baseline shift rather than as a text-positioning
          glitch hidden inside a uniform row. */}
      <section
        data-testid="section-chart-strips"
        className="flex max-w-xl flex-col gap-3"
      >
        <SectionHeader>20. Sparkbar / bar</SectionHeader>
        <div
          className="flex h-12 items-end gap-0 text-emerald-500"
          data-testid="sparkbar-row"
        >
          {[8, 14, 22, 30, 18, 26, 34, 12].map((h, i) => (
            <span
              key={i}
              className="sparkbar"
              style={{ height: `${h}px` }}
              data-testid={`sparkbar-${i}`}
            />
          ))}
        </div>
        <div
          className="flex h-24 items-end gap-3"
          data-testid="bar-row"
        >
          {[36, 64, 88].map((h, i) => (
            <div
              key={i}
              className="bar w-8"
              style={{ height: `${h}px` }}
              data-testid={`bar-${i}`}
            />
          ))}
        </div>
      </section>

      {/* KpiTile primitive (M22 slice 02 / T05).

          Five tiles cover the full prop matrix in a single screenshot:
          (1) plain numeric value with positive trend pill,
          (2) abbreviated value (412K) with sparkbar + neutral trend,
          (3) progress bar with hint ("$5 / $20 budget") — gradient tone,
          (4) danger tone — Failed 24h shape used in M23,
          (5) undefined value — em-dash placeholder, mono variant.

          Layout: a 5-up grid that wraps to 2 columns on narrow viewports
          so every prop combination stays on-screen at the visual baseline. */}
      <section
        data-testid="section-kpi-tile"
        className="flex flex-col gap-2"
      >
        <SectionHeader>21. KpiTile</SectionHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <KpiTile
            label="Active runs"
            value={3}
            trend={{ delta: "+2 today", tone: "positive" }}
          />
          <KpiTile
            label="Tokens 24h"
            value={412_000}
            spark={[8, 14, 22, 30, 18, 26, 34, 12]}
            trend={{ delta: "no change", tone: "neutral" }}
            mono
          />
          <KpiTile
            label="Spend today"
            value="$5.20"
            hint="$20 budget"
            progress={{ value: 5, max: 20, tone: "gradient" }}
          />
          <KpiTile
            label="Failed 24h"
            value={2}
            tone="danger"
            trend={{ delta: "+1 today", tone: "negative" }}
          />
          <KpiTile
            label="Last cost"
            value={undefined}
            mono
            hint="no runs yet"
          />
        </div>
      </section>

      {/* Design primitives — comprehensive variant grid for the M22 design
          system primitives. Bundled into a single section so the
          `npm run e2e:update`-blessed baseline can diff every primitive at
          every documented variant in one shot.

          Section is keyed by `data-testid="primitives-section"` so the
          Playwright spec can scope its screenshot to this surface only,
          per the task brief — full-page baselines already cover the same
          DOM via the global tokens-preview-{light,dark}.png screenshots,
          so this scoped capture is what re-blesses cleanly when only a
          design primitive changes. */}
      <section
        data-testid="primitives-section"
        className="flex flex-col gap-6 rounded-xl border border-border bg-background p-5"
      >
        <DesignSectionHeader
          title="Design primitives"
          subtitle="One example of every primitive at every documented variant."
          size="page"
          data-testid="primitives-page-header"
        />

        {/* KpiTile — 5 variants (number, mono number, with sparkbar, with
            progress, with delta). The order matches the brief's bullet
            list 1:1 so a side-by-side review matches the spec doc. */}
        <div data-testid="primitives-kpi-tile" className="flex flex-col gap-2">
          <DesignSectionHeader
            title="KpiTile"
            subtitle="5 variants"
            size="section"
            leadingSwatch="bg-indigo-500"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <KpiTile label="Active runs" value={3} />
            <KpiTile label="Tokens 24h" value={412_000} mono />
            <KpiTile
              label="Throughput"
              value={128}
              spark={[8, 14, 22, 30, 18, 26, 34, 12]}
            />
            <KpiTile
              label="Spend today"
              value="$5.20"
              hint="$20 budget"
              progress={{ value: 5, max: 20, tone: "gradient" }}
            />
            <KpiTile
              label="Cost 24h"
              value={42}
              trend={{ delta: "+12% wow", tone: "positive" }}
            />
          </div>
        </div>

        {/* FlatCard — default + interactive + with footer. */}
        <div data-testid="primitives-flat-card" className="flex flex-col gap-2">
          <DesignSectionHeader
            title="FlatCard"
            subtitle="default · interactive · with footer"
            size="section"
            leadingSwatch="bg-zinc-500"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <FlatCard className="px-4 py-3">
              <div className="text-sm font-medium">Default</div>
              <p className="text-xs text-muted-foreground">
                Flat surface, no hover affordance.
              </p>
            </FlatCard>
            <FlatCard
              interactive
              onClick={() => {}}
              className="px-4 py-3"
            >
              <div className="text-sm font-medium">Interactive</div>
              <p className="text-xs text-muted-foreground">
                Hover lifts; Enter/Space activates.
              </p>
            </FlatCard>
            <FlatCard
              className="px-4 py-3"
              footer={
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Footer</span>
                  <Button size="sm" variant="ghost">
                    Action
                  </Button>
                </div>
              }
            >
              <div className="text-sm font-medium">With footer</div>
              <p className="text-xs text-muted-foreground">
                Top hairline divider separates the footer.
              </p>
            </FlatCard>
          </div>
        </div>

        {/* StatusPill — every tone in the shared semantic palette. */}
        <div data-testid="primitives-status-pill" className="flex flex-col gap-2">
          <DesignSectionHeader
            title="StatusPill"
            subtitle="success · warning · danger · info · neutral"
            size="section"
            leadingSwatch="bg-emerald-500"
          />
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                "success",
                "warning",
                "danger",
                "info",
                "neutral",
              ] as StatusPillTone[]
            ).map((tone) => (
              <StatusPill key={tone} tone={tone}>
                {tone}
              </StatusPill>
            ))}
          </div>
        </div>

        {/* SegmentToggle — 2-option + 3-option in uncontrolled mode. */}
        <div
          data-testid="primitives-segment-toggle"
          className="flex flex-col gap-2"
        >
          <DesignSectionHeader
            title="SegmentToggle"
            subtitle="2-option · 3-option"
            size="section"
            leadingSwatch="bg-violet-500"
          />
          <div className="flex flex-wrap items-center gap-3">
            <SegmentToggle
              aria-label="View mode"
              options={[
                { value: "list", label: "List" },
                { value: "grid", label: "Grid" },
              ]}
              defaultValue="list"
              data-testid="primitives-segment-2"
            />
            <SegmentToggle
              aria-label="Range"
              options={[
                { value: "24h", label: "24h" },
                { value: "7d", label: "7d" },
                { value: "30d", label: "30d" },
              ]}
              defaultValue="7d"
              data-testid="primitives-segment-3"
            />
          </div>
        </div>

        {/* SectionHeader — page + section sizes nested for visual diff. */}
        <div
          data-testid="primitives-section-header"
          className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
        >
          <DesignSectionHeader
            title="SectionHeader"
            subtitle="page · section"
            size="section"
            leadingSwatch="bg-amber-500"
          />
          <DesignSectionHeader
            title="Page heading"
            subtitle="Used as the top-of-page title block."
            size="page"
            data-testid="primitives-section-header-page"
          />
          <DesignSectionHeader
            title="Section heading"
            subtitle="12 items"
            size="section"
            leadingSwatch="bg-indigo-500"
            data-testid="primitives-section-header-section"
          />
        </div>

        {/* LiveDot — idle + live + error in a single row. */}
        <div data-testid="primitives-live-dot" className="flex flex-col gap-2">
          <DesignSectionHeader
            title="LiveDot"
            subtitle="idle · live · error"
            size="section"
            leadingSwatch="bg-emerald-500"
          />
          <div className="flex items-center gap-6 text-sm">
            <span className="flex items-center gap-2">
              <LiveDot state="idle" />
              idle
            </span>
            <span className="flex items-center gap-2">
              <LiveDot state="live" />
              live
            </span>
            <span className="flex items-center gap-2">
              <LiveDot state="error" />
              error
            </span>
          </div>
        </div>

        {/* Sparkbar — four series at different densities (4 / 8 / 12 / 24
            bars) plus four distinct tones, so a single screenshot exercises
            every tone-class branch and the maxBars slicing window. */}
        <div data-testid="primitives-sparkbar" className="flex flex-col gap-2">
          <DesignSectionHeader
            title="Sparkbar"
            subtitle="4 series · varying density"
            size="section"
            leadingSwatch="bg-rose-500"
          />
          <div className="flex flex-wrap items-end gap-6">
            <Sparkbar
              data={[6, 18, 10, 22]}
              tone="emerald"
              data-testid="primitives-sparkbar-4"
            />
            <Sparkbar
              data={[8, 14, 22, 30, 18, 26, 34, 12]}
              tone="indigo"
              data-testid="primitives-sparkbar-8"
            />
            <Sparkbar
              data={[4, 9, 16, 22, 18, 26, 30, 24, 12, 8, 20, 28]}
              tone="amber"
              maxBars={12}
              data-testid="primitives-sparkbar-12"
            />
            <Sparkbar
              data={[
                4, 8, 6, 12, 10, 18, 14, 22, 20, 28, 24, 30, 26, 32, 28, 34,
                30, 26, 22, 28, 18, 24, 12, 16,
              ]}
              tone="rose"
              maxBars={24}
              data-testid="primitives-sparkbar-24"
            />
          </div>
        </div>
      </section>
    </div>
  );
}
