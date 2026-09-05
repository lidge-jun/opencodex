/**
 * Delivery sinks for a detected quota reset: an HTTP webhook and a local command.
 *
 * Both are best-effort and independently isolated. Neither ever throws to the caller, and one
 * failing never suppresses the other — a reset notification is a courtesy, and a courtesy that
 * can break the quota write that triggered it is a defect.
 *
 * There is deliberately NO retry. The wp3 observer claims the idempotence key before dispatch,
 * so a retry here could only ever duplicate a delivery the ledger already considers done; and a
 * reset notification is interesting only while it is fresh.
 *
 * Imported lazily by the activation path, never statically from a core file: this module
 * reaches the destination policy and the config barrel, and
 * tests/usage/quota-reset-core-boundary.test.ts enforces that none of that lands on the request path.
 */

import { signalWithTimeout } from "../lib/abort";
import { assertUrlResolvesPublic } from "../lib/destination-policy";
import { cancelResponseBodyBestEffort } from "../lib/upstream-retry";
import type { QuotaResetEvent } from "./reset-detector";
import type { ResolvedQuotaResetNotify } from "./reset-notify-config";

export type QuotaResetSinkName = "webhook" | "command";

/**
 * Outcome of one delivery attempt.
 *
 * `reason` is a CLOSED UNION on purpose. An upstream body, a resolved address, or the webhook
 * URL itself would all be sensitive — the URL is the credential for Slack and Discord — and this
 * value reaches logs and the management API.
 */
export type QuotaResetDeliveryResult = {
  readonly sink: QuotaResetSinkName;
  readonly ok: boolean;
  readonly reason?: "blocked-destination" | "timeout" | "http-error" | "spawn-failed";
};

/**
 * The delivered payload.
 *
 * Closed-union labels and numbers only: no email, no account id, no token, no filesystem path,
 * no URL. `accountTag` is a salted hash whose salt never leaves the install.
 *
 * The TYPE is the enforcement. `bun run privacy:scan` reads repository text, not runtime output,
 * so it cannot check this — stating the obligation in the type is what keeps a later field
 * addition honest.
 */
type QuotaResetPayload = {
  readonly type: "quota_reset";
  readonly kind: QuotaResetEvent["kind"];
  readonly scope: string;
  readonly accountTag: string;
  readonly window: string;
  readonly percentBefore?: number;
  readonly percentAfter?: number;
  readonly previousResetAt?: number;
  readonly resetAt?: number;
  readonly detectedAt: number;
};

/**
 * Build the payload by NAMING every field, never by spreading the event.
 *
 * A spread would silently forward whatever the detector gains next — including the internal
 * idempotence `key`, which encodes the scope and tag and has no business crossing a webhook
 * boundary to a third party.
 */
function payloadFor(event: QuotaResetEvent): QuotaResetPayload {
  return {
    type: "quota_reset",
    kind: event.kind,
    scope: event.scope,
    accountTag: event.accountTag,
    window: event.window,
    ...(event.percentBefore !== undefined ? { percentBefore: event.percentBefore } : {}),
    ...(event.percentAfter !== undefined ? { percentAfter: event.percentAfter } : {}),
    ...(event.previousResetAt !== undefined ? { previousResetAt: event.previousResetAt } : {}),
    ...(event.resetAt !== undefined ? { resetAt: event.resetAt } : {}),
    detectedAt: event.detectedAt,
  };
}

/** Test seam for the payload contract, so a test cannot drift from what is actually sent. */
export function quotaResetPayloadForTests(event: QuotaResetEvent): unknown {
  return payloadFor(event);
}

async function deliverWebhook(
  json: string,
  config: ResolvedQuotaResetNotify,
): Promise<QuotaResetDeliveryResult> {
  const url = config.webhookUrl;
  if (url === undefined) return { sink: "webhook", ok: true };

  // An operator-supplied URL is an SSRF surface: this process can reach loopback services and
  // cloud metadata endpoints that the operator's browser cannot. The repository already owns
  // this policy, so the check is reused rather than reinvented. Self-hosted receivers opt in.
  if (!config.allowPrivateNetwork) {
    try {
      await assertUrlResolvesPublic(url);
    } catch {
      return { sink: "webhook", ok: false, reason: "blocked-destination" };
    }
  }

  const timeout = signalWithTimeout(config.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json,
      // The destination check above validated THIS url. Following a redirect would send the
      // payload somewhere unvalidated, so a hop is refused rather than re-validated: the
      // operator can configure the final URL directly, which is the stance
      // providerRedirectError already takes for provider traffic.
      redirect: "manual",
      signal: timeout.signal,
    });
    // Nothing reads the body, and an undrained response holds the connection open.
    cancelResponseBodyBestEffort(response);
    if (response.status >= 300 && response.status < 400) {
      return { sink: "webhook", ok: false, reason: "blocked-destination" };
    }
    if (!response.ok) return { sink: "webhook", ok: false, reason: "http-error" };
    return { sink: "webhook", ok: true };
  } catch (error) {
    const aborted = error instanceof Error
      && (error.name === "TimeoutError" || error.name === "AbortError");
    return { sink: "webhook", ok: false, reason: aborted ? "timeout" : "http-error" };
  } finally {
    // Without this the timer keeps the event loop alive for up to timeoutMs after a fast
    // response, which on a short-lived CLI invocation delays exit for no reason.
    timeout.cleanup();
  }
}

async function deliverCommand(
  json: string,
  config: ResolvedQuotaResetNotify,
): Promise<QuotaResetDeliveryResult> {
  const command = config.command;
  if (command === undefined || command.length === 0) return { sink: "command", ok: true };

  try {
    // argv form, NOT a shell string: an operator-supplied command must not become an injection
    // surface, and there is no shell here to interpret metacharacters.
    const proc = Bun.spawn([...command], {
      // Encoded bytes, not a string. Bun 1.4.0 throws ERR_INVALID_ARG_TYPE on a plain string
      // here, and no existing call site in this repository pipes stdin, so there was no
      // in-repo precedent to copy.
      stdin: new TextEncoder().encode(json),
      // The event is already delivered by writing it to stdin; the command's own chatter is not
      // ours to relay, and inheriting it would interleave into whatever is on the terminal.
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return { sink: "command", ok: false, reason: "spawn-failed" };
    return { sink: "command", ok: true };
  } catch {
    // A missing binary or a permission error. The message could contain a filesystem path, so
    // it is deliberately not carried through.
    return { sink: "command", ok: false, reason: "spawn-failed" };
  }
}

/**
 * Deliver one event to every configured sink.
 *
 * Sinks run CONCURRENTLY and are settled independently, so a webhook that sits until its
 * timeout does not delay the local command. Never rejects.
 */
export async function deliverQuotaResetEvent(
  event: QuotaResetEvent,
  config: ResolvedQuotaResetNotify,
): Promise<QuotaResetDeliveryResult[]> {
  // Filtered here as well as at the sink registration, because this function is the public
  // entry point and a caller should not be able to deliver a kind the operator excluded.
  if (!config.kinds.has(event.kind)) return [];

  const json = JSON.stringify(payloadFor(event));
  const attempts: Array<Promise<QuotaResetDeliveryResult>> = [];
  if (config.webhookUrl !== undefined) attempts.push(deliverWebhook(json, config));
  if (config.command !== undefined && config.command.length > 0) {
    attempts.push(deliverCommand(json, config));
  }
  if (attempts.length === 0) return [];

  const settled = await Promise.allSettled(attempts);
  return settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    // Both helpers catch internally, so this is unreachable in practice — but a rejected
    // promise must still not propagate out of a best-effort notifier.
    const sink: QuotaResetSinkName = index === 0 && config.webhookUrl !== undefined
      ? "webhook"
      : "command";
    return { sink, ok: false, reason: "spawn-failed" };
  });
}
