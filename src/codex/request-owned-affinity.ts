/**
 * Caller-owned affinity is scoped to the exact Authorization value and conversation key under a
 * process-random HMAC key. It is process-local and must never be anchored or persisted, as required
 * by the structure contract. Decisions describe the binding at selection time.
 */
import { createHmac, randomBytes } from "node:crypto";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { codexConversationIdentity } from "./lineage";
import { getThreadAffinity, getModelDetourAffinity, type CodexAffinityDecision } from "./routing/thread-affinity";
import type { CodexQuotaScope } from "./routing/health-store";

const key = randomBytes(32);
const prefix = "request-owned:v1:";

/** Derive the opaque key for this caller and conversation, if both exist. */
export function requestOwnedAffinityKey(headers: Headers): string | undefined {
  const authorization = headers.get("authorization");
  const conversation = codexConversationIdentity(headers)?.conversationKey;
  if (!authorization || !conversation) return undefined;
  return prefix + createHmac("sha256", key)
    .update("opencodex-request-owned-affinity-v1\0").update(authorization).update("\0").update(conversation)
    .digest("base64url");
}

/** Identify namespace keys that must remain process-local. */
export function isRequestOwnedAffinityKey(value: string): boolean {
  return value.startsWith(prefix);
}

/** Report a bind only when the selection-time entry names the selected account. */
export function honestAffinityDecision(
  decision: CodexAffinityDecision | undefined,
  affinityKey: string | undefined,
  accountId: string,
  quotaScope?: CodexQuotaScope,
  modelId?: string,
  requestOwnedKeyWithheld = false,
): CodexAffinityDecision | undefined {
  if (!decision || (decision.move !== "new_bind" && decision.move !== "rebound")) return decision;
  // This is a selection-time snapshot, immediately after the synchronous selector returns.
  if (affinityKey && (getThreadAffinity(affinityKey, quotaScope)?.accountId === accountId
    || getModelDetourAffinity(affinityKey, modelId, quotaScope)?.accountId === accountId)) return decision;
  if (decision.move === "rebound") return { move: "cleared", reason: decision.reason };
  return { move: "unbound", reason: affinityKey ? decision.reason : requestOwnedKeyWithheld ? "request_owned" : "no_conversation" };
}

/** Identify the issuer for a Pool or keyed caller-main context. */
export function conversationStateAccountId(ctx: { kind: "main" | "pool" | "main-pool"; accountId: string | null; affinityKey?: string }): string | undefined {
  return ctx.kind === "main" ? (ctx.affinityKey ? MAIN_CODEX_ACCOUNT_ID : undefined) : ctx.accountId ?? undefined;
}
