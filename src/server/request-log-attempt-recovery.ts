import type { AttemptRecoveryWithheld, PersistedUsageAttempt } from "../usage/log";

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
