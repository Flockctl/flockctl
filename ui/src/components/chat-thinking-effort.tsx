import { Brain, ChevronDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { EffortLevel } from "@/lib/types";

/**
 * Popover control for the per-chat adaptive-thinking toggle + reasoning
 * effort picker. Rendered inline in the composer toolbar next to the model
 * / key / permission selectors.
 *
 * Shape mirrors the other toolbar controls: a compact button trigger,
 * optimistic local state in the parent, PATCH-on-change via the chat
 * mutation. The two knobs surface the SDK defaults verbatim — adaptive
 * thinking on, effort "high" — so users who leave them alone see the same
 * behavior they had before the toggle existed.
 *
 * Intentionally separate from `PermissionModeSelect` because those controls
 * are scope-sensitive (inherit from project / workspace) and this one is
 * strictly per-chat; sharing a component would have muddled both.
 */
export function ChatThinkingEffortControl({
  thinkingEnabled,
  effort,
  onThinkingChange,
  onEffortChange,
  disabled,
}: {
  thinkingEnabled: boolean;
  effort: EffortLevel | null;
  onThinkingChange: (next: boolean) => void;
  onEffortChange: (next: EffortLevel) => void;
  disabled?: boolean;
}) {
  // Fall back to the SDK's default label when no per-chat override is
  // stored — matches the server-side resolution in routes/chats/messages.ts
  // (NULL → "high"). We don't persist the default back to the DB; a null
  // value signals "follow the default" and stays writable from any path.
  const effectiveEffort: EffortLevel = effort ?? "high";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1 px-2 text-xs"
          disabled={disabled}
          data-testid="chat-thinking-effort-trigger"
          title="Adaptive thinking & effort"
        >
          <Brain className="h-3.5 w-3.5" />
          <span className="font-mono">{effectiveEffort}</span>
          {!thinkingEnabled && (
            <span className="text-muted-foreground">· off</span>
          )}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 p-2">
        <DropdownMenuLabel className="flex items-center gap-1.5 px-1">
          <Brain className="h-3.5 w-3.5" /> Adaptive thinking
        </DropdownMenuLabel>
        <div className="px-1 pb-1 text-[11px] leading-snug text-muted-foreground">
          Lets Claude decide when to think before replying — better reasoning
          on hard prompts, a bit slower and more expensive. Turn off to skip
          the thinking step entirely.
        </div>
        {/*
          Using DropdownMenuItem (not Radix Checkbox/Radio primitives) because
          the local dropdown-menu.tsx wrapper doesn't export those. onSelect
          preventDefault keeps the menu open on click so the user can tweak
          both knobs in one go.
        */}
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            onThinkingChange(!thinkingEnabled);
          }}
          data-testid="chat-thinking-toggle"
        >
          <span className="flex h-4 w-4 items-center justify-center">
            {thinkingEnabled && <Check className="h-3.5 w-3.5" />}
          </span>
          <span>Enable adaptive thinking</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="px-1">Reasoning effort</DropdownMenuLabel>
        <div className="px-1 pb-1 text-[11px] leading-snug text-muted-foreground">
          Guides how much effort Claude puts into the response. Higher = more
          thinking (when adaptive thinking is on) and deeper replies.
          <strong className="ml-1 font-medium">high</strong> is the default.
        </div>
        {EFFORT_OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            onSelect={(e) => {
              e.preventDefault();
              onEffortChange(opt.value);
            }}
            data-testid={`chat-effort-${opt.value}`}
          >
            <span className="flex h-4 w-4 items-center justify-center">
              {effectiveEffort === opt.value && <Check className="h-3.5 w-3.5" />}
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="font-mono text-xs">{opt.value}</span>
              <span className="text-[11px] text-muted-foreground">
                {opt.description}
              </span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const EFFORT_OPTIONS: Array<{ value: EffortLevel; description: string }> = [
  { value: "low", description: "Minimal thinking, fastest responses." },
  { value: "medium", description: "Moderate thinking." },
  { value: "high", description: "Deep reasoning (default)." },
  { value: "max", description: "Maximum effort — select models only." },
];
