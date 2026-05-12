import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FlatCard } from "@/components/design/FlatCard";
import { HelpCircle, Loader2, Send } from "lucide-react";

export interface AgentQuestionOption {
  /** Visible label and the value submitted to the agent. */
  label: string;
  /** Optional muted secondary line under the label. */
  description?: string;
  /**
   * Reserved hint string the schema (slice 00) allows the agent to attach to
   * an option — e.g. a short preview of what choosing that option will do.
   * Currently rendered as additional muted text after the description. The
   * field is accepted here so newer agent payloads don't get dropped before
   * a richer renderer lands.
   */
  preview?: string;
}

export interface AgentQuestionPromptProps {
  /** The human-readable question emitted by the agent. Rendered verbatim —
   *  React's JSX escaping handles HTML neutralization. */
  question: string;
  /** Opaque request id threaded back to `POST .../question/:requestId/answer`.
   *  Used here only to re-mount the textarea/picker when the question rotates,
   *  so an in-progress draft for an old question doesn't leak into a new one. */
  requestId: string;
  /**
   * Optional short header (≤ 40 chars per slice 00 schema bound). Rendered as
   * a small uppercase pill above the question to give the user a one-glance
   * category for the prompt ("PERMISSION", "MODEL CHOICE", …).
   */
  header?: string;
  /**
   * Optional pre-baked answer choices. When omitted or empty the prompt
   * collapses back to a single free-form input (the original UI). When
   * present, the prompt renders a radio (or checkbox, see `multiSelect`)
   * picker plus an "Other" escape hatch.
   */
  options?: AgentQuestionOption[];
  /**
   * Flip the picker from radios to checkboxes. Ignored when `options` is not
   * provided. Defaults to false (single-select).
   */
  multiSelect?: boolean;
  /**
   * Async answer submitter. The prompt stays disabled + shows a spinner until
   * the promise resolves; on rejection the inputs are re-enabled so the user
   * can retry without losing their draft.
   */
  onAnswer: (answer: string) => Promise<void>;
}

/**
 * Amber-tinted prompt block (slice 03 of 24-ui-redesign-working-surfaces /
 * 03-chat-conversation). Shows the agent's question and either:
 *
 *   - a single-line free-form `<Input>` (no `options` provided), where
 *     plain `Enter` submits the answer, or
 *   - a radio / checkbox picker over the supplied `options`, with an
 *     "Other" multi-line textarea escape hatch beneath. In picker mode
 *     plain Enter inside the multi-line override behaves normally
 *     (newline) — Cmd/Ctrl+Enter submits.
 *
 * Submit is disabled while no answer is selected/typed or while a POST is
 * in flight. The wire format is always a single string passed to
 * `onAnswer`, matching the slice 01 REST body shape `{ answer: string }`.
 */
export function AgentQuestionPrompt({
  question,
  requestId,
  header,
  options,
  multiSelect = false,
  onAnswer,
}: AgentQuestionPromptProps) {
  const hasOptions = Array.isArray(options) && options.length > 0;

  // Free-form draft — used both for the no-options branch and as the "Other"
  // override when options are present.
  const [answer, setAnswer] = useState("");
  // Single-select selected index (radio mode).
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  // Multi-select selected indices (checkbox mode), kept as a Set for O(1)
  // toggle. We render the join in the original `options` order, not in click
  // order, so the order is derived at submit time — the Set just tracks
  // membership.
  const [checked, setChecked] = useState<Set<number>>(() => new Set());

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset every input whenever the question rotates (new requestId). A stale
  // selection or typed override for a previous, already-answered question
  // would be confusing.
  useEffect(() => {
    setAnswer("");
    setSelectedIndex(null);
    setChecked(new Set());
    setError(null);
  }, [requestId]);

  // Resolve what would be submitted right now, given the current input state.
  // Rule (per slice 02 spec): the "Other" textarea always wins when filled;
  // otherwise we fall back to the selected option(s).
  const submitValue = useMemo<string | null>(() => {
    const trimmedOther = answer.trim();
    if (hasOptions) {
      if (trimmedOther.length > 0) return trimmedOther;
      if (multiSelect) {
        if (checked.size === 0) return null;
        // Comma-join is intentional and matches Claude's harness convention
        // for multi_select answers — the agent receives a single string and
        // splits on ", " to recover the individual labels.
        const ordered = options!
          .map((o, i) => (checked.has(i) ? o.label : null))
          .filter((x): x is string => x !== null);
        return ordered.join(", ");
      }
      if (selectedIndex == null) return null;
      const picked = options![selectedIndex];
      return picked ? picked.label : null;
    }
    return trimmedOther.length > 0 ? trimmedOther : null;
  }, [answer, hasOptions, multiSelect, checked, selectedIndex, options]);

  const disabled = pending || submitValue === null;

  async function handleSubmit() {
    if (disabled || submitValue === null) return;
    setPending(true);
    setError(null);
    try {
      await onAnswer(submitValue);
      // Don't clear locally — the parent is expected to unmount us once
      // `agent_question_resolved` propagates. Clearing would briefly flash
      // an empty input before unmount.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  }

  function onAnyKeyDown(e: React.KeyboardEvent) {
    // Cmd/Ctrl+Enter submits from anywhere inside the card, matching the
    // free-form branch's existing behavior.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSubmit();
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Plain Enter submits when the user is in the single-line free-form
    // input — the slice 03 contract says "Enter submits" for the input
    // path. Shift+Enter is preserved as a no-op (Inputs don't have
    // newlines; the modifier just bypasses the submit handler so the
    // event doesn't surprise screen-reader users mid-typing).
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  // Stable id base so each input/label pair gets a unique id even when
  // multiple AgentQuestionPrompts are mounted simultaneously.
  const idBase = `aq-${requestId}`;

  return (
    <FlatCard className="border-amber-500/60 bg-amber-50/60 dark:bg-amber-950/20">
      <div
        className="flex flex-col gap-3 p-4"
        data-testid="agent-question-prompt"
        onKeyDown={onAnyKeyDown}
      >
        {header && (
          <div>
            <span
              className="inline-block max-w-full truncate rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300"
              data-testid="agent-question-header"
              title={header}
            >
              {header}
            </span>
          </div>
        )}
        <div className="flex items-start gap-2">
          <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
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

        {hasOptions ? (
          <>
            <fieldset
              className="flex flex-col gap-1.5"
              disabled={pending}
              data-testid="agent-question-options"
              data-multi={multiSelect ? "true" : "false"}
            >
              <legend className="sr-only">
                {multiSelect ? "Choose one or more" : "Choose one"}
              </legend>
              {options!.map((opt, i) => {
                const inputId = `${idBase}-opt-${i}`;
                const isChecked = multiSelect
                  ? checked.has(i)
                  : selectedIndex === i;
                return (
                  <label
                    key={inputId}
                    htmlFor={inputId}
                    className="flex cursor-pointer items-start gap-2 rounded-md border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/40"
                  >
                    <input
                      id={inputId}
                      type={multiSelect ? "checkbox" : "radio"}
                      name={multiSelect ? `${idBase}-multi-${i}` : `${idBase}-single`}
                      className="mt-0.5 h-4 w-4 shrink-0"
                      checked={isChecked}
                      onChange={() => {
                        if (multiSelect) {
                          setChecked((prev) => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          });
                        } else {
                          setSelectedIndex(i);
                        }
                      }}
                      data-testid={`agent-question-option-${i}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm">{opt.label}</span>
                      {opt.description && (
                        <span className="mt-0.5 block break-words text-xs text-muted-foreground">
                          {opt.description}
                        </span>
                      )}
                      {opt.preview && (
                        <span className="mt-0.5 block break-words font-mono text-[11px] text-muted-foreground">
                          {opt.preview}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <div className="border-t pt-2">
              <Textarea
                data-testid="agent-question-textarea"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Other answer (optional)"
                rows={2}
                disabled={pending}
              />
            </div>
          </>
        ) : (
          <Input
            autoFocus
            data-testid="agent-question-textarea"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Type your answer..."
            disabled={pending}
          />
        )}

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
                Submitting...
              </>
            ) : (
              <>
                <Send className="mr-1 h-3 w-3" />
                Submit
              </>
            )}
          </Button>
        </div>
      </div>
    </FlatCard>
  );
}
