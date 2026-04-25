// --- Permission modes (mirror backend enum) ---

export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "auto",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
