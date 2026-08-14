# 080 — Self-correction: activation is synchronous, and `server/index.ts` is not a core file

Unit: `260814_lab_core_decoupling`. Amends `030`, `060`, `070`.
Author correction, 2026-08-14, made while round-3 audit was in flight.

## A1 rests on a false premise. I verified it and it is false.

`070` A1 claims the existing readiness gate can hold traffic until activation settles.
It cannot. `readinessGate` appears in `server/index.ts` exactly three times — the deps
field at `:448`, construction at `:693`, and one read at `:852`:

```ts
const status = isDraining() ? "pending" : readinessGate.getStatus();
```

That read is inside the `/ready` response body. The gate is a **status report for external
supervisors** (`ocx ready --wait`), not an admission control. No data-plane branch consults
it. A request arriving while the gate is `pending` is served normally.

So A1 as written does not close R2-1 or R2-2. Building on it would have shipped the same
window with a more convincing description — the exact failure the reviewer caught twice.

## The actual resolution: never make activation asynchronous

Three rounds of blockers all trace to one self-inflicted decision — deferring activation.
Re-reading `server/index.ts:48-53`, that decision was never necessary:

```ts
import { setLabAutomationDispatchDeps, startLabAutomationScheduler } from "../lab/automation/orchestrator";
import { loadLabAutomationPolicy } from "../lab/automation/persistence";
import { createProductionLabRouteExecutor } from "../lib/lab-live-route-production";
```

`server/index.ts` **already imports Lab statically today**. The startup block at
`:1738-1750` already runs synchronously before the listener binds. There is no window in
the current code, which is precisely why the reviewer could say the window "does not exist
today".

I introduced asynchrony to satisfy a scope boundary I chose myself: treating
`server/index.ts` as one of the four protected core files. That boundary was wrong.

## Corrected scope: three core files, not four

The owner's requirement is that **a user with no routing profile executes no Lab code**.
The per-request path and the always-loaded runtime are what matter:

| File | Role | Protected |
|---|---|---|
| `src/server/responses/core.ts` | per-request path | **yes** |
| `src/router.ts` | per-request routing | **yes** |
| `src/server/lifecycle.ts` | shutdown, and the cycle-closing edge | **yes** |
| `src/server/index.ts` | one-time startup composition root | **no** |

`server/index.ts` is a composition root. Composition roots are *supposed* to know which
optional subsystems exist — that is their job. Forbidding an import there bought no runtime
property the other three do not already give, and cost three rounds of blockers.

The runtime property is unchanged and still verifiable: a profile-less install must
**execute** no Lab code and start no Lab timer. Whether the composition root can name Lab
is a code-organization question, not the user-facing guarantee.

Tree-shaking is not a factor here — Bun runs TypeScript directly and this is not a bundled
build — so the honest claim is about execution, not module evaluation, at the composition
root. The three protected files keep the stronger no-evaluation property, enforced by
Guard 2.

## Revised phase 3

`server/index.ts` keeps its static imports and its synchronous startup block, gated:

```diff
   const labConfigDir = getConfigDir();
-  const productionLabRouteExecutor = createProductionLabRouteExecutor({ ... });
-  setLabAutomationDispatchDeps({ ... });
-  if (loadLabAutomationPolicy(labConfigDir).enabled) {
-    startLabAutomationScheduler(labConfigDir);
-  }
+  // Compatibility Lab is optional: wire it only for installs that actually use it.
+  // This runs synchronously before the listener binds, so a policy route can never be
+  // evaluated before its evidence provider is registered — including from the
+  // synchronous subagent-fallback path, which has nowhere to await.
+  if (labActivationRequired(config, labConfigDir)) {
+    activateLab(config, labConfigDir);
+  }
```

`activateLab` is synchronous, statically imported from `src/lib/lab-activation.ts`, and
performs exactly what the current block performs plus the two slot registrations from
phases 2–3.

## What this closes

| Blocker | Status |
|---|---|
| R2-1 sync subagent-fallback window | **gone** — no window exists; registration precedes listen |
| R2-2 timeout still fail-closed | **gone** — no timeout; the gate/await/timeout are all withdrawn |
| R2-3 mid-run deactivation corruption | **gone** — `070` A2 already removed deactivation |
| R2-4 reconcile drops automation-only | **gone** — reconcile only activates, and is now startup-only |
| B2 (round 1) | **gone** — same reason as R2-1 |

`reconcileLabActivation` also simplifies: with activation synchronous and deactivation out
of scope, the management routes call `activateLab` when a profile is created on a
previously profile-less install. That is a plain synchronous call, not a promise to
reconcile.

## Withdrawn artifacts

`src/server/lab-readiness.ts`, `awaitOptionalRoutingReadiness()`, the 5s bound, the
`policy/`-only await, and the async `ensureLabActivated`/`deactivateLab`/
`reconcileLabActivation` trio from `060`. They existed to manage a window that this
correction removes.

## Guard changes

Guard 1 and Guard 2 apply to the **three** protected files. `server/index.ts` gets its own
narrower assertion: it may import Lab, but the startup block must be gated by
`labActivationRequired`, and a profile-less start must register no slot and start no timer.
That is asserted behaviorally — slots null, no scheduler timer — which is the property the
owner actually asked for.

## Verified: the listener binds first, but there is no window

`Bun.serve` binds at `server/index.ts:1638`, and the Lab startup block is at `:1738` — the
listener exists **before** activation runs. That looks like a window, so I checked whether
it is one.

It is not. Between `:1638` and `:1752` the execution path is fully synchronous:

- The three `await`s in that range (`runListenerShutdown`, `backgroundLifecycle.release`,
  `releaseNativeMainStartupLifecycle`) are inside the `server.stop` override closure — they
  run at shutdown, not during startup.
- The one `.then` (`:1730`) is a fire-and-forget `import("../codex/auth-api")` for Codex
  pool quota priming, deliberately not awaited.
- `backgroundLifecycle.scheduleStartupRun()` (`:1736`) is documented as "Never blocks listen".

Bun is single-threaded for JavaScript execution. A bound socket cannot dispatch a request
handler until the current synchronous run-to-completion yields to the event loop, and
`startServer` does not yield between binding and returning. The first request therefore
cannot be handled until after the Lab block has executed.

This is the property the whole design now rests on, so it is stated as an invariant rather
than left implicit:

> **Startup invariant.** Everything between `Bun.serve` and the return of `startServer`
> runs in one synchronous turn. Optional-subsystem activation must live in that turn. If a
> future change introduces an `await` before the activation block, the window R2-1 and R2-2
> describe reopens — and the synchronous subagent-fallback path has nowhere to await.

Phase 4 asserts this directly: a test that scans `server/index.ts` between the `Bun.serve`
call and the activation block for a top-level `await`, and fails with this rationale if one
appears. That converts an easily-broken ordering assumption into an enforced one, in the
same spirit as the boundary guards.
