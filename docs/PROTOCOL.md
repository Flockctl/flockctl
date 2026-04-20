# Flockctl — WebSocket & SSE Protocol

## Overview

Flockctl uses two real-time communication channels:

- **WebSocket** — live task log streaming and chat events
- **Server-Sent Events (SSE)** — AI chat response streaming

Both respect the same auth rules as the REST API — see [API.md](API.md#authentication) for full details. TL;DR:

- Local mode (no `remoteAccessToken` set) → everything is open.
- Remote mode → non-localhost connections must authenticate.
  - REST/SSE: `Authorization: Bearer <token>` header.
  - WebSocket: `?token=<token>` query parameter (browsers can't set headers on WS upgrades).

Failures close the WebSocket with close code `1008` and the reason `"Missing token"` / `"Invalid token"`.

## WebSocket Endpoints

| Path | Purpose |
|------|---------|
| `ws://HOST/ws/ui/tasks/:taskId/logs` | Live task execution logs for a single task |
| `ws://HOST/ws/ui/chats/:chatId/events` | Live events for a specific chat (permission requests, session start/end) |
| `ws://HOST/ws/ui/chats/events` | Global chat events stream (used by the chat list for "running" / "pending approval" indicators) |
| `GET /ws/status` | HTTP. Returns `{ clients: N }` — number of live WS connections. |

### Task Log Stream

1. Client connects via WebSocket to `ws://HOST/ws/ui/tasks/:taskId/logs` (with `?token=...` in remote mode).
2. Server verifies the token and registers the client with `WSManager`.
3. As the task executes, log lines are broadcast to all connected clients.
4. On task completion, any terminal status event is sent.
5. Client disconnects (or server closes on task completion).

Message format:

```json
{
  "type": "log",
  "content": "Log line content",
  "streamType": "stdout",
  "timestamp": "2026-04-15T10:30:00.000Z"
}
```

### Chat Events Stream

For per-chat (`/ws/ui/chats/:chatId/events`) and global (`/ws/ui/chats/events`) streams, events include:

- `session_started` — agent session began for this chat
- `session_ended` — agent session finished
- `permission_request` — agent is asking the user to approve a tool call
- `permission_resolved` — user resolved a pending approval

Each event is a JSON object with at least `type` and `chat_id`.

## SSE: Chat Streaming

### Endpoint

- `POST /chats/:id/messages/stream` — the single streaming endpoint for all chat contexts (regular, plan-entity, workspace). Behavior is specialized via request parameters.

### Request

```json
{
  "content": "User message text",
  "model": "claude-sonnet-4-20250514",
  "system": "Optional system prompt",
  "keyId": 1,
  "entity_context": {
    "entity_type": "slice",
    "entity_id": "slice-slug",
    "milestone_id": "milestone-slug"
  }
}
```

### Response

`Content-Type: text/event-stream`

```
data: {"content":"Partial ","done":false}

data: {"content":"response ","done":false}

data: {"content":"text.","done":true,"chat_id":1,"usage":{"inputTokens":100,"outputTokens":50,"totalCostUsd":0.001}}
```

Each SSE event is a JSON object with:
- `content` — incremental text chunk
- `done` — whether this is the final chunk
- `chat_id` — chat session ID (final chunk)
- `usage` — token usage stats (only in final chunk)

In remote mode, the SSE request carries `Authorization: Bearer <token>` like any other REST call.
