/**
 * Does an update own the runtime it is about to stop and restart?
 *
 * Both updaters ask this: `src/update/index.ts` on the Bun path and `bin/ocx.mjs` on the
 * npm and pnpm path. It lives here as plain ESM for the same reason `stop-decision.mjs`
 * does — the Node launcher has to be able to import it, and two lanes deciding the same
 * situation separately is how a fix ships on one side only.
 */

/**
 * Decide how an update treats a runtime it may not own.
 *
 * `ocx update` replaces the package's files and then puts the proxy back: it stops the
 * running server first, and afterwards runs `ocx service repair` to re-register and restart
 * the background service. Under a desktop owner both halves are wrong. The running server is
 * the app's own bundled sidecar rather than anything this package installed, so stopping it
 * takes down a runtime the update has no way to bring back; and the repair would re-enable
 * the npm launcher the takeover superseded, which is the exact reactivation the ownership
 * marker exists to prevent. Neither half is needed either — the app updates its own runtime.
 *
 * The service registration itself is untouched in every case. It is kept by decision, not by
 * accident, so a user who later runs `ocx service install` gets their npm service back.
 *
 * THE COST OF A STALE MARKER. This reads the recorded claim, not liveness. An app deleted
 * without releasing ownership leaves a marker behind, and an update then declines to stop or
 * refresh a runtime no app is managing any more. That is the orphan-recovery cost the
 * two-record ownership design accepted; `ocx service install` clears the marker and restores
 * the ordinary path.
 *
 * The three returned flags are separate authorities, not commands. In particular, leaving
 * a runtime running is not permission to replace the package it may be executing from.
 *
 * A recorded desktop claim does not prove which binary is live. Until the bundled resolver
 * carries installation identity, it therefore blocks package replacement as well as stop and
 * restoration; the notice tells a stale-marker user how to take ownership back explicitly.
 *
 * @param {{ ownership: { owner: string, installId: string, consentGeneration: number } | null, ownershipUnknown?: boolean, serviceInstalled: boolean }} input
 * @returns {{ mayReplacePackage: boolean, mayStopRuntime: boolean, mayRestoreService: boolean, notice: string | null }}
 */
export function planUpdateRuntimeHandling({ ownership, ownershipUnknown = false, serviceInstalled }) {
  // Unreadable, malformed or contradictory is not "nobody owns it". Reading it that way is
  // how a permissions error reactivates the npm launcher over a consented takeover.
  if (ownershipUnknown) {
    return {
      mayReplacePackage: false,
      mayStopRuntime: false,
      mayRestoreService: false,
      notice: "⚠️  The background runtime's recorded owner could not be determined, so it was "
        + "left running and the service registration was not touched. "
        + "Run 'ocx service install' to re-register the service and take the runtime back.",
    };
  }
  // Any owner that is not this CLI. Reading it this way rather than testing for "desktop"
  // keeps a third kind of owner from silently falling into the branch that touches the npm
  // registration.
  if (ownership && ownership.owner !== "cli") {
    return {
      // A claim does not prove which binary is live. A stale desktop marker beside a
      // manually started npm proxy would otherwise replace that proxy's executing files.
      mayReplacePackage: false,
      mayStopRuntime: false,
      mayRestoreService: false,
      notice: `🖥️  The desktop app owns the background runtime (install ${ownership.installId}, `
        + `consent generation ${ownership.consentGeneration}). It and the npm package were left unchanged, and the `
        + "service registration was neither re-enabled nor restarted. "
        + "If the desktop app is gone, run 'ocx service install' to take the runtime back.",
    };
  }
  return {
    mayReplacePackage: true,
    mayStopRuntime: true,
    mayRestoreService: serviceInstalled,
    notice: null,
  };
}
