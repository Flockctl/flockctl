import { useMilestoneReadme } from "@/lib/hooks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

// --- Milestone README Dialog ---

export function MilestoneReadmeDialog({
  open,
  onOpenChange,
  projectId,
  milestoneSlug,
  milestoneTitle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  milestoneSlug: string;
  milestoneTitle: string;
}) {
  const { data, isLoading, error } = useMilestoneReadme(projectId, milestoneSlug, {
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-[1600px] sm:max-w-[1600px] h-[90vh] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{milestoneTitle} — README</DialogTitle>
          {data?.path && (
            <DialogDescription className="truncate font-mono text-xs">
              {data.path}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="flex-1 overflow-y-auto pr-2">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          )}
          {error && (
            <div className="text-sm text-muted-foreground">
              No README.md for this milestone yet. Create one at{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                .flockctl/plan/{milestoneSlug}/README.md
              </code>
              .
            </div>
          )}
          {data?.content && (
            <div className="chat-markdown prose prose-sm dark:prose-invert min-w-0 max-w-none break-words [overflow-wrap:anywhere]">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
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
                  code({ className, children, ...rest }) {
                    const isBlock =
                      className?.startsWith("language-") ||
                      className?.startsWith("hljs");
                    if (isBlock) {
                      return (
                        <code className={className} {...rest}>
                          {children}
                        </code>
                      );
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
                    return (
                      <pre className="my-2 overflow-x-auto rounded-md border border-border bg-zinc-900 p-3 text-xs">
                        {children}
                      </pre>
                    );
                  },
                  table({ children }) {
                    return (
                      <div className="my-2 max-w-full overflow-x-auto">
                        <table className="w-full border-collapse text-xs">
                          {children}
                        </table>
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
                    return (
                      <td className="border border-border px-2 py-1">{children}</td>
                    );
                  },
                }}
              >
                {data.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
