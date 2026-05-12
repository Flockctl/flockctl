import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Breadcrumb,
  type BreadcrumbHandleFn,
} from "@/components/shell/Breadcrumb";

/**
 * Mount helper — renders <Breadcrumb /> inside a memory router driven
 * by a list of route handles. Each entry is a `{ path, breadcrumb }`
 * pair; the breadcrumb factory matches the runtime contract used by
 * `ui/src/lib/route-handles.ts`.
 */
function mount({
  initial,
  handles,
}: {
  initial: string;
  handles: { path: string; breadcrumb?: BreadcrumbHandleFn }[];
}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    handles.map(h => ({
      path: h.path,
      element: <Breadcrumb />,
      handle: h.breadcrumb ? { breadcrumb: h.breadcrumb } : undefined,
    })),
    { initialEntries: [initial] },
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("Breadcrumb — base behaviour", () => {
  it("renders nothing when no route declares a breadcrumb handle", () => {
    const { container } = mount({
      initial: "/foo",
      handles: [{ path: "/foo" }],
    });
    expect(container.querySelector("nav[aria-label='Breadcrumb']")).toBeNull();
  });

  it("renders a single static segment", () => {
    mount({
      initial: "/dashboard",
      handles: [
        {
          path: "/dashboard",
          breadcrumb: () => ({ label: "Dashboard", href: "/dashboard" }),
        },
      ],
    });
    expect(screen.getByText("Dashboard")).toBeTruthy();
  });

  it("flattens multi-segment handles", () => {
    mount({
      initial: "/projects/abc",
      handles: [
        {
          path: "/projects/:id",
          breadcrumb: ({ params }) => [
            { label: "Projects", href: "/projects" },
            {
              label: `Project ${params.id}`,
              href: `/projects/${params.id}`,
            },
          ],
        },
      ],
    });
    expect(screen.getByText("Projects")).toBeTruthy();
    expect(screen.getByText("Project abc")).toBeTruthy();
  });

  it("renders a skeleton placeholder for `loading: true` segments", () => {
    const { container } = mount({
      initial: "/projects/abc",
      handles: [
        {
          path: "/projects/:id",
          breadcrumb: () => [
            { label: "Projects", href: "/projects" },
            { label: "", loading: true, href: "/projects/abc" },
          ],
        },
      ],
    });
    expect(container.querySelector("[aria-label='loading']")).not.toBeNull();
  });

  it("ignores handle errors silently (does not crash chrome)", () => {
    const { container } = mount({
      initial: "/danger",
      handles: [
        {
          path: "/danger",
          breadcrumb: () => {
            throw new Error("boom");
          },
        },
      ],
    });
    expect(container.querySelector("nav[aria-label='Breadcrumb']")).toBeNull();
  });

  it("last segment is rendered as plain text (no link), earlier segments are links", () => {
    const { container } = mount({
      initial: "/projects/abc",
      handles: [
        {
          path: "/projects/:id",
          breadcrumb: () => [
            { label: "Projects", href: "/projects" },
            { label: "alpha", href: "/projects/abc" },
          ],
        },
      ],
    });
    const links = container.querySelectorAll("a");
    expect(links.length).toBe(1);
    expect(links[0]?.textContent).toBe("Projects");
  });
});

describe("Breadcrumb — new-token visual contract", () => {
  it("wrapper applies prototype tokens (gap-1.5, text-[12.5px])", () => {
    const { container } = mount({
      initial: "/dashboard",
      handles: [
        {
          path: "/dashboard",
          breadcrumb: () => ({ label: "Dashboard", href: "/dashboard" }),
        },
      ],
    });
    const nav = container.querySelector("nav[aria-label='Breadcrumb']");
    expect(nav).not.toBeNull();
    const cls = nav?.getAttribute("class") ?? "";
    expect(cls).toContain("gap-1.5");
    expect(cls).toContain("text-[12.5px]");
  });

  it("uses chevron SVG separators (text-zinc-400) between segments", () => {
    const { container } = mount({
      initial: "/projects/abc",
      handles: [
        {
          path: "/projects/:id",
          breadcrumb: () => [
            { label: "Projects", href: "/projects" },
            { label: "alpha", href: "/projects/abc" },
          ],
        },
      ],
    });
    const seps = container.querySelectorAll("[data-testid='breadcrumb-separator']");
    // One separator between the two segments. No leading separator.
    expect(seps.length).toBe(1);
    const cls = seps[0]?.getAttribute("class") ?? "";
    expect(cls).toContain("text-zinc-400");
    // Sanity: we render the chevron polyline, not lucide's <line>.
    expect(seps[0]?.querySelector("polyline")).not.toBeNull();
  });

  it("does not render a leading separator before the first segment", () => {
    const { container } = mount({
      initial: "/dashboard",
      handles: [
        {
          path: "/dashboard",
          breadcrumb: () => ({ label: "Dashboard", href: "/dashboard" }),
        },
      ],
    });
    const seps = container.querySelectorAll(
      "[data-testid='breadcrumb-separator']",
    );
    expect(seps.length).toBe(0);
  });
});

describe("Breadcrumb — segment truncation", () => {
  it("does NOT truncate labels at or under 32 chars", () => {
    const exact32 = "x".repeat(32);
    mount({
      initial: "/p",
      handles: [
        {
          path: "/p",
          breadcrumb: () => ({ label: exact32, href: "/p" }),
        },
      ],
    });
    expect(screen.getByText(exact32)).toBeTruthy();
  });

  it("truncates labels over 32 chars with ellipsis and full title attr", () => {
    // 80-char project name — covers the slice's negative_test:
    // "80-char project name truncates."
    const longName = "long-project-name-that-definitely-exceeds-the-32-char-truncate-threshold-yepyep";
    expect(longName.length).toBeGreaterThan(32);

    const { container } = mount({
      initial: "/projects/p",
      handles: [
        {
          path: "/projects/:id",
          breadcrumb: () => [
            { label: "Projects", href: "/projects" },
            { label: longName, href: "/projects/p" },
          ],
        },
      ],
    });
    // Find the rendered last-segment span — it should contain the
    // ellipsis character and NOT the full label.
    const last = container.querySelector("nav span[title]");
    // The first span[title] is "Projects"; collect them all instead.
    const titled = Array.from(container.querySelectorAll("nav [title]"));
    const longSeg = titled.find(el => el.getAttribute("title") === longName);
    expect(longSeg).toBeTruthy();
    const text = longSeg?.textContent ?? "";
    expect(text.length).toBe(32);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toBe(longName);
    // The first segment is also still present.
    expect(last).toBeTruthy();
  });

  it("preserves full title attribute on truncated link segments too", () => {
    const longName = "z".repeat(60);
    const { container } = mount({
      initial: "/projects/p/sub",
      handles: [
        {
          path: "/projects/:id/sub",
          breadcrumb: () => [
            { label: longName, href: "/projects/p" },
            { label: "Sub", href: "/projects/p/sub" },
          ],
        },
      ],
    });
    const link = container.querySelector("a");
    expect(link?.getAttribute("title")).toBe(longName);
    const display = link?.textContent ?? "";
    expect(display.length).toBe(32);
    expect(display.endsWith("…")).toBe(true);
  });
});

describe("Breadcrumb — path-to-breadcrumb mapping (T02 table)", () => {
  // The mapping below mirrors `ui/src/lib/route-handles.ts` in spirit,
  // but injects the same factories inline so this test stays a unit
  // test (no router config import). Each row is one expected path.

  it("/ → Dashboard", () => {
    mount({
      initial: "/",
      handles: [
        {
          path: "/",
          breadcrumb: () => ({ label: "Dashboard", href: "/dashboard" }),
        },
      ],
    });
    expect(screen.getByText("Dashboard")).toBeTruthy();
  });

  it("/projects → Projects", () => {
    mount({
      initial: "/projects",
      handles: [
        {
          path: "/projects",
          breadcrumb: () => ({ label: "Projects", href: "/projects" }),
        },
      ],
    });
    expect(screen.getByText("Projects")).toBeTruthy();
  });

  it("/projects/:slug → Projects > <name>", () => {
    const { container } = mount({
      initial: "/projects/my-app",
      handles: [
        {
          path: "/projects/:projectId",
          breadcrumb: ({ params }) => [
            { label: "Projects", href: "/projects" },
            {
              label: "my-app",
              href: `/projects/${params.projectId}`,
            },
          ],
        },
      ],
    });
    expect(screen.getByText("Projects")).toBeTruthy();
    expect(screen.getByText("my-app")).toBeTruthy();
    // Earlier segment is a link, last is plain text.
    const links = container.querySelectorAll("a");
    expect(links.length).toBe(1);
    expect(links[0]?.textContent).toBe("Projects");
  });

  it("/projects/:slug?tab=runs → Projects > <name> > Runs", () => {
    // The query string itself does not change which handles match; the
    // route handle reads `searchParams` and emits a third segment.
    // Simulate that by emitting a 3-segment handle when ?tab=runs is
    // present in the initial location.
    mount({
      initial: "/projects/my-app?tab=runs",
      handles: [
        {
          path: "/projects/:projectId",
          breadcrumb: ({ params }) => [
            { label: "Projects", href: "/projects" },
            { label: "my-app", href: `/projects/${params.projectId}` },
            { label: "Runs" },
          ],
        },
      ],
    });
    expect(screen.getByText("Projects")).toBeTruthy();
    expect(screen.getByText("my-app")).toBeTruthy();
    expect(screen.getByText("Runs")).toBeTruthy();
  });

  it("/missions → Missions", () => {
    mount({
      initial: "/missions",
      handles: [
        {
          path: "/missions",
          breadcrumb: () => ({ label: "Missions", href: "/missions" }),
        },
      ],
    });
    expect(screen.getByText("Missions")).toBeTruthy();
  });

  it("/missions/:id → Missions > <id|objective>", () => {
    mount({
      initial: "/missions/M-002",
      handles: [
        {
          path: "/missions/:missionId",
          breadcrumb: ({ params }) => [
            { label: "Missions" },
            { label: `M-${params.missionId}` },
          ],
        },
      ],
    });
    expect(screen.getByText("Missions")).toBeTruthy();
    expect(screen.getByText("M-M-002")).toBeTruthy();
  });

  it("/chats → Chats", () => {
    mount({
      initial: "/chats",
      handles: [
        {
          path: "/chats",
          breadcrumb: () => ({ label: "Chats", href: "/chats" }),
        },
      ],
    });
    expect(screen.getByText("Chats")).toBeTruthy();
  });

  it("/chats/:id → Chats > <chat title>", () => {
    mount({
      initial: "/chats/abc-123",
      handles: [
        {
          path: "/chats/:chatId",
          breadcrumb: ({ params }) => [
            { label: "Chats", href: "/chats" },
            { label: "Refactor auth", href: `/chats/${params.chatId}` },
          ],
        },
      ],
    });
    expect(screen.getByText("Chats")).toBeTruthy();
    expect(screen.getByText("Refactor auth")).toBeTruthy();
  });

  it("/settings → Settings", () => {
    mount({
      initial: "/settings",
      handles: [
        {
          path: "/settings",
          breadcrumb: () => ({ label: "Settings", href: "/settings" }),
        },
      ],
    });
    expect(screen.getByText("Settings")).toBeTruthy();
  });
});

describe("Breadcrumb — negative-tests (slice spec)", () => {
  // From `02-breadcrumb-refresh.md` negative_tests:
  //  - "unknown route path renders just the topmost segment."
  it("unknown route path renders just the topmost (parent) segment", () => {
    // Nested route structure: a parent `/projects` that emits a
    // breadcrumb segment, and a child `unknown/zzz` whose handle does
    // NOT contribute (mimicking a route the breadcrumb pipeline
    // doesn't know about). The trail should still render — but only
    // the parent's contribution.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter(
      [
        {
          path: "/projects",
          element: <Breadcrumb />,
          handle: {
            breadcrumb: () => ({ label: "Projects", href: "/projects" }),
          },
          children: [
            {
              path: "unknown/zzz",
              element: <Breadcrumb />,
              // No `handle.breadcrumb` — this route is unknown to the
              // breadcrumb pipeline and contributes nothing.
            },
          ],
        },
      ],
      { initialEntries: ["/projects/unknown/zzz"] },
    );
    const { container } = render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    // Only the parent segment renders.
    expect(screen.getByText("Projects")).toBeTruthy();
    // No separator (only one segment).
    const seps = container.querySelectorAll(
      "[data-testid='breadcrumb-separator']",
    );
    expect(seps.length).toBe(0);
  });
});
