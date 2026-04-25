import { describe, it, expect } from "vitest";
import {
  providerToAgentId,
  filterModelsForKey,
  filterKeysByAllowList,
} from "@/lib/provider-agents";
import type { MetaKey, MetaModel } from "@/lib/types";

const models: MetaModel[] = [
  { id: "claude-opus-4-7", name: "Claude Opus 4.7 (via Claude Code)", agent: "claude-code" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (via Claude Code)", agent: "claude-code" },
  { id: "claude-opus-4.7", name: "Claude Opus 4.7", agent: "copilot" },
  { id: "gpt-5.3-codex", name: "GPT-5.3-Codex", agent: "copilot" },
  { id: "gpt-4.1", name: "GPT-4.1", agent: "copilot" },
];

const keys: MetaKey[] = [
  { id: "1", name: "cc-key", provider: "claude_cli", is_active: true },
  { id: "2", name: "copilot-key", provider: "github_copilot", is_active: true },
  { id: "3", name: "raw-anthropic", provider: "anthropic", is_active: true },
];

describe("providerToAgentId", () => {
  it("maps claude_cli → claude-code", () => {
    expect(providerToAgentId("claude_cli")).toBe("claude-code");
  });
  it("maps github_copilot → copilot", () => {
    expect(providerToAgentId("github_copilot")).toBe("copilot");
  });
  it("returns null for providers without a registered agent", () => {
    expect(providerToAgentId("anthropic")).toBeNull();
    expect(providerToAgentId("openai")).toBeNull();
    expect(providerToAgentId(null)).toBeNull();
    expect(providerToAgentId(undefined)).toBeNull();
  });
});

describe("filterModelsForKey", () => {
  it("returns full catalogue when no key is selected", () => {
    expect(filterModelsForKey(models, keys, null).length).toBe(models.length);
    expect(filterModelsForKey(models, keys, undefined).length).toBe(models.length);
  });

  it("filters to Claude Code models when a claude_cli key is selected", () => {
    const filtered = filterModelsForKey(models, keys, "1");
    expect(filtered.map((m) => m.id)).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
  });

  it("filters to Copilot models when a github_copilot key is selected", () => {
    const filtered = filterModelsForKey(models, keys, "2");
    expect(filtered.map((m) => m.id)).toEqual(["claude-opus-4.7", "gpt-5.3-codex", "gpt-4.1"]);
  });

  it("returns full catalogue for providers without a mapped agent", () => {
    // `anthropic` key → no registered agent → fall through to full list.
    expect(filterModelsForKey(models, keys, "3").length).toBe(models.length);
  });

  it("returns full catalogue when the key id does not exist", () => {
    expect(filterModelsForKey(models, keys, "999").length).toBe(models.length);
  });
});

describe("filterKeysByAllowList", () => {
  it("returns all keys unchanged when allow-list is null/undefined", () => {
    expect(filterKeysByAllowList(keys, null)).toEqual(keys);
    expect(filterKeysByAllowList(keys, undefined)).toEqual(keys);
  });

  it("filters keys to the allow-listed ids", () => {
    // Allow numeric ids against string-id keys — the helper must coerce.
    const filtered = filterKeysByAllowList(keys, [1, 3]);
    expect(filtered.map((k) => k.id)).toEqual(["1", "3"]);
  });

  it("returns an empty list when allow-list excludes everything", () => {
    expect(filterKeysByAllowList(keys, [999])).toEqual([]);
  });

  it("works against numeric-id key shapes (AIKey, not MetaKey)", () => {
    const numeric = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(filterKeysByAllowList(numeric, [2]).map((k) => k.id)).toEqual([2]);
  });
});
