# Flockctl — AGENTS.md Layering

> How agent-guidance files are resolved, merged, and injected into every session.

Flockctl agent sessions are prompted from up to **three AGENTS.md layers** that are read from disk at session start and concatenated (with header banners) into the system prompt. This document is the detailed reference for the layering model — layer order, file paths, precedence, size caps, the wire format, and the decision tree for deciding where to put a given rule.

For a one-paragraph summary and where this fits in the bigger picture, see [ARCHITECTURE.md](ARCHITECTURE.md). For the CLI entry points, see [`flockctl agents`](CLI.md#flockctl-agents).

## Why three layers

Flockctl uses a **pure read-only loader** (`src/services/agent-session/agent-guidance-loader.ts`) to resolve agent guidance. Nothing is generated on disk. Each layer is an independently editable file; the merge happens in memory on every session start, and the merged string is injected into the SDK system prompt directly (see `AgentSession.injectAgentGuidance()`).

Three layers cover the three natural scopes a rule can live at — user (all my projects, all my machines), workspace (this workspace, every linked project), and project (this one repo). Later layers append to earlier ones in the merged prompt, so rules compose rather than override.

## Layer contract

Layers are read in this exact order. Later layers **append** to the merged prompt; they do **not** override or mask earlier layers — the agent sees every non-empty layer concatenated top-to-bottom.

| # | Layer              | Path (relative to its root)                  | Root                              | Scope              |
|---|--------------------|----------------------------------------------|-----------------------------------|--------------------|
| 1 | `user`             | `AGENTS.md`                                  | `<flockctlHome>`                  | user-global        |
| 2 | `workspace-public` | `AGENTS.md`                                  | `<workspacePath>`                 | workspace          |
| 3 | `project-public`   | `AGENTS.md`                                  | `<projectPath>`                   | project            |

**Precedence = append, not override.** If layer 1 says "always run `npm test` after edits" and layer 3 says "always run `pytest` after edits", the agent receives both rules back-to-back. There is no "project wins over user" short-circuit — later rules can refine, contradict, or replace earlier ones only through the natural-language reading of the merged prompt. If you want a lower layer to *silence* a higher one, say so explicitly in the lower layer's text.

**Skipped layers.** A layer is omitted (not written as an empty section) when:

- The file is missing.
- The path is a directory named `AGENTS.md`.
- The file is zero bytes.
- The file cannot be read (EACCES, I/O error).
- The file is a symlink whose `realpath` escapes its containing root — traversal guard.

**Workspace auto-discovery.** When a session is scoped to a project, the workspace path is taken from the project's `workspaceId` in the database (API and task flows) or by walking up ancestors of the project path looking for a `.flockctl/` scaffold (the `flockctl agents` CLI, which works while the daemon is stopped). A project with no enclosing workspace resolves layer 2 as absent.

**Workspace-only sessions.** `GET /workspaces/:id/agents-md/effective` and `flockctl agents show --workspace <path>` resolve only layers 1–2. There is no project scope to attach layer 3 to.

## Size caps

Guidance files can grow unboundedly (users paste large style guides, long checklists, transcripts). To keep the system prompt predictable, the loader enforces two caps:

| Cap              | Value      | What happens on overflow                                                                 |
|------------------|------------|------------------------------------------------------------------------------------------|
| **Per-layer**    | 256 KiB    | The layer is truncated at 256 KiB and stamped with a `reason=per-layer-cap` marker.      |
| **Total merged** | 1 MiB      | Layers are appended in order until the budget runs out. The overflowing layer is truncated to fit (with `reason=total-cap`); later layers are dropped entirely and listed in `truncatedLayers`. |

**Truncation marker format** (both caps use the same shape, differing only in `reason`):

```
<!-- flockctl:truncated layer=<layer> original_bytes=<n> reason=<per-layer-cap|total-cap> -->
```

The marker is appended after the kept prefix. Multi-byte UTF-8 sequences at the cut point are trimmed cleanly — the loader never emits U+FFFD. Truncated layers are also reported in the API response as `truncatedLayers: LayerName[]`.

## Runtime merge format

The merged output is a single UTF-8 string with a per-layer header banner and a final trailer. Tools that consume or diagnose the merged prompt (CLI, UI preview, logs) can parse these banners to reconstruct per-layer boundaries.

Each present layer is emitted as:

```
<!-- flockctl:agent-guidance layer=<layer> path=<absolute_path> bytes=<n>[ truncated=true] -->
<layer content>
```

followed by a single trailer:

```
<!-- flockctl:agent-guidance end total_bytes=<n>[ truncated_layers=<comma,separated,list>] -->
```

Example with all three layers present (one truncated):

```
<!-- flockctl:agent-guidance layer=user path=/Users/me/flockctl/AGENTS.md bytes=412 -->
# User rules
- Prefer small commits.
<!-- flockctl:agent-guidance layer=workspace-public path=/Users/me/workspaces/main/AGENTS.md bytes=1804 -->
# Workspace rules
...
<!-- flockctl:agent-guidance layer=project-public path=/Users/me/repos/widget/AGENTS.md bytes=262144 truncated=true -->
# Project rules
...
<!-- flockctl:truncated layer=project-public original_bytes=309241 reason=per-layer-cap -->
<!-- flockctl:agent-guidance end total_bytes=264360 truncated_layers=project-public -->
```

When no layer is present the merged string is empty and `injectAgentGuidance` passes the system prompt through untouched.

## Editing each layer

### Decision tree

- **Is this rule for all my projects, on all my machines?**
  → `user` (layer 1). Lives in `<flockctlHome>/AGENTS.md`.

- **Is this rule specific to this workspace, across every linked project?**
  → `workspace-public` (layer 2). Lives at `<workspacePath>/AGENTS.md`. Git-trackable like any other root-level document; `.gitignore` it via the auto-managed block if you want to keep it local-only.

- **Is this rule specific to this project?**
  → `project-public` (layer 3). This is the classic `AGENTS.md` at the repo root.

### What goes where — quick reference

| Layer              | Typical contents                                                                 | Where it lives |
|--------------------|----------------------------------------------------------------------------------|----------------|
| `user`             | Cross-cutting personal preferences: commit style, language, general taste.       | `$FLOCKCTL_HOME/AGENTS.md` — not in any repo. |
| `workspace-public` | Standards that all linked projects should show to any agent / tool.              | `<workspacePath>/AGENTS.md` — git-trackable. |
| `project-public`   | Classic `AGENTS.md` at the repo root — conventions visible to every tool.        | `<projectPath>/AGENTS.md` — git-trackable. |

See the `gitignoreFlockctl` / `gitignoreAgentsMd` booleans on [`POST /projects`](API.md#projects) and [`POST /workspaces`](API.md#workspaces) for the auto-managed `.gitignore` block.

## Debugging

To see exactly what an agent session rooted at a given path will be injected with:

```bash
flockctl agents show <path>                  # merged guidance with layer banners
flockctl agents show <path> --workspace      # workspace-scoped view (layers 1-2)
flockctl agents show <path> --layers         # JSON summary: per-layer bytes, paths, truncation
```

The CLI is filesystem-local — it works whether or not the daemon is running. Output goes to stdout (pipe-friendly, no ANSI escapes); errors and warnings go to stderr.

Inside the daemon, the same data is available over HTTP:

- `GET /projects/:id/agents-md` — project-scoped layer contents (`{ layers: { "project-public": LayerContent } }`).
- `GET /projects/:id/agents-md/effective` — merged guidance with all three layers resolved.
- `GET /workspaces/:id/agents-md` — workspace-scoped layer contents (`{ layers: { "workspace-public": LayerContent } }`).
- `GET /workspaces/:id/agents-md/effective` — merged guidance, layers 1–2 only.

See [API.md](API.md) for request/response shapes.

Each session also logs a one-line trace when guidance is injected:

```
[agent-session] guidance.injected layers=3 ref=<session-prefix> total_bytes=4020
```

When any layer is truncated, the trace includes `truncated=<comma-separated-layer-list>`.

See [`flockctl agents show`](CLI.md#flockctl-agents-show-path) for the full CLI reference.
