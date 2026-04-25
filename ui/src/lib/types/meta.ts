// --- AI Provider Keys ---

export interface AIProviderKeyResponse {
  id: string;
  provider: string;
  provider_type: string;
  label: string | null;
  key_value: string | null;
  cli_command: string | null;
  env_var_name: string | null;
  config_dir: string | null;
  priority: number;
  is_active: boolean;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_errors: number;
  disabled_until: string | null;
  created_at: string;
  // computed convenience fields
  name: string | null;        // alias for label
  key_suffix: string | null;  // last 4 chars if keyValue present
}

export interface AIProviderKeyCreate {
  provider: string;
  provider_type: string;
  label?: string;
  key_value?: string;
  cli_command?: string;
  config_dir?: string;
  priority?: number;
  is_active?: boolean;
}

export interface AIProviderKeyUpdate {
  label?: string;
  key_value?: string;
  config_dir?: string;
  priority?: number;
  is_active?: boolean;
}

/** Response shape of `GET /keys/:id/identity`. */
export interface AIKeyIdentityResponse {
  /** `false` when the provider isn't `claude_cli`. */
  supported: boolean;
  /** `true` when Anthropic returned a profile under this key's config dir. */
  loggedIn: boolean;
  /** Set when `supported === false`. */
  reason?: string;
  /** Set when `loggedIn === false`. */
  error?: string;
  email?: string;
  accountUuid?: string;
  organizationUuid?: string;
  organizationName?: string;
  organizationType?: string;
  rateLimitTier?: string;
  hasClaudeMax?: boolean;
  hasClaudePro?: boolean;
  subscriptionStatus?: string;
}

// --- Meta (agents & models) ---

export interface MetaAgent {
  id: string;
  name: string;
  available: boolean;
}

export interface MetaModel {
  id: string;
  name: string;
  agent: string;
}

export interface MetaKey {
  id: string;
  name: string;
  provider: string;
  is_active: boolean;
}

export interface MetaDefaults {
  model: string;
  planning_model: string;
  agent: string;
  /** Global default AI Provider Key id (stringified by the API layer), or null when unset. */
  key_id: string | null;
}

export interface MetaResponse {
  agents: MetaAgent[];
  models: MetaModel[];
  keys: MetaKey[];
  defaults: MetaDefaults;
}
