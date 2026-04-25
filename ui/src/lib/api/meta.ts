import type { MetaResponse, MetaDefaults } from "../types";
import { apiFetch } from "./core";

export function fetchMeta(): Promise<MetaResponse> {
  return apiFetch("/meta");
}

/**
 * Update one or both global defaults. Pass `null` to clear a field; omit to leave
 * it unchanged. Backend responds with the resolved defaults block.
 */
export function updateMetaDefaults(input: {
  default_model?: string | null;
  default_key_id?: number | null;
}): Promise<MetaDefaults> {
  return apiFetch("/meta/defaults", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
