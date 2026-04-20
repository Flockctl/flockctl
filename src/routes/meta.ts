import { Hono } from "hono";
import { listAgents } from "../services/agents/registry.js";
import {
  getDefaultModel,
  getPlanningModel,
  getDefaultAgent,
  getDefaultKeyId,
  setGlobalDefaults,
  getRemoteServers,
  addRemoteServer,
  updateRemoteServer,
  deleteRemoteServer,
} from "../config.js";
import { getDb } from "../db/index.js";
import { aiProviderKeys } from "../db/schema.js";
import { desc, eq } from "drizzle-orm";

export const metaRoutes = new Hono();

function publicServer(s: { id: string; name: string; url: string; token?: string }) {
  return { id: s.id, name: s.name, url: s.url, hasToken: !!s.token };
}

function isValidUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// GET /meta/remote-servers — list remote servers (no tokens leaked)
metaRoutes.get("/remote-servers", (c) => {
  return c.json(getRemoteServers().map(publicServer));
});

// POST /meta/remote-servers — add new server
metaRoutes.post("/remote-servers", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { name, url, token } = body as { name?: unknown; url?: unknown; token?: unknown };
  if (typeof name !== "string" || name.trim().length === 0) {
    return c.json({ error: "name is required" }, 400);
  }
  if (!isValidUrl(url)) {
    return c.json({ error: "url must be a valid http(s) URL" }, 400);
  }
  if (token !== undefined && token !== null && typeof token !== "string") {
    return c.json({ error: "token must be a string" }, 400);
  }
  const server = addRemoteServer({
    name: name.trim(),
    url: url as string,
    token: typeof token === "string" ? token : undefined,
  });
  return c.json(publicServer(server), 201);
});

// PATCH /meta/remote-servers/:id — update server
metaRoutes.patch("/remote-servers/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { name, url, token } = body as {
    name?: unknown;
    url?: unknown;
    token?: unknown;
  };
  if (name !== undefined && (typeof name !== "string" || name.trim().length === 0)) {
    return c.json({ error: "name must be a non-empty string" }, 400);
  }
  if (url !== undefined && !isValidUrl(url)) {
    return c.json({ error: "url must be a valid http(s) URL" }, 400);
  }
  if (token !== undefined && token !== null && typeof token !== "string") {
    return c.json({ error: "token must be a string or null" }, 400);
  }
  const updated = updateRemoteServer(id, {
    name: typeof name === "string" ? name.trim() : undefined,
    url: typeof url === "string" ? url : undefined,
    token:
      token === null ? null : typeof token === "string" ? token : undefined,
  });
  if (!updated) return c.json({ error: "Server not found" }, 404);
  return c.json(publicServer(updated));
});

// DELETE /meta/remote-servers/:id — remove server
metaRoutes.delete("/remote-servers/:id", (c) => {
  const { id } = c.req.param();
  const removed = deleteRemoteServer(id);
  if (!removed) return c.json({ error: "Server not found" }, 404);
  return c.json({ ok: true });
});

// POST /meta/remote-servers/:id/proxy-token — hand token to the local UI
metaRoutes.post("/remote-servers/:id/proxy-token", (c) => {
  const { id } = c.req.param();
  const server = getRemoteServers().find((s) => s.id === id);
  if (!server) return c.json({ error: "Server not found" }, 404);
  return c.json({ token: server.token ?? null });
});

// GET /meta — available agents and models
metaRoutes.get("/", (c) => {
  const agents: Array<{ id: string; name: string; available: boolean }> = [];
  const models: Array<{ id: string; name: string; agent: string }> = [];

  for (const provider of listAgents()) {
    const ready = provider.checkReadiness().ready;
    agents.push({ id: provider.id, name: provider.displayName, available: ready });
    if (ready) {
      for (const m of provider.listModels()) {
        models.push({ id: m.id, name: m.name, agent: provider.id });
      }
    }
  }

  // AI Provider Keys from DB
  const db = getDb();
  const allKeys = db.select().from(aiProviderKeys).orderBy(desc(aiProviderKeys.priority)).all();
  const keys = allKeys.map(k => ({
    id: k.id,
    name: k.label || `Key #${k.id}`,
    provider: k.provider,
    isActive: k.isActive ?? true,
  }));

  return c.json({
    agents,
    models,
    keys,
    defaults: {
      model: getDefaultModel(),
      planningModel: getPlanningModel(),
      agent: getDefaultAgent(),
      keyId: getDefaultKeyId(),
    },
  });
});

// PATCH /meta/defaults — update global defaults in ~/.flockctlrc
metaRoutes.patch("/defaults", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { defaultModel, defaultKeyId } = body as {
    defaultModel?: unknown;
    defaultKeyId?: unknown;
  };

  const update: { defaultModel?: string | null; defaultKeyId?: number | null } = {};

  if (defaultModel !== undefined) {
    if (defaultModel === null || defaultModel === "") {
      update.defaultModel = null;
    } else if (typeof defaultModel === "string") {
      update.defaultModel = defaultModel;
    } else {
      return c.json({ error: "defaultModel must be a string or null" }, 400);
    }
  }

  if (defaultKeyId !== undefined) {
    if (defaultKeyId === null) {
      update.defaultKeyId = null;
    } else if (typeof defaultKeyId === "number" && Number.isInteger(defaultKeyId) && defaultKeyId > 0) {
      // Validate the key exists and is active
      const db = getDb();
      const key = db
        .select()
        .from(aiProviderKeys)
        .where(eq(aiProviderKeys.id, defaultKeyId))
        .get();
      if (!key) return c.json({ error: "Provider key not found" }, 404);
      update.defaultKeyId = defaultKeyId;
    } else {
      return c.json({ error: "defaultKeyId must be a positive integer or null" }, 400);
    }
  }

  if (Object.keys(update).length === 0) {
    return c.json({ error: "No valid fields to update" }, 400);
  }

  setGlobalDefaults(update);
  return c.json({
    model: getDefaultModel(),
    planningModel: getPlanningModel(),
    agent: getDefaultAgent(),
    keyId: getDefaultKeyId(),
  });
});
