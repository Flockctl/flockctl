import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { Button } from "@/components/ui/button";
import { Copy, Check, Loader2 } from "lucide-react";
import { MessageAttachments } from "@/components/MessageAttachments";
import { InlineDiff } from "@/components/InlineDiff";
import { formatCostFine } from "@/lib/format";
import { extractText } from "@/lib/react-children";
import { parseServerTimestamp } from "@/lib/utils";
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
        <Button variant="ghost" size="icon" className="h-6 w-6 text-zinc-400 hover:text-zinc-200" aria-label={copied ? "Copied" : "Copy code"} onClick={handleCopy}>
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </Button>
      </div>
      <pre className="!mt-0 !rounded-t-none !border-0 overflow-x-auto"><code className={className}>{children}</code></pre>
    </div>
  );
}

// ─── Hoisted ReactMarkdown configuration ─────────────────────────────────
//
// `<ReactMarkdown>` memoises its AST internally keyed on the identity of
// the `remarkPlugins`, `rehypePlugins`, and `components` props. When these
// were inline literals inside the render body, every streaming token tick
// produced fresh references → ReactMarkdown re-parsed and re-highlighted
// the entire scrollback on every keystroke. Hoisting them to module
// scope makes them stable references for the lifetime of the module, so
// React.memo'd ChatMessage bubbles skip the heavy re-parse on every
// update.
const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_REHYPE_PLUGINS = [rehypeHighlight];
const MARKDOWN_COMPONENTS: Components = {
  code({ className, children, ...rest }) {
    const text = extractText(children);
    const isBlock =
      text.includes("\n") ||
      !!className?.startsWith("language-") ||
      !!className?.startsWith("hljs");
    if (isBlock) {
      if (className === "language-diff" || className === "hljs language-diff") {
        return <InlineDiff diff={text} />;
      }
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }
    return (
      <code
        className="break-all rounded bg-zinc-200 px-1 py-0.5 text-xs dark:bg-zinc-700"
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-primary underline"
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="my-2 max-w-full overflow-x-auto">
        <table className="w-full border-collapse text-xs">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border border-border bg-muted/50 px-2 py-1 text-left font-medium">
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td className="border border-border px-2 py-1">{children}</td>;
  },
};

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
      className={`group flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}
      data-message-id={messageId}
    >
      {/* Assistant avatar — gradient "F" circle on the left.
          Lives outside the bubble so the bubble can be background-less but
          still has a visible identity. User rows skip it. */}
      {!isUser && (
        <div
          aria-hidden="true"
          data-testid="assistant-avatar"
          className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-[11px] font-semibold text-white shadow-sm"
        >
          F
        </div>
      )}

      <div className="relative max-w-[680px]">
        {/* Copy entire message button */}
        <Button
          variant="ghost"
          size="icon"
          className={`absolute top-1 h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 ${
            isUser ? "-left-8" : "-right-8"
          }`}
          aria-label={copied ? "Copied message" : "Copy message"}
          onClick={handleCopy}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
        </Button>

        <div
          data-testid="chat-bubble"
          data-role={role}
          className={`text-sm ${
            isUser
              ? "bg-indigo-500/10 dark:bg-indigo-500/15 rounded-2xl rounded-tr-sm px-4 py-2 text-foreground"
              : "px-0 py-1"
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
                remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                components={MARKDOWN_COMPONENTS}
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
              {costUsd != null && ` · ${formatCostFine(costUsd)}`}
            </span>
          )}
          {createdAt && (
            <span className="opacity-0 transition-opacity group-hover:opacity-100">
              {parseServerTimestamp(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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
