// --- AGENTS.md types (per-layer shape) ---
//
// The agent-guidance loader resolves three layers, merged in order:
//   1. user              — <flockctlHome>/AGENTS.md (read-only in UI)
//   2. workspace-public  — <workspacePath>/AGENTS.md (editable via workspace)
//   3. project-public    — <projectPath>/AGENTS.md (editable via project)
//
// Project routes expose only the project-scoped layer; workspace routes
// expose only the workspace-scoped layer. The "user" layer is never editable
// through the API — it's surfaced exclusively via the merged
// `/agents-md/effective` response.

export type ProjectLayer = "project-public";
export type WorkspaceLayer = "workspace-public";
export type Layer = ProjectLayer | WorkspaceLayer | "user";

export interface LayerState {
  present: boolean;
  bytes: number;
  content: string;
}

export interface ProjectAgentsMd {
  layers: Record<ProjectLayer, LayerState>;
}

export interface WorkspaceAgentsMd {
  layers: Record<WorkspaceLayer, LayerState>;
}

export interface EffectiveLayer {
  layer: string;
  path: string;
  bytes: number;
  content: string;
  truncated: boolean;
}

export interface Effective {
  layers: EffectiveLayer[];
  totalBytes: number;
  truncatedLayers: string[];
  mergedWithHeaders: string;
}

export interface PutLayerResult {
  layer: Layer;
  present: boolean;
  bytes: number;
}
