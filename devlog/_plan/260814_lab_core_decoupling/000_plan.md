# 000 — Plan: enforce the Compatibility Lab / proxy-core boundary

Unit: `260814_lab_core_decoupling`
Baseline: `dev` @ `ff674b8b7fd7905078f42b0f258d447cc785e8c2`
Owner directive: 2026-08-14. Feature work on the CL line is frozen; CL-10 PRs
[#1628](https://github.com/lidge-jun/opencodex/pull/1628) and
[#1510](https://github.com/lidge-jun/opencodex/pull/1510) are closed pending this boundary.

## The defect

opencodex is a provider proxy. A user who configures one provider and one model — no
routing profile, no Compatibility Lab, no evidence collection — currently executes Lab
code on every request and loads the entire Lab module graph at startup.

This is not a performance regression. Measured RSS on a live proxy is ~48 MB and the
per-request Lab call is pure computation over the config object plus one 32-byte salt
read. The defect is **architectural**: an optional subsystem sits on the mandatory path,
with no configuration surface to decline it. Every contributor reading `responses/core.ts`
must now reason about Lab, and every user ships it.

## Verified coupling (read, not assumed)

| # | Location | Runs when | Gate today |
|---|---|---|---|
| 1 | `src/server/responses/core.ts:36` → call at `1997-2009` | **every request attempt**, streaming and non-streaming, once per attempt; once per combo child | none |
| 2 | `src/router.ts:34` → call at `524` | `policy/` routes only | runtime-gated, import unconditional |
| 3 | `src/server/index.ts:48-53` → block at `1738-1750` | every server start | `enabled:false` skips the scheduler only |
| 4 | `src/server/lifecycle.ts:10` → calls at `455-456` | every shutdown | none |
| 5 | `src/usage/log.ts:50` `labRouteSubjectId`, validator at `214`, persisted at `297` | every attempt log write | none |
| 6 | `src/server/management/lab-routes.ts`, `lab-automation-routes.ts` | management API mount | none |

### The import cycle is the real finding

`assemble.ts` does not reach Lab through anything resembling compatibility logic. It
reaches Lab through the **quota chain, and back out through `lifecycle.ts`**:

```
routing/compatibility/assemble.ts:7  → routing/quota.ts:21
  → providers/quota.ts:6            → codex/auth-api.ts
  → codex/native-main-admission.ts:2 → server/lifecycle.ts:10
  → lab/automation/orchestrator.ts
```

`src/lib/lab-live-route-production.ts:11` reaches the identical cycle through
`oauth/index.ts:28 → oauth/health.ts:2 → oauth/anthropic-routing.ts:19 → providers/quota.ts`.

Both entry points therefore pull in **~69 `src/lab/` runtime files**. Coupling point 4 —
one line in `lifecycle.ts` — is what closes the loop. Cutting it is the highest-leverage
single edit in this unit, and it is why phase ordering below starts there rather than at
the most visible symptom.

### What the per-request hook actually feeds

`labRouteSubjectId` is not dead weight. It is written to `usage.jsonl` and read by
`src/lab/query/passive-production.ts:82`, surfaced through
`GET /api/lab/production-signals` (`lab-routes.ts:198`), `ocx lab production-signals`
(`cli/lab.ts:241`), and the Compatibility Matrix GUI
(`compatibility-matrix-api.ts:238`, `CompatibilityMatrix.tsx:194`).

So deletion is not free: it retires a shipped, user-visible read surface. Gating keeps
the feature for installs that opted in. **This unit gates; it does not delete.** Scope
boundary for anyone extending this work: removing CL-09 entirely is a separate decision
with its own user-facing deprecation, not a side effect of a boundary fix.

### The routing constraint that shapes everything

`routeModelInternal` (`src/router.ts:504`) is **synchronous**, and so are its public
wrappers `routeModel` (`654`) and `routeConcreteModel` (`684`). A dynamic `import()`
inside it is impossible without making the chain async, which would touch ~11 production
call expressions, ~272 test call sites, and — the actual blocker — the synchronous
subagent-fallback API in `src/codex/subagent-model-fallback.ts` (`tryRouteFallbackModel:63`
feeding `isNativeModelQuotaExhausted:200`, `isModelHealthBlocked:216`,
`isSubagentModelUnavailable:234`, `selectAvailableSubagentModel:269`,
`noteSubagentModelFailure:298`, `applySubagentModelFallback:510`).

Making routing async to remove a Lab import would be a far larger and riskier change than
the problem justifies. **Routing stays synchronous.** The boundary is drawn with a
provider-registration seam instead.

## Design: registration, not dynamic import

The core already owns the exact pattern needed — `src/lib/server-resource-ownership.ts`,
`registerCurrentServerResourceCleanup` — and Lab already consumes it at
`lab/automation/orchestrator.ts:104`. This unit generalizes that idea rather than
inventing a mechanism:

- Core declares a **slot** (a nullable function reference) for each optional Lab capability.
- Core calls the slot when populated, and skips when null. No `import` of Lab anywhere.
- Lab **registers into** the slot during an explicit activation step.
- Activation runs only when the install actually has a routing profile / enabled automation.

A profile-less install therefore never activates, never registers, never loads Lab —
and every core call site is a null check on the mandatory path.

## Phase map (dependency-ordered)

Ordered so each phase consumes the previous phase's verified output. Not effort-ordered.

| Phase | Doc | Delivers | Depends on |
|---|---|---|---|
| 1 | [`010`](./010_lifecycle_shutdown_registry.md) | Break the import cycle at `lifecycle.ts` via a shutdown-hook registry | — |
| 2 | [`020`](./020_request_path_gate.md) | Remove Lab from the per-request path; register the passive linker | 1 |
| 3 | [`030`](./030_router_and_startup_activation.md) | Policy-evidence slot + lazy Lab activation at startup | 1, 2 |
| 4 | [`040`](./040_boundary_guard_test.md) | Executable boundary guard so the property cannot silently regress | 1–3 |
| 5 | [`050`](./050_governance_and_release.md) | CODEOWNERS/branch protection, verification on `lidge`, PR, release | 1–4 |

Phase 1 first because it closes the cycle that makes phases 2 and 3 leaky: while
`lifecycle.ts` statically imports the orchestrator, any module reaching `lifecycle.ts`
still drags Lab in regardless of what phases 2–3 do.

## Scope

**IN:** `src/server/lifecycle.ts`, `src/server/responses/core.ts`, `src/router.ts`,
`src/server/index.ts`, `src/routing/compatibility/*`, a new core-owned optional-capability
module, `tests/` regressions, `.github/CODEOWNERS`, branch protection, this devlog unit.

**OUT:** deleting `src/lab`, removing routing-profile or Compatibility Matrix features,
retiring CL-09 as a product surface, provider/adapter changes, GUI redesign, and every
open PR from other contributors.

## Accept criteria

1. `rg` over `src/router.ts`, `src/server/index.ts`, `src/server/responses/core.ts`,
   `src/server/lifecycle.ts` returns **no** static `lab/` or `routing/compatibility/` import.
2. A request served from a config with zero routing profiles executes no Lab code —
   proven by an executable test, not by inspection.
3. Routing-profile installs keep candidate compatibility evidence and CL-09 passive
   signals working.
4. `bun x tsc --noEmit` exits 0.
5. Full suite green on the remote Linux runner `lidge`.
6. Core-file changes require owner approval going forward.

## Verification

Local: focused `bun test` per phase, then `bun x tsc --noEmit`.
Remote: full suite on `lidge` (`~/.bun/bin/bun`, Bun 1.3.14, Ubuntu). The local pre-push
hook (`.git/hooks/pre-push` → `bun run prepush`) is bypassed with `--no-verify` because
the authoritative suite run happens on `lidge`.
