import { parsePermissionModeField as parseRaw } from "../services/permission-resolver.js";
import { ValidationError } from "../lib/errors.js";

/**
 * Thin wrapper that converts resolver's plain Error into ValidationError
 * for route layer consumption. Returns undefined/null/PermissionMode.
 */
export function parsePermissionModeBody(
  body: Record<string, unknown>,
): string | null | undefined {
  // `??` would collapse null into undefined and silently turn a clear-to-null
  // request into a no-op — so dispatch on key presence instead.
  const hasSnake = Object.prototype.hasOwnProperty.call(body, "permission_mode");
  const hasCamel = Object.prototype.hasOwnProperty.call(body, "permissionMode");
  if (!hasSnake && !hasCamel) return undefined;
  const raw = hasSnake ? body.permission_mode : body.permissionMode;
  try {
    return parseRaw(raw);
  } catch (err) {
    throw new ValidationError(
      err instanceof Error ? err.message : "invalid permission_mode",
    );
  }
}
