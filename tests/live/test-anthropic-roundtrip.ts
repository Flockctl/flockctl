/**
 * Direct Anthropic SDK roundtrip — smallest possible "are keys valid and
 * model reachable" probe. Exits 77 (skipped) if ANTHROPIC_API_KEY is absent.
 */
import Anthropic from "@anthropic-ai/sdk";

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("  (skipping: ANTHROPIC_API_KEY not set)");
  process.exit(77);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const res = await client.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 16,
  messages: [{ role: "user", content: "Reply with exactly: OK" }],
});

const text = res.content
  .filter((b) => b.type === "text")
  .map((b) => (b as { type: "text"; text: string }).text)
  .join("");
if (!text.toUpperCase().includes("OK")) {
  throw new Error(`expected 'OK' in reply, got: ${text}`);
}
if (!res.usage || res.usage.input_tokens < 1 || res.usage.output_tokens < 1) {
  throw new Error(`missing or zero usage on response: ${JSON.stringify(res.usage)}`);
}
