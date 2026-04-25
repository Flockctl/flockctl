# Configuration

Flockctl is configured from two places:

1. **Environment variables** — read once at process start.
2. **`~/.flockctlrc`** — JSON, re-read from disk with a 5-second cache; every write by Flockctl (e.g. `flockctl token generate --save`) chmods the file back to `600`.

Neither source is required to run locally; unset values fall back to documented defaults.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `FLOCKCTL_HOME` | `~/flockctl` | Data root (database, workspaces, skills, PID file, logs). Takes precedence over `home` in `~/.flockctlrc` |

Other `process.env` values that influence behavior (set by you or Flockctl itself):

| Variable | Used by |
|----------|---------|
| `NODE_ENV` | Standard Node conventions; Flockctl does not branch on this for anything user-visible |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | Optional fallback keys. API keys configured via the UI (stored in the `ai_provider_keys` table) take precedence |

## `~/.flockctlrc`

JSON object, created on demand. Hand-editing is fine; in-process writers use `writeFileSync(... )` followed by `chmod 600` and cache-bust the 5 s read cache.

### Full shape

```json
{
  "home": "/custom/path/to/flockctl",

  "defaultModel": "claude-sonnet-4-6",
  "planningModel": "claude-opus-4-7",
  "defaultAgent": "claude-code",
  "defaultKeyId": 3,

  "remoteAccessTokens": [
    { "label": "phone",  "token": "..." },
    { "label": "laptop", "token": "..." }
  ],
  "remoteAccessToken": "legacy-single-token-still-honored",

  "corsOrigins": ["https://flockctl.example.com"],

  "remoteServers": [
    {
      "id": "uuid",
      "name": "work-laptop",
      "url": "https://flockctl.example.com",
      "token": "..."
    }
  ]
}
```

### Field reference

#### `home` — `string`, optional

Absolute path to the data root. Overrides the `~/flockctl` default. `FLOCKCTL_HOME` environment variable wins over this field.

#### `defaultModel` — `string`, optional (default `claude-sonnet-4-6`)

Model used for task execution when a task does not specify one. Must match a model name understood by the active agent backend.

#### `planningModel` — `string`, optional (default `claude-opus-4-7`)

Model used by the planner when generating milestones and slices. Can be different (and usually stronger) than `defaultModel`.

#### `defaultAgent` — `string`, optional (default `claude-code`)

Agent backend used when a project / task does not specify one. Currently:

- `claude-code` — Anthropic Claude via the Claude Code CLI / agent SDK (default; fully wired)
- `copilot` — GitHub Copilot via `@github/copilot-sdk`. Selected **per task / chat** by attaching a GitHub Copilot AI Provider Key (see [Adding a GitHub Copilot key](#adding-a-github-copilot-key) below) — not via this global field. Uses flat-rate billing (one premium request per prompt turn, regardless of tool calls inside the turn); pack multi-step work into a single prompt to avoid paying per milestone.

OpenAI and Google Generative AI clients are present as dependencies and have stub integrations, but tasks are not routed through them yet.

#### `defaultKeyId` — `number`, optional

Numeric `id` of the AI Provider Key (`ai_provider_keys.id`) used when a chat or task does not pass `keyId` explicitly. The runtime silently skips the fallback if the key has been deactivated. Manage it from **Settings → Defaults** in the UI, or `PATCH /meta/defaults` (see [API.md](API.md)).

#### `remoteAccessTokens` — `Array<{label, token}>`, optional

Bearer tokens accepted by remote-mode clients. Each entry is independent — revoking one does not affect the others.

- `label` (`string`) — used to identify the token in `flockctl token list` and logs. Must be unique across the array.
- `token` (`string`) — the secret. Must be **≥ 32 characters**; shorter entries are dropped at load time with a `[SECURITY]` warning.

Prefer `flockctl token generate --label <name> --save` over hand-editing; it atomically appends, chmods `600`, and busts the 5 s read cache.

See [REMOTE-ACCESS.md](REMOTE-ACCESS.md) for the full flow.

#### `remoteAccessToken` — `string`, optional (legacy)

Legacy single-token field from before labeled tokens existed. Still honored — treated as `{label: "default", token: <value>}` — but prefer `remoteAccessTokens` for new setups. If a `default` entry exists in `remoteAccessTokens`, that entry wins.

Running `flockctl token generate --label <something-else> --save` while this legacy field is present will migrate it into the array (as `default`) on its next write.

#### `corsOrigins` — `string[]`, optional

CORS whitelist. Only consulted when at least one token is configured (i.e. remote mode is active):

- List populated → only listed origins are allowed.
- Empty array or field missing → wildcard (`*`) with `credentials: false`.

In local mode the field is ignored and wildcard is always used.

#### `remoteServers` — `Array<{id, name, url, token?}>`, optional

UI-side list of other Flockctl daemons (the "server switcher" in the sidebar). Managed through the API — typically via the UI — but you can hand-edit if you prefer:

| Field | Purpose |
|-------|---------|
| `id` | UUID, generated by `addRemoteServer()`; keep stable |
| `name` | Human label shown in the UI |
| `url` | Root URL of the remote daemon (trailing slash is stripped) |
| `token` | Optional bearer token for that daemon |

The server never returns tokens back through the API; list responses show `hasToken: true/false` only.

## Adding a GitHub Copilot key

GitHub Copilot is available as a first-class AI Provider Key type (alongside Anthropic / OpenAI / Google keys). Attach it to a task or chat like any other provider key — the task executor dispatches to the Copilot SDK when the selected key's `provider` is `github_copilot`.

**Prerequisites:**

- A Copilot-enabled GitHub account (Pro+ subscription for premium-request quota).
- A GitHub token with Copilot access. Generate one via `gh auth token` after `gh auth login`, or create a fine-grained PAT with Copilot scope.

**Create the key:**

- **UI:** Settings → AI Keys → Add Key → Provider: *GitHub Copilot* → paste your GitHub token.
- **API:** `POST /ai-keys` with body `{ "name": "my-copilot", "provider": "github_copilot", "provider_type": "oauth", "key_value": "<github-token>" }`.

**Billing note.** Copilot charges per **prompt turn**, not per tool call. Each user message consumes one premium request, scaled by the model multiplier (`claude-opus-4.7` = 7.5×, `gpt-5.3-codex` = 1×, `gpt-4.1` / `gpt-5-mini` = 0× on Pro+). Packing multi-milestone work into a single prompt minimizes quota consumption.

**Model IDs.** The SDK rejects unknown model names with `Model "<id>" is not available`. Run `npx tsx scripts/copilot-spike.ts` once to list the models your account can use.

## Per-project / per-workspace overrides

Some settings can be overridden below the global level:

- **Default model**, **default agent**, **permission mode**, and **allowed key IDs** can be set on a project.
- **Allowed key IDs** can also be set on a workspace (applies to all its projects unless the project overrides).

These fields live in the database, not in `~/.flockctlrc`. See [API.md](API.md) for the shapes.

## Config cache

`~/.flockctlrc` is read with `JSON.parse` behind a 5-second in-process cache. This means:

- Hand-edits take effect within ~5 s without restarting the daemon.
- Programmatic writes through Flockctl (`flockctl token generate --save`, …) bust the cache immediately.

If your edit doesn't seem to take effect, either wait 5 s or restart with `flockctl stop && flockctl start`.

## File permissions

Flockctl re-applies `chmod 600` to `~/.flockctlrc` on every write. For the initial file creation (first run before any token is saved) the mode inherits from your umask. If remote mode is enabled and the file is world-readable, the daemon logs a `[SECURITY WARNING]` on startup telling you to run:

```bash
chmod 600 ~/.flockctlrc
```

See [SECURITY.md](SECURITY.md) for the threat model around this file.
