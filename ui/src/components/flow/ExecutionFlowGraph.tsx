import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
} from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import { sliceNodeTypes } from "./SliceNode";
import { useFlowData } from "./use-flow-data";
import SliceDetailPanel from "./SliceDetailPanel";
import type { ExecutionWave, ProjectTree } from "@/lib/types";

interface ExecutionFlowGraphProps {
  waves: ExecutionWave[];
  criticalPath: string[];
  currentSliceIds: string[];
  tree: ProjectTree | undefined;
  milestoneId: string;
  parallelismFactor: number;
  selectedSliceId: string | null;
  onSliceSelect: (sliceId: string | null) => void;
  sliceWorkers: Record<string, string[]>;
}

export default function ExecutionFlowGraph({
  waves,
  criticalPath,
  currentSliceIds,
  tree,
  milestoneId,
  parallelismFactor,
  selectedSliceId,
  onSliceSelect,
  sliceWorkers,
}: ExecutionFlowGraphProps) {
  const { nodes, edges } = useFlowData(
    waves,
    criticalPath,
    currentSliceIds,
    tree,
    milestoneId,
    sliceWorkers,
  );

  if (waves.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        No execution waves to display.
      </div>
    );
  }

  // Find the selected slice from tree data
  const milestone = tree?.milestones?.find((m) => m.id === milestoneId);
  const selectedSlice =
    selectedSliceId
      ? milestone?.slices?.find((s) => s.id === selectedSliceId) ?? null
      : null;

  return (
    <div className="flex gap-4 h-[500px] w-full">
      <div className="flex-1 min-w-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={sliceNodeTypes}
          onNodeClick={(_, node) =>
            onSliceSelect(node.id === selectedSliceId ? null : node.id)
          }
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
          <MiniMap />
          <Panel position="top-right">
            <Badge variant="outline" className="text-xs">
              parallelism: {parallelismFactor}
            </Badge>
          </Panel>
        </ReactFlow>
      </div>

      {selectedSlice && (
        <SliceDetailPanel
          slice={selectedSlice}
          onClose={() => onSliceSelect(null)}
          sliceWorkers={sliceWorkers[selectedSliceId!] ?? []}
        />
      )}
    </div>
  );
}
