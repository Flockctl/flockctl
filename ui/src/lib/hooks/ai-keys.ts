import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchAIKeys,
  createAIKey,
  updateAIKey,
  deleteAIKey,
  fetchAIKeyIdentity,
} from "../api";
import type { AIKeyIdentityResponse } from "../types";
import { queryKeys } from "./core";

// --- AI Key hooks ---

export function useAIKeys() {
  return useQuery({
    queryKey: queryKeys.aiKeys,
    queryFn: () => fetchAIKeys().then((res) => res.items),
  });
}

export function useCreateAIKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createAIKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.aiKeys });
    },
  });
}

export function useUpdateAIKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ keyId, data }: { keyId: string; data: { is_active?: boolean; label?: string; config_dir?: string } }) =>
      updateAIKey(keyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.aiKeys });
    },
  });
}

export function useDeleteAIKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => deleteAIKey(keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.aiKeys });
    },
  });
}

/**
 * Resolve the Anthropic account behind a Claude Code key and cache the
 * result in react-query for 5 minutes. The query auto-fires on mount, so
 * the Account column no longer starts as "Click Verify" — the real state
 * appears as soon as the row is rendered. The Verify button calls
 * `refetch()` so the user can force a re-resolution after fixing the
 * Keychain ACL or re-logging in with `claude auth login`.
 *
 * Shared react-query cache (not a per-row `useState`) means navigating
 * away from Settings and back doesn't lose the resolved identity, and
 * deleting/renaming keys invalidates automatically via the `ai-keys` key.
 */
export function useAIKeyIdentity(keyId: string, opts?: { enabled?: boolean }) {
  return useQuery<AIKeyIdentityResponse, Error>({
    queryKey: queryKeys.aiKeyIdentity(keyId),
    queryFn: () => fetchAIKeyIdentity(keyId),
    enabled: (opts?.enabled ?? true) && Boolean(keyId),
    // 5 min — tokens rarely change, and the UI has an explicit Verify
    // button for users who want to force a fresh resolution.
    staleTime: 5 * 60 * 1000,
    // One auto-retry covers the common "daemon was just starting up /
    // Keychain ACL prompt was briefly denied" transient; more retries
    // would mask real errors.
    retry: 1,
  });
}

/**
 * @deprecated Use {@link useAIKeyIdentity} instead — the mutation form
 * caused the Account column to keep a stale "not logged in" in component
 * state even after the underlying `claude auth` state was fixed. Kept
 * temporarily for any external callers; will be removed in a later slice.
 */
export function useVerifyAIKeyIdentity() {
  return useMutation<AIKeyIdentityResponse, Error, string>({
    mutationFn: (keyId: string) => fetchAIKeyIdentity(keyId),
  });
}
