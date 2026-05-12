# Contributing — Flockctl UI Design

> Status: **finalised (M26 slice 03 / T02).** Started as a draft in M22 slice 02 / T07.
> Reach for this doc whenever you're adding a card, tile, pill, header,
> toggle, status indicator, or any reusable visual primitive on a page
> surface. The defaults below are deliberately opinionated — the goal of
> the UI redesign (M22–M26) is that page-level work becomes mechanical
> primitive-application, with no per-page visual decisions.

## TL;DR

- **Pages** (`ui/src/pages/**`) consume **flat primitives** from
  `@/components/design`. They MUST NOT import shadcn primitives like
  `<Card>` directly. This is enforced by an ESLint rule plus a Vitest
  fallback (`src/__tests__/lint/no-shadcn-card-on-page.test.ts`).
- **Components** (`ui/src/components/**`) MAY use shadcn primitives —
  dialogs, forms, complex Radix interactions. They're not banned, just
  scoped.
- The seven **flat design primitives** live in
  `ui/src/components/design/` and are re-exported through
  `ui/src/components/design/index.ts`. Always import via the barrel.
- Custom CSS utilities + `--*` theme variables live in
  `ui/src/index.css`. Use the named utility / variable; don't
  re-derive zinc / indigo shades in component classes.

## When to use what

### shadcn primitives — keep using them for

- **Dialogs** (`Dialog`, `AlertDialog`, `Sheet`) — modal interactions
  that need Radix focus traps, aria wiring, and portalling.
- **Forms and inputs** (`Input`, `Textarea`, `Select`, `Checkbox`,
  `Label`, `Button`) — accessible primitives with consistent focus rings
  that we'd otherwise rebuild badly.
- **Menus and overlays** (`DropdownMenu`, `ContextMenu`, `Popover`) —
  same reason; Radix gives us the keyboard model for free.
- **Tables, tabs, scroll areas** (`Table`, `Tabs`, `ScrollArea`) — used
  inside both pages and components, no per-surface look planned.
- **Skeletons, separators, progress bars** (`Skeleton`, `Separator`,
  `Progress`) — visual atoms the design primitives currently compose.

### Flat design primitives — reach for these on page surfaces

| Primitive       | Replaces / use for                                                | Path                                |
|-----------------|-------------------------------------------------------------------|-------------------------------------|
| `KpiTile`       | Top-of-page metric tiles (cost, slice count, throughput…)         | `@/components/design`               |
| `FlatCard`      | Any rectangular grouping of content — replaces shadcn `<Card>`    | `@/components/design`               |
| `StatusPill`    | Coloured rounded-full badges (success/warning/danger/info/neutral)| `@/components/design`               |
| `SegmentToggle` | 2- or 3-option segmented switches (filters, view modes, density)  | `@/components/design`               |
| `SectionHeader` | Page `<h1>` with optional subtitle + action, OR section `<h2>`    | `@/components/design`               |
| `LiveDot`       | Idle / live / error indicator dots                                | `@/components/design`               |
| `Sparkbar`      | Inline mini-bar charts beside KPI numbers                         | `@/components/design`               |

> All seven primitives ship from
> `.flockctl/plan/22-ui-redesign-foundation/02-design-primitives/`. The
> barrel re-exports the component plus its props type — pages should
> always import the named symbols from `@/components/design`.

## Do / Don't

These are the recurring mistakes the M23–M25 review pulled up. Keep them
in mind when building a new page.

```tsx
// ✅ DO — import via the barrel
import { FlatCard, StatusPill } from "@/components/design";

// ❌ DON'T — bypass the barrel; defeats the ESLint guard
import { FlatCard } from "@/components/design/FlatCard";
```

```tsx
// ❌ DON'T — use shadcn Card on a page surface
import { Card } from "@/components/ui/card";

export default function MyPage() {
  return <Card>…</Card>;
}

// ✅ DO — use FlatCard
import { FlatCard } from "@/components/design";

export default function MyPage() {
  return <FlatCard>…</FlatCard>;
}
```

```tsx
// ❌ DON'T — hard-code zinc shades for backgrounds & borders
<div className="bg-zinc-50 border-zinc-200 dark:bg-zinc-900 dark:border-zinc-800" />

// ✅ DO — use theme variables / utilities so light & dark stay aligned
<div className="bg-card border divider-y" />
```

```tsx
// ❌ DON'T — reach for ad-hoc badge HTML
<span className="rounded px-2 py-0.5 bg-emerald-100 text-emerald-700">healthy</span>

// ✅ DO — StatusPill carries the canonical tone palette
<StatusPill tone="success">healthy</StatusPill>
```

```tsx
// ❌ DON'T — reinvent a pulse-dot per page
<span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />

// ✅ DO — LiveDot ships the prefers-reduced-motion opt-out for free
<LiveDot state="live" size="sm" />
```

## Quick example

```tsx
import {
  FlatCard,
  KpiTile,
  LiveDot,
  SectionHeader,
  StatusPill,
} from "@/components/design";

export function ProjectOverview() {
  return (
    <section className="space-y-4">
      <SectionHeader
        size="page"
        title="acme-frontend"
        subtitle="Next.js • indigo-tone workspace"
        action={<StatusPill tone="success">Healthy</StatusPill>}
      />

      <div className="grid grid-cols-4 gap-3">
        <KpiTile label="Spend (24h)" value="$2.41" mono />
        <KpiTile label="Tokens"      value={142_300} mono spark={[3, 9, 12, 7, 18, 22, 30, 17]} />
        <KpiTile label="Slices"      value={6} trend={{ delta: "+2 today", tone: "positive" }} />
        <KpiTile
          label="Budget"
          value="$2.41"
          hint="/ $20"
          progress={{ value: 2.41, max: 20, tone: "indigo" }}
        />
      </div>

      <FlatCard
        footer={
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <LiveDot state="live" size="xs" /> streaming
          </div>
        }
      >
        {/* …recent runs table… */}
      </FlatCard>
    </section>
  );
}
```

## Per-primitive reference

Every component below ships from `@/components/design` (the barrel).
Import the component AND its props interface from the same path —
don't `import type … from "./KpiTile"`.

### `KpiTile`

Top-of-page metric tile. Bold compact-formatted number with an optional
trend chip, hint string, sparkbar trail, or progress bar.

```ts
interface KpiTileProps {
  label: string;
  value: string | number | undefined;        // undefined / NaN → "—"
  mono?: boolean;                             // tabular JetBrains Mono
  trend?: { delta: string; tone: 'positive' | 'negative' | 'neutral' };
  spark?: number[];                           // last 8 values used
  progress?: { value: number; max: number; tone?: 'indigo' | 'gradient' };
  hint?: string;                              // small grey text after value
  tone?: 'default' | 'danger' | 'warning';   // tints the label
}
```

```tsx
<KpiTile label="Spend" value={241} mono trend={{ delta: "+12%", tone: "positive" }} />
```

Notes: numbers ≥ 1000 use `Intl.NumberFormat` compact notation (`1.2K`,
`412K`, `1.2M`). Passing both `spark` and `progress` is a caller error —
`progress` wins and we `console.warn` once. Tile isn't clickable; wrap
in `<FlatCard interactive>` if you need that.

### `FlatCard`

The rounded-xl + hairline-bordered container that replaces shadcn
`<Card>`. Optional footer slot rendered below the divider.

```ts
interface FlatCardProps {
  interactive?: boolean;            // adds card-hover + role/tabindex
  onClick?: () => void;
  footer?: React.ReactNode;         // rendered below children, divider above
  className?: string;
  children: React.ReactNode;
}
```

```tsx
<FlatCard interactive onClick={open} footer={<span>3 runs in last hour</span>}>
  <h3>my-slice</h3>
</FlatCard>
```

When `interactive`, the card is keyboard-accessible: `role="button"`,
`tabindex={0}`, Enter / Space invoke `onClick`. Don't add those by hand
— the prop wires them.

### `StatusPill`

Small uppercase tracking-wider tone badge.

```ts
interface StatusPillProps {
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  size?: 'sm' | 'md';                // default 'md'
  children: React.ReactNode;
}
```

```tsx
<StatusPill tone="warning" size="sm">degraded</StatusPill>
```

Tone palette (15% tint background + 600/400 text in light/dark) is
fixed; don't pass arbitrary class overrides. Unknown tone falls back to
`neutral` and `console.warn`s once.

### `SegmentToggle`

2- or 3-option segmented switch. Controlled OR uncontrolled.

```ts
interface SegmentToggleProps<T extends string> {
  options: { value: T; label: string }[];
  value?: T;                         // controlled
  defaultValue?: T;                  // uncontrolled
  onChange?: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}
```

```tsx
<SegmentToggle<'cards' | 'table'>
  options={[
    { value: 'cards', label: 'Cards' },
    { value: 'table', label: 'Table' },
  ]}
  defaultValue="cards"
  onChange={setMode}
/>
```

Each option is a `<button role="radio" aria-pressed>`. ArrowLeft /
ArrowRight cycle focus among options; Enter / Space activate. Don't put
unrelated UI inside — pass labels only.

### `SectionHeader`

Page or section heading with optional subtitle and right-aligned action
slot.

```ts
interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;          // right-aligned (e.g. button, pill)
  size?: 'page' | 'section';         // default 'section'
  leadingSwatch?: string;            // optional 8px colour chip before title
}
```

```tsx
<SectionHeader
  size="page"
  title="Missions"
  subtitle="Long-running supervised plans"
  action={<Button>New mission</Button>}
/>
```

`size="page"` renders an `<h1>` (text-2xl, mb-6, with subtitle row).
`size="section"` renders an `<h2>` (text-base font-semibold, with a
trailing hairline rule that fills remaining width).

### `LiveDot`

Tiny status dot with a ping animation in the live state.

```ts
interface LiveDotProps {
  state: 'idle' | 'live' | 'error';
  size?: 'xs' | 'sm';                // xs = 6px, sm = 8px (default xs)
  pulse?: boolean;                   // override default-by-state
}
```

```tsx
<LiveDot state="live" size="sm" />
```

Default `pulse` is `state === 'live'`. The wrapper opts out under
`prefers-reduced-motion: reduce` (see the `.pulse-dot` utility in
`index.css`). Use only for liveness signals, not generic decoration.

### `Sparkbar`

Inline mini-bar chart, currentColor-driven so the parent picks the
tone via `text-{tone}-500`.

```ts
interface SparkbarProps {
  data: number[];
  tone?: 'emerald' | 'indigo' | 'amber' | 'rose';
  maxBars?: number;                  // default 8 — slices trailing
}
```

```tsx
<Sparkbar data={[3, 8, 12, 6, 14, 22, 30, 17]} tone="emerald" />
```

Empty array renders nothing. Heights scale to the [4, 28] px range.
Inside `KpiTile`, the inline variant is used directly — don't double-up.

## Custom CSS utility reference (Tailwind v4)

All defined in `ui/src/index.css`. Use these instead of redefining the
same recipe in component classes. The orphan/missing checker
(`src/__tests__/styles/css-utilities.test.ts`) walks every `@layer
utilities` block and fails CI if a utility is consumed without
definition (or defined without consumers).

| Utility               | Purpose                                                                            |
|-----------------------|------------------------------------------------------------------------------------|
| `mono`                | JetBrains Mono Variable + tabular numerals — for KPI numbers, code, IDs            |
| `divider-y`           | Border colour that resolves to `var(--border)` in both themes                      |
| `card-hover`          | Lift (-1px) + indigo border tint + indigo-tinted shadow for interactive cards      |
| `tab-active`          | 1px ::after underline pinned at `bottom: -1px` — overlaps tab strip border, no jolt|
| `pulse-dot`           | Opacity + scale dot animation; opts out under `prefers-reduced-motion`             |
| `agent-glow`          | Inset box-shadow walk on the message left rule, for active agent bubbles           |
| `mission-event-row`   | Used with `[data-fresh="true"]` for the slide-down + fade-in fresh-event animation |
| `sparkbar`            | The 3px-wide currentColor span used by `<Sparkbar>` and inline KPI sparks          |
| `bar`                 | Indigo column-bar gradient (light / dark variants) used by the tokens preview demo |
| `editor-line`         | 56px gutter + 1fr content grid row, 22px line-height — the code-mode editor rail   |
| `ln`                  | Right-aligned non-selectable line-number cell inside `.editor-line`                |
| `tok-kw / fn / str / com / num / type` | Syntax-highlight token colours (purple / blue / green / zinc / amber / pink) |
| `diff-add / diff-rem` | Tinted background + 2px coloured left rule for added / removed diff lines          |
| `diff-add-marker / diff-rem-marker` | Foreground colour for the `+` / `-` glyph in the diff gutter         |
| `chat-markdown`       | Rhythm rules for assistant-rendered markdown bubbles (substitute for `prose`)      |

## Theme variable reference

Defined in `ui/src/index.css` under `:root` (light) and `.dark` (dark).
Always reach for the variable name (`bg-card`, `text-foreground`,
`border`) instead of hard-coding zinc shades on every component — the
ThemeProvider toggles `.light` / `.dark` on the document root and these
classes auto-resolve.

| CSS variable             | Tailwind class             | Use for                                       |
|--------------------------|----------------------------|-----------------------------------------------|
| `--background`           | `bg-background`            | Outermost page surface                        |
| `--foreground`           | `text-foreground`          | Body text                                     |
| `--card`                 | `bg-card`                  | Card backgrounds (default of `<FlatCard>`)    |
| `--card-foreground`      | `text-card-foreground`     | Text inside cards                             |
| `--popover`              | `bg-popover`               | Popover, dropdown, tooltip surfaces           |
| `--primary`              | `bg-primary`               | Indigo brand colour for primary buttons / focus |
| `--primary-foreground`   | `text-primary-foreground`  | Text on `--primary`                           |
| `--secondary`            | `bg-secondary`             | Subtle filled chips (Light: zinc-100)         |
| `--muted`                | `bg-muted`                 | Subtle inset surfaces (rails, code blocks)    |
| `--muted-foreground`     | `text-muted-foreground`    | Subtitles, captions, hints                    |
| `--accent`               | `bg-accent`                | Hover state for menu items                    |
| `--destructive`          | `bg-destructive`           | Destructive action buttons, danger states     |
| `--border`               | `border`, `divider-y`      | Card borders, hairlines                       |
| `--input`                | `border-input`             | Form-control border colour                    |
| `--ring`                 | `ring`, `ring-ring`        | Focus rings                                   |
| `--sidebar*`             | `bg-sidebar`, …            | Shell sidebar surfaces (don't repurpose)      |
| `--chart-1` … `--chart-5`| `fill-chart-1`, …          | Recharts series colours                       |
| `--radius`               | `rounded-md`, `rounded-xl` | Single radius scale (sm/md/lg/xl/2xl/3xl/4xl) |

## How to add a new primitive

1. **Confirm it's worth a primitive.** Three+ existing or planned uses,
   each one a near-clone of the same JSX. One-off styling stays inline.
   If unsure, file an inline JSX usage first and promote to a primitive
   when a third caller appears.
2. **File the slice.** Add a task under
   `.flockctl/plan/22-ui-redesign-foundation/02-design-primitives/` (or
   the equivalent slice for later milestones) with: props contract,
   variant matrix, and the prototype HTML it derives from.
3. **Implement** in `ui/src/components/design/<Name>.tsx`. Export both a
   named component and named props / tone / size types alongside it.
4. **Test** at `ui/src/__tests__/components/design/<name>.test.tsx`:
   default render, every variant prop, at least one negative case
   (invalid prop → expected fallback + `console.warn`), keyboard
   accessibility for interactive surfaces.
5. **Re-export** from `ui/src/components/design/index.ts`. Always export
   the props type alongside the component (`export { Foo }; export type
   { FooProps, FooTone };`).
6. **Showcase** on `/dev/tokens-preview` — every variant, light + dark.
   Update the Playwright baselines (`ui/e2e/tokens-preview.spec.ts`)
   with `npm run e2e:update -- e2e/tokens-preview.spec.ts`.
7. **Update this doc** — add a row to the per-primitive table at the top
   AND a `### <Name>` section in the per-primitive reference, with the
   props interface and a single-line example.

## How to add a new utility

1. **Confirm it's worth a utility.** Three+ surfaces (or one surface
   that re-uses the recipe per-row, like `card-hover`). One-off CSS
   stays inline as Tailwind classes.
2. **Define inside an `@layer utilities { … }` block** in
   `ui/src/index.css`. The orphan-checker walks layer scopes — utilities
   defined outside a layer aren't seen and CI fails on first orphan.
3. **Reference theme variables**, not raw hex / zinc names. `currentColor`
   is preferred for tone-flexible utilities (`.sparkbar`, `.tab-active`).
4. **Honour `prefers-reduced-motion: reduce`** for any animation-bearing
   utility — the existing `.pulse-dot` / `.agent-glow` blocks are the
   pattern. Without the opt-out, the WCAG 2.3.3 check fails the audit.
5. **Test** at `ui/src/__tests__/styles/css-utilities.test.ts` (the
   orphan-checker auto-detects added utilities; just confirm it still
   passes after the change). For utilities with semantics (e.g.
   reduced-motion), add a focused test asserting the rule resolves.
6. **Update this doc** — add a row to the utility reference table.

## Migration notes

The M22→M26 redesign sequence is wrapping up. These notes capture the
contract that survives migration and preserves context for any future
reshaping of the primitives layer.

- **shadcn `<Card>` ban — current enforcement.** The ESLint rule in
  `ui/eslint.config.js` is currently `'warn'` (scoped to
  `src/pages/**/*.{ts,tsx}` via `no-restricted-imports`). The Vitest
  fallback in `src/__tests__/lint/no-shadcn-card-on-page.test.ts` is
  the hard gate — it carries an explicit `LEGACY_ALLOWLIST` of pages
  still on shadcn `<Card>` and asserts the list **shrinks
  monotonically**. Every page-redesign PR removes one or more entries;
  new entries are not allowed. When the allowlist hits zero (end of
  M26 cleanup): delete the allowlist branch in the test, bump the
  ESLint rule severity from `'warn'` to `'error'`, and remove this
  paragraph.
- **Old shell removal.** `OldLayout`, `ShellSwitch`, and the
  `flockctl.ui.next` feature flag are scheduled for removal in M26
  slice 01 ("old-layout-removal"). The `no-old-layout-imports` and
  `no-feature-flag-imports` lint tests under
  `ui/src/__tests__/lint/` pin the post-removal state. If you need to
  introduce a future "next-next" shell, follow the same playbook —
  flag → dual ship → flip default → strip flag — and add the
  corresponding lint test before flipping the default.
- **Visual baselines are the contract.** Every primitive variant lives
  on `/dev/tokens-preview` with light + dark Playwright baselines under
  `ui/e2e/__screenshots__/tokens-preview.spec.ts/`. A primitive change
  that re-rolls the visuals MUST refresh those baselines in the same
  PR — drift caught later is much harder to bisect.
- **Prototype is the source of truth.** When a primitive's CSS recipe
  was lifted from `.flockctl/plan/ui-prototype.html`, the recipe lines
  there are still authoritative for the Monaco theme overlay (M23) and
  any future re-skin. If a colour value needs to change, change it in
  the prototype + the primitive + the consuming utility in one PR; the
  CSS-utilities test pins this invariant.
- **Future shell rework.** If/when the shell layout is reworked again
  (post-M26), the contract for new primitives is unchanged: barrel
  re-export, props type co-located, `/dev/tokens-preview` showcase,
  light + dark baselines, this doc updated. The migration playbook is
  the same — flag → dual ship → flip → strip — and it goes through
  this file's "How to add a new primitive" section, not around it.
