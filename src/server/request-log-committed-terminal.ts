import type { CommittedTerminalCooldownFacts } from "../combos/failover";
import { isPausedTurn } from "../lib/client-error-body";
import type { PersistedUsageAttempt } from "../usage/log";
import type { RequestLogContext, RequestLogEntry } from "./request-log";

let committedTerminalCooldownHandler: ((facts: CommittedTerminalCooldownFacts) => void) | undefined;

/**
 * Composition-root hook: the combos layer registers its committed-terminal
 * cooldown policy here so request logging can report finalized terminals
 * without importing routing state (and risking an import cycle).
 */
export function registerCommittedTerminalCooldownHandler(
  handler: ((facts: CommittedTerminalCooldownFacts) => void) | undefined,
): void {
  committedTerminalCooldownHandler = handler;
}

/**
 * Report a finalized committed-terminal outcome to the registered combo cooldown handler.
 * Safe to call unconditionally on every writeFinalRequestLog; catches and swallows any errors
 * so cooldown bookkeeping never interferes with log writing.
 */
export function reportCommittedTerminalCooldown(
  logCtx: RequestLogContext,
  meta: Pick<RequestLogEntry, "terminalStatus" | "closeReason"> | undefined,
  attempts: PersistedUsageAttempt[] | undefined,
  effectiveStatus: number,
  outputTokens?: number,
): void {
  const servingAttempt = attempts?.at(-1);
  try {
    committedTerminalCooldownHandler?.({
      ...(logCtx.comboId !== undefined ? { comboId: logCtx.comboId } : {}),
      ...(meta?.terminalStatus !== undefined ? { terminalStatus: meta.terminalStatus } : {}),
      ...(logCtx.failureDetail?.code !== undefined ? { failureDetailCode: logCtx.failureDetail.code } : {}),
      ...(servingAttempt ? {
        servingAttempt: {
          provider: servingAttempt.provider,
          model: servingAttempt.model,
          status: servingAttempt.status,
          ...(servingAttempt.locallyAnswered === true ? { locallyAnswered: true } : {}),
        },
      } : {}),
      ...(logCtx.comboTarget ? { target: logCtx.comboTarget } : {}),
      ...(logCtx.comboWriterGeneration !== undefined ? { writerGeneration: logCtx.comboWriterGeneration } : {}),
      ...(logCtx.comboTargetOutputCeiling !== undefined ? { outputCeiling: logCtx.comboTargetOutputCeiling } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      isPaused: isPausedTurn(logCtx),
      httpStatus: effectiveStatus,
    });
  } catch {
    /* committed-terminal cooldown bookkeeping must never break request logging */
  }
}
