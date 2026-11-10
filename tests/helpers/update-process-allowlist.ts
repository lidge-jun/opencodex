// Best-effort known-pattern regression lint, not a security boundary or
// completeness proof. Runtime mutation guards enforce update authority.
// Exact existing terminal/probe lifecycle sites. No arbitrary process API is admitted.
import { orchestratedChildReview } from "./update-review-orchestrated-child";
import { orchestratedEntryReview } from "./update-review-orchestrated-entry";
import { signedSupplyReview } from "./update-review-signed-supply";

const baseProcessAllowlist: readonly (readonly [string, string, number])[] = [
  ["bin/ocx.mjs:runPackageManagerSelfUpdate:process.on(signal, () => {})","pre-mutation: keep the update session owner alive during installer supervision",1],
  ["bin/ocx.mjs:runPackageManagerSelfUpdate:process.once(\"exit\", () => { try { if (enteredMutation) session.finish(childOutcome); else session.finishPreflight(); } catch (error) { console.error(`Orchestrated outcome write failed: ${error?.message ?? error}`); process.exitCode = 1; } })","pre-mutation: register session outcome cleanup at exit",1],
  ["bin/ocx.mjs:runPackageManagerSelfUpdate:process.once(\"exit\", () => { try { if (enteredMutation) session.finish(childOutcome); else session.finishPreflight(); } catch (error) { console.error(`Update outcome write failed: ${error?.message ?? error}`); process.exitCode = 1; } })","pre-mutation: register legacy session outcome cleanup at exit",1],
  ["bin/ocx.mjs:<module>:process.exit(result.status ?? 1)","read-only: return identity probe status",1],
  ["bin/ocx.mjs:<module>:process.exit(64)","pre-mutation: reject invalid orchestrated arguments",1],
  ["bin/ocx.mjs:<module>:process.exit(result.exitCode)","read-only: return independently admitted orchestrated result status",1],
  ["bin/ocx.mjs:<module>:process.exit(syncLease.exit)","pre-mutation: return sync admission refusal",1],
  ["bin/ocx.mjs:<module>:process.once(\"exit\", releaseSyncLease)","pre-mutation: release the sync admission lease on exit",1],
  ["bin/ocx.mjs:<module>:process.exit(10)","pre-mutation: refuse apply when the runtime is unavailable",1],
  ["bin/ocx.mjs:<module>:child.kill()","pre-mutation: terminate own sync child after delegate publication failure",1],
  ["src/update/posix-install-supervisor.mjs:supervise:process.kill(-pid, \"SIGKILL\")","supervisor child: terminates only the installer group this supervisor spawned",2],
  ["bin/ocx.mjs:runPackageManagerSelfUpdate:process.exit(10)","pre-mutation session start refusal or mutation entry refusal; scanner checks the latter exact branch",2],
  ["bin/ocx.mjs:runPackageManagerSelfUpdate:process.exit(1)","terminal failure only; cannot publish successful update",32],
  ["bin/ocx.mjs:runPackageManagerSelfUpdate:process.exit(0)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",1],
  ["bin/ocx.mjs:fail:process.exit(1)","terminal failure only; cannot publish successful update",1],
  ["bin/ocx.mjs:<module>:process.exit(0)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",4],
  ["bin/ocx.mjs:<module>:process.exit(2)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",1],
  ["bin/ocx.mjs:<module>:process.exit(1)","terminal failure only; cannot publish successful update",8],
  ["bin/ocx.mjs:<module>:process.exit(127)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",1],
  ["bin/ocx.mjs:<module>:process.exit(result.code)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",1],
  ["bin/ocx.mjs:<module>:process.on(sig, handler)","ordinary launcher signal relay registration/cleanup",1],
  ["bin/ocx.mjs:<module>:process.removeListener(sig, handler)","ordinary launcher signal relay registration/cleanup",1],
  ["bin/ocx.mjs:<module>:process.exit(code ?? 1)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",1],
  ['src/update/index.ts:runUpdate:process.once("exit", () => session?.finishPreflight())',"pre-mutation exit cleanup for the legacy session",1],
  ["src/update/index.ts:runUpdateWithSession:process.exit(1)","terminal failure only; cannot publish successful update",4],
  ["src/update/index.ts:runUpdateWithSession:process.exit(updateExitCode)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",1],
  ["src/update/job.ts:defaultProbeProxyIdentity:fetch(`http://${probeHostname(hostname)}:${port}/healthz`, { signal: AbortSignal.timeout(750), })","bounded loopback health observation, no update control",1],
  ["src/update/notify.ts:maybeShowUpdatePrompt:process.exit(0)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",1],
  ["src/update/service-home-probe-entry.ts:<module>:process.exit(1)","terminal failure only; cannot publish successful update",1],
];
export const updateProcessAllowlist: readonly (readonly [string, string, number])[] = [...baseProcessAllowlist, ...orchestratedEntryReview.process, ...orchestratedChildReview.process, ...signedSupplyReview.process];
