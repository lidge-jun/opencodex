# 070 — Audit round 2: eliminating the activation window

Unit: `260814_lab_core_decoupling`. Amends `030`, `040`, `060`.
Reviewer: same independent reviewer, round 2, 2026-08-14.
Verdict: **FAIL** — 4 blocking (R2-1..R2-4), 2 non-blocking.

Round 1's five blockers are confirmed closed. Round 2 found that **my round-1 fix
introduced four new defects**, three of them proven by executing the real modules.

## The one sentence that reframes the whole design

> "Note this window does not exist today, because compatibility evidence currently loads
> synchronously through static imports; the deferred activation creates it."

Every one of R2-1 through R2-4 descends from a single decision: making activation
asynchronous and letting the listener accept traffic before it settles. I patched that
window twice — a readiness gate, then a timeout — and the reviewer showed each patch
leaks. R2-1 is the proof it cannot be patched at all: the synchronous subagent-fallback
chain has no place to await.

So the amendment is not a third patch. **The window is removed.**

## R2-1 (High) — the readiness gate cannot cover the synchronous path

The reviewer executed this, rather than reasoning about it. With a compatibility-gated
profile aliased `fast-tier`:

- `routeModel(cfg, "fast-tier")` throws `NoEligiblePolicyCandidateError`
- `isSubagentModelUnavailable("fast-tier", cfg)` → `true`
- `selectAvailableSubagentModel("a/primary", cfg, ["fast-tier", "b/m"])`
  → `{"model":"b/m","rewritten":true,"skipped":["a/primary","fast-tier"]}`

`tryRouteFallbackModel` (`codex/subagent-model-fallback.ts:63`) swallows the throw, and
`isSubagentModelUnavailable:244` reads a null route as "unavailable". These five functions
are synchronous, so no `await` fits.

The failure is silent: during the window a policy alias is dropped from the fallback chain
and the subagent runs on **a different model than the operator configured** — no error, no
log, just a `skipped` entry. That is worse than the 404 it replaced, because a 404 is
visible.

I checked the swallow myself: `routeModel` is called inside `try { } catch { return null }`
at `subagent-model-fallback.ts:63-68`. The reviewer is right.

## R2-2 (High) — the 5s timeout fails identically, 5 seconds later

`060:53-54` claimed that on timeout "the existing unknown path applies". It does not.
Timeout lands on exactly the fail-closed chain the gate existed to avoid:
`policy.ts:95` → `profile.ts:41` (`exclude`) → `evaluator.ts:352` → `router.ts:528` throw
→ 404 at `responses/core.ts:1618`.

The reviewer also rejected the obvious shortcut, correctly: forcing unknown→`allow` while
pending would silently override the operator's fail-closed intent on every
default-configured compatibility profile, converting a routing-availability bug into a
**policy-bypass bug**. A compatibility gate exists precisely to not do that.

## R2-3 (High) — deactivation has no safe teardown, and the abort primitive is global

Detaching dispatch deps deletes the map entry (`orchestrator.ts:99`), after which
`dispatchDepsFor` returns `{}` (`:66`). A run already inside `runDispatchBatch` re-reads
deps at `:360` and dispatch hits `if (!deps.routeExecutor) return routeIneligible();`
(`dispatch.ts:134`) — finalizing the run as **ineligible rather than cancelled**, writing a
misleading terminal state into the ledger.

The alternative is worse: `requestLabAutomationShutdown` (`orchestrator.ts:114`) sets
`shutdownRequested`, a module-global (`:56`) gating dispatch for *every* `configDir`
(`:314`), cleared only by `startLabAutomationScheduler` (`:402`). Deactivating one config
would wedge automation for all others — the exact multi-config bug B3 set out to fix.

## R2-4 (High) — the reconcile predicate drops automation-only installs

`labActivationRequired` is a disjunction: profiles present **or** automation enabled.
`060` described reconcile as driven by profile mutations, so deleting the last profile
would tear down a scheduler the operator explicitly enabled.

---

# Amendment: activate before listen, deactivate never

## A1 — activation completes before the listener accepts traffic

This closes R2-1 and R2-2 together, because both are window defects.

`src/cli/index.ts:236` already creates a `readinessGate` and passes it into
`startServer` (`:241`), and `src/server/readiness.ts:44` already owns the pending/ready
/failed lifecycle. The core already has the mechanism; the plan simply failed to use it.

Revised `server/index.ts` wiring:

```
if (labActivationRequired(config, labConfigDir)) {
  // Synchronous require-time activation for installs that opted in. Paid once, at
  // startup, only by installs that already use routing profiles or Lab automation.
  activateLabSync(config, labConfigDir);
}
```

`activateLabSync` uses a static import inside `src/lib/lab-activation.ts` — which is
itself never imported by the four core files, so the boundary holds. The core imports the
*activation module*, not Lab; the activation module imports Lab.

Wait. That still makes `server/index.ts` import `lib/lab-activation.ts`, which statically
imports Lab, which re-couples the graph. The resolution:

- `server/index.ts` keeps a **dynamic** `import("../lib/lab-activation")`.
- The listener does not accept traffic until it resolves, using the existing readiness
  gate: activation failure marks the gate failed; success marks it ready.
- Because `startServer` stays synchronous, the await lives in `cli/index.ts` around the
  existing gate transition, where `handleStart` is already async and already awaits
  `runStartupReadinessSync`.

Net effect: for an install with routing profiles, Lab is fully registered before the first
request can be routed — synchronous or asynchronous, request path or subagent fallback.
For an install without them, nothing is imported at all. **There is no window.**

The `awaitOptionalRoutingReadiness()` slot, the 5s timeout, and the `policy/`-only await
from `060` are all **withdrawn**. They were solving a problem that no longer exists.

## A2 — deactivation is removed from scope

R2-3 and R2-4 are both deactivation defects. Deactivation exists only to serve
"user deletes their last routing profile", and the reviewer showed a correct
implementation needs a per-`configDir` shutdown signal that the orchestrator does not
have — scoping `shutdownRequested` into a `Map` is a change to Lab's own concurrency
model, well outside a boundary fix.

Revised rule:

- `ensureLabActivated` stays idempotent and per-`configDir`.
- `reconcileLabActivation` **only ever activates**. Creating the first profile activates
  Lab for that config.
- Deleting the last profile does **not** deactivate. Lab stays loaded until the process
  restarts, at which point `labActivationRequired` is false and it is not loaded again.
- `deactivateLab` is retained only as a test helper, driven by
  `resetLabActivationForTests`.

The cost is honest and bounded: a user who creates a profile, then deletes it, keeps Lab
in memory until restart. That is a one-process-lifetime residue for a user who *did* opt
in, and it does not violate the objective — which is about users who never opted in.

R2-4 dissolves under this rule: reconcile never tears anything down, so the disjunction
cannot be misread. It is still recomputed in full for the activation decision.

## A3 — non-blocking items

- `030:258`'s accept-criteria grep is restated to match B1: forbid direct `src/lab/`
  imports, and let Guard 2 own transitive reachability.
- B9's research/roadmap split stays deferred by agreement.

## Revised accept criteria

3 (unchanged in intent, now provable): routing-profile installs keep compatibility
evidence and CL-09 passive signals working — with no activation window on either the async
or synchronous path, because activation precedes traffic.

New criterion 7: an install with routing profiles has Lab fully registered before the
listener accepts its first request, proven by a test that issues a policy request
immediately after readiness and asserts success with `unknownEvidence` at its default
`exclude`.
