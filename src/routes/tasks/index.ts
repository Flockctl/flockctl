import { Hono } from "hono";
import {
  registerTaskList,
  registerTaskStats,
  registerTaskGetById,
  registerTaskCreate,
  registerTaskPatch,
  registerTaskPut,
  registerTaskCancel,
  registerTaskRerun,
  registerTaskApproval,
} from "./crud.js";
import { registerTaskLogs, registerTaskDiff } from "./logs.js";
import {
  registerTaskPendingPermissions,
  registerTaskQuestions,
  registerTaskPermissionResolve,
} from "./permissions.js";

export { taskSpecSchema, SPEC_MAX_ACCEPTANCE_CRITERIA_ITEMS, SPEC_MAX_ACCEPTANCE_CRITERION_CHARS, SPEC_MAX_DECISION_TABLE_RULES } from "./helpers.js";

export const taskRoutes = new Hono();

// Registration order mirrors the original monolithic tasks.ts so Hono's
// first-match routing behaves identically. Literal segments like `/stats`
// MUST be registered before `/:id`-style patterns.

// GET /tasks
registerTaskList(taskRoutes);

// GET /tasks/stats — literal, must come before GET /:id
registerTaskStats(taskRoutes);

// GET /tasks/:id
registerTaskGetById(taskRoutes);

// GET /tasks/:id/pending-permissions
registerTaskPendingPermissions(taskRoutes);

// GET /tasks/:id/logs
registerTaskLogs(taskRoutes);

// POST /tasks
registerTaskCreate(taskRoutes);

// PATCH /tasks/:id
registerTaskPatch(taskRoutes);

// PUT /tasks/:id
registerTaskPut(taskRoutes);

// POST /tasks/:id/cancel
registerTaskCancel(taskRoutes);

// POST /tasks/:id/rerun
registerTaskRerun(taskRoutes);

// GET /tasks/:id/diff
registerTaskDiff(taskRoutes);

// POST /tasks/:id/approve, POST /tasks/:id/reject
registerTaskApproval(taskRoutes);

// GET /tasks/:id/pending-questions, POST /tasks/:id/question/:requestId,
// GET /tasks/:id/questions, POST /tasks/:id/question/:requestId/answer
registerTaskQuestions(taskRoutes);

// POST /tasks/:id/permission/:requestId
registerTaskPermissionResolve(taskRoutes);
