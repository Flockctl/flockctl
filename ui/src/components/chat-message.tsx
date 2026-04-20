import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";

interface ChatMessageProps {
  role: "user" | "assistant" | "system";
  content: string;
  isStreaming?: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  createdAt?: string;
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

export function ChatMessage({ role, content, isStreaming, inputTokens, outputTokens, costUsd, createdAt }: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const isUser = role === "user";

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`group flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="relative max-w-[80%]">
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
          className={`rounded-lg p-3 text-sm ${
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted"
          }`}
        >
          {isUser ? (
            <span className="whitespace-pre-wrap">{content}</span>
          ) : (
            <div className="chat-markdown prose prose-sm dark:prose-invert max-w-none break-words">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  code({ className, children, ...rest }) {
                    const isBlock = className?.startsWith("language-") || className?.startsWith("hljs");
                    if (isBlock) {
                      return <CodeBlock className={className}>{children}</CodeBlock>;
                    }
                    return <code className="rounded bg-zinc-200 px-1 py-0.5 text-xs dark:bg-zinc-700" {...rest}>{children}</code>;
                  },
                  pre({ children }) {
                    // Let CodeBlock handle the wrapper
                    return <>{children}</>;
                  },
                  a({ href, children }) {
                    return <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">{children}</a>;
                  },
                  table({ children }) {
                    return <table className="my-2 w-full border-collapse text-xs">{children}</table>;
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

        {/* Metadata footer */}
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
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
