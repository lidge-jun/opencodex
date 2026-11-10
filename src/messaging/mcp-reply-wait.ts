import { z } from "zod";
import { MessageBudget } from "./budget";
import type { QueueMcpOptions } from "./mcp-queue-rpc";
import { decodeReplyCursor, replyInput, type ReplyInput } from "./mcp-reply-cursor";
import { queueMcpReadReply } from "./mcp-reply-tools";

export const replyWaitInput = { ...replyInput, waitMs: z.number().int().min(1).max(20_000).default(20_000) };
type Observation = Extract<Awaited<ReturnType<typeof queueMcpReadReply>>, { available: true }>;

/** Delay only between snapshots; cancellation always removes its timer and listener. */
function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener("abort", cancel); resolve(); };
    const timer = setTimeout(done, 2_000);
    const cancel = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(signal.reason); };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

/** Wait for eligible stored final text, never for goal completion or exclusive/new reply ownership. */
export async function queueMcpWaitReply(options: QueueMcpOptions, raw: ReplyInput & { waitMs?: number }, signal?: AbortSignal) {
  const unavailable = (code: string) => ({ available: false as const, error: { code } });
  if (!options.allowReplyRead) return unavailable("reply_read_disabled");
  const parsed = z.object(replyWaitInput).strict().safeParse(raw);
  if (!parsed.success) return unavailable("reply_invalid_input");
  const { waitMs, ...input } = parsed.data;
  try { decodeReplyCursor(input); } catch { return unavailable("reply_invalid_cursor"); }
  const budget = new MessageBudget(waitMs, signal);
  let last: Observation | undefined, observedAt = 0, attempts = 0;
  const finish = (observation: Observation, waitOutcome: "reply_observed" | "needs_pagination" | "ambiguous" | "wait_exhausted") =>
    ({ ...observation, waitOutcome, attempts, lastObservationAgeMs: Math.max(0, Math.floor(performance.now() - observedAt)) });
  const exhausted = () => last ? finish(last, "wait_exhausted") : unavailable("reply_wait_timeout");
  let position: ReplyInput = input;
  try {
    for (let index = 0; index < 3; index++) {
      budget.throwIfEnded();
      attempts++;
      const snapshotStartedAt = performance.now();
      let observedFailure = false, observedCompleteTimely = false;
      const result = await queueMcpReadReply(options, position, budget.signal, {
        onObservedFailure: () => { observedFailure = true; },
        outcomeIsTimely: () => { try { budget.throwIfEnded(); return true; } catch { return false; } },
        // Cleanup may outlive the deadline; what matters is when this snapshot's complete observation arrived.
        onObservedSuccess: timely => { observedCompleteTimely = timely; },
      });
      if (signal?.aborted) return unavailable("reply_wait_cancelled");
      if (!result.available) {
        if (observedFailure) return result;
        return budget.signal.aborted ? exhausted() : result;
      }
      // A completion observed after the deadline is not a valid success; a timely one survives cleanup.
      if (!observedCompleteTimely) return exhausted();
      // The reply page precedes later metadata reads and helper cleanup; age conservatively
      // from the snapshot start so that delay cannot make an older observation appear fresh.
      last = result; observedAt = snapshotStartedAt;
      if (result.replies.length) return finish(result, "reply_observed");
      if (result.status === "ambiguous") return finish(result, "ambiguous");
      if (result.nextCursor) return finish(result, "needs_pagination");
      if (index === 2) return exhausted();
      // Stored summaries from another process are not authoritative live/terminal state.
      if (result.status === "observed") position = { ...input, cursor: result.refreshCursor };
      await pause(budget.signal);
    }
    return exhausted();
  } catch {
    if (signal?.aborted) return unavailable("reply_wait_cancelled");
    return budget.signal.aborted ? exhausted() : unavailable("reply_wait_unavailable");
  } finally { budget.dispose(); }
}
