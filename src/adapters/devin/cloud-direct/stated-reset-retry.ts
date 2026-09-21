/**
 * Same-target retry of an explicit, pre-output 429 refusal with a stated
 * recovery delay. No event-producing attempt is ever automatically replayed.
 * This is a refusal-specific policy, not a claim that every eventless POST
 * is idempotent; ambiguous transport failures still propagate unchanged.
 */
import { parseRetryAfterFromMessage } from '../../../lib/retry-delay.js';
import type { AdapterFetchContext } from '../../base.js';
import { createAdapterPhysicalSend } from '../../physical-send.js';
import { abortError, SendBudgetExhaustedError, sleepWithAbort } from '../../../lib/upstream-retry.js';
import { CloudChatError, streamChatEvents, type CloudChatEvent, type CloudChatRequest } from './chat.js';

/** 1 initial attempt plus at most 2 replays. */
export const STATED_RESET_MAX_REPLAYS = 2;
/** Default cumulative wait allowance for one invocation (30 minutes). */
export const STATED_RESET_MAX_WAIT_MS = 1_800_000;
/** Absolute maximum cumulative allowance, including explicit overrides. */
export const STATED_RESET_WAIT_CEILING_MS = 3_600_000;

function statedResetMaxWaitMs(): number {
  const raw = process.env.OPENCODEX_DEVIN_STATED_RESET_WAIT_MS?.trim();
  if (!raw) return STATED_RESET_MAX_WAIT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return STATED_RESET_MAX_WAIT_MS;
  // Zero explicitly disables local waiting. Values above one hour are capped.
  return Math.min(Math.floor(parsed), STATED_RESET_WAIT_CEILING_MS);
}
export const statedResetMaxWaitMsForTests = statedResetMaxWaitMs;

export interface StatedResetRetryOptions {
  /** Test seam: defaults to the real cloud stream. */
  stream?: (req: CloudChatRequest) => AsyncGenerator<CloudChatEvent>;
  /** Test seam: must either honour the whole delay or reject on cancellation. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxReplays?: number;
  /** CUMULATIVE wait allowance, not a fresh allowance on every failure. */
  maxWaitMs?: number;
  /** Request-wide execution authority. Absent preserves context-free callers' unlimited fetch. */
  execution?: Pick<
    AdapterFetchContext,
    "executor" | "sendBudget" | "onPhysicalSend" | "onRecoveryWithheld"
  >;
}

function replayLimit(value: number | undefined): number {
  if (value === undefined) return STATED_RESET_MAX_REPLAYS;
  if (!Number.isInteger(value) || value < 0 || value > STATED_RESET_MAX_REPLAYS) {
    throw new RangeError('maxReplays must be an integer from 0 to 2');
  }
  return value;
}

function waitLimit(value: number | undefined): number {
  if (value === undefined) return statedResetMaxWaitMs();
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('maxWaitMs must be a finite non-negative number');
  }
  return Math.min(Math.floor(value), STATED_RESET_WAIT_CEILING_MS);
}

export async function* streamChatEventsWithResetRetry(
  req: CloudChatRequest,
  options?: StatedResetRetryOptions,
): AsyncGenerator<CloudChatEvent> {
  const stream = options?.stream ?? streamChatEvents;
  const sleep = options?.sleep ?? sleepWithAbort;
  const maxReplays = replayLimit(options?.maxReplays);
  const maxWaitMs = waitLimit(options?.maxWaitMs);
  const execution = options?.execution;
  // One sender owns the whole invocation so ordinals span the initial POST and both replays.
  // Its executor remains lazy: replay admission happens after the provider-stated wait, never
  // while a reservation could be held for up to an hour.
  const send = execution
    ? createAdapterPhysicalSend({ ...execution, abortSignal: req.signal })
    : undefined;
  let replays = 0;
  let waitedMs = 0;
  let replaySourceError: CloudChatError | undefined;
  while (true) {
    // Check again after sleeping: cancellation can race with timer completion.
    // A pre-aborted request must not even enter a custom transport.
    if (req.signal?.aborted) throw abortError(req.signal);
    let yielded = false;
    try {
      const recovery = replays > 0 ? "rate-limit-429" as const : undefined;
      const attemptRequest = send
        ? {
            ...req,
            executor: ((input, init) => send({
              url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
              ...(recovery ? { sendClass: "auth-recovery" as const, recovery } : {}),
              dispatch: executor => executor(input, init),
            })) as typeof globalThis.fetch,
          }
        : req;
      for await (const event of stream(attemptRequest)) {
        // Latch before yielding, so a consumer-injected error is post-output.
        yielded = true;
        yield event;
      }
      return;
    } catch (error) {
      if (req.signal?.aborted) throw abortError(req.signal);
      if (!yielded && error instanceof SendBudgetExhaustedError && replaySourceError) {
        // The provider's refusal is the real upstream answer. A local cap can withhold its
        // recovery, but replacing the 429 would erase the status and stated reset metadata.
        execution?.onRecoveryWithheld?.({ reason: "retry-send-budget" });
        throw replaySourceError;
      }
      const retryableError = !yielded
        && error instanceof CloudChatError
        && error.status === 429
        ? error
        : undefined;
      const waitSec = retryableError
        ? parseRetryAfterFromMessage(retryableError.message)
        : undefined;
      const waitMs = waitSec === undefined ? undefined : waitSec * 1000;
      if (
        retryableError === undefined
        || waitMs === undefined
        || replays >= maxReplays
        || waitMs > maxWaitMs - waitedMs
      ) {
        // Never shorten a provider's minimum delay to fit the local budget.
        // Keep the original refusal so outer policy can preserve its metadata.
        throw error;
      }
      replays += 1;
      replaySourceError = retryableError;
      // Charge the complete scheduled wait once, before sleeping. This is a
      // sleep allowance, not a wall-clock deadline on generation or timer
      // scheduling: waking a few milliseconds late must not reject an already
      // approved one-hour retry. No later wait can spend this allowance again.
      waitedMs += waitMs;
      await sleep(waitMs, req.signal);
      if (req.signal?.aborted) throw abortError(req.signal);
    }
  }
}
