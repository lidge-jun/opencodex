import type { CodexNativeRestoreResult } from "../codex/inject";
import { deferralMatchesReceipt, type PendingTeardownRead } from "../config/pending-teardown";

/**
 * Shared-teardown decision and execution for `POST /api/stop` (#3008).
 *
 * Lives outside the route handler because the handler schedules `process.exit` 200ms
 * after it answers, which makes it uncallable from a test. The part worth testing is
 * exactly this: whether the deferral is honoured, whether the restores actually run, and
 * whether the response says what happened.
 */

export type GrokStripResult = { ok: boolean; changed: boolean; message: string };

export type StopTeardownIo = {
  /** The caller's pending-teardown receipt as it stands on disk. */
  readReceipt?: () => PendingTeardownRead;
  restoreNativeCodex?: () => Promise<CodexNativeRestoreResult>;
  stripGrok?: () => GrokStripResult;
};

export type StopTeardownBody = {
  success: boolean;
  message: string;
  sharedTeardown: "deferred" | "performed";
};

/**
 * A deferral is honoured only when the caller proves it owns the obligation.
 *
 * The query flag names an intention; the receipt is the obligation. Without the second
 * half any authenticated caller could ask the proxy to skip teardown and then exit,
 * leaving native Codex and the Grok fence pointed at a proxy that no longer exists.
 *
 * "A receipt exists" is not that proof either: it would let any caller ride on another
 * stop's outstanding obligation and get a deferral it never owns. The request has to name
 * the receipt's nonce, which only the process that wrote it (and anything that can read
 * the 0700 config directory, which is already the trust boundary for the admin token)
 * can know.
 */
export function deferralHonored(url: URL, readReceipt: () => PendingTeardownRead): boolean {
  if (url.searchParams.get("deferSharedTeardown") !== "1") return false;
  return deferralMatchesReceipt(url.searchParams.get("teardownNonce"), readReceipt());
}

/** Run (or skip) the shared teardown and describe the outcome truthfully. */
export async function performStopTeardown(url: URL, io: StopTeardownIo = {}): Promise<StopTeardownBody> {
  const readReceipt = io.readReceipt ?? ((): PendingTeardownRead => ({ state: "missing" }));
  if (deferralHonored(url, readReceipt)) {
    // Not "native Codex restored": nothing was restored here, and claiming otherwise
    // would be a success message the operator cannot verify.
    return {
      success: true,
      message: "Proxy stopping; shared teardown deferred to the stopping client.",
      sharedTeardown: "deferred",
    };
  }
  const restore = io.restoreNativeCodex
    ? await io.restoreNativeCodex()
    : await (await import("../codex/inject")).restoreNativeCodexAsync();
  const grok = io.stripGrok
    ? io.stripGrok()
    : (await import("../grok/inject")).stripGrokConfig();
  const grokNote = grok.ok ? "" : ` Grok config cleanup failed: ${grok.message}`;
  return restore.success
    ? { success: true, message: `Proxy stopping, native Codex restored.${grokNote}`, sharedTeardown: "performed" }
    : {
      success: false,
      message: `Proxy stopping, but native Codex restore failed: ${restore.message}. Run \`ocx restore\`.${grokNote}`,
      sharedTeardown: "performed",
    };
}
