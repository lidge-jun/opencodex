import { finishRequestAttempt, type RequestLogContext } from "./request-log";
import { sealedCredentialRefusals } from "./request-log-attempt-recovery";
import { attributeSealedAttempt } from "./request-log-failure-attribution";
import type { AttemptRecoveryKind } from "../usage/log";

/** Freeze the physical refusal while a replacement is only a plan. */
export function sealCredentialRefusal(logCtx: RequestLogContext, status: number, recovery?: AttemptRecoveryKind): void {
  const attempt = logCtx.activeAttempt;
  if (!attempt?.sendCount || sealedCredentialRefusals.has(attempt)) return;
  // An estimate cannot prove that a refused RPC consumed any tokens.
  delete attempt.inputTokenEstimate;
  finishRequestAttempt(attempt, status, Date.now() - (logCtx.activeAttemptStartedAt ?? Date.now()), attempt.usage ?? logCtx.usage);
  attributeSealedAttempt(attempt, recovery);
  if (attempt.tierOutcome) attempt.tierOutcome = { ...attempt.tierOutcome };
  sealedCredentialRefusals.add(attempt);
}
