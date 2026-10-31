/**
 * One Claude session keeps one pool account.
 *
 * The Messages bridge replays each turn on a fresh internal /v1/responses request. Unless the
 * caller sent a complete identity, its headers carry no bindable thread, so `codexPoolAffinityKey`
 * returns no key, the Codex pool never binds the turn, and round-robin with sticky limit 1 moves
 * every turn to the next account.
 *
 * The bridge passes the Claude session it already sends upstream as `session_id`
 * (`withClaudeNativeSession`): the uuid form of the metadata.user_id hash, or else Claude Code's
 * `x-claude-code-session-id` header. The identity is completed only when the Codex key would stay
 * undefined. A caller session alias names the session. A caller thread, a parent or an already
 * bindable identity is explicit and left unchanged. The shared
 * system-prompt cohort is never a session.
 */
import { codexPoolAffinityKey } from "../codex/auth-context";
import { contextPrincipalIdOf, type DataPlaneAdmission } from "./auth-cors";
import { safeCallerSessionId } from "./caller-session-identity";

const CALLER_SESSION_ALIASES = ["session-id", "session_id"] as const;

/** Claude Code's session header, scoped to the admitted principal exactly like x-session-id at ingress. */
export function claudeHeaderSessionId(headers: Headers, admission: DataPlaneAdmission | undefined): string | undefined {
  const session = safeCallerSessionId(headers.get("x-claude-code-session-id"));
  if (!session || !admission || admission.kind === "loopback") return session;
  const principal = contextPrincipalIdOf(admission);
  if (!principal) return undefined;
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(["opencodex-caller-session-v1", principal, session])).digest("hex");
}

export function withClaudeBridgePoolSession(headers: Headers, claudeSessionId: string | undefined): void {
  if (codexPoolAffinityKey(headers) !== undefined || headers.get("x-codex-parent-thread-id")?.trim() || headers.get("thread-id")?.trim()) return;
  // A non-empty invalid caller alias suppresses the weaker Claude identity, as on native egress.
  const alias = CALLER_SESSION_ALIASES.map(name => headers.get(name)?.trim()).find(value => !!value);
  const sessionId = safeCallerSessionId(alias ?? claudeSessionId ?? null);
  if (!sessionId) return;
  if (!headers.get("session-id")?.trim()) headers.set("session-id", sessionId);
  headers.set("thread-id", sessionId);
}
