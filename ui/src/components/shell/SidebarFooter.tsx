import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { fetchVersion, type VersionInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * SidebarFooter — bottom block of the new shell's sidebar.
 *
 * Renders:
 *   1. A `Settings` nav row sharing the same `nav-item` shape as the
 *      BROWSE/LIBRARY rows above (15×15 stroke-1.8 cog SVG + label).
 *   2. A muted version line — the daemon's `/meta/version` payload
 *      (or `…` while the initial fetch is in flight).
 *
 * The original prototype shipped a "user pill" here (avatar +
 * username + version). It was removed because Flockctl is single-
 * tenant local-first — an identity affordance would have been
 * decoration without information. The version string is the only
 * payload worth keeping, since it tells the operator at a glance
 * whether `make reinstall` actually picked up.
 */

const SETTINGS_ICON_PROPS = {
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
} as const;

export function SidebarFooter() {
  const [info, setInfo] = useState<VersionInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchVersion()
      .then(v => {
        if (!cancelled) setInfo(v);
      })
      .catch(() => {
        // Endpoint missing or daemon offline — render `…` quietly.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const versionLabel = info?.current ? `v${info.current}` : "…";

  return (
    <div
      data-shell-slot="sidebar-footer"
      className="px-2 pt-2 border-t divider-y"
    >
      <NavLink
        to="/settings"
        data-nav="settings"
        className={({ isActive }) =>
          cn(
            "nav-item w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] hover:bg-zinc-100 dark:hover:bg-zinc-800",
            isActive
              ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
              : "text-zinc-700 dark:text-zinc-300",
          )
        }
      >
        <svg {...SETTINGS_ICON_PROPS} aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>Settings</span>
      </NavLink>
      <div
        data-shell-slot="version-line"
        className="px-2.5 py-1.5 mt-0.5 text-[10.5px] text-zinc-500 truncate"
        title={versionLabel}
      >
        {versionLabel}
      </div>
    </div>
  );
}

export default SidebarFooter;
