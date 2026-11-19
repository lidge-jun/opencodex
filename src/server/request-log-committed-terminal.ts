import type { CommittedIncompleteReason, CommittedTerminalCooldownFacts } from "../combos/failover";
import { isPausedTurn } from "../lib/client-error-body";
import { isTerminalRefusalCode } from "../lib/errors";
import type { PersistedUsageAttempt } from "../usage/log";
import type { RequestLogContext, RequestLogEntry } from "./request-log";
import type { UpstreamErrorPayload } from "./request-log-terminal-status";

/** Combo serving facts carried on RequestLogContext; internal-only, omitted from RequestLogEntry/JSONL. */
export interface CommittedComboLogFields {
  /** Serving combo target (as selected), its writer generation and output ceiling. */
  comboTarget?: { provider: string; model: string };
  comboWriterGeneration?: number;
  comboTargetOutputCeiling?: number | null;
  /** Closed capacity/health reason recognized from a committed terminal; null when none applies. */
  committedIncompleteReason?: CommittedIncompleteReason | null;
}

let committedTerminalCooldownHandler: ((facts: CommittedTerminalCooldownFacts) => void) | undefined;

function isRefusal(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const code = value.trim();
  return code === "content_filter" || code === "refusal" || code === "moderation_refusal"
    || code === "content_policy_violation" || isTerminalRefusalCode(code);
}

/** Recognize closed capacity/health reasons independently of the text printed for the turn. */
export function committedIncompleteReason(payload: UpstreamErrorPayload): CommittedIncompleteReason | null {
  const response = payload.response;
  const reasons = [payload.incomplete_details?.reason, response?.incomplete_details?.reason];
  const errors = [payload.error, payload.last_error, response?.error, response?.last_error];
  if (reasons.some(isRefusal) || isRefusal(payload.code) || errors.some(error => isRefusal(error?.code) || isRefusal(error?.type))) {
    return null;
  }
  const normalized = reasons.map(reason => typeof reason === "string" ? reason.trim() : undefined);
  if (normalized.includes("max_output_tokens")) return "max_output_tokens";
  return normalized.includes("upstream_stall_timeout") ? "upstream_stall_timeout" : null;
}

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
): void {
  const servingAttempt = attempts?.at(-1);
  const outputTokens = servingAttempt?.usage?.outputTokens;
  try {
    committedTerminalCooldownHandler?.({
      ...(logCtx.comboId !== undefined ? { comboId: logCtx.comboId } : {}),
      ...(meta?.terminalStatus !== undefined ? { terminalStatus: meta.terminalStatus } : {}),
      ...(logCtx.committedIncompleteReason ? { terminalReason: logCtx.committedIncompleteReason } : {}),
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
