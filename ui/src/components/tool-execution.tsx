import { useState } from "react";
import { ChevronRight, Loader2, Check, X, Wrench } from "lucide-react";

export interface ToolExecution {
  id: string;
  name: string;
  input: unknown;
  status: "pending" | "success" | "error";
  result?: Record<string, unknown> | string;
  error?: string;
}

export function ToolExecutionItem({ tool }: { tool: ToolExecution }) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = tool.status === "pending"
    ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
    : tool.status === "success"
    ? <Check className="h-3 w-3 text-green-500" />
    : <X className="h-3 w-3 text-destructive" />;

  return (
    <div className="rounded border border-border text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1 hover:bg-accent/50"
        onClick={() => setExpanded(v => !v)}
      >
        <ChevronRight className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
        <Wrench className="h-3 w-3 text-muted-foreground" />
        <span className="font-medium">{tool.name}</span>
        <span className="ml-auto">{statusIcon}</span>
      </button>
      {expanded && (
        <div className="border-t border-border px-2 py-1.5 space-y-1">
          {tool.input != null && (
            <div>
              <span className="text-muted-foreground">Input:</span>
              <pre className="mt-0.5 max-h-32 overflow-auto rounded bg-muted p-1 text-[10px]">
                {typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.result != null && (
            <div>
              <span className="text-muted-foreground">Result:</span>
              <pre className="mt-0.5 max-h-32 overflow-auto rounded bg-muted p-1 text-[10px]">
                {typeof tool.result === "string" ? tool.result : JSON.stringify(tool.result, null, 2)}
              </pre>
            </div>
          )}
          {tool.error != null && (
            <div>
              <span className="text-destructive">Error:</span>
              <pre className="mt-0.5 max-h-32 overflow-auto rounded bg-destructive/10 p-1 text-[10px] text-destructive">
                {tool.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
