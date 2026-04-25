import type { WorkspaceMilestoneNode } from "@/lib/types";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GitBranch, ArrowRight } from "lucide-react";

// --- Dependency Graph Card (workspace dependency-graph visualization) ---

function milestoneNodeBadge(status: string) {
  switch (status) {
    case "completed":
      return (
        <Badge variant="outline" className="border-green-500 text-green-600 dark:text-green-400">
          completed
        </Badge>
      );
    case "active":
      return <Badge>active</Badge>;
    case "pending":
      return <Badge variant="secondary">pending</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

export function DependencyGraphCard({
  graph,
}: {
  graph: { nodes: WorkspaceMilestoneNode[]; waves: string[][]; errors: string[] };
}) {
  const nodeMap = new Map(graph.nodes.map((n) => [n.milestone_id, n]));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="h-4 w-4" />
          Dependency Graph
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {graph.waves.map((waveIds, waveIdx) => (
          <div key={waveIdx}>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Wave {waveIdx + 1}
            </p>
            <div className="flex flex-wrap gap-3">
              {waveIds.map((mid) => {
                const node = nodeMap.get(mid);
                if (!node) return null;
                const deps = node.depends_on
                  .map((did) => nodeMap.get(did))
                  .filter(Boolean);
                return (
                  <div
                    key={mid}
                    className="min-w-[200px] rounded-lg border p-3 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{node.title}</span>
                      {milestoneNodeBadge(node.status)}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {node.project_name}
                    </p>
                    {deps.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        <ArrowRight className="h-3 w-3" />
                        depends on:{" "}
                        {deps.map((d, i) => (
                          <span key={d!.milestone_id}>
                            {i > 0 && ", "}
                            {d!.title}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {graph.errors.length > 0 && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="mb-1 text-xs font-medium text-destructive">
              Graph Errors
            </p>
            {graph.errors.map((err, i) => (
              <p key={i} className="text-xs text-destructive">
                {err}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
