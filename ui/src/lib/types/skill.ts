// --- Skills ---

export type DisableLevel = "global" | "workspace" | "project";

export interface DisableEntry {
  name: string;
  level: DisableLevel;
}

export interface Skill {
  name: string;
  level: DisableLevel;
  content: string;
}
