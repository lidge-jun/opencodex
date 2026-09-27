import type { OcxUsage } from "../../types";
import type { PersistedUsageAttempt } from "../../usage/log";
import {
  beginRequestAttempt,
  finishRequestAttempt,
  sealRequestAttemptIdentity,
  type RequestLogContext,
} from "../request-log";

export interface InferenceAttemptTarget {
  provider: string;
  model: string;
  adapter: string;
}

export interface InferenceAttempt {
  readonly attempt: PersistedUsageAttempt;
  /** Epoch ms the attempt became active; the duration `finish` records is measured from it. */
  readonly startedAt: number;
  /** Stamp the attempt's provider/adapter identity and, before its first send, its account. */
  seal(accountLabel?: string): void;
  /** Close the attempt row with its status and duration; `usage` overrides the attempt's own. */
  finish(status: number, usage?: OcxUsage): PersistedUsageAttempt;
}

/**
 * Open one physical attempt on `logCtx`: the next ordinal, the active attempt and its start
 * time, and the attempt appended to the request's list, in that order. The attempt is the row
 * the final request log finishes; `finish` exists for owners that close it themselves.
 */
export function beginInferenceAttempt(
  logCtx: RequestLogContext,
  target: InferenceAttemptTarget,
): InferenceAttempt {
  const attempt = beginRequestAttempt(
    (logCtx.attempts?.length ?? 0) + 1,
    target.provider,
    target.model,
    target.adapter,
  );
  logCtx.activeAttempt = attempt;
  const startedAt = Date.now();
  logCtx.activeAttemptStartedAt = startedAt;
  (logCtx.attempts ??= []).push(attempt);
  return {
    attempt,
    startedAt,
    seal: accountLabel => sealRequestAttemptIdentity(attempt, target.provider, target.adapter, accountLabel),
    finish: (status, usage) => finishRequestAttempt(attempt, status, Date.now() - startedAt, usage),
  };
}
