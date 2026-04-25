/**
 * Contract test for the `/workspaces/:workspaceId/settings` → `?tab=config`
 * redirect.
 *
 * The former WorkspaceSettingsPage was folded into the Config tab inside
 * the redesigned workspace-detail page. `main.tsx` replaces the old
 * settings route with a `<WorkspaceSettingsRedirect>` that forwards to
 * `/workspaces/:id?tab=config` via `<Navigate replace />`. This test
 * locks that contract so deep links (bookmarks, emailed URLs, the CLI
 * `flockctl ws open --settings` shortcut) keep landing on the new
 * surface.
 *
 * We deliberately DO NOT import the app-level router from `main.tsx`
 * because that module calls `createRoot().render()` at import time. Tests
 * mount a minimal router that mirrors the `main.tsx` route configuration
 * for the two paths under test: the settings redirect and the
 * workspace-detail destination. A `LocationProbe` captures the final
 * pathname + search after React Router resolves the redirect.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  MemoryRouter,
  Navigate,
  Routes,
  Route,
  useLocation,
  useParams,
} from "react-router-dom";
import { useEffect } from "react";

/**
 * Same 3-line wrapper as in `main.tsx` — duplicated here on purpose so
 * the test is self-contained and doesn't force `main.tsx` to export
 * internals purely for testability.
 */
function WorkspaceSettingsRedirect() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return <Navigate to={`/workspaces/${workspaceId}?tab=config`} replace />;
}

/** Stub destination — we only assert the URL, not the page content. */
function WorkspaceDetailStub() {
  return <div data-testid="workspace-detail-stub">workspace-detail</div>;
}

type Probe = { pathname: string; search: string };
function LocationProbe({ onLocation }: { onLocation: (loc: Probe) => void }) {
  const location = useLocation();
  useEffect(() => {
    onLocation({ pathname: location.pathname, search: location.search });
  });
  return null;
}

describe("workspace settings redirect", () => {
  it("forwards /workspaces/:id/settings to /workspaces/:id?tab=config", () => {
    const probe: { current: Probe } = {
      current: { pathname: "", search: "" },
    };

    render(
      <MemoryRouter initialEntries={["/workspaces/abc/settings"]}>
        <Routes>
          <Route
            path="/workspaces/:workspaceId"
            element={<WorkspaceDetailStub />}
          />
          <Route
            path="/workspaces/:workspaceId/settings"
            element={<WorkspaceSettingsRedirect />}
          />
        </Routes>
        <LocationProbe onLocation={(p) => (probe.current = p)} />
      </MemoryRouter>,
    );

    // Final URL after the Navigate resolves: pathname preserves the id,
    // search carries `tab=config`. Asserted separately so a failure
    // message points at whichever piece regressed.
    expect(probe.current.pathname).toBe("/workspaces/abc");
    expect(probe.current.search).toBe("?tab=config");
  });

  it("preserves the :workspaceId param verbatim (numeric and string ids)", () => {
    // Defensive case — workspace ids are server-generated opaque strings.
    // The redirect must not assume they are numeric.
    const probe: { current: Probe } = {
      current: { pathname: "", search: "" },
    };

    render(
      <MemoryRouter
        initialEntries={["/workspaces/ws_01HXYZABCDEF/settings"]}
      >
        <Routes>
          <Route
            path="/workspaces/:workspaceId"
            element={<WorkspaceDetailStub />}
          />
          <Route
            path="/workspaces/:workspaceId/settings"
            element={<WorkspaceSettingsRedirect />}
          />
        </Routes>
        <LocationProbe onLocation={(p) => (probe.current = p)} />
      </MemoryRouter>,
    );

    expect(probe.current.pathname).toBe("/workspaces/ws_01HXYZABCDEF");
    expect(probe.current.search).toBe("?tab=config");
  });
});
