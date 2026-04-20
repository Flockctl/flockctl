import OpenAI from "openai";

if (!process.env.OPENAI_API_KEY) {
  console.log("  (skipping: OPENAI_API_KEY not set)");
  process.exit(77);
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const res = await client.chat.completions.create({
  model: "gpt-4o-mini",
  max_tokens: 16,
  messages: [{ role: "user", content: "Reply with exactly: OK" }],
});

const text = res.choices[0]?.message?.content ?? "";
if (!text.toUpperCase().includes("OK")) {
  throw new Error(`expected 'OK' in reply, got: ${text}`);
}
if (!res.usage || res.usage.prompt_tokens < 1 || res.usage.completion_tokens < 1) {
  throw new Error(`missing or zero usage on response: ${JSON.stringify(res.usage)}`);
}
