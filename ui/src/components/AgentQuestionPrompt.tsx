import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { HelpCircle, Loader2, Send } from "lucide-react";

export interface AgentQuestionPromptProps {
  /** The human-readable question emitted by the agent. Rendered verbatim —
   *  React's JSX escaping handles HTML neutralization. */
  question: string;
  /** Opaque request id threaded back to `POST .../question/:requestId/answer`.
   *  Used here only to re-mount the textarea when the question rotates, so an
   *  in-progress draft for an old question doesn't leak into a new one. */
  requestId: string;
  /**
   * Async answer submitter. The prompt stays disabled + shows a spinner until
   * the promise resolves; on rejection the textarea is re-enabled so the user
   * can retry without losing their draft.
   */
  onAnswer: (answer: string) => Promise<void>;
}

/**
 * Yellow-bordered prompt block mirroring the layout of the blue-bordered
 * permission prompt in task-detail / chats. Shows the agent's question, a
 * multi-line textarea, and a Send button; Send is disabled while the
 * textarea is empty or while a POST is in flight. Visually signals the
 * waiting-for-input state without blocking the rest of the page.
 */
export function AgentQuestionPrompt({
  question,
  requestId,
  onAnswer,
}: AgentQuestionPromptProps) {
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clear the draft whenever the question rotates (new requestId). A stale
  // draft for a previous, already-answered question would be confusing.
  useEffect(() => {
    setAnswer("");
    setError(null);
  }, [requestId]);

  const disabled = pending || answer.trim().length === 0;

  async function handleSubmit() {
    if (disabled) return;
    setPending(true);
    setError(null);
    try {
      await onAnswer(answer.trim());
      // Don't clear locally — the parent is expected to unmount us once
      // `agent_question_resolved` propagates. Clearing would briefly flash
      // an empty input before unmount.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  }

  return (
    <Card
      className="border-yellow-500"
      data-testid="agent-question-prompt"
    >
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-start gap-2">
          <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600 dark:text-yellow-400" />
          <div className="flex-1 min-w-0">
            <p className="font-medium">The agent has a question</p>
            <p
              className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground"
              data-testid="agent-question-text"
            >
              {question}
            </p>
          </div>
        </div>
        <Textarea
          autoFocus
          data-testid="agent-question-textarea"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Type your answer..."
          rows={3}
          disabled={pending}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handleSubmit();
            }
          }}
        />
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            disabled={disabled}
            onClick={handleSubmit}
            data-testid="agent-question-send"
          >
            {pending ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="mr-1 h-3 w-3" />
                Send
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
