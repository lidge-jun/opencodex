import type { CodexNativeRestoreResult } from "../codex/inject";

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
  /** Presence of the caller's pending-teardown receipt. */
  readReceipt?: () => unknown;
  restoreNativeCodex?: () => Promise<CodexNativeRestoreResult>;
  stripGrok?: () => GrokStripResult;
};

export type StopTeardownBody = {
  success: boolean;
  message: string;
  sharedTeardown: "deferred" | "performed";
};

/**
 * A deferral is honoured only when the caller also left a receipt on disk.
 *
 * The query flag names an intention; the receipt is the obligation. Without that second
 * half any authenticated caller could ask the proxy to skip teardown and then exit,
 * leaving native Codex and the Grok fence pointed at a proxy that no longer exists, with
 * nothing on disk for a later stop or update to find.
 */
export function deferralHonored(url: URL, readReceipt: () => unknown): boolean {
  if (url.searchParams.get("deferSharedTeardown") !== "1") return false;
  return readReceipt() != null;
}

/** Run (or skip) the shared teardown and describe the outcome truthfully. */
export async function performStopTeardown(url: URL, io: StopTeardownIo = {}): Promise<StopTeardownBody> {
  const readReceipt = io.readReceipt ?? (() => null);
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
