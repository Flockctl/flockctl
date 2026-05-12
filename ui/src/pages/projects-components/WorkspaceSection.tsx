import * as React from "react";

import { SectionHeader } from "@/components/design";
import type { Workspace } from "@/lib/types";
import { workspaceTone } from "@/lib/workspace-tone";

/**
 * WorkspaceSection — section heading rendered above each workspace's
 * project grid on the projects page (slice M23/03). Thin wrapper around
 * the `SectionHeader` design primitive at `size="section"`:
 *
 *   ▣  work  3 projects ───────────────────────────────────────
 *
 * The leading swatch is painted in the workspace's stable accent tone
 * (see {@link workspaceTone}) so the same workspace shows the same
 * colour in its section header, its card icons, and its recent-row
 * swatches in the sidebar. The horizontal hairline that fills the
 * remaining width comes from `SectionHeader` itself — keeping the
 * "flat, uncarded" feel of the prototype.
 *
 * Presentational only: the parent decides the project count to display
 * and owns the grid layout that follows.
 */
export interface WorkspaceSectionProps {
  /** The workspace whose name + tone the header reflects. */
  ws: Pick<Workspace, "id" | "name">;
  /** Number of projects in this workspace; rendered as the subtitle. */
  count: number;
}

export function WorkspaceSection({
  ws,
  count,
}: WorkspaceSectionProps): React.JSX.Element {
  // Tailwind needs literal class names for the JIT compiler to pick the
  // colour up at build time. The full set lives in `workspaceTone`'s
  // `TONE_ORDER`; each `bg-<tone>-400` class is also referenced from
  // sibling components (cards, pills) so the safelist is implicit.
  const swatch = `bg-${workspaceTone(ws.name)}-400`;
  return (
    <SectionHeader
      size="section"
      leadingSwatch={swatch}
      title={ws.name}
      subtitle={`${count} projects`}
      data-testid="workspace-section-header"
    />
  );
}

export default WorkspaceSection;
