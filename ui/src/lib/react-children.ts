import type { ReactNode } from "react";

/**
 * Recursively flatten a `ReactNode` tree into a single string of its text
 * content. Walks `string` / `number` leaves, descends through arrays and
 * elements via `props.children`, and ignores anything that doesn't carry
 * text (boolean, null, undefined, fragments without text payloads).
 *
 * Used by markdown-rendering components in two places:
 *
 *   1. The "copy code" button in `chat-message.tsx`'s `<CodeBlock>` —
 *      reaches past `rehype-highlight`'s span wrappers to recover the
 *      original source text.
 *   2. Block-vs-inline detection on `<code>` elements rendered by
 *      `react-markdown`. Fenced code blocks always contain a newline
 *      (the closing fence sits on its own line); inline code spans
 *      cannot contain one (CommonMark §6.1). Checking the extracted
 *      text for a newline is therefore an invariant signal of "this
 *      is a block" that does NOT depend on the user typing a language
 *      tag — which is critical, because untagged fenced blocks
 *      (` ```\n…\n``` `) come through with no `language-*` className
 *      and would otherwise be silently misclassified as inline code,
 *      collapsing ASCII-art diagrams into a wrapped staircase.
 */
export function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}
