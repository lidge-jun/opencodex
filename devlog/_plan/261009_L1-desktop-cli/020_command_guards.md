# 020 — Desktop supervision command guards (wp5 / PR B)

When the tracked proxy is a verified child of OpenCodex Desktop, activating a CLI service or
updating this CLI must stop before mutation. Ordinary stop remains available; ordinary restart
uses the existing authenticated request and waits for Desktop's replacement. This is the
accepted Kant D5 amendment and D6 in `002_consultation.md`, not a new ownership policy.

Planning snapshot: 2026-10-09, lane `.tmp/lanes/L1-desktop-cli`; source anchors below were read
in this lane. PR B is stacked on PR A's `codex/desktop-sidecar-cli-authority` branch, then
retargeted to `dev` when PR A lands. Re-resolve anchors against PR A before implementation;
line numbers describe the current pre-wp2 source, not invented post-edit locations.
This document is the only file written by this planning worker. No tests or live commands ran.

## Contract, dependency and scope

IN: service install/repair/start/restart refusal, Node/Bun update decisions and recovery,
dashboard restart veto, start duplicate guidance, stop stderr notice and JSON suppression,
Desktop restart wording, focused regressions and synchronized architecture/user docs.
OUT: wp2 evidence implementation/projection, ownership writes or claim synthesis, Rust protocol
changes, service stop/uninstall policy changes, CLI/PATH installer, Bun fallback/version notice
(wp3), GUI translation/UI changes, home mutation, live stop/restart, full local suite, merge/release.

PR A supplies `src/service/desktop-supervision.mjs` and `.d.mts`:

```ts
// Synchronous, plain ESM; the import is usable by Node and Bun.
inspectDesktopSupervision(deps?)
// => {kind:"desktop", runtimePid:number, supervisorPid:number, app:string, proxy:string}
//  | {kind:"none"} | {kind:"unknown", reason:string} | {kind:"unsupported"}
```

The inspector reads the selected home's pid/runtime-port files; darwin uses two consistent
`/bin/ps` snapshots, Linux procfs, Windows returns unsupported. Each process probe has a
750 ms ceiling. Call it at command/decision time, never at import time or on each request.
Only `desktop` activates these new blocks. Unknown/unsupported/none retain the previous
behavior, including the independent existing refusal for unknown **durable ownership**.
No environment bypass, login-registration requirement, install-id comparison or claim is added.
For target-specific start/restart wording, also require `runtimePid === target.pid`; a different
runtime in this home is not evidence about an unrelated endpoint.

An unrelated npm/Bun package is also left unchanged while Desktop supervision is verified.
This follows accepted D5: `ocx update` bundles replacement, stop and service recovery into one
operation, and the evidence has no package-install identity proving safe isolation. A partial
package-only exception would make the command's result and recovery ambiguous. Quit Desktop
and rerun to update the PATH install; use the app updater to update its bundle. No package-only
flag is introduced. This is conservative product policy, not proof that the two installs overlap.

## Diff-level implementation packet

### NEW `src/service/desktop-command-guard.ts`

Existing owner searched: `src/service/guards.ts:1-311` covers environment/auth guards;
`src/service/repair.ts:79-98` formats durable-owner refusal. Neither models live supervision.
This leaf keeps service code independent of the CLI presentation leaf. Exact new code:

```ts
import { inspectDesktopSupervision } from "./desktop-supervision.mjs";

export type DesktopSupervision = ReturnType<typeof inspectDesktopSupervision>;
export type SupervisionInspector = () => DesktopSupervision;

export function desktopServiceRefusal(evidence: DesktopSupervision): string | null {
  if (evidence.kind !== "desktop") return null;
  return `OpenCodex Desktop supervises the running proxy (pid ${evidence.runtimePid}, ${evidence.app}). `
    + "Quit OpenCodex, then rerun 'ocx service install' to move startup management to this CLI.";
}

export function assertNoDesktopSupervision(inspect: SupervisionInspector = inspectDesktopSupervision): void {
  const refusal = desktopServiceRefusal(inspect());
  if (refusal) throw new Error(refusal);
}

export function desktopServiceCommandRefusal(
  command: string,
  inspect: SupervisionInspector = inspectDesktopSupervision,
): string | null {
  if (!["install", "repair", "start", "restart"].includes(command)) return null;
  return desktopServiceRefusal(inspect());
}
```

### MODIFY `src/service/cli.ts`

Anchor: `serviceCommand` :215-485, argument-only preliminary parsing :476, Windows writer lock
:480-481; actual plan :228-233; repair dispatch :234; install :273; start :338.
Import `desktopServiceCommandRefusal` from `./desktop-command-guard` after imports :28.
Before **acquiring the Windows lock** replace :476 with:

```ts
  const preliminary = parseServiceArgs(filteredArgs);
  if (preliminary.invalid.length === 0) {
    const refusal = desktopServiceCommandRefusal(preliminary.sub);
    if (refusal) {
      console.error(refusal);
      process.exitCode = 1;
      return;
    }
  }
```

A bare service command parses to install (:41-42); that is guarded even if the under-lock
read later selects repair. Status/stop/uninstall/remove/claim do not invoke the inspector.
Keep invalid-option handling and backend validation in the current planner; do not mutate
or promote readiness on a refusal. Use the existing `process.exitCode = 1; return` convention
(:223, :255, :359), which releases locks normally and works for tray callers.

At :233, immediately after `const { parsed, command } = plan;`, insert the same fresh refusal
block, calling `desktopServiceCommandRefusal(command)` instead of `preliminary.sub`.
This second check is after waiting for a lock, before environment assertions, registration,
stop, serving reports, star prompt or owner release. Preserve all durable-owner checks.
The lower-level checks below cover programmatic install/repair and the staging entry point.

### MODIFY `src/service/orchestration.ts`

Import `assertNoDesktopSupervision` and `type SupervisionInspector` from
`./desktop-command-guard` beside :13. Add `inspectSupervision?: SupervisionInspector;` to
`ServiceInstallPreparationDeps` (:232-237) and `FreshWindowsSchedulerInstallDeps` (:286-302).

Anchor: `prepareServiceInstall` :244-275. Before :248 `const diagnostic = ...`, insert:

```ts
  assertNoDesktopSupervision(deps.inspectSupervision);
```

`installServiceSafely` :277-284 already awaits this preparation before `install()`; no duplicate
wrapper change is needed. It must never call manager.stop, stopTrackedProxy or install on refusal.

Anchor: `installFreshWindowsSchedulerSafely` :312-401. Insert the same assertion as its first
statement, before :315 `const stage = ...`, :343 randomUUID and :348 `stage(attemptNonce)`.
A check only in `prepare()` (:364) is too late: temporary XML and OS registration already exist.
In the default preparation closure at :318, replace:

```ts
  const prepare = deps.prepare ?? (() => prepareServiceInstall("scheduler"));
```

with:

```ts
  const prepare = deps.prepare ?? (() => prepareServiceInstall("scheduler", { inspectSupervision: deps.inspectSupervision }));
```

The second read before manager cleanup remains useful after a UAC wait. Existing attempt-owned
rollback applies if Desktop appears after registration; the guarantee is no mutation when evidence
is already desktop at entry, not an impossible atomic freeze of process ancestry across UAC.
Windows production evidence is unsupported; an injected desktop result tests guard placement
before Windows staging and protects the seam if Windows support is added later.

### MODIFY `src/service/repair.ts`

Anchor: `RepairServiceDeps` :25-67, `repairService` :150-383. Add the same guard/type import and
`inspectSupervision?: SupervisionInspector;` to the dependency interface. Insert as the first
statement of repairService, before :151 `const diagnose = ...`:

```ts
  assertNoDesktopSupervision(deps.inspectSupervision);
```

Both verb repair and restart pass here (:47). Refusal precedes diagnosis, assertions, native
WinSW writes (:185), scheduler staging/refresh, launchd/systemd mutation and state publication.
Existing foreign/unknown durable-owner refusals :169-175 remain intact. A verified supervisor
gets the new message even when the stale registration says absent; an absent service with
non-desktop supervision keeps its current diagnostic.

### MODIFY `src/update/runtime-ownership.mjs`

Anchor: `planUpdateRuntimeHandling` :40-76. Replace its signature and prepend one decision:

```js
export function planUpdateRuntimeHandling({ ownership, ownershipUnknown = false, serviceInstalled, supervision }) {
  if (supervision?.kind === "desktop") {
    return {
      mayReplacePackage: false,
      mayStopRuntime: false,
      mayRestoreService: false,
      notice: "OpenCodex Desktop runs this proxy from its own bundle; use the app's updater (tray → Check for Updates). "
        + "This npm/Bun install was left unchanged; quit OpenCodex first to update it.",
    };
  }
```

Keep the entire existing ownershipUnknown/foreign-owner/default body after this block. The
new notice has precedence over stale/unknown durable metadata when supervision is verified.
Replace the input JSDoc at :37 with this exact declaration (no new runtime import):

```js
 * @param {{ ownership: { owner: string, installId: string, consentGeneration: number } | null, ownershipUnknown?: boolean, serviceInstalled: boolean, supervision?: ReturnType<typeof import('../service/desktop-supervision.mjs').inspectDesktopSupervision> }} input
```

The planner stays pure and cannot probe the user's home.
Replace the explanatory paragraph :24-27 (stale marker) with:

> Durable ownership and live supervision are separate. A verified Desktop supervisor denies
> replacement, stop and service restoration even without a claim. Unknown supervision does
> not create a veto; unknown durable ownership still does. A stale durable claim keeps its
> existing recovery through explicit service install after Desktop has quit.

Failure-recovery hole: `planStoppedRuntimeRecovery` :78-98 otherwise authorizes a direct spawn
on dead liveness without rechecking supervision. Add `supervision,` after its destructured
`stopAttempted,` (:79), then insert **after** the existing `if (!stopAttempted)` (:89):

```js
  if (supervision?.kind === "desktop") return { action: "none", reason: "desktop-supervised" };
```

This is a required expansion within the same assigned planner file: all failure recoveries
also honor accepted D5. Do not change unknown/unsupported recovery or sameOwner semantics.

### MODIFY `src/update/runtime-ownership.d.mts`

Anchor: `planUpdateRuntimeHandling` :1-10 and `planStoppedRuntimeRecovery` :12-26.
At file top add this type import (no dependency on PR A's chosen type-export name):

```ts
import type { inspectDesktopSupervision } from "../service/desktop-supervision.mjs";
```

Inside both input object declarations add:

```ts
  supervision?: ReturnType<typeof inspectDesktopSupervision>;
```

Returned flags and the existing string recovery reason need no changes. The optional input
preserves existing callers/tests. Do not add process probing to this declaration or planner.

### MODIFY `bin/ocx.mjs`

Anchor: `runPackageManagerSelfUpdate` :195-872; import block :11-58. Add:

```js
import { inspectDesktopSupervision } from "../src/service/desktop-supervision.mjs";
```

For **each** exact production call below insert `supervision: inspectDesktopSupervision(),`
inside its object argument (fresh call per boundary; never one invocation-wide cached value):

| Current anchor | Before | After |
|---|---|---|
| initial plan :327 | `{ ...initialOwnership, serviceInstalled: serviceWasInstalled }` | `{ ...initialOwnership, serviceInstalled: serviceWasInstalled, supervision: inspectDesktopSupervision() }` |
| failed refresh/direct fallback :538 | `{ ...readOwnership(), serviceInstalled: true }` | `{ ...readOwnership(), serviceInstalled: true, supervision: inspectDesktopSupervision() }` |
| under-lease stop authorization :577 | `{ ...lockedOwnership, serviceInstalled: serviceWasInstalled }` | `{ ...lockedOwnership, serviceInstalled: serviceWasInstalled, supervision: inspectDesktopSupervision() }` |
| pre-replacement authorization :725 | `{ ...replacementOwnership, serviceInstalled: serviceWasInstalled }` | `{ ...replacementOwnership, serviceInstalled: serviceWasInstalled, supervision: inspectDesktopSupervision() }` |
| post-install restoration :832 | `{ ...readOwnership(), serviceInstalled: serviceWasInstalled }` | `{ ...readOwnership(), serviceInstalled: serviceWasInstalled, supervision: inspectDesktopSupervision() }` |

In `recoverStoppedRuntimeAfterFailure`/`planRecovery` :611-627, at :617's
`planStoppedRuntimeRecovery({` add the same field. After :638-639's ownership-transferred
branch insert, before the runtime-liveness branch:

```js
      } else if (recovery.reason === "desktop-supervised") {
        console.log("OpenCodex Desktop supervises the proxy; no CLI runtime was restored.");
```

Replace the inaccurate refusal line :330:

```js
    console.error("opencodex: update stopped before tray handoff, runtime stop, or package replacement because runtime ownership is unknown.");
```

with:

```js
    console.error("opencodex: update stopped before tray handoff, runtime stop, or package replacement because runtime authority does not permit it.");
```

Keep :328 notice printing and :331 exit 1. In the failed-refresh/direct-fallback boundary only,
use one **fresh local** sample so post-replacement messaging does not claim package files were
unchanged. Replace :538-540 with this exact block (supersedes that one table row above):

```js
        const fallbackSupervision = inspectDesktopSupervision();
        const nowOwned = planUpdateRuntimeHandling({ ...readOwnership(), serviceInstalled: true, supervision: fallbackSupervision });
        if (!nowOwned.mayStopRuntime) {
          console.warn(fallbackSupervision.kind === "desktop"
            ? "OpenCodex Desktop supervises the proxy; CLI recovery was skipped. Use the app's updater (tray → Check for Updates)."
            : nowOwned.notice ?? "opencodex: the background runtime is owned elsewhere; not starting a second proxy.");
```

Retain the existing return and closing brace :541-542. This local sample is taken immediately
at this boundary, not cached from preflight. Existing integrity/cache metadata work before the
initial plan is retained; these guards protect package/runtime/service mutation, not every
preflight read or npm cache diagnostic. No Bun resolution change belongs in this PR.
The locked gate exits with the lease released; post-stop gate uses existing recovery.

### MODIFY `src/update/index.ts`

Anchor: `runUpdate` :409-938; imports :1-45. Add:

```ts
import { inspectDesktopSupervision } from "../service/desktop-supervision.mjs";
```

Insert `supervision: inspectDesktopSupervision(),` in all four `planUpdateRuntimeHandling`
object arguments: initial :488-491, replacement :708-711, post-install :786-789, failed
refresh fallback :892-895. Also insert the same field in both `planStoppedRuntimeRecovery`
objects: :576-580 (`planRecovery`) and :604-608 (unleased service recovery fallback).
This is an exact insertion, not replacement of the existing ownership, liveness or lease inputs.

Replace :494 with:

```ts
    console.error("⚠️  Update stopped before tray handoff, runtime stop, or package replacement because runtime authority does not permit it.");
```

Keep :492 notice and :495 return 1. Replace the contradicted comment :704-706 with:

```ts
  // Re-read durable ownership and live supervision before package replacement.
  // A verified Desktop supervisor or foreign/unknown owner vetoes replacement.
  // Unknown supervision alone preserves the existing ownership/liveness decision.
```

At :591's recovery classification, prepend (before manual/service/direct handling):

```ts
      if (recovery.reason === "desktop-supervised") {
        console.log("OpenCodex Desktop supervises the proxy; no CLI runtime was restored.");
      } else if (recovery.action === "manual") {
```

The remaining current `if (recovery.action === "manual")` body is retained as that else-if.
At the failed-refresh/direct-fallback boundary, replace :892-897 with this exact block
(supersedes the literal `supervision: inspectDesktopSupervision()` insertion at this one site):

```ts
            const fallbackOwnership = await resolvedRuntimeOwnership();
            const fallbackSupervision = inspectDesktopSupervision();
            const nowOwned = planUpdateRuntimeHandling({
              ...fallbackOwnership,
              serviceInstalled: true,
              supervision: fallbackSupervision,
            });
            if (!nowOwned.mayStopRuntime) {
              console.warn(fallbackSupervision.kind === "desktop"
                ? "OpenCodex Desktop supervises the proxy; CLI recovery was skipped. Use the app's updater (tray → Check for Updates)."
                : nowOwned.notice ?? "⚠️  The background runtime is owned elsewhere; not starting a second proxy.");
```

Retain existing return/closing brace :898-899. This is a fresh boundary-local sample and avoids
claiming a completed package update was left unchanged. Recovery/direct fallback now cannot
revive a CLI runtime beside a verified Desktop child.
Already-latest/source/mise early returns keep today's behavior; no false claim that a package
was changed. The command's replacement path refuses even an idle, unrelated npm install.

### MODIFY `src/update/restart-ownership.ts`

Anchor: `updateRestartVeto` :25-37; lease coordinator :78-128. Add inspector import and type:

```ts
import { inspectDesktopSupervision } from "../service/desktop-supervision.mjs";
type SupervisionInspector = () => ReturnType<typeof inspectDesktopSupervision>;
```

Replace the signature :25-27 with:

```ts
export function updateRestartVeto(
  resolve: () => ServiceOwnershipResolution = resolveServiceOwnership,
  inspect: SupervisionInspector = inspectDesktopSupervision,
): string | null {
```

Add `supervision: inspect(),` to :29-34's planner object. Keep `mayStopRuntime` and notice return.
Add an optional third argument to `runUpdateRestartWithOwnershipLease` after `restart` :80:

```ts
  inspect: SupervisionInspector = inspectDesktopSupervision,
```

Replace **all three** existing calls (:110, :114, :122) `updateRestartVeto(resolve)` with
`updateRestartVeto(resolve, inspect)`. This binds initial veto, under-lease direct fallback,
and vetoAgain to fresh evidence; the default production job caller stays unchanged.
No `src/update/job.ts` change: its existing `outcome.kind === "veto"` projects `restarted:false`.

### NEW `src/cli/desktop-runtime-guidance.ts`

Exact new code; presentation and restart coordination stay outside the nearly-full entrypoint:

```ts
import { inspectDesktopSupervision } from "../service/desktop-supervision.mjs";
import type { DesktopSupervision, SupervisionInspector } from "../service/desktop-command-guard";
import { planUpdateRuntimeHandling } from "../update/runtime-ownership.mjs";
import { UpdateRestartRequired } from "./update-restart-candidate";
import { runProxyRestart, type ProxyRestartIo, type ProxyRestartLive } from "./tray-proxy";

function desktopForTarget(evidence: DesktopSupervision, pid: number | null | undefined): boolean {
  return evidence.kind === "desktop" && pid != null && evidence.runtimePid === pid;
}

export function duplicateRuntimeMessage(
  pid: number | null | undefined,
  port: number,
  inspect: SupervisionInspector = inspectDesktopSupervision,
): string {
  const evidence = inspect();
  if (evidence.kind === "desktop" && desktopForTarget(evidence, pid)) {
    return `OpenCodex Desktop supervises the running proxy (pid ${evidence.runtimePid}, ${evidence.app}, port ${port}). `
      + "Use the running proxy, or quit OpenCodex before starting it from this CLI.";
  }
  return `⚠️  Proxy already running (PID ${pid ?? "unknown"}, port ${port}). Use 'ocx stop' first.`;
}

export function desktopStopNotice(evidence: DesktopSupervision): string | null {
  return evidence.kind === "desktop"
    ? "OpenCodex Desktop will restart this proxy after its backoff. Use Stop proxy or Quit in the tray to keep it stopped."
    : null;
}

export function runDesktopAwareProxyRestart(
  io: ProxyRestartIo,
  inspect: SupervisionInspector = inspectDesktopSupervision,
  info: (line: string) => void = console.log,
) {
  let desktopTarget: ProxyRestartLive | null = null;
  return runProxyRestart({
    ...io,
    requestInPlaceRestart: async previous => {
      const evidence = inspect();
      if (desktopForTarget(evidence, previous.pid)) desktopTarget = previous;
      const result = await io.requestInPlaceRestart(previous);
      if (desktopTarget && result.accepted) {
        info("Restart requested; OpenCodex Desktop starts the replacement.");
      }
      if (desktopTarget && !result.accepted && !result.uncertain && result.error instanceof UpdateRestartRequired) {
        const notice = planUpdateRuntimeHandling({ ownership: null, serviceInstalled: false, supervision: evidence }).notice!;
        info(notice);
        return { accepted: false as const, uncertain: false, error: new Error("restart_desktop_update_required") };
      }
      return result;
    },
    startWhenStopped: async recovering => {
      // Retain the known supervisor through the temporary absence during its handoff.
      // `skipped` on recovery is a replacement failure, never an unconfirmed success.
      if (desktopTarget || inspect().kind === "desktop") return { status: "skipped" as const };
      return io.startWhenStopped(recovering);
    },
  });
}
```

This wrapper retains authentication, PID/port attestation, deadlines, uncertainty and health
confirmation. The notice means request accepted, not replacement healthy. It prevents the
existing generic recovery-start path (`tray-proxy.ts:391-395`) from starting an npm process
while a known Desktop child is temporarily absent. A fresh desktop result also refuses a
fallback when supervision appeared only after the original request. A miss after an accepted
request remains nonzero at index.ts:959.
For differing CLI/bundle versions, preserve the current skew refusal. A newer CLI's
UpdateRestartRequired prints actionable app-updater guidance before returning a closed refusal
code (`restart_desktop_update_required`), and never enters the package-restart fallback. The
existing sanitized failure reporter prints its generic request failure; it does not echo arbitrary
Error.message text, so printing the guidance here is required. Do not bypass the version/attestation guard or promise a version update by restarting.
Older CLI skew remains the current refusal; wp3 adds the lifecycle skew notice.

### MODIFY `src/cli/index.ts` (net growth 0; maximum allowed +5)

Anchor: import `runProxyRestart` :88; `chooseListenPort` duplicate refusal :332;
`handleStart` decision :435-448; `handleProxyRestart` :927-960.
Remove :88's import-list member `runProxyRestart,` and add one import line:

```ts
import { duplicateRuntimeMessage, runDesktopAwareProxyRestart } from "./desktop-runtime-guidance";
```

Replace only these existing lines, one-for-one:

```ts
// chooseListenPort :332 BEFORE
console.error(`⚠️  Proxy already running (PID ${holder?.pid ?? "unknown"}, port ${preferred}). Use 'ocx stop' first.`);
// AFTER
console.error(duplicateRuntimeMessage(holder?.pid, preferred));

// handleStart :447 BEFORE
console.error(`⚠️  Proxy already running (PID ${owner.live.pid ?? owner.pidSnapshot ?? "unknown"}, port ${owner.live.port}). Use 'ocx stop' first.`);
// AFTER
console.error(duplicateRuntimeMessage(owner.live.pid ?? owner.pidSnapshot, owner.live.port));

// handleProxyRestart :931 BEFORE
const result = await runProxyRestart({
// AFTER
const result = await runDesktopAwareProxyRestart({
```

No stop helper is inserted in the entrypoint; the parsed JSON decision belongs to dispatch.
No changes to `decideStartWithLiveOwner` in dispatch :1018-1033: await-parent, service-stay-out,
sibling and refusal ordering remain unchanged. Service wrappers retain their existing message
and exit code. A requested different-port sibling is not blanket-blocked by Desktop evidence.

### MODIFY `src/cli/dispatch.ts`

Anchor: imports :34-39, `CliDispatchDeps` :41-65, stop runner :105-140.
Add imports:

```ts
import { inspectDesktopSupervision } from "../service/desktop-supervision.mjs";
import { desktopStopNotice } from "./desktop-runtime-guidance";
```

Add optional dependency inside CliDispatchDeps:

```ts
  inspectDesktopSupervision?: typeof inspectDesktopSupervision;
```

At :114, within `if (!parsed.json) {`, before :115's comment insert:

```ts
      const notice = desktopStopNotice((deps.inspectDesktopSupervision ?? inspectDesktopSupervision)());
      if (notice) console.error(notice);
```

Capture before `handleStop` removes pid/state. Always keep stop behavior and exit codes;
the notice is useful even if respawn makes the existing stop verification fail. JSON mode
invokes neither inspector nor this notice; existing JSON stdout and unrelated stderr remain.
No notice from handleStopUnlocked, so Desktop's runtime_stop.rs `stop --json` stays clean.

### MODIFY `src/cli/update-restart.ts`

Anchor: `UpdateRestartIo` :24-38, eligibility reasons :39-41, `runUpdateRestart` revalidate :74-93,
`describeUpdateRestartFailure` :144-159, `restartFromCurrentInstallation` :210-260.
Add inspector import. Add optional `inspectSupervision?: typeof inspectDesktopSupervision;`
to UpdateRestartIo (existing setup mocks stay compatible). Append `"desktop"` to
ELIGIBILITY_REASONS. Before :82's `try { if (!io.standalone(...)) ... }`, insert:

```ts
      const supervision = (io.inspectSupervision ?? inspectDesktopSupervision)();
      if (supervision.kind === "desktop" && supervision.runtimePid === candidate.target.pid) {
        eligibilityReason = "desktop";
        throw new UpdateRestartEligibilityError("desktop");
      }
```

This revalidate runs initially and immediately before the guarded stop transport. Do not
rewrite the existing :198-205 ps/orphan eligibility path or relax it for unknown supervision.
In describeUpdateRestartFailure's reason switch, before `case "service"` :150 add:

```ts
        case "desktop": return "OpenCodex Desktop supervises this proxy. Use the app's updater (tray → Check for Updates), or quit OpenCodex before updating and restarting from this CLI.";
```

Existing suffix says nothing was stopped. Same-pid Desktop is blocked; a supervisor of another
pid does not select this reason, and ordinary standalone/service checks still apply.
This protects direct programmatic use as well as the newer-CLI fallback intercepted above.

## Focused regression packet — C-ACTIVATION-GROUNDING-01

All four assigned test files exist. Tests add cases in these existing files; no new test file,
layout.json or test-layout-expected.json entry is needed. Exact new source above is the
implementation prescription; the following test names, fixtures, entrypoints and observable
assertions are the mandatory test changes. A source-text assertion alone is insufficient.
Every injected result uses the real PR A result shape; no production env bypass is introduced.

Fixture for all direct-module tests (local object, not a file in the user's home):

```ts
const supervision = { kind: "desktop", runtimePid: 4242, supervisorPid: 4200,
  app: "/Applications/OpenCodex.app/Contents/MacOS/opencodex-desktop",
  proxy: "/Applications/OpenCodex.app/Contents/MacOS/ocx" } as const;
const nonDesktop = [{kind:"none"}, {kind:"unknown", reason:"probe-timeout"}, {kind:"unsupported"}] as const;
```

### MODIFY `tests/service/service-ownership-handover.test.ts`

Verified seams: existing `repairService` dependency record :29-40 and :92-99; INSTALLED :17-20;
source binding tests :113-146. Import new service guard helpers and orchestration functions.
Append a describe after :146; existing passing fixtures explicitly inject
`inspectSupervision: () => ({kind:"none"})` so no real parentage read determines a unit test.

| Exact test name | Activation and injected dependencies | Observable assertion |
|---|---|---|
| `live Desktop supervision refuses every activating service verb before CLI mutation` | desktopServiceCommandRefusal for install/repair/start/restart; inspector counter; simulate dispatcher refusal before a mutation recorder | exact full refusal, runtime pid/app, no recorder event; verify source CLI binding is before Windows lock and actual plan dispatch |
| `deactivating and identity service verbs do not probe Desktop supervision` | stop/status/uninstall/remove/claim; inspector throws if called | all return null, zero probes; existing owner-release tests stay unchanged |
| `repair and restart refuse live supervision even without a durable claim` | repairService with verbs repair/restart, platform darwin/linux and injected Windows native/scheduler cases, desktop evidence, readOwnership none; diagnose/assert/write/repair/stop/start spies | rejection equals exact refusal; all spies including diagnose remain untouched |
| `safe install stops before cleanup and installation under live Desktop supervision` | installServiceSafely with desktop inspect and managerOps/diagnose/stopTrackedProxy/install event spies | reject before every event; prepareServiceInstall direct call also rejects |
| `fresh Windows install refuses before registration XML staging` | installFreshWindowsSchedulerSafely with desktop inspect; every FreshWindowsSchedulerInstallDeps callback records events | rejection; events empty including stageRegistrationXml, register, recordOwnership, removeStagedXml, rollback and assets; no temporary path created |
| `unknown unsupported and absent supervision retain service preparation and repair` | each nonDesktop result, NONE/CLI durable claim, fake darwin manager and repairLaunchd | prepare events retain status/stop/tracked/install order; repair executes once; no new refusal |
| `a fresh Windows install rechecks supervision after registration before cleanup` | injected inspect sequence none then desktop, default prepare closure, fake staging/register/state callbacks | allowed initial staging; second probe rejects before manager cleanup/assets/runTask; attempt-owned rollback runs, no service starts |

For CLI binding use repoPath/source positions, supplementing executed guard+orchestration tests,
not replacing them. Do not invoke serviceCommand against the real OS manager. Exit 1 convention
is pinned at both injected refusal branches and the entrypoint source binding; no process.exit mock
may leak into the shared Bun process. Existing uninstalled diagnostic test :104 remains unchanged
in expectation with a none inspector: durable Desktop alone still reports not installed first.

### MODIFY `tests/update/update-desktop-owner.test.ts`

Verified seam: direct pure planner import :14-18; tests :22-62 and stopped recovery :65-104;
source guards :165-273. Add imports for updateRestartVeto and lease coordinator; append tests
before the source-wiring describe :165. Existing fixture tests keep optional input absent.

| Exact test name | Activation | Observable assertion |
|---|---|---|
| `live Desktop supervision denies replacement stop and service restoration without a claim` | desktop, ownership null and CLI-owned; serviceInstalled true/false | exact three false flags and full requested notice, no install id required |
| `Desktop supervision takes notice precedence over unreadable durable ownership` | desktop plus ownershipUnknown true | Desktop notice; flags false; unknown durable owner without supervision still refuses with its prior notice |
| `unknown unsupported absent and omitted supervision retain the existing update decision` | each nonDesktop and omitted, null/CLI/foreign/unknown durable ownership | equals same planner result with supervision omitted, for both serviceInstalled values |
| `a separate npm install is left unchanged while Desktop supervises the proxy` | null ownership, serviceInstalled false, desktop | mayReplacePackage false; simulated package/stop/restore callbacks remain untouched |
| `failed update recovery never starts a CLI proxy beside Desktop supervision` | existing recovery base :66, desktop, stopped true, dead liveness, serviceInstalled true/false | action none/reason desktop-supervised; nonDesktop result equals existing direct/service outcomes; stopped false keeps not-stopped |
| `dashboard restart veto observes live supervision without changing durable ownership` | updateRestartVeto(() => NONE, () => desktop), then each nonDesktop | exact Desktop notice or null; durable foreign/unknown owner remains vetoed independently |
| `Desktop appearing between update boundaries changes the next fresh decision` | inspector sequence none then desktop, invoke planner gate twice | first permits; second refuses; second mutation recorder remains empty (stop/replace/direct fallback phases table) |

Add wiring test `all Node Bun and dashboard update boundaries pass fresh supervision` after :273:
read through repoPath, inspect **each** five Node/four Bun planner calls and Node one/Bun two
recovery calls for the field, plus restart veto :29 and all lease calls. Pin no invocation-wide
cached supervision; the two fallbackSupervision locals must be freshly assigned immediately
before their own boundary (after any awaited ownership read on the Bun path). For each initial/locked/replacement/post-install/fallback production gate,
use the actual gate's extracted block in a node:vm context with planner+inspector and side-effect
recorders (no launcher subprocess, no package manager). Assert desktop takes its return/exit
before stop/tray/package/service callbacks; nonDesktop reaches the same previous branch.
The pure tests prove policy; these isolated production-block tests prove caller activation and
observable mutation ordering. An injected exit throws a sentinel caught only by the harness.
Do not claim this is a full npm/Bun update integration test.

### MODIFY `tests/cli/cli-stop-json.test.ts`

Verified seams: stopDeps :174-177 supplies CliDispatchDeps; captureConsole :157-172;
withExitCode :31-36 restores `previousExitCode ?? 0`. Extend stopDeps with optional inspector
argument and add it to the returned deps; default to `() => ({kind:"none"})`. Add tests beside
:228's ordinary-stop case; existing JSON/approval/79/80 cases stay intact.

| Exact test name | Activation | Observable assertion |
|---|---|---|
| `ordinary stop warns on stderr that Desktop will restart after backoff` | injected desktop; handleStop records and returns existing successful summary | inspector before handleStop; stop runs once; stderr exact Desktop notice; stdout existing human output; exit unchanged |
| `Desktop stop --json never probes or emits supervision guidance` | inspector throws if called; existing summary and handleStop fixture | exactly one original JSON summary; no Desktop notice on stdout/stderr; stop called once; exit 0/1/79/80 unchanged |
| `non-Desktop stop retains existing output and behavior` | each nonDesktop evidence | no notice, same stdout downtime line, same handleStop count and result |
| `Desktop supervision notice remains useful when stop detects a respawn` | desktop plus existing respawned summary/exit 1 | notice on stderr; original failure summary/runtimeDown false; no success fabricated |

### MODIFY `tests/cli/cli-restart-health.test.ts`

Verified: :64-126 runCli has subprocess injection for the harness, not restart dependency
injection; :128-153 owns isolated temp homes; :256-287 only restart help cases. Do not pretend
runCli can inject supervision into a real subprocess. Add direct-module imports and a new
injected describe after EOF :389 using runDesktopAwareProxyRestart/duplicateRuntimeMessage
and ProxyRestartIo. Keep the current isolated subprocess/help/health tests intact.

| Exact test name | Activation | Observable assertion |
|---|---|---|
| `duplicate start guidance names the verified Desktop target` | helper target pid 4242/port 10100, desktop inspector; NONE/unknown/unsupported/different pid/null pid variants | Desktop app/pid and Quit guidance only for same pid; all other variants equal exact old duplicate message |
| `Desktop restart reports its replacement only after request acceptance` | ProxyRestartIo live 4242, request accepted, replacement pid 4243 same port, desktop inspector, info recorder | exact requested sentence once after request; result ok/restarted; no startWhenStopped callback |
| `Desktop restart misses never start a competing CLI runtime` | accepted request; replacement null; reobserve absent; desktop was present before request but subsequent evidence none | result failure/replacement; zero direct/service start events; captured supervisor survives temporary absence |
| `Desktop appearing before a restart fallback prevents CLI activation` | original inspector none, accepted request, replacement miss/absence, fallback inspector desktop | zero start callback events, result failure/replacement; original request gets no Desktop acceptance sentence |
| `Desktop restart refusal and uncertain response do not claim acceptance` | rejected or uncertain request; wait/reobserve fake outcomes | no requested sentence; existing uncertainty behavior; no fallback spawn |
| `newer CLI does not replace a supervised Desktop target` | request returns UpdateRestartRequired with synthetic candidate and desktop matching pid | result failure/request with restart_desktop_update_required; info recorder contains app-updater notice; no current-install restart callback/spawn and no acceptance sentence |
| `non-Desktop restart retains generic recovery and target decisions` | each nonDesktop and desktop of different pid | ordinary runProxyRestart behavior including accepted+absent recovery callback; no Desktop sentence |

Keep dispatch's decideStartWithLiveOwner unchanged and run the existing cli-dispatch tests
(:421-434 exact-parent, null-pid, sibling and service sentinel cases) as the start decision gate.
Add source binding assertions for index.ts helper calls and the two original duplicate-refusal
anchors; tests execute the helper branch rather than relying only on text matching.

### MODIFY `tests/cli/cli-update-restart.test.ts`

Required narrow expansion: this existing file exercises the actual destructive update-restart
transaction, whereas cli-restart-health's subprocess harness cannot inject that IO.
Verified setup :13-28 returns calls/io/live; revalidate tests :59 onward; no new fixture file.
Set setup io.inspectSupervision to none and append these named cases:

- `Desktop target refuses update restart before the guarded stop`: desktop same pid as candidate;
  result false/reason desktop, only acquire/release events; stop/start/observe absent; failure
  guidance names app updater and says nothing stopped.
- `Desktop appearing during attestation vetoes the final stop revalidation`: inspector none then
  desktop; setup io.stop calls revalidate before pushing stop; no stop/start; reason desktop.
- `unknown unsupported and unrelated Desktop target retain update restart eligibility`: each
  nonDesktop and desktop runtimePid different from candidate; all existing setup success events
  retained. Mock standalone remains true here; platform/orphan eligibility is not weakened.

### MODIFY `tests/update/update-restart-lease.test.ts`

Required narrow expansion: its existing sandbox :89-115 and lease-coordinator callers :492,
:549, :596, :646, :695 and :722 exercise the actual lease/reacquire protocol. Reuse the sandbox
and pass the new third inspector argument in two new cases; no new environment or process-parent
fake is needed.

- `live Desktop supervision vetoes the dashboard worker before its restart callback`: third
  inspector returns desktop, resolver returns unowned; expect kind veto and exact notice,
  restart callback event list empty, lease released and environment delegation restored.
- `Desktop appearing during service refresh vetoes direct fallback under the reacquired lease`:
  inspector sequence none then desktop; callback releases for manager, calls vetoAgain and
  reacquireForDirectStart using existing lease controls; expect both to return the notice,
  direct-start event absent, final lease released. Use a stable desktop result after the second
  read, so each fresh check remains grounded rather than running out of fixture values.

## Structure and user-documentation synchronization

MODIFY `structure/runtime.md`, anchor `## Background-service runtime ownership` :540,
replace :577-588 (12 lines) with these **12 lines**, preserving :589 onward. This doc is already
at the independent 600-line structure budget; do not append lines or raise the budget.

```md
Activating service verbs retain their foreign/unknown durable-owner refusals.
Verified Desktop supervision separately refuses install, repair, start and restart before
mutation, including Windows registration staging; quitting Desktop removes this live veto.
`src/service/desktop-command-guard.ts` shares this service decision. Stop and uninstall stay available.
`src/update/runtime-ownership.mjs` denies package replacement, stop and service restoration
under verified supervision, even for an unrelated npm install, and preserves unknown-supervision behavior.
Unknown durable ownership still denies all three. Node and Bun updater gates, failure recovery
and the dashboard restart veto re-read supervision at their mutation boundaries.
`src/cli/desktop-runtime-guidance.ts` names the supervisor for duplicate starts and accepted restarts;
ordinary stop warns on stderr, while stop --json skips the probe and notice. Desktop starts its replacement.
Both package updaters use `src/service/install-state-contract.mjs` and the full-record authority selector.
One mutation lease still covers fresh authorization, stop, runtime re-read and package replacement.
```

MODIFY `structure/desktop-shell.md`, anchor `Keeping the runtime alive`, replace :288-290's
three lines (beginning “previously wanted runtime”) with these five lines:

```md
previously wanted runtime, but never turns a completed tray Stop back on. A terminal
`ocx stop` of the runtime this app started clears nothing, so the app starts it again after
backoff; the CLI warns on stderr and suppresses that notice for `stop --json`, which the app uses.
The tray's Stop and Quit keep it stopped. An accepted CLI restart says Desktop starts the replacement,
and the CLI never launches its own recovery replacement for a known supervised child.
```

At `Runtime ownership, from the app's side` :297, insert after the heading:

```md
Live supervision is separate from the consented durable claim. The CLI's verified process evidence
blocks competing service activation and package updates without recording ownership. Unknown or
unsupported supervision retains the prior CLI behavior; see [runtime ownership](runtime.md#background-service-runtime-ownership).
```

MODIFY `structure/ops/service-and-sidecars.md`, anchor `Bun updater ownership transaction` :360,
insert after :369's recovery paragraph:

```md
Live supervision is re-read separately from durable ownership at every stop, package replacement,
service restoration and direct recovery decision. `src/update/runtime-ownership.mjs` refuses all
three update authorities and failed-update recovery only for verified Desktop supervision;
unknown/unsupported supervision preserves the existing owner/liveness guards. Service install,
repair, start and restart refuse before mutation, with the fresh Windows guard before XML staging.
```

Update :390's phrase “re-runs the recorded-owner veto under it” to “re-runs the durable-owner and
live-supervision veto under it”. Do not overwrite the wp2 startup-diagnostics paragraph :536;
PR B links its existing evidence contract and adds the command consequences above.

MODIFY `structure/cli-management.md`, anchor `Head and help navigation` :9. Insert before it:

```md
`src/cli/desktop-runtime-guidance.ts` reports verified Desktop supervision for duplicate starts and
accepted restart requests. Ordinary stop prints its backoff/tray guidance to stderr; `stop --json`
does not probe or print this guidance. Lifecycle decisions, attestation and exit codes remain authoritative.
```

Mapped-doc review: src/cli also maps to config.md, local-messaging.md, clients/integrations.md,
clients/chatgpt-desktop.md, clients/claude-desktop.md and ops/docs-and-release.md. Their configuration,
client integration, transport and package-transaction contracts are unchanged; review these owners,
record unchanged disposition, do not copy the guard prose. bin/ maps to runtime.md and
ops/docs-and-release.md; the latter's staged package verification/swap contract is unchanged.
No new source area: both new leaves live in already mapped src/service/ and src/cli/;
structure/manifest.json and generated INDEX.md need no ownership edit/regeneration.

MODIFY `docs-site/src/content/docs/guides/desktop-app.md`, anchor `Keeping the proxy running`
:113, replace the existing :120-121 two-line crash/terminal-stop explanation with:

```md
crash, or `ocx stop` from a terminal), the app starts it again after a short delay that grows from
3 to 30 seconds while the proxy keeps failing. The terminal stop prints this reminder on stderr;
`ocx stop --json` keeps the same stop behavior without that reminder. Use **Stop proxy** or **Quit**
in the tray to keep it stopped. An accepted `ocx restart` reports that Desktop starts the replacement.
```

Insert before `## Updates` :169:

```md
## CLI commands while Desktop runs the proxy

On macOS and Linux, when the CLI verifies that Desktop supervises the running proxy,
`ocx service install`, `repair`, `start`, and `restart` refuse before changing the service.
Quit OpenCodex, then run `ocx service install` to move startup management to the CLI.
`ocx start` names the existing Desktop supervisor instead of suggesting a terminal stop.
`ocx update` also leaves the npm/Bun install unchanged, even if it is a separate installation.
Use **Check for Updates…** in the tray for the app's bundle, or quit OpenCodex first to update
an npm/Bun install. A newer PATH CLI cannot replace the app's proxy through `ocx restart`.
These live-supervision guards are unavailable on Windows. An inconclusive supervision probe
preserves the previous command behavior; existing recorded-ownership guards still apply.
```

MODIFY `docs-site/src/content/docs/ko/guides/desktop-app.md`, insert before `## 업데이트` :61:

```md
## Desktop이 실행하는 프록시와 CLI

macOS와 Linux에서 CLI가 Desktop의 프록시 감독을 확인하면 `ocx service install`,
`repair`, `start`, `restart`는 서비스를 변경하기 전에 중단됩니다. CLI로 시작 관리를
옮기려면 OpenCodex를 종료한 뒤 `ocx service install`을 실행하세요. `ocx start`는 이미
실행 중인 Desktop 감독자를 표시합니다. `ocx update`도 별도로 설치한 npm/Bun 패키지를
그대로 둡니다. 앱 번들은 트레이의 **Check for Updates…**로 업데이트하고, npm/Bun 설치는
OpenCodex를 종료한 뒤 업데이트하세요. 더 최신인 PATH CLI도 `ocx restart`로 앱의 프록시를
자기 설치의 런타임으로 교체하지 않습니다.

터미널의 `ocx stop`은 프록시를 중지하지만 Desktop은 backoff 뒤에 다시 시작합니다.
계속 중지하려면 트레이의 **Stop proxy** 또는 **Quit**을 사용하세요. 일반 stop은 이 안내를
stderr에 표시하고 `ocx stop --json`은 안내 없이 같은 중지 경로를 실행합니다.
수락된 `ocx restart`는 Desktop이 교체 프록시를 시작한다고 알리며 교체 확인을 기다립니다.
Windows에서는 이 실행 중 감독 검사가 지원되지 않습니다. 검사 결과가 불확실하면 기존
동작을 유지하고, 기록된 소유권에 따른 기존 거부 검사는 계속 적용됩니다.
```

These paragraphs are intentionally pending behavior until PR B lands; wp2's startup-safety
paragraph edit is inherited and not re-decided here. No new locale contradiction is introduced.

## File-size evidence and growth budget

Read `tests/fixtures/file-size-baseline.json` and `scripts/file-size-ratchet.ts:4,105-125,182-195`.
All listed existing growth candidates have **no individual baseline.files entry** in this lane.
Scanned unbaselined paths must stay **below 2000**, so their maximum is 1999; caps never rise
(`Math.min` :188). Counts use the script's newline rule, not bytes. `.d.mts` has extension `.mts`,
absent from SCAN_EXTENSIONS :7-19, so it is not scanned (not a license for oversized declarations).
No baseline edit is planned. The stricter user constraint permits index.ts growth at most five.

| NEW/MODIFY path | Current lines | Effective ceiling | Headroom / planned bound |
|---|---:|---:|---|
| NEW src/service/desktop-command-guard.ts | 0 | 1999 | exact code above under 40 |
| MODIFY src/service/cli.ts | 485 | 1999 | 1514 |
| MODIFY src/service/orchestration.ts | 617 | 1999 | 1382 |
| MODIFY src/service/repair.ts | 383 | 1999 | 1616 |
| MODIFY src/update/runtime-ownership.mjs | 122 | 1999 | 1877 |
| MODIFY src/update/runtime-ownership.d.mts | 40 | not scanned | small two fields + type import |
| MODIFY bin/ocx.mjs | 1120 | 1999 | 879; coordinate wp3 imports/edits |
| MODIFY src/update/index.ts | 938 | 1999 | 1061 |
| MODIFY src/update/restart-ownership.ts | 128 | 1999 | 1871 |
| NEW src/cli/desktop-runtime-guidance.ts | 0 | 1999 | exact code above under 90 |
| MODIFY src/cli/index.ts | 1976 | 1999 | 23; specified patch net 0, hard task maximum +5 |
| MODIFY src/cli/dispatch.ts | 1175 | 1999 | 824 |
| MODIFY src/cli/update-restart.ts | 260 | 1999 | 1739 |
| MODIFY tests/service/service-ownership-handover.test.ts | 146 | 1999 | 1853 |
| MODIFY tests/update/update-desktop-owner.test.ts | 273 | 1999 | 1726 |
| MODIFY tests/cli/cli-stop-json.test.ts | 520 | 1999 | 1479 |
| MODIFY tests/cli/cli-restart-health.test.ts | 389 | 1999 | 1610 |
| MODIFY tests/cli/cli-update-restart.test.ts | 228 | 1999 | 1771 |
| MODIFY tests/update/update-restart-lease.test.ts | 869 | 1999 | 1130 |
| MODIFY structure/runtime.md | 600 | 600 structure / 1999 ratchet | 0 / 1399; exact equal-length replacement |
| MODIFY structure/desktop-shell.md | 545 | 600 structure / 1999 ratchet | 55 / 1454 |
| MODIFY structure/ops/service-and-sidecars.md | 538 | 600 structure / 1999 ratchet | 62 / 1461 |
| MODIFY structure/cli-management.md | 107 | 600 structure / 1999 ratchet | 493 / 1892 |
| MODIFY docs-site/src/content/docs/guides/desktop-app.md | 207 | 1999 | 1792 |
| MODIFY docs-site/src/content/docs/ko/guides/desktop-app.md | 85 | 1999 | 1914 |

The assigned devlog file is excluded by ratchet's devlog prefix (:21-27). All counts are pre-wp2;
PR A may consume structure/runtime's zero headroom or entrypoint lines. Recount at PR B build,
preserve this equal-length replacement and do not silently increase caps or write unassigned files.
If inherited edits prevent the bound, report expansion for an extraction before implementation.

## Verifiers (implementation phase only; not run by this worker)

From the lane checkout, exact focused command:

```sh
bun test tests/update/update-desktop-owner.test.ts tests/update/update-restart-lease.test.ts tests/service/service-ownership-handover.test.ts tests/cli/cli-stop-json.test.ts tests/cli/cli-restart-health.test.ts tests/cli/cli-update-restart.test.ts tests/cli/cli-dispatch.test.ts tests/cli/system-restart-client.test.ts tests/cli/system-restart-client-package-tree.test.ts
bun run typecheck
bun run structure:check
bun run privacy:scan
```

The last three CLI files exercise unchanged decision/attestation/package-fence contracts around
the new wrapper. Source-reading tests are explicitly listed because import-graph selection
cannot infer them. No full `bun run test` in this lane. Broad acceptance requires the parent's
exact-head hosted cross-platform/shard evidence, including Windows; unknown/skipped/cancelled/
old-head is not a pass. Record local scope/resource limit and hosted coverage in Verification.

Docs-site build, only in the implementation phase and without changing this worker's shell cwd:

```sh
bun run --cwd docs-site build
```

Use existing installed dependencies; do not install packages under this planning delegation.
If the parent authorizes a frozen install because dependencies are missing, record that separately.
Stage newly implemented leaves before the parent's structure gate because it resolves repo paths
through the git index; this worker must not stage anything. No structure:index command is needed
unless the parent deliberately changes manifest ownership. Parent handles PR creation/readiness.

## Risks and readiness

- Process evidence is a bounded observation, not a durable lease on Desktop or authority transfer.
  Recheck after waits and before each mutation; already-desktop entry refusal must precede even
  Windows XML staging. A Desktop launch after a permitted check remains a race, not an excuse to
  synthesize ownership. Existing mutation leases retain their independent role.
- Darwin double reads can cost multiple 750 ms probes. This is lifecycle command overhead only;
  no timers, hot-path imports into server request code or repeated per-request probes are added.
- Unknown supervision intentionally keeps existing behavior. Distinguish it from unknown durable
  ownership, which continues to block as before. Windows has no new production parentage guard.
- Updater notices claiming package unchanged are pre-replacement notices. A Desktop appearing
  after a completed package swap can veto restoration without undoing the completed update;
  print the existing “Updated” result and refusal as separate facts, never report a rollback.
- Generic restart recovery can race Desktop's backoff after an accepted restart; retain captured
  supervisor intent in the new wrapper so absence never earns a competing CLI start. Request
  wording is not health proof. Existing replacement timeout/failure exit stays authoritative.
- Newer-CLI update restart keeps its destructive eligibility gate. Same-version Desktop restart
  remains the existing protocol; version mismatch does not earn a bypass or current-install spawn.
- Tests use injected modules/isolated production-block evaluation, not live homes/processes. Native
  proof requires a separately authorized parent acceptance run; none is claimed in this plan.

No product question remains: D5's unrelated-install refusal and D6 stop/JSON behavior are locked.
Required implementation scope expansion is the small recovery-planner input and its two existing
regression files (`cli-update-restart.test.ts`, `update-restart-lease.test.ts`), all described above.
PR A's pending type-export spelling is avoided through ReturnType; revalidate its file existence,
pid/runtime-port default reader contract and bounded result before starting PR B.


## r2 amendments (Kant reflection)

- Guards block on `kind === "desktop"` **or** `kind === "unknown" && desktopSeen` (010 r2 §6); plain `unknown`/
  `unsupported`/`none` keep current behavior. Add one test per guard family for the `desktopSeen` case.
- Supervision is inspected against the identity-checked target pid where the command has one (010 r2 §2).
- `ocx stop` notice wording: "OpenCodex Desktop may start this proxy again after a short backoff. Use Stop Proxy or
  Quit in the OpenCodex menu to keep it stopped." ("may", not "will").



## r3 amendment (guard continuity)

Each guarded operation (one `service install|repair|start|restart`, one update run in `bin/ocx.mjs` or
`src/update/index.ts`, one dashboard restart decision) creates `const latch = createSupervisionLatch()` from
`src/service/desktop-command-guard.ts`. `latch.observe(evidence)` returns blocked; once it has seen `desktop` or
`unknown && desktopSeen`, it stays blocked for the rest of that operation unless a later observation is positively
`none` (runtime gone or parent verified non-Desktop). An inconclusive later read (`unknown` without desktopSeen,
`unsupported`) never clears it. Every re-inspection inside the operation (initial, locked, replacement, recovery,
refresh) goes through the same latch. Test (update-desktop-owner): desktop → unknown(desktopSeen:false) sequence stays
blocked; desktop → none clears.



## r4 amendments (A audit round 1)

- **F1 Node-safe latch:** `createSupervisionLatch()` lives in `src/service/desktop-supervision.mjs` (declared in its
  `.d.mts`), not in a TS module. `src/service/desktop-command-guard.ts` imports it for the Bun side; `bin/ocx.mjs`
  imports it directly. Test: an actual Node launcher run (tests/cli/ocx-launcher-runtime.test.ts harness, `node bin/ocx.mjs update`
  with injected supervision evidence via the existing test seam or a fake `ps` on PATH) proves the import loads under Node.
- **F2 fresh pre-stop gate:** immediately before the stop spawn in `src/update/index.ts` (the
  `if (runtimePlan.mayStopRuntime && …)` block at :634) and before the equivalent stop in `bin/ocx.mjs`, run
  `latch.observe(inspectDesktopSupervision({ targetPid }))`; when blocked: print the Desktop notice, perform no stop, no
  package replacement and no service refresh, exit 1. Test: evidence sequence none (initial) → desktop (pre-stop) ⇒ zero
  stop/package/service mutations.
- **F7 bypass ledger (PLAN-BYPASS-NAMED-01):**

| Guard | Tier / surface | Known bypass / limit | Residual risk | Wording | Negative assertion |
|---|---|---|---|---|---|
| service install/repair/start/restart | E3, CLI pre-mutation | older CLI on PATH; Windows (`unsupported`); inconclusive evidence without desktopSeen | second supervisor from an old CLI | "early warning", not enforcement | none/unsupported → command proceeds |
| update (Node launcher + Bun updater, initial + pre-stop + recovery) | E3, CLI | same; Desktop starting after the last check inside the stop window | short race | early warning | none → update proceeds |
| dashboard restart veto | E3, server route | older runtime | — | early warning | none → restart allowed |
| stop notice | E1 notice only | — | Desktop may restart the proxy | notice | --json emits no notice |


## r5 (A audit round 2)

Node verification path, replacing the r4 "Node launcher run" test:
1. Import compatibility: run the real launcher under Node with `update --help` (exits before any package-manager probe,
   bin/ocx.mjs help short-circuit) — proves the module graph including `desktop-supervision.mjs` loads under Node.
2. A direct Node test (spawn `node -e` importing `src/service/desktop-supervision.mjs`) exercising
   `createSupervisionLatch` sequences and `inspectDesktopSupervision` with injected `run`/`proc`/`readPid` deps.
3. Updater refusal: the Node launcher's update decision is extracted into a pure planner already used there
   (`planUpdateRuntimeHandling` with the new `supervision` input) and asserted at unit level in
   tests/update/update-desktop-owner.test.ts, plus a source-order assertion in tests/cli/ocx-launcher-source.test.ts that
   the supervision check precedes the stop spawn and package-manager mutation calls in bin/ocx.mjs. A full copied-package
   update run is out of scope (it needs real package-manager preflight); hosted CI's npm-global smokes cover the launcher
   end to end.
