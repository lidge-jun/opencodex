import { ConfigMutationLockError } from "../config";
import { deriveOAuthDefaultModel, deriveOAuthProviderConfig } from "../providers/derive";
import type { AnthropicInstanceId } from "../providers/anthropic-instance-id";
import { loginAnthropic, refreshAnthropicToken } from "./anthropic";
import type { OAuthProviderDef } from "./index";
import {
  clearOAuthRefreshIntent, clearOAuthRefreshIntentIfMatch, markOAuthRefreshIntentCleanupPending,
  OAuthRefreshIntentIOError, type OAuthRefreshIntent, type OAuthRefreshIntentCleanupPending,
} from "./store";

/** Both pools use the same flow; only A may import the local Claude credential. */
export function anthropicOAuthDefinition(instance: AnthropicInstanceId): OAuthProviderDef {
  const providerConfig = deriveOAuthProviderConfig(instance);
  const defaultModel = deriveOAuthDefaultModel(instance);
  if (!providerConfig || !defaultModel) throw new Error(`OAuth provider missing from registry: ${instance}`);
  return {
    login: (ctrl, opts) => loginAnthropic(ctrl, {
      instance, importLocal: instance === "anthropic2" || opts?.forceLogin ? "off" : "fallback",
    }),
    refresh: refreshAnthropicToken,
    providerConfig,
    defaultModel,
    // Subscription OAuth must never generate unattended traffic by default.
    defaultRefreshPolicy: "disabled",
  };
}

export { AnthropicInstanceCollisionError, assertAnthropicInstanceLoginConfig } from "./store-anthropic-instance";

/** Cleanup is secondary once a rotated credential has become durable. */
export function clearAnthropicRefreshIntentBestEffort(provider: string, accountId: string, expected: OAuthRefreshIntent): boolean {
  try {
    return expected.attemptId
      ? clearOAuthRefreshIntentIfMatch(provider, accountId, expected)
      : clearOAuthRefreshIntent(provider, accountId, expected.generation);
  } catch {
    console.warn("[opencodex] Anthropic refresh intent cleanup failed; preserving the durable replay guard.");
    return false;
  }
}

const ANTHROPIC_INTENT_MARK_RETRY_DELAYS_MS = [10, 25, 50] as const;
function isConfigMutationLockContention(error: unknown): boolean {
  if (!(error instanceof ConfigMutationLockError)) return false;
  const cause = error.cause;
  const code = cause && typeof cause === "object" && "code" in cause
    ? String((cause as { code?: unknown }).code) : "";
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

export async function clearAnthropicRefreshIntentForKnownFailure(
  provider: string, accountId: string, expected: OAuthRefreshIntent,
  cleanupPending: OAuthRefreshIntentCleanupPending, refreshError: unknown,
): Promise<boolean> {
  let marked: OAuthRefreshIntent | undefined;
  for (let attempt = 0; attempt <= ANTHROPIC_INTENT_MARK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      marked = markOAuthRefreshIntentCleanupPending(provider, accountId, expected, cleanupPending);
      break;
    } catch (cause) {
      const retryDelay = ANTHROPIC_INTENT_MARK_RETRY_DELAYS_MS[attempt];
      if (!isConfigMutationLockContention(cause) || retryDelay === undefined) {
        throw new OAuthRefreshIntentIOError("mark-cleanup-pending", cause, refreshError);
      }
      // Settlement retains the account lock after a definitive provider answer.
      await Bun.sleep(retryDelay);
    }
  }
  if (!marked) throw new OAuthRefreshIntentIOError("mark-cleanup-pending",
    new Error("Anthropic refresh intent changed before safe cleanup"), refreshError);
  let cleared: boolean;
  try {
    cleared = clearOAuthRefreshIntentIfMatch(provider, accountId, marked);
  } catch {
    console.warn("[opencodex] Anthropic refresh intent cleanup failed; retry-safe cleanup remains pending.");
    return false;
  }
  if (!cleared) throw new OAuthRefreshIntentIOError("clear-cleanup-pending",
    new Error("Anthropic refresh intent changed during safe cleanup"), refreshError);
  return true;
}

export function resumeAnthropicRefreshIntentCleanup(provider: string, accountId: string, pendingIntent: OAuthRefreshIntent): void {
  let cleared: boolean;
  try {
    cleared = clearOAuthRefreshIntentIfMatch(provider, accountId, pendingIntent);
  } catch (cause) {
    throw new OAuthRefreshIntentIOError("resume-cleanup", cause);
  }
  if (!cleared) throw new OAuthRefreshIntentIOError("resume-cleanup",
    new Error("Pending Anthropic refresh intent changed before cleanup"));
}

export function clearObservedAnthropicRefreshIntent(provider: string, accountId: string, pendingIntent: OAuthRefreshIntent): boolean {
  return pendingIntent.attemptId
    ? clearOAuthRefreshIntentIfMatch(provider, accountId, pendingIntent)
    : clearOAuthRefreshIntent(provider, accountId, pendingIntent.generation);
}
