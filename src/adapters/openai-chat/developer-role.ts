import type { OcxProviderConfig } from "../../types";

/**
 * The role a `developer` message carries on the Chat wire, decided in one place for both the
 * translated adapter and the native passthrough.
 *
 * `developer` belongs to the Chat Completions role set, but not every OpenAI-compatible gateway
 * accepts it: one that does not answers `400 role 'developer' is not allowed` and the turn never
 * starts. #5213 removed a hostname test that decided the role, which was right — a gateway
 * proxying OpenAI accepts the role and the hostname cannot say so.
 *
 * `foldDeveloperRoleToSystem` is tri-state and only two of its states say anything about the
 * destination: `true` records an upstream known to reject the role, `false` one known to accept
 * it, and absent means nobody has recorded either. Returning `undefined` for the absent state
 * instead of a role keeps the recorded fact separate from the default a route applies to
 * silence, which is what lets the native route honour the first without inheriting the second.
 *
 * This decides the role and only the role. Which slot the message occupies is the caller's
 * decision and must not change with this value.
 */
export function explicitChatDeveloperWireRole(
  provider: OcxProviderConfig,
): "developer" | "system" | undefined {
  if (provider.foldDeveloperRoleToSystem === undefined) return undefined;
  return provider.foldDeveloperRoleToSystem ? "system" : "developer";
}

/**
 * The translated route's role: the recorded one, or `system` when nothing is recorded.
 *
 * The unrecorded state folds because the two mistakes are not symmetrical. Sending `developer`
 * to a destination that rejects it fails the request outside this repository, where no test here
 * can reach it; sending `system` to one that would have accepted `developer` costs the role name
 * and nothing else.
 */
export function translatedChatDeveloperWireRole(provider: OcxProviderConfig): "developer" | "system" {
  return explicitChatDeveloperWireRole(provider) ?? "system";
}

/**
 * Apply a recorded role to a caller-supplied `messages` array, leaving every other field of
 * every message, and the order of all of them, exactly as they arrived.
 *
 * The native route forwards the caller's messages verbatim, so an operator who recorded that a
 * destination rejects the role still sent `developer` there and the turn failed upstream with a
 * 400. Only an explicit record changes anything here: with the key unset, or set to the role the
 * message already carries, the same array reference is returned and the wire is byte-identical
 * to the one the caller sent.
 */
export function applyExplicitChatDeveloperRole(messages: unknown, provider: OcxProviderConfig): unknown {
  const role = explicitChatDeveloperWireRole(provider);
  if (role === undefined || role === "developer" || !Array.isArray(messages)) return messages;
  let rewritten = false;
  const applied = messages.map(message => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return message;
    if ((message as { role?: unknown }).role !== "developer") return message;
    rewritten = true;
    return { ...(message as Record<string, unknown>), role };
  });
  return rewritten ? applied : messages;
}
