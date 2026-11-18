/**
 * Whether an upstream 4xx says the provider rejects the `developer` message role (#8864).
 *
 * Read only through fixed lowercase phrases that name the role itself; nothing from the message is
 * returned or stored. Each phrase is a provider's own wording: DashScope compatible-mode (#5664),
 * Moonshot (#7583) and serde-based gateways. Any other 400 stays a plain request rejection.
 */
const MAX_SCAN = 4096;
const PHRASES = ["developer is not one of", "role 'developer' is not allowed", "unknown variant `developer`"] as const;

export function isDeveloperRoleRejection(status: number | undefined, message: unknown): boolean {
  if (typeof status !== "number" || status < 400 || status >= 500 || typeof message !== "string") return false;
  const scanned = message.slice(0, MAX_SCAN).toLowerCase();
  return PHRASES.some(phrase => scanned.includes(phrase));
}
