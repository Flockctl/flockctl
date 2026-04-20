# Multi-Account Claude Code Setup

Flockctl supports running tasks under different Claude accounts simultaneously. This lets you spread workload across several Claude Max / Team subscriptions or isolate projects by account.

## How It Works

Claude Code stores credentials and settings in a **config directory** (default: `~/.claude`). By pointing Flockctl at different config directories, each key gets its own independent OAuth session.

When a task runs, Flockctl sets `CLAUDE_CONFIG_DIR` to the key's config directory before launching the Claude CLI. The CLI then uses the credentials stored in that directory.

## Quick Setup

### 1. Install Claude Code

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

### 2. Create a profile for each account

For each account, choose a unique directory name and log in:

```bash
# Account 1 — personal
CLAUDE_CONFIG_DIR=~/.claude-personal claude
# Inside the session, type /login and authenticate

# Account 2 — work
CLAUDE_CONFIG_DIR=~/.claude-work claude
# Inside the session, type /login and authenticate

# Account 3 — team
CLAUDE_CONFIG_DIR=~/.claude-team claude
# Inside the session, type /login and authenticate
```

Each directory will contain its own `.credentials.json` after login.

### 3. Add keys in Flockctl

Open the Flockctl UI → **Settings** → **Add Claude Code Key**.

For each account, fill in:

| Field | Value |
|-------|-------|
| **Config Directory** | `~/.claude-personal` (or whichever path you used) |
| **Name** | A descriptive label, e.g. "Personal" or "Work" |

Leave **OAuth Credentials** empty — Flockctl reads them directly from the config directory.

Repeat for each account.

### 4. Verify

Create a test task. In the task logs, you'll see which key was selected. Each key uses its own config directory and therefore its own authenticated session.

## API Usage

You can also manage keys via the REST API:

```bash
# Add a key with config_dir
curl -X POST http://localhost:52077/keys \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Work Account",
    "provider": "claude_cli",
    "provider_type": "cli",
    "config_dir": "~/.claude-work"
  }'

# List all keys
curl http://localhost:52077/keys
```

## Key Assignment (Project & Workspace)

By default, any task can use any active key. To restrict which keys a project or workspace uses:

### Hierarchy

```
Task → Project → Workspace → All keys
```

- If a **project** has `allowedKeyIds`, only those keys are used. No fallback to workspace.
- If a project has no restriction but its **workspace** has `allowedKeyIds`, the workspace restriction applies.
- If neither is set, all active keys are available.

### Examples

```bash
# Assign key IDs [1] to a workspace → all projects in it use only key 1
curl -X PATCH http://localhost:52077/workspaces/1 \
  -H "Content-Type: application/json" \
  -d '{ "allowedKeyIds": [1] }'

# Override for a specific project → use keys 2 and 3 (rotation between them)
curl -X PATCH http://localhost:52077/projects/5 \
  -H "Content-Type: application/json" \
  -d '{ "allowedKeyIds": [2, 3] }'

# Remove restriction (fall back to workspace, then all keys)
curl -X PATCH http://localhost:52077/projects/5 \
  -H "Content-Type: application/json" \
  -d '{ "allowedKeyIds": null }'
```

### Typical setup

| Entity | allowedKeyIds | Effect |
|--------|---------------|--------|
| Workspace "Work" | `[1]` (work key) | All work projects → work account |
| Workspace "Personal" | `[2, 3]` (2 personal keys) | All personal projects → rotation between 2 keys |
| Project "special" in "Work" | `[2]` (personal key) | Override: this project uses personal key, not work |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "No available AI keys" error | Make sure at least one key is active and not disabled |
| Auth fails for a specific key | Re-run `CLAUDE_CONFIG_DIR=<path> claude` and `/login` again |
| Wrong account used | Check the key's config_dir — each must point to a unique directory |
| `~` not expanding | Flockctl expands `~` automatically — use `~/.claude-work`, not the full path |
