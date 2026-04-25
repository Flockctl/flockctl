// --- Secrets ---

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
