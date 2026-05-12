import { Hono } from "hono";
import {
  registerChatCrud,
  registerChatGetById,
  registerChatDelete,
  registerChatBatchDelete,
  registerChatPatch,
} from "./crud.js";
import { registerChatMessages } from "./messages.js";
import { registerChatAttachments } from "./attachments.js";
import { registerChatIncidents } from "./incidents.js";
import {
  registerChatGlobalPendingPermissions,
  registerChatIdPendingPermissions,
  registerChatPermissionResolve,
  registerChatCancel,
  registerChatApproval,
} from "./permissions.js";
import { registerChatQuestions } from "./questions.js";
import { registerChatMetrics } from "./metrics.js";
import { registerChatTodos } from "./todos.js";
import { registerChatDiff } from "./diff.js";
import {
  registerChatEndSession,
  registerChatWorktreeApply,
  registerChatWorktreeCleanup,
} from "./worktree.js";

export const chatRoutes = new Hono();

// Registration order matters — Hono uses first-match routing, so literal
// segments like `/pending-permissions` MUST be registered before `/:id`-style
// patterns. The sequence below mirrors the original monolithic chats.ts so
// route precedence is unchanged.

// POST /, GET /
registerChatCrud(chatRoutes);

// GET /pending-permissions — literal path, must come before GET /:id
registerChatGlobalPendingPermissions(chatRoutes);

// POST /batch-delete — literal path, must come before any /:id routes so a
// request like POST /chats/batch-delete isn't captured by /:id-style handlers.
registerChatBatchDelete(chatRoutes);

// GET /:id
registerChatGetById(chatRoutes);

// POST /:id/messages, POST /:id/messages/stream
registerChatMessages(chatRoutes);

// POST /:id/attachments, GET /:id/attachments/:attId/blob
registerChatAttachments(chatRoutes);

// POST /:id/extract-incident
registerChatIncidents(chatRoutes);

// GET /:id/pending-permissions
registerChatIdPendingPermissions(chatRoutes);

// GET /:id/pending-questions, POST /:id/question/:requestId,
// GET /:id/questions, POST /:id/question/:requestId/answer
registerChatQuestions(chatRoutes);

// POST /:id/permission/:requestId
registerChatPermissionResolve(chatRoutes);

// POST /:id/cancel
registerChatCancel(chatRoutes);

// GET /:id/metrics
registerChatMetrics(chatRoutes);

// GET /:id/todos, GET /:id/todos/history
registerChatTodos(chatRoutes);

// GET /:id/diff — synthesized unified diff of every Edit/Write the agent
// made in this chat. Mirrors GET /tasks/:id/diff; see routes/chats/diff.ts.
registerChatDiff(chatRoutes);

// DELETE /:id
registerChatDelete(chatRoutes);

// POST /:id/approve, POST /:id/reject
registerChatApproval(chatRoutes);

// PATCH /:id
registerChatPatch(chatRoutes);

// POST /:id/end-session — operator-driven worktree cleanup (matches
// `claude --worktree` exit prompt). Cleans iff worktree is clean,
// returns 409 otherwise; pass `?force=true` to discard a dirty
// worktree.
registerChatEndSession(chatRoutes);

// DELETE /:id/worktree — RESTful synonym of POST /:id/end-session
// (same handler under the hood). CLI / scripting clients reach for
// this; the UI's "End session" button uses POST /end-session.
registerChatWorktreeCleanup(chatRoutes);

// POST /:id/worktree/apply — merge the chat's worktree branch into
// the project's currently-checked-out branch. Counterpart to End
// session (which discards the worktree); this lands the agent's
// commits on the operator's branch. Worktree itself is preserved.
registerChatWorktreeApply(chatRoutes);
