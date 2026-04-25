// ─── Incident extractor (LLM → structured draft) ───
//
// Takes a chat transcript and asks a cheap LLM (default: Claude Haiku) to
// pull out the four post-mortem fields — title, symptom, root cause,
// resolution — plus a short list of tags. Designed for the "promote chat
// to incident" flow: the user clicks a button, we pre-fill the form, the
// user edits and saves. The LLM output is treated as advisory, not
// authoritative — on any failure we fall back to empty fields so the user
// can still save the incident manually.
//
// Contract:
//   - Exactly one LLM call per invocation.
//   - Structured output via a strict JSON-only prompt (no tool calls — the
//     Claude Code SDK path streams text, so we parse a JSON object out of
//     the reply text).
//   - Usage is persisted to `usage_records` with activity_type =
//     'incident_extract' so incident-extraction cost shows up in the cost
//     breakdown alongside task/chat usage.
//   - On LLM error, JSON parse failure, or shape mismatch: return an empty
//     draft. Never throw — the caller should always get a usable draft.
//
// The AI client is injectable for testing; production callers omit `client`
// and get a freshly constructed Claude Code client.
//
// NOTE ON MODEL CHOICE: Haiku is intentional — the task is a
// straightforward "summarize a transcript into five slots" extraction.
// Opus/Sonnet tokens on this would be wasted.

import type { AIClient } from "../ai/client.js";
import { getDb as defaultGetDb } from "../../db/index.js";
import type { FlockctlDb } from "../../db/index.js";
import { usageRecords } from "../../db/schema.js";

/** Message shape accepted by the extractor. Compatible with `chat_messages` rows
 *  (use `role` + `content`) and with the Anthropic SDK message format. */
export interface ExtractorMessage {
  role: string;
  content: string;
}

/** Structured draft returned by the extractor. Every field may be empty so
 *  callers can safely render the draft into a form without null guards. */
export interface IncidentDraft {
  title: string;
  symptom: string;
  rootCause: string;
  resolution: string;
  tags: string[];
}

export interface ExtractOptions {
  /** Override the default model. Defaults to 'claude-haiku-4-5'. */
  model?: string;
  /** Injectable AI client for tests. Defaults to `createAIClient()`. */
  client?: AIClient;
  /** Optional override for DB access (tests). */
  db?: FlockctlDb;
  /** Attribute the usage record to this project (for cost rollups). */
  projectId?: number | null;
  /** Optional link back to the source chat (for auditing which chat funded the call). */
  chatId?: number | null;
  /** Optional abort signal — propagated to the AI client. */
  abortSignal?: AbortSignal;
}

const DEFAULT_MODEL = "claude-haiku-4-5";
const ACTIVITY_TYPE = "incident_extract";

/** Empty draft — used as the fallback whenever the LLM call or parse fails. */
function emptyDraft(): IncidentDraft {
  return { title: "", symptom: "", rootCause: "", resolution: "", tags: [] };
}

/** Render the chat transcript as a single prompt block. Keeps roles visible
 *  so the LLM can distinguish user-reported symptoms from assistant
 *  analysis, which helps it pick the right phrases for symptom vs. root
 *  cause. Blank messages are dropped so they do not dilute the context. */
function renderTranscript(messages: ExtractorMessage[]): string {
  return messages
    .map((m) => {
      const content = typeof m.content === "string" ? m.content.trim() : "";
      if (!content) return null;
      return `[${m.role}] ${content}`;
    })
    .filter((s): s is string => s !== null)
    .join("\n\n");
}

/** Strict JSON-only system prompt. We deliberately constrain the model to a
 *  top-level object with exactly these five keys — any deviation is caught
 *  by the parser below and triggers the empty-draft fallback. */
const SYSTEM_PROMPT = [
  "You are an incident post-mortem extractor.",
  "Given a chat transcript between a user and an engineer/assistant about a",
  "production problem, extract structured post-mortem fields.",
  "",
  "Respond with a SINGLE JSON object — no prose, no markdown fences — with",
  "exactly these keys:",
  "  - title:       short one-line summary (<=80 chars)",
  "  - symptom:     what the user or system observed (1-3 sentences)",
  "  - root_cause:  underlying cause identified in the conversation",
  "  - resolution:  fix applied or recommended",
  "  - tags:        array of 1-6 short lowercase topic tags (e.g. 'db','tls')",
  "",
  "If the transcript does not contain enough information for a field,",
  "return an empty string for that field (or an empty array for tags).",
  "Never invent facts that are not supported by the transcript.",
].join("\n");

/**
 * Strip a leading/trailing code fence (```json ... ```) if the model ignored
 * the no-fences instruction. Returns the string unchanged otherwise.
 */
function stripFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1] !== undefined ? fenceMatch[1].trim() : trimmed;
}

/**
 * Find the outermost JSON object in a possibly-noisy text reply. The
 * extractor prompt asks for JSON-only, but cheap models sometimes prepend
 * a sentence. We grab the first balanced `{...}` substring — good enough
 * for the shape we expect (single flat object) and avoids a JSON parser
 * dependency for partial fragments.
 */
function extractJsonObject(text: string): string | null {
  const stripped = stripFence(text);
  const firstBrace = stripped.indexOf("{");
  if (firstBrace < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = firstBrace; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return stripped.slice(firstBrace, i + 1);
    }
  }
  return null;
}

/** Narrow an arbitrary parsed JSON value into a safe IncidentDraft. Unknown
 *  fields are ignored; missing or wrong-typed fields collapse to empty. */
function coerceDraft(parsed: unknown): IncidentDraft {
  const draft = emptyDraft();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return draft;
  const o = parsed as Record<string, unknown>;
  if (typeof o.title === "string") draft.title = o.title.trim();
  if (typeof o.symptom === "string") draft.symptom = o.symptom.trim();
  // Accept both camelCase and snake_case from the LLM — haiku sometimes
  // drifts on casing even with explicit instructions.
  const rc = o.root_cause ?? o.rootCause;
  if (typeof rc === "string") draft.rootCause = rc.trim();
  if (typeof o.resolution === "string") draft.resolution = o.resolution.trim();
  if (Array.isArray(o.tags)) {
    draft.tags = o.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0)
      .slice(0, 6);
  }
  return draft;
}

/**
 * Persist a usage record for the extraction call. Failures here are
 * swallowed — we would rather lose cost attribution than break the
 * extraction flow on a DB hiccup.
 */
function recordUsage(
  db: FlockctlDb,
  params: {
    projectId?: number | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalCostUsd: number;
  },
): void {
  try {
    db.insert(usageRecords)
      .values({
        projectId: params.projectId ?? null,
        provider: "anthropic",
        model: params.model,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        cacheCreationInputTokens: params.cacheCreationInputTokens,
        cacheReadInputTokens: params.cacheReadInputTokens,
        totalCostUsd: params.totalCostUsd,
        activityType: ACTIVITY_TYPE,
      })
      .run();
  } catch {
    /* v8 ignore next — best-effort cost logging */
  }
}

/**
 * Extract a structured incident draft from a chat transcript using a single
 * LLM call. Returns an empty draft (never throws) on any error.
 *
 * Usage is persisted with `activity_type = 'incident_extract'` so cost
 * reports can separate extraction spend from task/chat spend.
 */
export async function extractIncidentFromMessages(
  messages: ExtractorMessage[],
  opts: ExtractOptions = {},
): Promise<IncidentDraft> {
  const transcript = renderTranscript(messages ?? []);
  if (!transcript) return emptyDraft();

  const model = opts.model ?? DEFAULT_MODEL;
  const db = opts.db ?? defaultGetDb();

  // Lazy-create the production client so tests that inject a mock avoid
  // pulling the Claude SDK into the test graph.
  let client = opts.client;
  if (!client) {
    const { createAIClient } = await import("../ai/client.js");
    client = createAIClient();
  }

  try {
    const result = await client.chat({
      model,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Transcript:\n\n${transcript}\n\nReturn the JSON now.`,
        },
      ],
      noTools: true,
      sessionLabel: "incident-extract",
      abortSignal: opts.abortSignal,
    });

    if (result.usage) {
      recordUsage(db, {
        projectId: opts.projectId ?? null,
        model,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        cacheCreationInputTokens: result.usage.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: result.usage.cacheReadInputTokens ?? 0,
        totalCostUsd: result.costUsd ?? 0,
      });
    }

    const jsonText = extractJsonObject(result.text ?? "");
    if (!jsonText) return emptyDraft();
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return emptyDraft();
    }
    return coerceDraft(parsed);
  } catch {
    // Propagate nothing — the caller's UX is "pre-fill; user can edit".
    // An exception here would force them into a retry loop for no gain.
    return emptyDraft();
  }
}
