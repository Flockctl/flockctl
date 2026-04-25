import type { McpServerConfig } from "@/lib/types";

export function McpConfigView({ config }: { config: McpServerConfig }) {
  return (
    <div className="mt-1 space-y-1 text-xs text-muted-foreground">
      <div>
        <span className="font-medium">command:</span>{" "}
        <code className="rounded bg-muted px-1 py-0.5">{config.command}</code>
      </div>
      {config.args && config.args.length > 0 && (
        <div>
          <span className="font-medium">args:</span>{" "}
          <code className="rounded bg-muted px-1 py-0.5">{config.args.join(" ")}</code>
        </div>
      )}
      {config.env && Object.keys(config.env).length > 0 && (
        <div>
          <span className="font-medium">env:</span>{" "}
          <code className="rounded bg-muted px-1 py-0.5">
            {Object.entries(config.env).map(([k, v]) => `${k}=${v}`).join(", ")}
          </code>
        </div>
      )}
    </div>
  );
}
