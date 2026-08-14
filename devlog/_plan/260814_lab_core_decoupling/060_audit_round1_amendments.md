# 060 — Audit round 1: blockers and plan amendments

Unit: `260814_lab_core_decoupling`. Amends `000`, `020`, `030`, `040`.
Reviewer: independent adversarial review, 2026-08-14.
Verdict: **FAIL** — 5 blocking (B1-B5), 4 non-blocking (B6-B9).

Every blocker was re-verified against the tree before amending. This document is
authoritative where it conflicts with the docs it amends; those docs keep their original
text so the delta stays auditable.

## B1 (High) — Guard 1 contradicts phase 3

`000_plan.md:123` forbids every `routing/compatibility/` import in core, and `040:21-30`
encodes that. But `030` deliberately keeps `router.ts:34` importing
`routing/compatibility/assemble` — the assembler stays, it just stops reaching Lab. The
intended final tree would fail its own acceptance test. **Verified.**

**Amendment.** The invariant is Lab reachability, not the string `routing/compatibility`.

- Guard 1 forbids direct `src/lab/` imports in the four core files.
- Guard 2 (transitive graph walk) owns the real property: no `src/lab/` module reachable.
- `assemble` and `provider-slot` stay permitted in `router.ts` — Guard 2 proves they are
  Lab-free rather than assuming it.

Accept criterion 1 is restated: no static `src/lab/` import in the four core files, and no
`src/lab/` module transitively reachable from them.

## B2 (High) — The activation race is fail-closed, not degrade-open

`030:228-231` accepted serving policy requests before the provider registers, reasoning
that absent evidence degrades to unknown. **Verified — the reviewer is right, and this is
the most serious finding. My original text was wrong.**

| Step | Evidence |
|---|---|
| default is exclude, not opt-in | `routing/profile.ts:41` `DEFAULT_COMPATIBILITY_UNKNOWN_EVIDENCE = "exclude"` |
| no subject leads to exclusion | `routing/compatibility/policy.ts:94-104`, reason `subject-unresolved` |
| exclusion makes candidate ineligible | `routing/evaluator.ts:352-354` |
| none eligible throws | `router.ts:528-529` `NoEligiblePolicyCandidateError` |

During the window a compatibility-gated request does not lose scoring — it fails outright.

**Amendment.** Await activation before policy routing. `handleResponsesInner`
(`responses/core.ts:1480`) is already async, so the wait is structurally free.

1. NEW core-owned `src/server/lab-readiness.ts`: a nullable pending promise plus
   `awaitOptionalRoutingReadiness()`, resolving immediately when nothing is pending.
2. `server/index.ts` publishes the activation promise into that slot. `startServer` stays
   synchronous and still does not block listen.
3. Handlers await it before `routeModel` only when the model resolves to a `policy/` id.
   Non-policy requests never wait.

The await is bounded at 5s; on timeout the request proceeds and the existing unknown path
applies, so a slow activation degrades one request instead of hanging it.

Required tests: with `unknownEvidence` both defaulted and explicitly `exclude`, a policy
request issued immediately after listen succeeds. That is the activation scenario for the
readiness branch, driven red by removing the await.

## B3 (High) — Activation must be per-config and reconcilable

A process-global one-shot that captures the first `config`/`configDir` and drops detach
receipts breaks three reachable transitions. **Verified** — profiles mutate at runtime via
`server/management/routing-profile-routes.ts:289-304`, no restart:

- start profile-less, create a profile, and evidence never registers until restart;
- delete the last profile and Lab linkage keeps running;
- two `configDir`s in one process and automation binds to whichever activated first.

**Amendment.** Per-`configDir` activation records that retain their receipts:

```ts
type Activation = { ready: Promise<void>; detach: Array<() => void> };
const activations = new Map<string, Activation>();

export function ensureLabActivated(config, configDir?): Promise<void>
export function deactivateLab(configDir?): void
export async function reconcileLabActivation(config, configDir?): Promise<void>
```

`setLabAutomationDispatchDeps` already returns a release function
(`lab/automation/orchestrator.ts:79`); the linker and provider slots get the same shape.
Retaining those receipts is what makes deactivation possible. `reconcileLabActivation` is
called by the routing-profile mutation handlers and the automation-policy handler.

**Guard 3 correction.** `040:57-60` is unsatisfiable as written — it installs a linker then
expects it not to run. Corrected: with zero profiles and no activation, assert the slot is
null and `labRouteSubjectId` is absent. Guard 4 keeps the positive case.

## B4 (High) — Automation detection reads the wrong authority

`030:187-190` proposes reading the small policy JSON. **Verified stale**:
`lab/automation/config-persistence.ts:46-48` writes `automation-config.json` and
`loadLabAutomationConfig` prefers it; `automation-policy.json`
(`lab/automation/persistence.ts:252-257`) is the legacy fallback.

**Amendment.** `labAutomationEnabledOnDisk` mirrors that precedence, still reading with
plain `node:fs` so the detector never imports Lab:

```
automation-config.json -> valid JSON and policy.enabled === true -> true
automation-policy.json -> valid JSON and enabled === true        -> true
otherwise (missing, malformed, disabled)                         -> false
```

Reading only the legacy file would miss every install that enabled automation through the
current dashboard. Tests: combined-only, legacy-only, both, malformed, missing, enabled,
disabled.

## B5 (High) — The provider slot as written does not compile

**Verified.** The real names are `NormalizedRoutingProfileCompatibility`
(`routing/profile.ts:43`) and `AssemblePolicyEvidenceOptions`
(`routing/compatibility/assemble.ts:25`) — and that options type carries Lab-specific test
seams (`resolveSubjects`, `loadEvidenceSnapshot`, `loadCatalogSnapshot`), so moving it
wholesale leaves the core assembler coupled to provider internals.

**Amendment.** Split the options type along the same seam as the code: a core
`CoreEvidenceOptions` carrying only `configDir` and `routedProviderConfig`, and a
provider-side `LabCompatibilityProviderOptions` extending it with the three Lab test seams.
`AssemblePolicyEvidenceOptions` stays as a deprecated alias of the union so existing call
sites and tests keep compiling. The slot signature uses the real normalized type. Reviewer
confirms `attachCompatibilityEvidence` is cleanly relocatable — its state arrives entirely
through arguments.

## Non-blocking, adopted

**B6 — management routes at diff level.** Remove the static imports at
`server/management-api.ts:71-72`; branch by pathname inside `handleManagementAPI` (already
async, `:99-105`) before the generic chain: `/api/lab/automation*` uses a dynamic import
plus `await reconcileLabActivation` on PUT, manual run, and scheduler ops; other
`/api/lab*` dynamically imports the read handler; automation ordering preserved. Assert an
unrelated `/api/*` request loads no Lab module.

**B7 — guard blind spots.** Guard 2 parses with the TypeScript AST rather than a
`from "..."` regex, covering side-effect imports, runtime re-exports, and top-level dynamic
`import()`. Dynamic Lab imports are allowed only from an explicit allowlist
(`lib/lab-activation.ts`, the management branch). Resolution covers `.ts`, `.mts`, `.mjs`,
and `/index.*`.

**B8 — missing scenarios and docs.** Add an activation-lifecycle test section: first-request
readiness, live profile create and delete, combined automation config, activation rejection
and retry, multiple `configDir`s, lazy management loading. Add a `docs-site/` note on when
Lab activates and why passive signals may be absent. No usage-log migration and no GUI
rebuild are needed — `labRouteSubjectId` is already optional (`usage/log.ts:50`) and
`cli/dispatch.ts:466` already lazy-imports the Lab CLI.

**B9 — citation drift.** Corrected: `handleResponsesInner` starts at `responses/core.ts:1480`
(not 1476); orchestrator registration `:106` (not 104); subject construction
`routing/compatibility/subject.ts:77-82` (not 68/76); GUI request
`compatibility-matrix-api.ts:245` (not 238). The research and roadmap split is accepted and
deferred to the phase-1 P amendment so this round is not blocked on a document move.

## Revised order

1 -> 2 -> 3 -> 4 -> 5 unchanged. Phase 3 absorbs B2, B3, B4, B5. Phase 4 absorbs B1, the
corrected Guard 3, and B7.
