import { isLoopbackBindHost } from "../middleware/remote-auth.js";

export type GateDecision =
  | { action: "start"; warning?: string; info?: string }
  | { action: "refuse"; error: string };

/**
 * Classify a startup configuration: should the server start, and with what
 * console output? Pure function — all side effects live at the call site
 * (server-entry), so it can be unit-tested without forking.
 *
 * Rules:
 *   - Loopback bind (127.0.0.1, ::1, localhost): always start silently.
 *   - Non-loopback bind + token configured: start + info message.
 *   - Non-loopback bind + no token + `allowInsecurePublic=true`: start + warning.
 *   - Non-loopback bind + no token + no flag: refuse.
 */
export function evaluateBindSecurity(args: {
  host: string;
  port: number;
  hasToken: boolean;
  allowInsecurePublic: boolean;
}): GateDecision {
  const { host, port, hasToken, allowInsecurePublic } = args;

  if (isLoopbackBindHost(host)) {
    return { action: "start" };
  }

  if (hasToken) {
    return {
      action: "start",
      info: `Remote access enabled on http://${host}:${port} (token auth active)`,
    };
  }

  if (allowInsecurePublic) {
    return {
      action: "start",
      warning:
        `[SECURITY WARNING] Remote access enabled on http://${host}:${port} ` +
        `WITHOUT authentication. Anyone who can reach this address can execute ` +
        `tasks on your machine. Set up a token with 'flockctl token generate --save' ` +
        `as soon as possible.`,
    };
  }

  return {
    action: "refuse",
    error:
      `Refusing to bind to non-loopback host '${host}' without authentication.\n` +
      `Either configure a token:\n` +
      `    flockctl token generate --save\n` +
      `or explicitly opt into unauthenticated public exposure:\n` +
      `    flockctl start --host ${host} --allow-insecure-public`,
  };
}
