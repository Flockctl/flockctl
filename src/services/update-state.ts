export type UpdateStatus = "idle" | "running" | "success" | "error";

export interface UpdateState {
  status: UpdateStatus;
  error?: string;
  targetVersion?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}

let state: UpdateState = { status: "idle" };

export function getUpdateState(): UpdateState {
  return { ...state };
}

export function setUpdateState(next: UpdateState): void {
  state = next;
}

// Test-only helper — lets the route test suite start each case from a clean slate.
export function resetUpdateState(): void {
  state = { status: "idle" };
}
