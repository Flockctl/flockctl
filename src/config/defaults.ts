import { loadRc, saveRc } from "./paths.js";

export function getDefaultModel(): string {
  return loadRc().defaultModel ?? "claude-sonnet-4-6";
}

export function getPlanningModel(): string {
  return loadRc().planningModel ?? "claude-opus-4-7";
}

export function getDefaultAgent(): string {
  return loadRc().defaultAgent ?? "claude-code";
}

/** Default AI Provider Key id (numeric). Returns null when unset. */
export function getDefaultKeyId(): number | null {
  const raw = loadRc().defaultKeyId;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  return null;
}

/**
 * Update one or more global defaults in ~/.flockctlrc. Pass `null` to clear a
 * field; omit a key to leave it untouched.
 */
export function setGlobalDefaults(input: {
  defaultModel?: string | null;
  defaultKeyId?: number | null;
}): void {
  const rc = { ...loadRc() };
  if (input.defaultModel !== undefined) {
    if (input.defaultModel === null || input.defaultModel === "") {
      delete rc.defaultModel;
    } else {
      rc.defaultModel = input.defaultModel;
    }
  }
  if (input.defaultKeyId !== undefined) {
    if (input.defaultKeyId === null) {
      delete rc.defaultKeyId;
    } else {
      rc.defaultKeyId = input.defaultKeyId;
    }
  }
  saveRc(rc);
}
