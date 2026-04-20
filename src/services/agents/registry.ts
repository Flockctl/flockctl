import type { AgentProvider } from "./types.js";
import { ClaudeCodeProvider } from "./claude-code/provider.js";

const registry = new Map<string, AgentProvider>();
let defaultAgentId: string | null = null;

export function registerAgent(provider: AgentProvider, opts?: { asDefault?: boolean }): void {
  registry.set(provider.id, provider);
  if (opts?.asDefault || defaultAgentId === null) {
    defaultAgentId = provider.id;
  }
}

export function unregisterAgent(id: string): void {
  registry.delete(id);
  if (defaultAgentId === id) {
    defaultAgentId = registry.size > 0 ? registry.keys().next().value ?? null : null;
  }
}

export function getAgent(id?: string): AgentProvider {
  ensureBuiltIns();
  const key = id ?? defaultAgentId ?? "claude-code";
  const provider = registry.get(key);
  if (!provider) {
    throw new Error(`Agent provider "${key}" is not registered`);
  }
  return provider;
}

export function listAgents(): AgentProvider[] {
  ensureBuiltIns();
  return Array.from(registry.values());
}

export function hasAgent(id: string): boolean {
  ensureBuiltIns();
  return registry.has(id);
}

/** For tests — clears registry and built-in init flag. */
export function resetRegistry(): void {
  registry.clear();
  defaultAgentId = null;
  builtInsRegistered = false;
}

let builtInsRegistered = false;

function ensureBuiltIns(): void {
  if (builtInsRegistered) return;
  builtInsRegistered = true;
  if (!registry.has("claude-code")) {
    // Use asDefault only if no other provider has already claimed it.
    registerAgent(new ClaudeCodeProvider(), { asDefault: defaultAgentId === null });
  }
}
