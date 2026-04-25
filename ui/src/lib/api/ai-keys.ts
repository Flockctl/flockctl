import type { AIProviderKeyResponse, AIKeyIdentityResponse } from "../types";
import { apiFetch } from "./core";

export function fetchAIKeys(): Promise<{ items: AIProviderKeyResponse[]; total: number }> {
  return apiFetch(`/keys`);
}

export function createAIKey(data: {
  name?: string;
  provider: string;
  provider_type: string;
  cli_command?: string;
  key_value?: string;
  config_dir?: string;
}): Promise<AIProviderKeyResponse> {
  return apiFetch(`/keys`, {
    method: "POST",
    body: JSON.stringify({
      provider: data.provider,
      providerType: data.provider_type,
      label: data.name,
      keyValue: data.key_value,
      cliCommand: data.cli_command,
      configDir: data.config_dir,
    }),
  });
}

export function updateAIKey(
  keyId: string,
  data: { is_active?: boolean; label?: string; config_dir?: string },
): Promise<AIProviderKeyResponse> {
  return apiFetch(`/keys/${keyId}`, {
    method: "PATCH",
    body: JSON.stringify({
      ...(data.is_active !== undefined && { isActive: data.is_active }),
      ...(data.label !== undefined && { label: data.label }),
      ...(data.config_dir !== undefined && { configDir: data.config_dir }),
    }),
  });
}

export function deleteAIKey(keyId: string): Promise<{ deleted: boolean }> {
  return apiFetch(`/keys/${keyId}`, { method: "DELETE" });
}

/**
 * Resolve the Anthropic OAuth profile for a Claude Code key — answers
 * "who does this key actually authenticate as?" by hitting
 * `https://api.anthropic.com/api/oauth/profile` on the backend under the
 * key's `CLAUDE_CONFIG_DIR`.
 *
 * `rawKeys: true` is mandatory here: the backend intentionally returns
 * camelCase (`loggedIn`, `organizationName`, `rateLimitTier`, …) because
 * that's the shape `AIKeyIdentityResponse` declares. Without `rawKeys`,
 * apiFetch would deep-convert keys to snake_case and the UI would read
 * `data.loggedIn` as `undefined`, rendering every key as "not logged in"
 * even when the backend successfully resolved the profile. See the
 * 2026-04-23 bugfix that added this flag.
 */
export function fetchAIKeyIdentity(keyId: string): Promise<AIKeyIdentityResponse> {
  return apiFetch(`/keys/${keyId}/identity`, { rawKeys: true });
}
