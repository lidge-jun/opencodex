import type { AttemptRecoveryKind, AttemptRecoveryWithheld, PersistedUsageAttempt } from "../usage/log";

/** Credential recovery starts a new attempt even when the account's opaque identity is unchanged. */
export function credentialRecoveryStatus(recovery?: AttemptRecoveryKind): 401 | 402 | 403 | 429 | undefined {
  if (recovery === "oauth-401" || recovery === "key-401") return 401;
  if (recovery === "oauth-account-402") return 402;
  if (recovery === "oauth-account-403") return 403;
  if (recovery === "key-429" || recovery === "anthropic-oauth-429" || recovery === "oauth-account-429") return 429;
  return undefined;
}

/**
 * Record that a recovery this attempt was eligible for did not happen.
 *
 * Deliberately NOT `noteAttemptSend`: nothing was sent, so `sendCount` must not move. The two
 * together are what make a one-send log readable — no kind and no withheld reason means nothing
 * was eligible, a withheld reason means something was and the budget refused it (#5044).
 */
export function noteAttemptRecoveryWithheld(
  attempt: PersistedUsageAttempt | undefined,
  reason: AttemptRecoveryWithheld,
): void {
  if (!attempt) return;
  if (!attempt.recoveryWithheld) attempt.recoveryWithheld = [];
  if (!attempt.recoveryWithheld.includes(reason)) attempt.recoveryWithheld.push(reason);
}
