/**
 * Caller-owned affinity is scoped to the exact Authorization value and conversation key under a
 * process-random HMAC key. It is process-local and must never be anchored or persisted, as required
 * by the structure contract. Decisions describe the binding at selection time.
 */
import { createHmac, randomBytes } from "node:crypto";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { codexConversationIdentity } from "./lineage";
import { getThreadAffinity, getModelDetourAffinity, deleteThreadAffinity, deleteModelDetourAffinity, notePendingReleaseReason, type CodexAffinityDecision, type CodexAffinityReason, type ThreadAffinityEntry } from "./routing/thread-affinity";
import type { CodexQuotaScope } from "./routing/health-store";
import { classifyCodexUpstreamOutcome } from "./routing/cooldown-math";
import type { CodexAuthContext } from "./auth-context";
import { isRequestOwnedAffinityKey, REQUEST_OWNED_AFFINITY_KEY_PREFIX } from "./request-owned-affinity-key";
export { isRequestOwnedAffinityKey } from "./request-owned-affinity-key";

const key = randomBytes(32);
const prefix = REQUEST_OWNED_AFFINITY_KEY_PREFIX;

/** Derive the opaque key for this caller and conversation, if both exist. */
export function requestOwnedAffinityKey(headers: Headers): string | undefined {
  const authorization = headers.get("authorization");
  const conversation = codexConversationIdentity(headers)?.conversationKey;
  if (!authorization || !conversation) return undefined;
  return prefix + createHmac("sha256", key)
    .update("opencodex-request-owned-affinity-v1\0").update(authorization).update("\0").update(conversation)
    .digest("base64url");
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
export function conversationStateAccountId(ctx: { kind: "main" | "pool" | "main-pool"; accountId: string | null; affinityKey?: string; conversationStateKey?: string }): string | undefined {
  return ctx.kind === "main" ? (ctx.affinityKey || ctx.conversationStateKey ? MAIN_CODEX_ACCOUNT_ID : undefined) : ctx.accountId ?? undefined;
}

/** Describe the account actually serving a caller-owned fallback. */
export function callerOwnedFallbackAffinityDecision(
  decision: CodexAffinityDecision | undefined, affinityKey: string | undefined, quotaScope: CodexQuotaScope | undefined,
  modelId: string | undefined, requestOwnedKeyWithheld: boolean, reason: "cooldown" | "unusable",
): CodexAffinityDecision {
  const ordinary = affinityKey ? getThreadAffinity(affinityKey, quotaScope) : undefined;
  const detour = affinityKey ? getModelDetourAffinity(affinityKey, modelId, quotaScope) : undefined;
  if (ordinary?.accountId === MAIN_CODEX_ACCOUNT_ID || detour?.accountId === MAIN_CODEX_ACCOUNT_ID)
    return honestAffinityDecision(decision ?? { move: "reused", reason: "healthy" }, affinityKey, MAIN_CODEX_ACCOUNT_ID, quotaScope, modelId, requestOwnedKeyWithheld)!;
  if (ordinary || detour) return { move: "detour", reason };
  return { move: "unbound", reason: affinityKey ? decision?.reason ?? "healthy" : requestOwnedKeyWithheld ? "request_owned" : "no_conversation" };
}

/** Opaque process-local identity for the bindings present when main was selected. */
export type RequestOwnedBindingSnapshot = object;
type EntryIdentity = { entry: ThreadAffinityEntry; accountId: string; generation: number; createdAt: number };
const bindingSnapshots = new WeakMap<RequestOwnedBindingSnapshot, { key: string; scope?: CodexQuotaScope; modelId?: string; ordinary?: EntryIdentity; detour?: EntryIdentity }>();

function identity(entry: ThreadAffinityEntry | undefined): EntryIdentity | undefined {
  return entry && { entry, accountId: entry.accountId, generation: entry.generation, createdAt: entry.createdAt };
}
function matches(captured: EntryIdentity | undefined, current: ThreadAffinityEntry | undefined): boolean {
  return !!captured && captured.entry === current && captured.accountId === current.accountId
    && captured.generation === current.generation && captured.createdAt === current.createdAt;
}

/** Capture the exact entries that a request is authorized to release after selection. */
export function captureRequestOwnedAffinityBindings(key: string | undefined, scope?: CodexQuotaScope, modelId?: string): RequestOwnedBindingSnapshot | undefined {
  if (!key || !isRequestOwnedAffinityKey(key)) return undefined;
  const snapshot = {};
  bindingSnapshots.set(snapshot, { key, scope, modelId, ordinary: identity(getThreadAffinity(key, scope)), detour: identity(getModelDetourAffinity(key, modelId, scope)) });
  return snapshot;
}

/** Whether a context carries a caller-owned routing key. */
export function isKeyedRequestOwnedMain(ctx: CodexAuthContext): ctx is Extract<CodexAuthContext, { kind: "main" }> & { affinityKey: string } {
  return ctx.kind === "main" && !!ctx.affinityKey && isRequestOwnedAffinityKey(ctx.affinityKey);
}

/** Release this caller’s scoped binding after its own main credential is refused. */
export function releaseRequestOwnedMainOnOutcome(ctx: CodexAuthContext, outcome: number, _modelId?: string): void {
  if (!isKeyedRequestOwnedMain(ctx) || !ctx.affinityBindingSnapshot) return;
  const snapshot = bindingSnapshots.get(ctx.affinityBindingSnapshot);
  if (!snapshot || snapshot.key !== ctx.affinityKey) return;
  const outcomeClass = classifyCodexUpstreamOutcome(outcome);
  const reason: CodexAffinityReason | undefined = outcomeClass === "quota" ? "quota_refusal"
    : outcomeClass === "credential" ? "unusable" : outcomeClass === "transient" ? "transient" : undefined;
  if (!reason) return;
  const key = ctx.affinityKey;
  const { scope, modelId: selectedModelId } = snapshot;
  let released = false;
  const ordinary = getThreadAffinity(key, scope);
  const detour = getModelDetourAffinity(key, selectedModelId, scope);
  const mainDetour = matches(snapshot.detour, detour) && detour?.accountId === MAIN_CODEX_ACCOUNT_ID;
  // A caller-main fallback or model detour can leave an ordinary binding on a different
  // account. Retire it too so the next placement reports the release rather than reuse. If
  // main was itself bound and another turn has since rebound elsewhere, keep that newer entry.
  const callerMainDetour = ctx.affinityDecision?.move === "detour";
  if (matches(snapshot.ordinary, ordinary) && (ordinary?.accountId === MAIN_CODEX_ACCOUNT_ID || mainDetour || callerMainDetour)) {
    deleteThreadAffinity(key, scope);
    released = true;
  }
  if (mainDetour) {
    deleteModelDetourAffinity(key, selectedModelId, scope);
    released = true;
  }
  if (released) notePendingReleaseReason(key, reason);
}
