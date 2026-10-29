import type { CodexNativeRestoreResult } from "../codex/inject";
import { siblingOfLivePort, siblingSkipMessage } from "../codex/sibling-start";
import { deferralMatchesReceipt } from "../config/pending-teardown";
import { isDesktopSupervised } from "../lib/system-restart-contract";
import type { ManagementPrincipal } from "./management-auth";
import type { RestoreConfigOptions } from "../codex/inject/restore";
import { stopRestoreWriteGuard } from "../cli/stop-restore-guard";

/**
 * Shared-teardown decision and execution for `POST /api/stop` (#3008).
 *
 * Lives outside the route handler because the handler schedules `process.exit` 200ms
 * after it answers, which makes it uncallable from a test. The part worth testing is
 * exactly this: whether the deferral is honoured, whether the restores actually run, and
 * whether the response says what happened.
 */

export type GrokStripResult = { ok: boolean; changed: boolean; message: string };

// A verified receipt transfers shared restoration to the parent until this process exits.
// Keep this separate from recycling and connected-client capability/ownership decisions.
let sharedTeardownDeferredOnExit = false;
export function isSharedTeardownDeferredOnExit(): boolean { return sharedTeardownDeferredOnExit; }

/** Read-only promise covering API teardown and the CLI runtime's signal/manager exit cleanup. */
export function stopCapabilities() {
  return { schema: "ocx-stop-capabilities/1", connectedClientOwnership: true, pid: process.pid };
}

export type StopTeardownIo = {
  /** Does the nonce this request carries name a readable obligation on disk? */
  ownsReceipt?: (nonce: string | null) => boolean;
  /** Does that obligation hand the teardown to the proxy an update restarts (#7423)? */
  isHandoverReceipt?: (nonce: string | null) => boolean;
  /** Keep Codex, Grok and env fences in place when this process exits. */
  keepClientConfigOnExit?: () => void;
  restoreNativeCodex?: (options?: RestoreConfigOptions) => Promise<CodexNativeRestoreResult>;
  stripGrok?: () => GrokStripResult;
};

export type StopTeardownBody = {
  success: boolean;
  message: string;
  /** `not-owned`: shared routing belongs to a live sibling owner or a client connection. */
  sharedTeardown: "deferred" | "performed" | "not-owned" | "refused";
};

function stopOwnershipRefusal(): StopTeardownBody {
  return { success: false, message: "Stop refused: client connection ownership may be changing; remaining restoration and obligations are preserved. Retry once connect or disconnect finishes.", sharedTeardown: "refused" };
}

/** Read under C before manager mutation; every later write still revalidates independently. */
export function preflightStopTeardownOwnership(): StopTeardownBody | null {
  const guard = stopRestoreWriteGuard();
  try { guard.run(() => {}); }
  catch (error) {
    if (guard.boundary() === "unproven") return stopOwnershipRefusal();
    if (guard.boundary() !== "hub-owned") throw error;
  }
  return null;
}

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

export type StopRefusalBody = { success: false; code: string; message: string };

/**
 * The dashboard's Stop, refused while the desktop app supervises this process.
 *
 * The app starts its runtime again after any exit it did not ask for
 * (`desktop/src-tauri/src/supervisor.rs`), and a dashboard Stop is not the app asking: the proxy
 * would restore native Codex and exit, and the app would start it again seconds later and reload
 * the dashboard. Like the service-manager refusals it is refused before anything changes, and it
 * names what does stop the proxy: the app's tray Stop proxy, or Quit. Only a dashboard session is
 * refused. `ocx stop`, which the tray's Stop, Quit and an update's drain all run, authenticates
 * with the admin token and is unaffected. Read only on this route, never on the request path.
 */
export function desktopSupervisedStopRefusal(
  principal: ManagementPrincipal | null | undefined,
  supervised: () => boolean = isDesktopSupervised,
): StopRefusalBody | null {
  if (principal !== "gui-session" || !supervised()) return null;
  return {
    success: false,
    code: "desktop_supervised",
    message: "The OpenCodex desktop app runs this proxy and starts it again after it exits, so the dashboard does not stop it. Use Stop proxy in the app's tray menu, or quit the app. Nothing was changed.",
  };
}

/** Run (or skip) the shared teardown and describe the outcome truthfully. */
export async function performStopTeardown(url: URL, io: StopTeardownIo = {}): Promise<StopTeardownBody> {
  // Before the deferral check: a sibling owns no shared teardown to perform OR to hand over.
  // Restoring here would replay the live owner's journal and strip its Grok fence.
  if (siblingOfLivePort() !== null) {
    return { success: true, message: `Proxy stopping. ${siblingSkipMessage()}`, sharedTeardown: "not-owned" };
  }
  // A connection owns its integrations across stop/start, even for a successful API stop.
  // This is persisted authority, not a caller's request to skip an obligation it owns.
  const connection = (await import("../client/state")).readClientConnectionState();
  // A Link Child's route is an unauthenticated loopback listener. Once this process exits,
  // preserving that route would let another local process claim the released port.
  if (connection.kind === "connected" && connection.value.transport !== "link") {
    return {
      success: true,
      message: "Proxy stopping; connection-owned Codex routing, catalog and Grok config preserved. Run `ocx disconnect` to release them.",
      sharedTeardown: "not-owned",
    };
  }
  const ownsReceipt = io.ownsReceipt ?? deferralMatchesReceipt;
  if (deferralHonored(url, ownsReceipt)) {
    sharedTeardownDeferredOnExit = true;
    // A handover outlives this process: the exit cleanup would otherwise restore native
    // Codex and put the pristine catalog back right after the stop kept them (#7423).
    // Exiting as a recycle leaves them for the replacement, as a dashboard restart does.
    const nonce = url.searchParams.get("teardownNonce");
    const handover = io.isHandoverReceipt
      ? io.isHandoverReceipt(nonce)
      : (await import("../config/pending-teardown")).isUpdateHandoverReceipt(nonce);
    if (handover) {
      if (io.keepClientConfigOnExit) io.keepClientConfigOnExit();
      else (await import("./lifecycle")).markRecyclingForExit();
      return {
        success: true,
        message: "Proxy stopping; Codex routing and catalog kept for the updated proxy.",
        sharedTeardown: "deferred",
      };
    }
    // Not "native Codex restored": nothing was restored here, and claiming otherwise
    // would be a success message the operator cannot verify.
    return {
      success: true,
      message: "Proxy stopping; shared teardown deferred to the stopping client.",
      sharedTeardown: "deferred",
    };
  }
  const guard = stopRestoreWriteGuard();
  let restore: CodexNativeRestoreResult;
  let grok: GrokStripResult;
  try {
    guard.run(() => {}); // Refuse pending ownership before entering an asynchronous writer.
    const options = { withWriteGuard: guard.run };
    restore = io.restoreNativeCodex
      ? await io.restoreNativeCodex(options)
      : await (await import("../codex/inject")).restoreNativeCodexAsync(options);
    const strip = io.stripGrok ?? (await import("../grok/inject")).stripGrokConfig;
    grok = guard.run(() => strip());
  } catch (error) {
    const boundary = guard.boundary();
    if (boundary === "restore") throw error;
    return boundary === "hub-owned"
      ? { success: true, message: "Proxy stopping; a hub connection owns Codex routing, catalog and Grok config, so restoration stopped.", sharedTeardown: "not-owned" }
      : stopOwnershipRefusal();
  }
  // Success means BOTH halves came down. Deciding it from the native restore alone and
  // appending the Grok text let a caller read `success: true` while the fence still
  // pointed at a proxy that was exiting — the teardown reported done with half of it
  // undone (#3008).
  const grokNote = grok.ok ? "" : ` Grok config cleanup failed: ${grok.message}`;
  if (restore.success && grok.ok) {
    // A degraded restore is a success — routing is out and the client is no longer aimed at
    // a port that is about to disappear — but it left a provider table behind on purpose.
    // Reporting a bare "restored" would put the caller in exactly the position #4812
    // describes: a config they did not expect and no idea why it is there.
    const retained = restore.retainedCodexProviderTable
      ? ` ${(await import("../codex/inject/restore")).describeRetainedCodexProviderTable(restore.retainedCodexProviderTable)}`
      : "";
    return { success: true, message: `Proxy stopping, native Codex restored.${retained}`, sharedTeardown: "performed" };
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
