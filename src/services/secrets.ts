import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { secrets, projects, workspaces } from "../db/schema.js";
import { getFlockctlHome } from "../config/index.js";

export type SecretScope = "global" | "workspace" | "project";

export interface SecretRecord {
  id: number;
  scope: SecretScope;
  scopeId: number | null;
  name: string;
  description: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SecretWithValue extends SecretRecord {
  value: string;
}

// ─── Master key management ───

const KEY_LEN = 32;
let _cachedKey: Buffer | null = null;

function getMasterKeyPath(): string {
  return join(getFlockctlHome(), "secret.key");
}

/** @internal — reset cache between tests */
export function _resetMasterKeyCache(): void {
  _cachedKey = null;
}

function loadOrCreateMasterKey(): Buffer {
  if (_cachedKey) return _cachedKey;

  const keyPath = getMasterKeyPath();
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, "utf-8").trim();
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== KEY_LEN) {
      throw new Error(`secret.key at ${keyPath} is not ${KEY_LEN} bytes`);
    }
    _cachedKey = buf;
    return buf;
  }

  mkdirSync(dirname(keyPath), { recursive: true });
  const buf = randomBytes(KEY_LEN);
  writeFileSync(keyPath, buf.toString("base64") + "\n", "utf-8");
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // chmod may fail on some filesystems (Windows) — non-fatal
  }
  _cachedKey = buf;
  return buf;
}

// Payload format: base64(iv(12) || authTag(16) || ciphertext)
function encryptValue(plaintext: string): string {
  const key = loadOrCreateMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

function decryptValue(payload: string): string {
  const key = loadOrCreateMasterKey();
  const buf = Buffer.from(payload, "base64");
  if (buf.length < 12 + 16) throw new Error("secret payload too short");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");
}

// ─── Validation ───

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateName(name: string): void {
  if (typeof name !== "string" || !name) throw new Error("secret name is required");
  if (!VALID_NAME.test(name)) {
    throw new Error("secret name must match [A-Za-z_][A-Za-z0-9_]*");
  }
  if (name.length > 128) throw new Error("secret name is too long (max 128)");
}

function validateScope(scope: string, scopeId: number | null): void {
  if (scope === "global") {
    if (scopeId != null) throw new Error("global secrets must have scopeId=null");
    return;
  }
  if (scope === "workspace" || scope === "project") {
    if (scopeId == null || !Number.isFinite(scopeId)) {
      throw new Error(`${scope} secrets require a numeric scopeId`);
    }
    return;
  }
  throw new Error(`invalid scope: ${scope}`);
}

// ─── CRUD ───

function toRecord(row: {
  id: number;
  scope: string;
  scopeId: number | null;
  name: string;
  description: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}): SecretRecord {
  return {
    id: row.id,
    scope: row.scope as SecretScope,
    scopeId: row.scopeId,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listSecrets(scope: SecretScope, scopeId: number | null): SecretRecord[] {
  validateScope(scope, scopeId);
  const db = getDb();
  const cond = scopeId == null
    ? and(eq(secrets.scope, scope), isNull(secrets.scopeId))
    : and(eq(secrets.scope, scope), eq(secrets.scopeId, scopeId));
  const rows = db.select({
    id: secrets.id,
    scope: secrets.scope,
    scopeId: secrets.scopeId,
    name: secrets.name,
    description: secrets.description,
    createdAt: secrets.createdAt,
    updatedAt: secrets.updatedAt,
  }).from(secrets).where(cond).all();
  return rows.map(toRecord).sort((a, b) => a.name.localeCompare(b.name));
}

export interface UpsertSecretInput {
  scope: SecretScope;
  scopeId: number | null;
  name: string;
  value: string;
  description?: string | null;
}

export function upsertSecret(input: UpsertSecretInput): SecretRecord {
  validateScope(input.scope, input.scopeId);
  validateName(input.name);
  if (typeof input.value !== "string") throw new Error("secret value must be a string");

  if (input.scope === "workspace") {
    const ws = getDb().select().from(workspaces).where(eq(workspaces.id, input.scopeId!)).get();
    if (!ws) throw new Error(`workspace ${input.scopeId} not found`);
  } else if (input.scope === "project") {
    const p = getDb().select().from(projects).where(eq(projects.id, input.scopeId!)).get();
    if (!p) throw new Error(`project ${input.scopeId} not found`);
  }

  const encrypted = encryptValue(input.value);
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  const db = getDb();
  const existing = db.select().from(secrets).where(
    input.scopeId == null
      ? and(eq(secrets.scope, input.scope), isNull(secrets.scopeId), eq(secrets.name, input.name))
      : and(eq(secrets.scope, input.scope), eq(secrets.scopeId, input.scopeId), eq(secrets.name, input.name)),
  ).get();

  if (existing) {
    db.update(secrets).set({
      valueEncrypted: encrypted,
      description: input.description ?? existing.description,
      updatedAt: now,
    }).where(eq(secrets.id, existing.id)).run();
    return toRecord({ ...existing, valueEncrypted: encrypted, description: input.description ?? existing.description, updatedAt: now } as any);
  }

  const insert = db.insert(secrets).values({
    scope: input.scope,
    scopeId: input.scopeId,
    name: input.name,
    valueEncrypted: encrypted,
    description: input.description ?? null,
  }).returning().get();
  return toRecord(insert as any);
}

export function deleteSecret(scope: SecretScope, scopeId: number | null, name: string): boolean {
  validateScope(scope, scopeId);
  validateName(name);
  const db = getDb();
  const cond = scopeId == null
    ? and(eq(secrets.scope, scope), isNull(secrets.scopeId), eq(secrets.name, name))
    : and(eq(secrets.scope, scope), eq(secrets.scopeId, scopeId), eq(secrets.name, name));
  const res = db.delete(secrets).where(cond).run();
  return res.changes > 0;
}

export function deleteSecretsForScope(scope: Exclude<SecretScope, "global">, scopeId: number): void {
  const db = getDb();
  db.delete(secrets).where(and(eq(secrets.scope, scope), eq(secrets.scopeId, scopeId))).run();
}

// ─── Resolution ───

/**
 * Look up a secret by name walking the scope chain: project → workspace → global.
 * Returns the decrypted value, or null if not found at any level.
 */
export function resolveSecretValue(name: string, projectId: number | null): string | null {
  const db = getDb();

  let workspaceId: number | null = null;
  if (projectId != null) {
    const row = db.select({
      scopeId: secrets.id,
      value: secrets.valueEncrypted,
    }).from(secrets).where(
      and(eq(secrets.scope, "project"), eq(secrets.scopeId, projectId), eq(secrets.name, name)),
    ).get();
    if (row) return decryptValue(row.value);

    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    workspaceId = project?.workspaceId ?? null;
  }

  if (workspaceId != null) {
    const row = db.select({
      value: secrets.valueEncrypted,
    }).from(secrets).where(
      and(eq(secrets.scope, "workspace"), eq(secrets.scopeId, workspaceId), eq(secrets.name, name)),
    ).get();
    if (row) return decryptValue(row.value);
  }

  const global = db.select({
    value: secrets.valueEncrypted,
  }).from(secrets).where(
    and(eq(secrets.scope, "global"), isNull(secrets.scopeId), eq(secrets.name, name)),
  ).get();
  if (global) return decryptValue(global.value);

  return null;
}

export function resolveSecretForWorkspace(name: string, workspaceId: number | null): string | null {
  const db = getDb();

  if (workspaceId != null) {
    const row = db.select({
      value: secrets.valueEncrypted,
    }).from(secrets).where(
      and(eq(secrets.scope, "workspace"), eq(secrets.scopeId, workspaceId), eq(secrets.name, name)),
    ).get();
    if (row) return decryptValue(row.value);
  }

  const global = db.select({
    value: secrets.valueEncrypted,
  }).from(secrets).where(
    and(eq(secrets.scope, "global"), isNull(secrets.scopeId), eq(secrets.name, name)),
  ).get();
  if (global) return decryptValue(global.value);

  return null;
}

// ─── Placeholder substitution ───

const PLACEHOLDER_RE = /\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface PlaceholderResult {
  value: string;
  missing: string[];
}

/**
 * Replace every `${secret:NAME}` occurrence in `input` with the resolved value.
 * Missing secrets are left as the original placeholder and reported in `missing`.
 */
export function substitutePlaceholders(
  input: string,
  lookup: (name: string) => string | null,
): PlaceholderResult {
  const missing: string[] = [];
  const value = input.replace(PLACEHOLDER_RE, (match, name: string) => {
    const resolved = lookup(name);
    if (resolved == null) {
      if (!missing.includes(name)) missing.push(name);
      return match;
    }
    return resolved;
  });
  return { value, missing };
}

export function listPlaceholders(input: string): string[] {
  const names: string[] = [];
  for (const m of input.matchAll(PLACEHOLDER_RE)) {
    const n = m[1];
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}
