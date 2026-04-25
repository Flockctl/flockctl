import type { MetaKey, MetaModel } from "./types";

/**
 * Map an AI Provider Key `provider` value (as stored in `ai_provider_keys`)
 * to the registered agent id that owns the matching model catalogue.
 *
 * Keeps the UI honest: a key with `provider: "claude_cli"` can only drive the
 * `claude-code` agent, so the model picker must hide Copilot's GPT entries.
 *
 * Returns `null` for providers that do not have a Flockctl-registered agent
 * (e.g. raw `anthropic` / `openai` API keys). Callers should treat `null` as
 * "no filter" so the user at least sees the full catalogue instead of an
 * empty dropdown.
 */
export function providerToAgentId(provider: string | null | undefined): string | null {
  switch (provider) {
    case "claude_cli":
      return "claude-code";
    case "github_copilot":
      return "copilot";
    default:
      return null;
  }
}

/**
 * Filter the /meta model catalogue down to the agent backing the selected
 * provider key. Falls back to the full list when no key is selected or the
 * key's provider does not map to a registered agent.
 */
export function filterModelsForKey(
  models: MetaModel[],
  keys: MetaKey[],
  selectedKeyId: string | null | undefined,
): MetaModel[] {
  if (!selectedKeyId) return models;
  const key = keys.find((k) => String(k.id) === String(selectedKeyId));
  if (!key) return models;
  const agentId = providerToAgentId(key.provider);
  if (!agentId) return models;
  return models.filter((m) => m.agent === agentId);
}

/**
 * Filter a keys list by the project's resolved AI-key allow-list (with
 * workspace inheritance already applied server-side via
 * `GET /projects/:id/allowed-keys`).
 *
 * `allowedKeyIds === null` → no restriction, return the list unchanged.
 * Otherwise return only the keys whose id appears in `allowedKeyIds`.
 *
 * Accepts `{ id: number | string }` so it works against both `MetaKey`
 * (meta endpoint shape) and `AIKey` (ai-keys endpoint shape) without
 * forcing the caller to normalize first.
 */
export function filterKeysByAllowList<K extends { id: number | string }>(
  keys: K[],
  allowedKeyIds: number[] | null | undefined,
): K[] {
  if (!allowedKeyIds) return keys;
  const allowed = new Set(allowedKeyIds.map((n) => Number(n)));
  return keys.filter((k) => allowed.has(Number(k.id)));
}
