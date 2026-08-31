import type { CodexNativeRestoreResult } from "../codex/inject";
import { deferralMatchesReceipt } from "../config/pending-teardown";

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
  /** Does the nonce this request carries name a readable obligation on disk? */
  ownsReceipt?: (nonce: string | null) => boolean;
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
export function deferralHonored(url: URL, ownsReceipt: (nonce: string | null) => boolean): boolean {
  if (url.searchParams.get("deferSharedTeardown") !== "1") return false;
  return ownsReceipt(url.searchParams.get("teardownNonce"));
}

/** Run (or skip) the shared teardown and describe the outcome truthfully. */
export async function performStopTeardown(url: URL, io: StopTeardownIo = {}): Promise<StopTeardownBody> {
  const ownsReceipt = io.ownsReceipt ?? deferralMatchesReceipt;
  if (deferralHonored(url, ownsReceipt)) {
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
  // Success means BOTH halves came down. Deciding it from the native restore alone and
  // appending the Grok text let a caller read `success: true` while the fence still
  // pointed at a proxy that was exiting — the teardown reported done with half of it
  // undone (#3008).
  const grokNote = grok.ok ? "" : ` Grok config cleanup failed: ${grok.message}`;
  if (restore.success && grok.ok) {
    return { success: true, message: "Proxy stopping, native Codex restored.", sharedTeardown: "performed" };
  }
  if (restore.success) {
    return {
      success: false,
      message: `Proxy stopping, native Codex restored, but the Grok fence was not removed:${grokNote} Run \`ocx restore\`.`,
      sharedTeardown: "performed",
    };
  }
  return {
    success: false,
    message: `Proxy stopping, but native Codex restore failed: ${restore.message}. Run \`ocx restore\`.${grokNote}`,
    sharedTeardown: "performed",
  };
}
