import { useState } from "react";

export function SkillContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.length > 200 ? content.slice(0, 200) + "…" : content;

  return (
    <div className="mt-1">
      <pre className="whitespace-pre-wrap text-xs text-muted-foreground font-mono max-h-60 overflow-auto rounded bg-muted p-2">
        {expanded ? content : preview}
      </pre>
      {content.length > 200 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-xs text-primary hover:underline"
        >
          {expanded ? "Collapse" : "Show full content"}
        </button>
      )}
    </div>
  );
}
