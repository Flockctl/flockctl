import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";

import {
  TemplatesToolbar,
  TEMPLATES_TAG_ALL,
  filterTemplatesByTag,
  type TemplatesToolbarTag,
} from "@/pages/templates-components/TemplatesToolbar";

/**
 * Contract tests for the tag-chip portion of {@link TemplatesToolbar}
 * (slice 25-00 T01).
 *
 * Each spec covers exactly one promise from the slice:
 *
 *   - Chip row layout: `All <total>`, then one chip per distinct tag —
 *     in that order.
 *   - Default tag is `'all'` when the URL has no `?tag=`.
 *   - URL `?tag=` is the single source of truth (replace-not-push,
 *     and the canonical `all` state strips the param).
 *   - Active chip styling: `bg-zinc-200 dark:bg-zinc-800 font-medium`.
 *   - Invalid `?tag=xxx` falls back to `'all'` + `console.warn`.
 *
 * Negative tests:
 *   - clicking the All chip twice keeps All selected (no deselect).
 *   - clicking the same tag chip twice keeps it selected.
 *   - filterTemplatesByTag actually narrows the result set.
 */

// --- Router probe ------------------------------------------------------------
type Probe = { pathname: string; search: string };
function LocationProbe({ onLocation }: { onLocation: (loc: Probe) => void }) {
  const location = useLocation();
  useEffect(() => {
    onLocation({ pathname: location.pathname, search: location.search });
  });
  return null;
}

function renderWithRouter(initial: string, ui: ReactNode) {
  const probe: { current: Probe } = {
    current: { pathname: "", search: "" },
  };
  render(
    <MemoryRouter initialEntries={[initial]}>
      {ui}
      <LocationProbe onLocation={(p) => (probe.current = p)} />
    </MemoryRouter>,
  );
  return probe;
}

// --- Tag-filter harness ------------------------------------------------------
// TemplatesToolbar is intentionally presentational — it does not own the
// template list.  This harness wires the same end-to-end shape the page
// uses: chip click → onTagChange → parent partitions templates → render
// reflects the partition.

interface TestTemplate {
  id: string;
  name: string;
  tags: string[];
}

function TagHarness({
  totalCount,
  tags,
  rows,
}: {
  totalCount: number;
  tags: TemplatesToolbarTag[];
  rows: TestTemplate[];
}) {
  const [tag, setTag] = useState<string>(TEMPLATES_TAG_ALL);
  const visible = filterTemplatesByTag(rows, tag);
  return (
    <>
      <TemplatesToolbar
        totalCount={totalCount}
        tags={tags}
        onTagChange={setTag}
      />
      <ul data-testid="harness-results">
        {visible.map((t) => (
          <li key={t.id} data-testid={`row-${t.id}`}>
            {t.name}
          </li>
        ))}
      </ul>
    </>
  );
}

const SAMPLE_TAGS: TemplatesToolbarTag[] = [
  { id: "frontend", slug: "frontend", name: "frontend", count: 5 },
  { id: "backend", slug: "backend", name: "backend", count: 4 },
  { id: "ops", slug: "ops", name: "ops", count: 3 },
];

describe("TemplatesToolbar — tag chips", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Most specs don't expect warnings; tests that DO want them assert
    // explicitly. Spy is restored in afterEach so leakage doesn't cascade.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("renders All <total>, then one chip per tag — in that order", () => {
    renderWithRouter(
      "/templates",
      <TemplatesToolbar totalCount={12} tags={SAMPLE_TAGS} />,
    );

    const all = screen.getByTestId("tag-chip-all");
    const frontend = screen.getByTestId("tag-chip-frontend");
    const backend = screen.getByTestId("tag-chip-backend");
    const ops = screen.getByTestId("tag-chip-ops");

    expect(all.textContent).toBe("All 12");
    expect(frontend.textContent).toBe("frontend 5");
    expect(backend.textContent).toBe("backend 4");
    expect(ops.textContent).toBe("ops 3");

    // DOCUMENT_POSITION_FOLLOWING bit (0x04) — left node precedes right.
    expect(
      all.compareDocumentPosition(frontend) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      frontend.compareDocumentPosition(backend) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      backend.compareDocumentPosition(ops) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders 'All' without a count when totalCount is omitted", () => {
    renderWithRouter("/templates", <TemplatesToolbar tags={SAMPLE_TAGS} />);
    expect(screen.getByTestId("tag-chip-all").textContent).toBe("All");
  });

  it("omits the per-tag count when the parent didn't supply one", () => {
    renderWithRouter(
      "/templates",
      <TemplatesToolbar
        tags={[{ id: "qa", slug: "qa", name: "qa" }]}
      />,
    );
    expect(screen.getByTestId("tag-chip-qa").textContent).toBe("qa");
  });

  it("defaults to All when the URL has no ?tag=", () => {
    renderWithRouter(
      "/templates",
      <TemplatesToolbar totalCount={12} tags={SAMPLE_TAGS} />,
    );
    expect(screen.getByTestId("tag-chip-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("tag-chip-frontend")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("active chip carries bg-zinc-200 dark:bg-zinc-800 font-medium classes", () => {
    renderWithRouter(
      "/templates?tag=frontend",
      <TemplatesToolbar totalCount={12} tags={SAMPLE_TAGS} />,
    );
    const frontend = screen.getByTestId("tag-chip-frontend");
    expect(frontend).toHaveAttribute("aria-pressed", "true");
    for (const cls of ["bg-zinc-200", "dark:bg-zinc-800", "font-medium"]) {
      expect(frontend.className).toContain(cls);
    }
    // Inactive chip carries the hover-only inactive classes — explicitly
    // does NOT carry the active background.
    const all = screen.getByTestId("tag-chip-all");
    expect(all).toHaveAttribute("aria-pressed", "false");
    expect(all.className).not.toContain("bg-zinc-200");
    for (const cls of [
      "hover:bg-zinc-100",
      "dark:hover:bg-zinc-800",
      "text-zinc-600",
    ]) {
      expect(all.className).toContain(cls);
    }
  });

  it("activates the tag chip when URL holds ?tag=<slug>", () => {
    renderWithRouter(
      "/templates?tag=ops",
      <TemplatesToolbar totalCount={12} tags={SAMPLE_TAGS} />,
    );
    expect(screen.getByTestId("tag-chip-ops")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("tag-chip-all")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("clicking a tag chip writes ?tag=<slug> to URL and emits onTagChange", async () => {
    const user = userEvent.setup();
    const onTagChange = vi.fn();

    const probe = renderWithRouter(
      "/templates",
      <TemplatesToolbar
        totalCount={12}
        tags={SAMPLE_TAGS}
        onTagChange={onTagChange}
      />,
    );

    // Mount fires the synthetic "all" emission once — clear it so the
    // assertion on the click event isn't ambiguous.
    onTagChange.mockClear();

    await user.click(screen.getByTestId("tag-chip-frontend"));

    expect(probe.current.search).toContain("tag=frontend");
    expect(onTagChange).toHaveBeenLastCalledWith("frontend");
    expect(screen.getByTestId("tag-chip-frontend")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("clicking the All chip from a tag filter strips ?tag= from URL", async () => {
    const user = userEvent.setup();

    const probe = renderWithRouter(
      "/templates?tag=frontend",
      <TemplatesToolbar totalCount={12} tags={SAMPLE_TAGS} />,
    );
    expect(probe.current.search).toContain("tag=frontend");

    await user.click(screen.getByTestId("tag-chip-all"));

    // Canonical "All" state is encoded as the param being absent.
    expect(probe.current.search).not.toContain("tag=");
    expect(screen.getByTestId("tag-chip-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("preserves unrelated query params (?q=) when toggling a chip", async () => {
    const user = userEvent.setup();

    const probe = renderWithRouter(
      "/templates?q=deploy",
      <TemplatesToolbar totalCount={12} tags={SAMPLE_TAGS} />,
    );

    await user.click(screen.getByTestId("tag-chip-backend"));

    expect(probe.current.search).toContain("tag=backend");
    expect(probe.current.search).toContain("q=deploy");
  });

  it("falls back to 'all' + console.warn when ?tag= is unknown", () => {
    renderWithRouter(
      "/templates?tag=ghost-tag",
      <TemplatesToolbar totalCount={12} tags={SAMPLE_TAGS} />,
    );

    // Active chip is All — never the unknown value.
    expect(screen.getByTestId("tag-chip-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(warnSpy).toHaveBeenCalled();
    const warnArgs = warnSpy.mock.calls.flat().join(" ");
    expect(warnArgs).toContain("ghost-tag");
    expect(warnArgs).toContain("all");
  });

  it("warns at most once for the same invalid value (no per-render spam)", async () => {
    const Harness = () => {
      const [_, setTick] = useState(0);
      return (
        <>
          <TemplatesToolbar totalCount={12} tags={SAMPLE_TAGS} />
          <button
            type="button"
            data-testid="bump"
            onClick={() => setTick((t) => t + 1)}
          />
        </>
      );
    };

    const user = userEvent.setup();
    renderWithRouter("/templates?tag=ghost", <Harness />);

    // First mount — exactly one warn.
    expect(warnSpy).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("bump"));
    await user.click(screen.getByTestId("bump"));
    await act(async () => {});

    // Re-renders with the same invalid value don't re-warn.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("clicking the All chip twice keeps All selected (no deselect)", async () => {
    const user = userEvent.setup();
    const onTagChange = vi.fn();

    const probe = renderWithRouter(
      "/templates",
      <TemplatesToolbar
        totalCount={12}
        tags={SAMPLE_TAGS}
        onTagChange={onTagChange}
      />,
    );

    expect(screen.getByTestId("tag-chip-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(probe.current.search).not.toContain("tag=");

    await user.click(screen.getByTestId("tag-chip-all"));
    expect(screen.getByTestId("tag-chip-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(probe.current.search).not.toContain("tag=");

    await user.click(screen.getByTestId("tag-chip-all"));
    expect(screen.getByTestId("tag-chip-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(probe.current.search).not.toContain("tag=");
  });

  it("clicking the same tag chip twice keeps it selected (no deselect)", async () => {
    const user = userEvent.setup();

    const probe = renderWithRouter(
      "/templates",
      <TemplatesToolbar totalCount={12} tags={SAMPLE_TAGS} />,
    );

    await user.click(screen.getByTestId("tag-chip-frontend"));
    expect(screen.getByTestId("tag-chip-frontend")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(probe.current.search).toContain("tag=frontend");

    // Click again — chip stays active, URL stays at tag=frontend.
    await user.click(screen.getByTestId("tag-chip-frontend"));
    expect(screen.getByTestId("tag-chip-frontend")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(probe.current.search).toContain("tag=frontend");
  });

  it("renders chips in the order the parent supplies tags", () => {
    const reordered: TemplatesToolbarTag[] = [
      { id: "ops", slug: "ops", name: "ops", count: 3 },
      { id: "frontend", slug: "frontend", name: "frontend", count: 5 },
      { id: "backend", slug: "backend", name: "backend", count: 4 },
    ];
    renderWithRouter(
      "/templates",
      <TemplatesToolbar totalCount={12} tags={reordered} />,
    );
    const ops = screen.getByTestId("tag-chip-ops");
    const frontend = screen.getByTestId("tag-chip-frontend");
    const backend = screen.getByTestId("tag-chip-backend");

    expect(
      ops.compareDocumentPosition(frontend) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      frontend.compareDocumentPosition(backend) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("handles zero tags — only the All chip renders", () => {
    renderWithRouter(
      "/templates",
      <TemplatesToolbar totalCount={0} tags={[]} />,
    );
    expect(screen.getByTestId("tag-chip-all")).toBeInTheDocument();
    // No tag-specific chips rendered.
    expect(screen.queryByTestId(/tag-chip-(?!all$).+/)).toBeNull();
  });

  it("emits onTagChange exactly once per tag change (not on every render)", async () => {
    const user = userEvent.setup();
    const onTagChange = vi.fn();

    renderWithRouter(
      "/templates",
      <TemplatesToolbar
        totalCount={12}
        tags={SAMPLE_TAGS}
        onTagChange={onTagChange}
      />,
    );

    // Mount fires the synthetic initial emission once.
    expect(onTagChange).toHaveBeenCalledTimes(1);
    expect(onTagChange).toHaveBeenLastCalledWith(TEMPLATES_TAG_ALL);

    await user.click(screen.getByTestId("tag-chip-backend"));
    expect(onTagChange).toHaveBeenCalledTimes(2);
    expect(onTagChange).toHaveBeenLastCalledWith("backend");

    // Re-clicking the SAME chip — value is unchanged, no re-emit.
    await user.click(screen.getByTestId("tag-chip-backend"));
    expect(onTagChange).toHaveBeenCalledTimes(2);
  });

  it("filterTemplatesByTag narrows rows by tag membership", () => {
    const rows: TestTemplate[] = [
      { id: "t1", name: "alpha", tags: ["frontend"] },
      { id: "t2", name: "bravo", tags: ["backend", "ops"] },
      { id: "t3", name: "charlie", tags: ["ops"] },
      { id: "t4", name: "delta", tags: [] },
    ];

    // 'all' returns every row in original order.
    expect(filterTemplatesByTag(rows, TEMPLATES_TAG_ALL).map((r) => r.id)).toEqual(
      ["t1", "t2", "t3", "t4"],
    );

    // Single-membership filter.
    expect(filterTemplatesByTag(rows, "frontend").map((r) => r.id)).toEqual([
      "t1",
    ]);

    // Multi-membership filter — tag matches as long as it's in the row's
    // tag list.
    expect(filterTemplatesByTag(rows, "ops").map((r) => r.id)).toEqual([
      "t2",
      "t3",
    ]);

    // Case-insensitive match.
    expect(filterTemplatesByTag(rows, "OPS").map((r) => r.id)).toEqual([
      "t2",
      "t3",
    ]);

    // Unknown tag → empty (parent UI surfaces this as the empty-state).
    expect(filterTemplatesByTag(rows, "ghost").map((r) => r.id)).toEqual([]);
  });

  it("Tag chip filters the rendered set end-to-end", async () => {
    const user = userEvent.setup();
    const rows: TestTemplate[] = [
      { id: "t1", name: "deploy-frontend", tags: ["frontend"] },
      { id: "t2", name: "build-backend", tags: ["backend"] },
      { id: "t3", name: "rotate-keys", tags: ["ops"] },
      { id: "t4", name: "lint-frontend", tags: ["frontend"] },
    ];

    renderWithRouter(
      "/templates",
      <TagHarness totalCount={4} tags={SAMPLE_TAGS} rows={rows} />,
    );

    // All four rows up front (default = all).
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(4);

    await user.click(screen.getByTestId("tag-chip-frontend"));

    // Only the frontend rows survive.
    const visible = screen.getAllByTestId(/^row-/);
    expect(visible.map((el) => el.getAttribute("data-testid"))).toEqual([
      "row-t1",
      "row-t4",
    ]);
    expect(screen.queryByTestId("row-t2")).not.toBeInTheDocument();
    expect(screen.queryByTestId("row-t3")).not.toBeInTheDocument();
  });
});
