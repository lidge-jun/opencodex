/**
 * Same-target replay for a 429 whose trailer states its own recovery delay.
 *
 * Cognition's free-tier cap answers `resource_exhausted` trailers that name
 * the wait: "Your limit will reset in 35 seconds". Surfaced raw, that turn
 * dies — the Codex client does not retry 429s, and the stated cooldown was
 * never read, so nothing waited the window the upstream itself announced.
 *
 * This wrapper waits the stated delay and replays the identical request, but
 * only while the replay is provably safe: the stream must have yielded ZERO
 * events. After the first event the turn may have billable side effects and
 * client-visible output, so a replay would double them — those failures keep
 * their terminal path. The wait is bounded twice (replays and a per-wait
 * ceiling) so a long stated window still surfaces instead of holding the
 * turn; the surfaced error now carries the parsed delay for whatever the
 * client decides next.
 */

import { parseRetryAfterFromMessage } from '../../../lib/errors.js';
import { sleepWithAbort } from '../../../lib/upstream-retry.js';
import { CloudChatError, streamChatEvents, type CloudChatEvent, type CloudChatRequest } from './chat.js';

/** Total replays after the first failure: 1 initial + 2 replays = 3 sends. */
export const STATED_RESET_MAX_REPLAYS = 2;
/**
 * Per-wait ceiling, default 30 minutes: observed Cognition stated windows run
 * from seconds through ~21 minutes, so a 5-minute ceiling would still fail the
 * common case. A stated window beyond this surfaces the failure (with the
 * parsed delay intact) rather than pinning a turn for the full window.
 * Override with OPENCODEX_DEVIN_STATED_RESET_WAIT_MS, bounded by
 * STATED_RESET_WAIT_CEILING_MS so a stray value cannot wedge a turn forever.
 */
export const STATED_RESET_MAX_WAIT_MS = 1_800_000;
/** Upper bound for the override: one hour is the longest wait worth holding. */
export const STATED_RESET_WAIT_CEILING_MS = 3_600_000;

function statedResetMaxWaitMs(): number {
  const raw = process.env.OPENCODEX_DEVIN_STATED_RESET_WAIT_MS?.trim();
  if (!raw) return STATED_RESET_MAX_WAIT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return STATED_RESET_MAX_WAIT_MS;
  return Math.min(parsed, STATED_RESET_WAIT_CEILING_MS);
}
/** Test seam for the wait ceiling; the resolver itself stays private. */
export const statedResetMaxWaitMsForTests = statedResetMaxWaitMs;

export interface StatedResetRetryOptions {
  /** Test seam: the event source. Defaults to the real cloud stream. */
  stream?: (req: CloudChatRequest) => AsyncGenerator<CloudChatEvent>;
  /** Test seam: abort-aware sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxReplays?: number;
  maxWaitMs?: number;
}

/**
 * `streamChatEvents` plus a bounded stated-reset replay. Yields the same
 * event stream; on a pre-output 429 carrying a parseable "reset in N" delay,
 * sleeps that delay and re-issues the request instead of failing the turn.
 */
export async function* streamChatEventsWithResetRetry(
  req: CloudChatRequest,
  options?: StatedResetRetryOptions,
): AsyncGenerator<CloudChatEvent> {
  const stream = options?.stream ?? streamChatEvents;
  const sleep = options?.sleep ?? sleepWithAbort;
  const maxReplays = options?.maxReplays ?? STATED_RESET_MAX_REPLAYS;
  const maxWaitMs = options?.maxWaitMs ?? statedResetMaxWaitMs();
  let replays = 0;
  while (true) {
    // Set BEFORE the yield: an error surfacing at the yield point (consumer
    // throw) must read as post-output, and any event at all means the turn
    // may already have had effects a replay would duplicate.
    let yielded = false;
    try {
      for await (const event of stream(req)) {
        yielded = true;
        yield event;
      }
      return;
    } catch (error) {
      const waitSec = !yielded
        && error instanceof CloudChatError
        && error.status === 429
        ? parseRetryAfterFromMessage(error.message)
        : undefined;
      if (
        waitSec === undefined
        || replays >= maxReplays
        || waitSec * 1000 > maxWaitMs
      ) {
        throw error;
      }
      replays += 1;
      // Throws on client abort; the adapter's catch reports the cancellation.
      await sleep(waitSec * 1000, req.signal);
    }
  }
}
