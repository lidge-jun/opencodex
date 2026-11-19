import { beginRequestAttempt, finishRequestAttempt, noteProviderAttemptSend, type RequestLogContext } from "./request-log";
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

type AttemptSendProvider = Parameters<typeof noteProviderAttemptSend>[2];
type AttemptSendRecovery = Parameters<typeof noteProviderAttemptSend>[4];

/** Open a native compact attempt at its first physical send and count each send against it. */
export function noteCompactAttemptSend(
  logCtx: RequestLogContext, route: { providerName: string; modelId: string }, provider: AttemptSendProvider, recovery?: AttemptSendRecovery,
): void {
  const { providerName, modelId } = route;
  if (!logCtx.activeAttempt) {
    logCtx.activeAttempt = beginRequestAttempt((logCtx.attempts?.length ?? 0) + 1, logCtx.provider, modelId, provider.adapter);
    logCtx.activeAttemptStartedAt = Date.now();
    (logCtx.attempts ??= []).push(logCtx.activeAttempt);
  }
  noteProviderAttemptSend(logCtx, providerName, provider, logCtx.usageLogInputTokens, recovery, { model: modelId, adapter: provider.adapter });
}
