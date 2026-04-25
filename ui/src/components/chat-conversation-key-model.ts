import { useCallback, useEffect, useRef, useState } from "react";
import { filterKeysByAllowList, filterModelsForKey } from "@/lib/provider-agents";
import type { MetaKey, MetaModel } from "@/lib/types";

/**
 * Inputs required to resolve which provider key + model the chat should use.
 * All fields are shaped exactly as the parent reads them from `useMeta`,
 * `useChat`, `useProjectConfig`, and `useProjectAllowedKeys` — the hook does
 * not re-fetch anything, it just owns the reconciliation logic.
 */
export interface UseChatKeyModelSelectionInput {
  chatId: string | null;
  allActiveKeys: MetaKey[];
  allModels: MetaModel[];
  defaultModel: string;
  defaultKeyId: string | number | null | undefined;
  projectIdForConfig: string;
  chatAllowedKeys: { allowedKeyIds: number[] | null } | null | undefined;
  chatProjectConfig: { model?: unknown } | null | undefined;
  persistedKeyId: string | number | null | undefined;
  persistedModel: string | null | undefined;
}

/**
 * Resolves the ChatConversation composer's "which key / which model" state.
 *
 * Behaviour mirrors the original inline implementation in chat-conversation.tsx:
 *   - Seeds local state from the persisted chat row once fetched.
 *   - Auto-picks a key (respecting the project allow-list + global default)
 *     until the user explicitly touches the dropdown.
 *   - Auto-picks a model (respecting the project config override + model
 *     catalogue filtered by selected key) until the user picks one.
 *   - Resets "user picked" flags on chatId change so a different chat
 *     re-runs its own auto-select.
 *
 * Returned setters flip the "user picked" latch — callers should invoke them
 * from the dropdown onChange handlers and separately fire the persistence
 * mutation (keeping the server round-trip out of this hook keeps it pure).
 */
export function useChatKeyModelSelection(input: UseChatKeyModelSelectionInput) {
  const {
    chatId,
    allActiveKeys,
    allModels,
    defaultModel,
    defaultKeyId,
    projectIdForConfig,
    chatAllowedKeys,
    chatProjectConfig,
    persistedKeyId,
    persistedModel,
  } = input;

  const [chatKeyId, setChatKeyIdState] = useState<string>("");
  const [chatModel, setChatModelState] = useState<string>("");

  // `userPickedModelRef` and `userPickedKeyRef` disable the auto-select
  // effects below for the rest of the chat's lifetime once the user touches
  // the selector. They're also reset whenever the server-side persisted value
  // changes (e.g. the chat was just fetched or PATCHed elsewhere), so
  // switching tabs picks up the new saved selection instead of the stale
  // local pick.
  const userPickedModelRef = useRef(false);
  const userPickedKeyRef = useRef(false);

  // Reset per-chat "user picked" latches on chat switch.
  useEffect(() => {
    userPickedModelRef.current = false;
    userPickedKeyRef.current = false;
  }, [chatId]);

  // When the chat detail finishes loading (or gets refetched with a newer
  // persisted selection), seed the local selectors from the saved values.
  // This is the "reload restores provider + model" bit — without it every
  // remount re-resolved from globals and the user's previous pick vanished.
  useEffect(() => {
    if (!persistedKeyId) return;
    if (String(persistedKeyId) === chatKeyId) return;
    setChatKeyIdState(String(persistedKeyId));
    // Server state wins on refresh — re-enable auto-select for model so the
    // dropdown re-picks a compatible model for the newly-loaded key.
    userPickedKeyRef.current = true;
  }, [persistedKeyId, chatKeyId]);
  useEffect(() => {
    if (!persistedModel) return;
    if (persistedModel === chatModel) return;
    setChatModelState(persistedModel);
    userPickedModelRef.current = true;
  }, [persistedModel, chatModel]);

  const keys = projectIdForConfig
    ? filterKeysByAllowList(allActiveKeys, chatAllowedKeys?.allowedKeyIds ?? null)
    : allActiveKeys;

  // Auto-select provider key. Handles two cases:
  //   (1) Initial mount with no persisted / user pick — pick the global
  //       default if it's in the project's allow-list, otherwise fall
  //       back to the first allowed key.
  //   (2) Allow-list tightened mid-session so the currently-selected
  //       key is no longer permitted — re-pick from the filtered set.
  // Critically, we WAIT for `chatAllowedKeys` to load before picking
  // for a project-scoped chat: `filterKeysByAllowList` treats a null
  // allow-list as "allow everything", so running the effect during the
  // pending fetch would lock in the user's global default (e.g. a
  // Personal key) even when the project only permits a Work key.
  // Once the user (or server-restore) explicitly sets a key we stop
  // overriding — matches the existing `userPickedKeyRef` contract and
  // the model dropdown's "persisted selection still shows even if
  // tightened out" behaviour.
  useEffect(() => {
    if (userPickedKeyRef.current) return;
    if (keys.length === 0) return;
    if (projectIdForConfig && !chatAllowedKeys) return;
    if (chatKeyId && keys.some((k) => String(k.id) === chatKeyId)) return;
    const preferred = defaultKeyId
      ? keys.find((k) => String(k.id) === String(defaultKeyId))
      : null;
    const pick = preferred ?? keys[0];
    if (!pick) return;
    setChatKeyIdState(String(pick.id));
  }, [keys, chatKeyId, defaultKeyId, projectIdForConfig, chatAllowedKeys]);

  // Model dropdown is restricted to the agent backing the currently selected
  // key. A Claude Code key hides GPT models, a Copilot key hides Anthropic
  // direct-API models, etc. No key → full catalogue. We look up the key in
  // `allActiveKeys` (not the allow-list-filtered `keys`) so the model list
  // still resolves correctly when a persisted selection has since been
  // tightened out of the project whitelist.
  const models = filterModelsForKey(allModels, allActiveKeys, chatKeyId || null);

  // Auto-select model (project config > global default), unless user overrode.
  // When the key changes and the previously-picked model is no longer in the
  // filtered list, fall back to the first available model so the selector
  // never shows a stale label.
  useEffect(() => {
    if (userPickedModelRef.current) {
      // User's choice still wins — but if it's no longer available under the
      // new key, override and clear the "user picked" flag so auto-selection
      // resumes.
      if (chatModel && models.length > 0 && !models.some((m) => m.id === chatModel)) {
        userPickedModelRef.current = false;
        const first = models[0];
        if (first) setChatModelState(first.id);
      }
      return;
    }
    const projectModel =
      typeof chatProjectConfig?.model === "string" ? chatProjectConfig.model : null;
    const preferred = projectModel || defaultModel;
    const next = models.some((m) => m.id === preferred)
      ? preferred
      : (models[0]?.id ?? preferred);
    if (next && next !== chatModel) setChatModelState(next);
  }, [chatProjectConfig, defaultModel, chatModel, models]);

  const setChatKeyIdFromUser = useCallback((v: string) => {
    userPickedKeyRef.current = true;
    setChatKeyIdState(v);
  }, []);

  const setChatModelFromUser = useCallback((v: string) => {
    userPickedModelRef.current = true;
    setChatModelState(v);
  }, []);

  return {
    chatKeyId,
    chatModel,
    keys,
    models,
    setChatKeyIdFromUser,
    setChatModelFromUser,
  };
}
