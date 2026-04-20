import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { aiProviderKeys } from "../db/schema.js";
import { eq, sql, desc } from "drizzle-orm";
import { paginationParams } from "../lib/pagination.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
const PROVIDERS: Record<string, { name: string; apiType: string }> = {
  claude_cli: { name: "Claude Code CLI", apiType: "claude-agent-sdk" },
};

export const aiKeyRoutes = new Hono();

// GET /keys — list all keys (redacts key_value)
aiKeyRoutes.get("/", (c) => {
  const db = getDb();
  const { page, perPage, offset } = paginationParams(c);

  const items = db.select().from(aiProviderKeys).orderBy(desc(aiProviderKeys.createdAt)).limit(perPage).offset(offset).all();
  const total = db.select({ count: sql<number>`count(*)` }).from(aiProviderKeys).get()?.count ?? 0;

  // Redact key values and add computed fields
  const redacted = items.map(k => ({
    ...k,
    keyValue: k.keyValue ? `${k.keyValue.slice(0, 8)}...${k.keyValue.slice(-4)}` : null,
    name: k.label,
    key_suffix: k.keyValue ? k.keyValue.slice(-4) : null,
    is_active: k.isActive,
    config_dir: k.configDir,
  }));

  return c.json({ items: redacted, total, page, perPage });
});

// GET /keys/providers — list available providers
aiKeyRoutes.get("/providers", (c) => {
  return c.json(PROVIDERS);
});

// GET /keys/claude-cli/status — Claude CLI readiness
aiKeyRoutes.get("/claude-cli/status", async (c) => {
  try {
    const { getAgent } = await import("../services/agents/registry.js");
    const provider = getAgent("claude-code");
    const readiness = provider.checkReadiness();
    return c.json({
      installed: readiness.installed,
      authenticated: readiness.authenticated,
      ready: readiness.ready,
      models: provider.listModels().map(m => m.id),
    });
  } catch {
    /* v8 ignore next — defensive: provider.checkReadiness shouldn't throw */
    return c.json({ installed: false, authenticated: false, ready: false, models: [] });
  }
});

// GET /keys/:id
aiKeyRoutes.get("/:id", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const key = db.select().from(aiProviderKeys).where(eq(aiProviderKeys.id, id)).get();
  if (!key) throw new NotFoundError("AI Key");

  return c.json({
    ...key,
    keyValue: key.keyValue ? `${key.keyValue.slice(0, 8)}...${key.keyValue.slice(-4)}` : null,
    name: key.label,
    key_suffix: key.keyValue ? key.keyValue.slice(-4) : null,
    is_active: key.isActive,
    config_dir: key.configDir,
  });
});

// — create key
aiKeyRoutes.post("/", async (c) => {
  const db = getDb();
  const body = await c.req.json();

  if (!body.provider) throw new ValidationError("provider is required");
  if (!body.providerType) throw new ValidationError("providerType is required");

  const result = db.insert(aiProviderKeys).values({
    provider: body.provider,
    providerType: body.providerType,
    label: body.label ?? null,
    keyValue: body.keyValue ?? null,
    cliCommand: body.cliCommand ?? null,
    envVarName: body.envVarName ?? null,
    configDir: body.configDir ?? null,
    priority: body.priority ?? 0,
    isActive: body.isActive ?? true,
  }).returning().get();

  return c.json(result, 201);
});

// PATCH /keys/:id
aiKeyRoutes.patch("/:id", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const existing = db.select().from(aiProviderKeys).where(eq(aiProviderKeys.id, id)).get();
  if (!existing) throw new NotFoundError("AI Key");

  const body = await c.req.json();
  db.update(aiProviderKeys)
    .set({
      ...(body.provider !== undefined && { provider: body.provider }),
      ...(body.providerType !== undefined && { providerType: body.providerType }),
      ...(body.label !== undefined && { label: body.label }),
      ...(body.keyValue !== undefined && { keyValue: body.keyValue }),
      ...(body.configDir !== undefined && { configDir: body.configDir }),
      ...(body.priority !== undefined && { priority: body.priority }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
    })
    .where(eq(aiProviderKeys.id, id))
    .run();

  const updated = db.select().from(aiProviderKeys).where(eq(aiProviderKeys.id, id)).get();
  if (!updated) throw new NotFoundError("Key");
  return c.json({
    ...updated,
    keyValue: updated.keyValue ? `${updated.keyValue.slice(0, 8)}...${updated.keyValue.slice(-4)}` : null,
    name: updated.label ?? null,
    key_suffix: updated.keyValue ? updated.keyValue.slice(-4) : null,
    is_active: updated.isActive ?? false,
    config_dir: updated.configDir ?? null,
  });
});

// DELETE /keys/:id
aiKeyRoutes.delete("/:id", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const existing = db.select().from(aiProviderKeys).where(eq(aiProviderKeys.id, id)).get();
  if (!existing) throw new NotFoundError("AI Key");

  db.delete(aiProviderKeys).where(eq(aiProviderKeys.id, id)).run();
  return c.json({ deleted: true });
});

