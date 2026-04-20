import { useMemo } from "react";
import type { Node, Edge } from "@xyflow/react";
import { getLayoutedElements } from "./layout";
import type { SliceNodeData } from "./SliceNode";
import type { ExecutionWave, ProjectTree } from "@/lib/types";

export function useFlowData(
  waves: ExecutionWave[],
  criticalPath: string[],
  currentSliceIds: string[],
  tree: ProjectTree | undefined,
  milestoneId: string,
  sliceWorkers: Record<string, string[]>,
): { nodes: Node<SliceNodeData>[]; edges: Edge[] } {
  return useMemo(() => {
    const criticalSet = new Set(criticalPath);
    const currentSet = new Set(currentSliceIds);

    // Find milestone in tree to get task counts
    const milestone = tree?.milestones?.find((m) => m.id === milestoneId);

    const nodes: Node<SliceNodeData>[] = [];
    const edges: Edge[] = [];

    for (const wave of waves) {
      for (const slice of wave.slices ?? []) {
        // Look up task counts from the project tree
        const treeSlice = milestone?.slices?.find((s) => s.id === slice.id);
        const tasksTotal = treeSlice?.tasks?.length ?? 0;
        const tasksDone =
          treeSlice?.tasks?.filter((t) => t.status === "completed").length ?? 0;

        nodes.push({
          id: slice.id,
          type: "sliceNode",
          position: { x: 0, y: 0 }, // Will be set by Dagre
          data: {
            title: slice.title,
            status: slice.status,
            risk: slice.risk,
            tasksDone,
            tasksTotal,
            isCritical: criticalSet.has(slice.id),
            isCurrent: currentSet.has(slice.id),
            workers: sliceWorkers[slice.id] ?? [],
          },
        });

        // Build edges from dependencies
        if (slice.depends) {
          for (const depId of slice.depends) {
            edges.push({
              id: `${depId}->${slice.id}`,
              source: depId,
              target: slice.id,
              type: "smoothstep",
              animated: currentSet.has(slice.id),
            });
          }
        }
      }
    }

    return getLayoutedElements(nodes, edges, "LR");
  }, [waves, criticalPath, currentSliceIds, tree, milestoneId, sliceWorkers]);
}
