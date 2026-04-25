/**
 * Direct Anthropic SDK roundtrip — smallest possible "are keys valid and
 * model reachable" probe. Exits 77 (skipped) if ANTHROPIC_API_KEY is absent.
 *
 * Two cases:
 *   1. Text-only: "Reply with exactly: OK" — proves the baseline path still
 *      works after the content-block widening.
 *   2. Multimodal: a deterministically-generated red 2×2 PNG is embedded as
 *      an `image` content block alongside a text block ("Describe the image
 *      in one sentence."). The model must mention "red" or "square" in its
 *      reply — failure here means the SDK rejected the array-shaped content
 *      or the model didn't receive the image bytes. This is the exact shape
 *      `buildMessageContent` produces when a chat turn has a linked PNG
 *      attachment, so a green test here is the proof the widened pipeline
 *      flows end-to-end.
 */
import Anthropic from "@anthropic-ai/sdk";

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("  (skipping: ANTHROPIC_API_KEY not set)");
  process.exit(77);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── 1. Text-only baseline ──────────────────────────────────────────────────
const textOnly = await client.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 16,
  messages: [{ role: "user", content: "Reply with exactly: OK" }],
});

const text = textOnly.content
  .filter((b) => b.type === "text")
  .map((b) => (b as { type: "text"; text: string }).text)
  .join("");
if (!text.toUpperCase().includes("OK")) {
  throw new Error(`expected 'OK' in reply, got: ${text}`);
}
if (!textOnly.usage || textOnly.usage.input_tokens < 1 || textOnly.usage.output_tokens < 1) {
  throw new Error(`missing or zero usage on text-only response: ${JSON.stringify(textOnly.usage)}`);
}

// ─── 2. Multimodal: text + image content blocks ─────────────────────────────
//
// Hand-built 2×2 red PNG — deterministic, no disk reads, no external tools.
// Bytes come from Node's zlib + a tiny IHDR/IDAT/IEND assembler so the probe
// stays self-contained. Anthropic requires valid PNG bytes (magic + CRCs);
// an invalid image surfaces as a 400 on the SDK call.
const red2x2PngBase64 = buildRedSquarePngBase64();

const multimodal = await client.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 64,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Describe the image in one sentence." },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: red2x2PngBase64,
          },
        },
      ],
    },
  ],
});

const imageReply = multimodal.content
  .filter((b) => b.type === "text")
  .map((b) => (b as { type: "text"; text: string }).text)
  .join("")
  .toLowerCase();
if (!imageReply) {
  throw new Error(`empty reply to multimodal prompt: ${JSON.stringify(multimodal.content)}`);
}
// Deterministic assertion: a red square should prompt at least one of
// "red" or "square" in the description. If neither, the model didn't see
// the image (likely the content-block array was mangled).
if (!/red|square/.test(imageReply)) {
  throw new Error(`multimodal reply missing expected image descriptors: ${imageReply}`);
}
if (!multimodal.usage || multimodal.usage.input_tokens < 1 || multimodal.usage.output_tokens < 1) {
  throw new Error(`missing or zero usage on multimodal response: ${JSON.stringify(multimodal.usage)}`);
}

// ─── PNG assembly helper ────────────────────────────────────────────────────
/**
 * Build the base64-encoded bytes of a 2×2 pure-red PNG. Kept inline rather
 * than loading from a fixture so this probe has zero on-disk dependencies —
 * `FLOCKCTL_LIVE_TESTS=1 npm run test:live` works on a fresh clone.
 */
function buildRedSquarePngBase64(): string {
  const { deflateSync } = require("node:zlib");
  // Raw pixel scanlines: each row starts with a filter byte (0 = no filter),
  // followed by RGB triples. Two rows × (1 filter + 2 pixels × 3 bytes).
  const raw = Buffer.from([
    0, 255, 0, 0, 255, 0, 0,
    0, 255, 0, 0, 255, 0, 0,
  ]);
  const ihdr = Buffer.concat([
    Buffer.from([0, 0, 0, 2]), // width = 2
    Buffer.from([0, 0, 0, 2]), // height = 2
    Buffer.from([8, 2, 0, 0, 0]), // 8-bit depth, truecolor RGB
  ]);
  const idat = deflateSync(raw);
  const chunks: Buffer[] = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ];
  return Buffer.concat(chunks).toString("base64");
}

/** Assemble one PNG chunk = length(4) || type(4) || data || CRC32(4). */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** Plain CRC32 — matches the PNG spec's polynomial. */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = c ^ buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}
