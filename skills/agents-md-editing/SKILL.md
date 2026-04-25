---
name: agents-md-editing
description: Edit AGENTS.md / CLAUDE.md in a Flockctl project or workspace. Three-layer model merged at session start. Use when asked to update CLAUDE.md, AGENTS.md, project rules, agent instructions. Keywords: AGENTS.md, CLAUDE.md, project rules, agent instructions.
---

# Editing AGENTS.md in Flockctl

AGENTS.md is **human-owned**. Flockctl no longer regenerates it — at session start it reads up to three layers, merges them, and injects the result as the agent's system-prompt prefix.

## Layers (merged in order)

1. user — `~/flockctl/AGENTS.md`
2. workspace-public — `<ws>/AGENTS.md`
3. project-public — `<proj>/AGENTS.md`

Workspace chats see only 1-2. Missing / empty / directory files are skipped.

## Which layer?

- My-machine preference → **1 user**.
- Team rule across every project in the workspace → **2 workspace-public** (commit).
- Rule specific to a single project → **3 project-public** (commit).

Narrower wins; append semantics — later layers can refine or contradict earlier ones in prose.

## API (`:scope` = `projects` | `workspaces`)

- `GET /:scope/:id/agents-md` → `{ layers: { "<scope>-public": {present,bytes,content} } }`.
- `PUT /:scope/:id/agents-md` — `{ content }`. Empty deletes. >256 KiB → `413`. **No cascade.**
- `GET /:scope/:id/agents-md/effective` → `{ layers[], totalBytes, truncatedLayers, mergedWithHeaders }`.

## CLI

- `flockctl agents migrate <path>` — one-shot migration from the legacy reconciler layout and/or retired `.flockctl/AGENTS.md` private layer.
- `flockctl agents show <path> [--workspace] [--effective|--layers]` — inspect merged guidance.

## Caps

Per-layer PUT **256 KiB** (`413` above). Total merged **1 MiB**; overflow named in `truncatedLayers[]`.

No generated root `AGENTS.md` / auto-overwritten `CLAUDE.md`; workspace edits don't touch project files.

See [docs/AGENTS-LAYERING.md](../../docs/AGENTS-LAYERING.md).
