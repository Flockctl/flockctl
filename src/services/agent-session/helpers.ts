import type { IncidentSearchResult } from "../incidents/service.js";
import type { MessageContent } from "./types.js";

/**
 * Flatten `MessageContent` down to plain text for consumers that can only
 * work with strings (log prefixes, FTS queries, session-title slices).
 * Concatenates every `text` block in order; non-text blocks (images, tool
 * results) contribute nothing so the extracted string is human-readable.
 */
export function extractPromptText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b && (b as { type?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
    .join("");
}

/**
 * Render a ranked list of past incidents as a compact markdown-ish block.
 * Wrapped in a distinct XML-style tag (`<past_incidents>`) so the model
 * can attend to it like any other structured context chunk, and so tests
 * can assert on the presence of the section header deterministically.
 */
export function formatIncidentsSection(matches: IncidentSearchResult[]): string {
  const lines: string[] = ["<past_incidents>", "## Past incidents", ""];
  for (const m of matches) {
    lines.push(`### [#${m.id}] ${m.title}`);
    if (m.tags && m.tags.length > 0) lines.push(`- Tags: ${m.tags.join(", ")}`);
    if (m.symptom) lines.push(`- Symptom: ${m.symptom}`);
    if (m.rootCause) lines.push(`- Root cause: ${m.rootCause}`);
    if (m.resolution) lines.push(`- Resolution: ${m.resolution}`);
    lines.push("");
  }
  lines.push("</past_incidents>");
  return lines.join("\n");
}
