import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { Button } from "@/components/ui/button";
import { Copy, Check, Loader2 } from "lucide-react";
import { MessageAttachments } from "@/components/MessageAttachments";
import { InlineDiff } from "@/components/InlineDiff";
import type { ChatMessageAttachment } from "@/lib/types";

interface ChatMessageProps {
  role: "user" | "assistant" | "system";
  content: string;
  isStreaming?: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  createdAt?: string;
  /**
   * Linked attachments rendered as a thumbnail grid beneath the bubble.
   * Only user messages ever carry a non-empty list; pass `undefined` or `[]`
   * to skip the grid entirely. `chatId` scopes the blob URL so the server
   * can enforce chat-boundary isolation.
   */
  chatId?: string;
  attachments?: ChatMessageAttachment[];
  /**
   * Optional persisted message id. When provided, rendered on the outer
   * wrapper as `data-message-id` so the prompt-history panel can locate
   * and scroll the element into view.
   */
  messageId?: string;
}

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const language = className?.replace("language-", "") || "";
  const code = extractText(children);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group/code relative my-2 overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between bg-zinc-800 px-3 py-1 text-xs text-zinc-400">
        <span>{language}</span>
        <Button variant="ghost" size="icon" className="h-6 w-6 text-zinc-400 hover:text-zinc-200" onClick={handleCopy}>
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </Button>
      </div>
      <pre className="!mt-0 !rounded-t-none !border-0 overflow-x-auto"><code className={className}>{children}</code></pre>
    </div>
  );
}

/** Recursively extract text from React children (for the copy button). */
function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function ChatMessageImpl({ role, content, isStreaming, inputTokens, outputTokens, costUsd, createdAt, chatId, attachments, messageId }: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const isUser = role === "user";

  // Suppress empty assistant bubbles that come from tool-only turns or
  // aborted/interrupted streams. The backend always persists the assistant
  // row with whatever `fullText` was collected (see `src/routes/chats.ts`),
  // which can be an empty string. Rendering those as a bare `bg-muted p-3`
  // shell produces a column of meaningless gray pills in the UI. Skip them
  // entirely unless the message is mid-stream (the streaming placeholder
  // passes a `\u00A0` content with `isStreaming=true`) or has attachments.
  const hasAttachments = !!(chatId && attachments && attachments.length > 0);
  const isBlank = !content || content.trim().length === 0;
  if (!isUser && !isStreaming && isBlank && !hasAttachments) {
    return null;
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={`group flex ${isUser ? "justify-end" : "justify-start"}`}
      data-message-id={messageId}
    >
      <div className="relative max-w-[92%] sm:max-w-[85%] lg:max-w-[80%]">
        {/* Copy entire message button */}
        <Button
          variant="ghost"
          size="icon"
          className={`absolute top-1 h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 ${
            isUser ? "-left-8" : "-right-8"
          }`}
          onClick={handleCopy}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
        </Button>

        <div
          className={`rounded-2xl px-4 py-3 text-sm shadow-sm ${
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted/60 border border-border/60"
          }`}
        >
          {isUser ? (
            <span className="whitespace-pre-wrap">{content}</span>
          ) : isStreaming && isBlank ? (
            // "Agent is working" placeholder — blank assistant bubble that
            // the conversation view renders while the session is spinning
            // up or still running after the local stream ended. Show a
            // spinner + label instead of an empty markdown paragraph with
            // a pulsing caret so the state reads as "working" at a glance.
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
              aria-label="Agent is working"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span>Thinking…</span>
            </div>
          ) : (
            <div className="chat-markdown prose prose-sm dark:prose-invert min-w-0 max-w-none break-words [overflow-wrap:anywhere]">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  code({ className, children, ...rest }) {
                    const isBlock = className?.startsWith("language-") || className?.startsWith("hljs");
                    if (isBlock) {
                      // ```diff fenced blocks get the structured inline-diff
                      // viewer instead of highlight.js token coloring so hunks,
                      // gutters and per-file stats line up with the task view.
                      if (className === "language-diff" || className === "hljs language-diff") {
                        return <InlineDiff diff={extractText(children)} />;
                      }
                      return <CodeBlock className={className}>{children}</CodeBlock>;
                    }
                    return <code className="break-all rounded bg-zinc-200 px-1 py-0.5 text-xs dark:bg-zinc-700" {...rest}>{children}</code>;
                  },
                  pre({ children }) {
                    // Let CodeBlock handle the wrapper
                    return <>{children}</>;
                  },
                  a({ href, children }) {
                    return <a href={href} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline">{children}</a>;
                  },
                  table({ children }) {
                    return (
                      <div className="my-2 max-w-full overflow-x-auto">
                        <table className="w-full border-collapse text-xs">{children}</table>
                      </div>
                    );
                  },
                  th({ children }) {
                    return <th className="border border-border bg-muted/50 px-2 py-1 text-left font-medium">{children}</th>;
                  },
                  td({ children }) {
                    return <td className="border border-border px-2 py-1">{children}</td>;
                  },
                }}
              >
                {content}
              </ReactMarkdown>
              {isStreaming && (
                <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-foreground" />
              )}
            </div>
          )}
        </div>

        {/* Thumbnail grid — rendered below the bubble so long prose/markdown
            doesn't squeeze the images. Only present when a user turn actually
            linked files; assistant messages always come back with `[]`. */}
        {chatId && attachments && attachments.length > 0 && (
          <MessageAttachments chatId={chatId} attachments={attachments} />
        )}

        {/* Metadata footer */}
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          {!isUser && inputTokens != null && outputTokens != null && (
            <span>
              {(inputTokens + outputTokens).toLocaleString()} tokens
              {costUsd != null && ` · $${costUsd.toFixed(4)}`}
            </span>
          )}
          {createdAt && (
            <span className="opacity-0 transition-opacity group-hover:opacity-100">
              {new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// Memoised — chat-conversation re-renders on every streaming tick, but a
// completed message's props are stable across renders, so shallow equality
// prevents the ReactMarkdown + syntax-highlighter subtree from re-parsing
// each keystroke.
export const ChatMessage = memo(ChatMessageImpl);
