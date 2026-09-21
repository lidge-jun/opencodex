/**
 * Does an update own the runtime it is about to stop and restart?
 *
 * Both updaters ask this: `src/update/index.ts` on the Bun path and `bin/ocx.mjs` on the
 * npm and pnpm path. It lives here as plain ESM for the same reason `stop-decision.mjs`
 * does — the Node launcher has to be able to import it, and two lanes deciding the same
 * situation separately is how a fix ships on one side only.
 */

/*
 * There is deliberately no ownership PARSER here any more.
 *
 * This module used to carry one so the Node launcher could read the record without importing
 * TypeScript, kept "in step" with the authoritative reader by a test that drove the same
 * shapes through both. It was not in step: it inspected one path and treated a record that
 * failed the whole install-state contract as an unowned runtime whenever its `ownership`
 * field was simply absent. Reading and resolving now live in
 * `src/service/install-state-contract.mjs`, which both runtimes import, so there is one
 * algorithm rather than two that a test has to keep aligned.
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
 * Both returned flags are VETOES, not commands: each updater already has its own reasons to
 * stop the proxy and to refresh the service, and this plan can only take them away.
 *
 * THE LIMIT OF THIS RULE. It reads the recorded claim, not the live process. If the app was
 * deleted and the user then starts an npm proxy by hand, the stale claim still vetoes the
 * stop and the update replaces package files under a live server. Proving WHICH runtime is
 * answering needs the identity the bundled CLI's resolve contract will carry; until then the
 * notice tells the user how to clear the marker.
 *
 * @param {{ ownership: { owner: string, installId: string, consentGeneration: number } | null, ownershipUnknown?: boolean, serviceInstalled: boolean }} input
 * @returns {{ stopRuntime: boolean, refreshService: boolean, notice: string | null }}
 */
export function planUpdateRuntimeHandling({ ownership, ownershipUnknown = false, serviceInstalled }) {
  // Unreadable, malformed or contradictory is not "nobody owns it". Reading it that way is
  // how a permissions error reactivates the npm launcher over a consented takeover.
  if (ownershipUnknown) {
    return {
      stopRuntime: false,
      refreshService: false,
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
      stopRuntime: false,
      refreshService: false,
      notice: `🖥️  The desktop app owns the background runtime (install ${ownership.installId}, `
        + `consent generation ${ownership.consentGeneration}). It was left running, and the `
        + "service registration was neither re-enabled nor restarted. "
        + "If the desktop app is gone, run 'ocx service install' to take the runtime back.",
    };
  }
  return { stopRuntime: true, refreshService: serviceInstalled, notice: null };
}
