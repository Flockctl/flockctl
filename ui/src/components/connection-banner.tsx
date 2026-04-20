import { AlertTriangle, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useServerContext } from "@/contexts/server-context";

export function ConnectionBanner() {
  const { connectionStatus, activeServer, testConnection } = useServerContext();

  if (connectionStatus === "connected") return null;

  if (connectionStatus === "checking") {
    return (
      <div className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Connecting to {activeServer.name}…</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">
        Cannot reach <strong>{activeServer.name}</strong>
        {activeServer.url ? (
          <span className="ml-1 font-mono text-[11px] opacity-70">({activeServer.url})</span>
        ) : null}
        . Check that the server is running and the token is correct.
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => void testConnection()}
      >
        <RefreshCw className="h-3 w-3" />
        Retry
      </Button>
    </div>
  );
}
