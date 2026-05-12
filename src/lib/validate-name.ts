import { ValidationError } from "./errors.js";

/**
 * Reject names that would escape a parent directory when joined into a
 * filesystem path. Used by the MCP-server, skills, and planning routes — any
 * place where an unsanitised name from the request body or a query param is
 * concatenated into a `join(parentDir, name)` lookup.
 *
 * Catches:
 *   - empty / non-string input
 *   - `/` or `\` path separators (anywhere in the string)
 *   - the literal segments `..`, `.`, and the dotfile prefix that lets a
 *     caller probe `~/.ssh/id_rsa` style paths
 *   - `..` substring anywhere (defence-in-depth against URL-encoded
 *     traversal that gets normalised before hitting the FS)
 *   - NUL bytes (truncation tricks against `fs.*` on POSIX)
 *
 * Throws `ValidationError` (422) on rejection — keeps the auth path consistent
 * with the rest of the routes layer.
 */
export function assertSafeName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new ValidationError("Invalid name: must be a non-empty string");
  }
  if (/[\/\\]/.test(name) || name.includes("..") || name === "." || name === "..") {
    throw new ValidationError("Invalid name: must not contain path separators or '..'");
  }
  if (name.startsWith(".") || name.includes("\0")) {
    throw new ValidationError("Invalid name: must not start with '.' or contain NUL bytes");
  }
}
