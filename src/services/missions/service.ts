// ─── Mission supervisor: production singleton ───
//
// Single export the boot path imports to wire `task_observed` events
// (`subscribeMissionEvents`) and the `heartbeat` cron (`registerHeartbeats`)
// into the same `SupervisorService` instance. Keeping the wiring on a
// module-level singleton mirrors the pattern used by `taskExecutor` /
// `chatExecutor` (`src/services/task-executor/executor.ts`,
// `src/services/chat-executor.ts`) — one instance per process, lazily
// constructed on first import.
//
// Production LLM is `ClaudeSupervisorLLM` (Claude Agent SDK round-trip,
// `noTools` + thinking-disabled). Tests must NOT import this singleton —
// they construct `new SupervisorService(fakeLLM)` directly so the LLM
// seam stays under their control. A test that accidentally pulled in this
// file would attempt a real SDK call inside the unit-test sandbox.

import { ClaudeSupervisorLLM } from "./claude-supervisor-llm.js";
import { SupervisorService } from "./supervisor.js";

/**
 * Process-wide `SupervisorService` for production wiring. Constructed once
 * at module-load time; consumers pass it to `subscribeMissionEvents` (event-
 * subscriber for task-terminal triggers) and to the heartbeat callback in
 * `server-entry.ts`. Both call sites use the same instance so per-mission
 * coalescing and budget tracking remain consistent across trigger sources.
 */
export const supervisorService = new SupervisorService(new ClaudeSupervisorLLM());
