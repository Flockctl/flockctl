-- Per-agent attribution for TodoWrite snapshots.
--
-- Background: a single chat can host multiple agents — the main session that
-- the user is talking to, plus any sub-agents spawned via the Claude Agent
-- SDK's built-in `Task` tool. Each of them keeps its own todo list and emits
-- its own `TodoWrite` calls, but until now `chat_todos` had no field to tell
-- them apart. The "Todo history" drawer in the UI ended up with a flat,
-- newest-first feed that mixed snapshots from every agent into one timeline,
-- making sequences like "0/11 → 1/11 → … → 9/11 from sub-agent A" interleave
-- nonsensically with "1/16 done from sub-agent B" and the main agent's plan.
--
-- The fix: persist the SDK-supplied `parent_tool_use_id` alongside each
-- snapshot. The SDK marks every tool_use block with this field — it's NULL
-- for the main agent's calls, and a `toolu_…` id for any sub-agent's calls
-- (pointing back to the `Task` tool_use that spawned it). With that column
-- the UI can pivot the flat history into one tab per agent (main + each
-- sub-agent), each tab showing its own latest snapshot and history.
--
-- Index `(chat_id, parent_tool_use_id, created_at DESC)` powers the new
-- "tabs" query (`SELECT … GROUP BY parent_tool_use_id` with a per-group
-- LIMIT 1 for the latest snapshot). Default NULL leaves all pre-existing
-- rows attributed to "main", which matches reality — sub-agents only
-- recently became reachable via the Task tool, and any historical snapshot
-- without this field came from a non-sidechain (main-agent) call.
ALTER TABLE chat_todos ADD COLUMN parent_tool_use_id TEXT;
--> statement-breakpoint
CREATE INDEX idx_chat_todos_chat_parent_created
  ON chat_todos (chat_id, parent_tool_use_id, created_at DESC);
