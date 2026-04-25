// --- Chat context type ---

export interface ChatContext {
  entity_type: "milestone" | "slice" | "task";
  entity_id: string;
  milestone_id?: string;
  slice_id?: string;
  title: string;
}
