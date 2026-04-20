import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import { NODE_WIDTH } from "./layout";

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  pending:   { bg: "bg-gray-100 dark:bg-gray-800", border: "border-gray-400", text: "text-gray-500 dark:text-gray-400" },
  planning:  { bg: "bg-blue-100 dark:bg-blue-900/40", border: "border-blue-500", text: "text-blue-700 dark:text-blue-300" },
  active:    { bg: "bg-blue-100 dark:bg-blue-900/40", border: "border-blue-500", text: "text-blue-700 dark:text-blue-300" },
  verifying: { bg: "bg-amber-50 dark:bg-amber-900/30", border: "border-amber-500", text: "text-amber-700 dark:text-amber-300" },
  merging:   { bg: "bg-amber-50 dark:bg-amber-900/30", border: "border-amber-500", text: "text-amber-700 dark:text-amber-300" },
  completed: { bg: "bg-green-50 dark:bg-green-900/30", border: "border-green-500", text: "text-green-700 dark:text-green-300" },
  failed:    { bg: "bg-red-100 dark:bg-red-900/30",  border: "border-red-500",   text: "text-red-700 dark:text-red-300" },
  skipped:   { bg: "bg-gray-100 dark:bg-gray-800", border: "border-gray-400", text: "text-gray-400" },
};

function getColors(status: string) {
  return STATUS_COLORS[status] ?? STATUS_COLORS.pending;
}

function statusBadge(status: string) {
  switch (status) {
    case "pending":
      return <Badge variant="secondary">pending</Badge>;
    case "planning":
      return <Badge variant="secondary">planning</Badge>;
    case "active":
      return <Badge>active</Badge>;
    case "verifying":
      return <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400">verifying</Badge>;
    case "merging":
      return <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400">merging</Badge>;
    case "completed":
      return <Badge variant="outline" className="border-green-500 text-green-600 dark:text-green-400">completed</Badge>;
    case "failed":
      return <Badge variant="destructive">failed</Badge>;
    case "skipped":
      return <Badge variant="outline">skipped</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

export interface SliceNodeData {
  title: string;
  status: string;
  risk: string;
  tasksDone: number;
  tasksTotal: number;
  isCritical: boolean;
  isCurrent: boolean;
  workers: string[];
  [key: string]: unknown;
}

export type SliceNodeType = Node<SliceNodeData, "sliceNode">;

function SliceNode({ data }: NodeProps<SliceNodeType>) {
  const colors = getColors(data.status);
  const truncatedTitle =
    data.title.length > 30 ? data.title.slice(0, 28) + "..." : data.title;

  return (
    <div
      className={`relative rounded-lg border shadow-sm px-3 py-2 ${colors.bg} ${colors.border} ${colors.text} ${
        data.isCurrent ? "ring-2 ring-blue-500 animate-[pulse_2s_ease-in-out_infinite]" : ""
      }`}
      style={{ width: NODE_WIDTH }}
    >
      <Handle type="target" position={Position.Left} className="!bg-gray-400 dark:!bg-gray-500" />
      <Handle type="source" position={Position.Right} className="!bg-gray-400 dark:!bg-gray-500" />

      {data.isCritical && (
        <span className="absolute top-1.5 right-1.5 h-2.5 w-2.5 rounded-full bg-red-500" />
      )}

      <div className="flex items-center justify-between gap-1 mb-1">
        <span className="text-sm font-semibold truncate">{truncatedTitle}</span>
      </div>

      <div className="flex items-center gap-2">
        {statusBadge(data.status)}
        {data.risk && (
          <Badge variant="outline" className="text-[10px] px-1 py-0">
            {data.risk}
          </Badge>
        )}
      </div>

      <div className="text-xs mt-1 opacity-75">
        {data.tasksDone}/{data.tasksTotal} tasks
      </div>

      {data.workers.length > 0 && (
        <div
          className="text-[10px] mt-0.5 opacity-60 truncate"
          style={{ maxWidth: NODE_WIDTH - 24 }}
          title={data.workers.join(", ")}
        >
          {data.workers.join(", ")}
        </div>
      )}
    </div>
  );
}

export const sliceNodeTypes = { sliceNode: SliceNode };
