import { MessageSquare, CheckSquare, AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Presentation fragments that live on the ChatConversation page but have no
 * coupling to its state machine. Extracted here so the parent file only has
 * to orchestrate hooks + top-level JSX. Props stay minimal — these children
 * never reach back into ChatConversation's internals.
 */

export function MultiSelectBar({
  active,
  selectedCount,
  onToggle,
  onSaveAsIncident,
  onClearSelection,
}: {
  active: boolean;
  selectedCount: number;
  onToggle: () => void;
  onSaveAsIncident: () => void;
  onClearSelection: () => void;
}) {
  return (
    <>
      <div className="flex items-center border-b px-4 py-1 text-xs text-muted-foreground">
        <Button
          variant={active ? "secondary" : "ghost"}
          size="sm"
          className="ml-auto h-6 gap-1 px-2 text-[11px]"
          onClick={onToggle}
          data-testid="chat-select-mode-toggle"
        >
          <CheckSquare className="h-3 w-3" />
          {active ? "Done" : "Select"}
        </Button>
      </div>
      {active && selectedCount > 0 && (
        <div
          className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-xs dark:bg-amber-950/30"
          data-testid="chat-action-bar"
        >
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
          <span className="font-medium">
            {selectedCount} message{selectedCount === 1 ? "" : "s"} selected
          </span>
          <Button
            size="sm"
            className="ml-auto h-7 text-xs"
            onClick={onSaveAsIncident}
            data-testid="chat-save-as-incident"
          >
            Save as incident
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClearSelection}
            aria-label="Clear selection"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </>
  );
}

export function DefaultEmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground gap-3">
      <MessageSquare className="h-8 w-8" />
      <p>Start a conversation</p>
      <div className="flex flex-wrap justify-center gap-2">
        {["Explain this codebase", "Help me debug an issue", "Write tests for a module"].map(
          (prompt) => (
            <Button
              key={prompt}
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => onPick(prompt)}
            >
              {prompt}
            </Button>
          ),
        )}
      </div>
    </div>
  );
}
