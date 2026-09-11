# Bun Canary Dogfood Roadmap

Date: 2026-08-13  
Status: docs-first; no implementation or deployment has been performed  
Owner: OpenCodex runtime maintainers

## Objective

Move the OpenCodex source-checkout dogfood runtime from Bun 1.3.14 to one immutable Bun canary revision, use the runtime change to expose and repair application-owned memory retention, prove that heap use is bounded under sustained real proxy traffic, and deploy the proven revision to the local managed service with a tested rollback.

The initiative succeeds only when all of the following are true:

1. The integration branch is synchronized without losing the two historical local realtime commits.
2. The exact Bun canary version and revision are recorded; `package.json` and `bun.lock` describe a reproducible dependency state.
3. Every long-lived app-owned retained store is bounded and either registered with the process memory budget or explicitly documented as observed-only/constant-size.
4. A 10-minute warm-up followed by a 60-minute load window shows no monotonic leak and no more than 32 MiB heap growth.
5. Typecheck, focused memory tests, the full suite, privacy scan, GUI build, service health, runtime-path proof, and rollback rehearsal all pass.
6. Deployment occurs only after explicit user approval.

## Decision: canary instead of waiting for Bun 1.4

The initiative's decision context is that Bun 1.4 stable is delayed and unavailable for the required dogfood window. Waiting would postpone runtime feedback and memory-leak discovery. Canary is therefore the only current path to exercise post-1.3.14 runtime/GC changes before 1.4 ships.

This is a project scheduling premise, not an independently verified Bun release promise. At execution time, record the current stable release and canary revision. Do not claim an official Bun 1.4 date unless Bun publishes one.

Bun documents canary builds as **untested builds produced from every main-branch commit**. This is the central risk: canary may fix allocator or GC behavior, but it may also introduce crashes, semantic regressions, lockfile changes, performance regressions, or memory growth of its own. The plan therefore pins one observed canary revision, compares it against 1.3.14 under the same workload, and retains a five-minute rollback path.

Official references:

- Bun canary installation and stable rollback: <https://bun.sh/docs/installation#canary-builds>
- `--smol` GC behavior: <https://bun.sh/docs/runtime#smol>
- Heap snapshots/profiling: <https://bun.sh/docs/project/benchmarking#heap-profiling>

## Baseline and stale-state warning

The task input described an older graph in which local `dev` had two commits absent from `origin/dev` (`304fa003d` and `022f6c0b3`) and the remote had advanced. The checkout inspected while writing this roadmap no longer has that shape:

```text
dev             a34d1a5a6
origin/dev      a34d1a5a6
dev..origin/dev 0 commits
```

Both named commits still exist in the object database. Therefore `010_git_cleanup.md` preserves the requested historical procedure but makes the expected graph an explicit precondition. Never run its hard reset from counts copied into this document.

The package baseline is currently:

```json
"bun": "1.3.14",
"@types/bun": "1.3.14"
```

The npm registry inspected on 2026-08-13 exposed a `bun` canary dist-tag but no `@types/bun` canary dist-tag. An installed binary canary version is not guaranteed to exist as an npm version for either package. WP-1 must fail closed if exact package parity cannot be represented; it must not invent a version or silently leave mismatched pins.

## Constraints

- Bun-native TypeScript and ESM only; no Node-only runtime path and no separate server compile step.
- Preserve unrelated tracked and untracked work. The existing untracked devlog directories are not cleanup targets.
- `git reset --hard` is authorized by this roadmap only after the preflight in `010_git_cleanup.md` proves the exact historical graph and `preview-dev` preserves both commits.
- Never use `git clean`, delete untracked files, force-push, publish packages, create a release, or promote `main`/`preview` in this initiative.
- Security findings that are not already public go in `.tmp/` or `mktemp -d`, never this public devlog.
- Do not log request bodies, API keys, account IDs, credentials, heap object contents, or raw heap snapshots into git. Profiling artifacts live under `.tmp/bun-canary-dogfood/` and remain untracked.
- Runtime and type packages must be reproducible. A moving label such as `canary` is acceptable for discovery only, never as the final `package.json` pin.
- Runtime changes and application patches are separate commits so either can be reverted independently.
- All memory fixes require a failing regression probe before the production diff.
- A canary-only failure must be reproduced against Bun 1.3.14 using the same source, config, workload, duration, and sampling method before attributing it to Bun.
- Service repair/deployment, any interruption of the running proxy, and rollback execution require explicit user approval.

## Scope

### IN

- Guarded preservation and synchronization of local `dev`.
- Fresh local Bun canary installation and immutable version/revision capture.
- Root `package.json` Bun runtime/type pins and root `bun.lock` regeneration.
- Bun compatibility typecheck and existing repository gates.
- Audit of all 12 retained-store registrations and four observed-buffer registrations.
- Audit of new long-lived Maps, Sets, caches, listeners, timers, and closure-held payloads added since the zero-leak state-store baseline.
- Focused audit of:
  - `src/responses/state.ts`
  - `src/codex/model-cache.ts`
  - `src/adapters/anthropic-image-normalize.ts`
  - `src/server/request-log.ts`
- Fixes proven necessary by the audit, including the unbounded workspace metadata cache in `src/adapters/command-code.ts`.
- Comparative Bun 1.3.14/canary memory profiling, real proxy load, local source-checkout service repair, health/runtime proof, and rollback rehearsal.

### OUT

- General performance optimization unrelated to retention.
- Rewriting the memory-budget architecture or changing its 256 MiB default without measured evidence and a separately approved design.
- Provider behavior changes, model-catalog changes, GUI redesign, API contract changes, or new telemetry vendors.
- Production/public deployment, npm publication, GitHub issue/PR writes, release tags, branch pushes, and promotion to `main` or `preview`.
- Bun upstream patching. A confirmed Bun defect is recorded with a minimal scratch reproduction; filing it upstream needs separate approval.
- Treating RSS alone as proof of a JS leak. Allocator retention, native image buffers, external memory, and JS heap must be separated.

## Dependency-ordered work-phase map

```text
WP-1 Foundation
  git preservation/sync
    -> install and identify Bun canary
    -> pin reproducible package state
    -> compatibility/typecheck gates

WP-2 Memory audit and patches
  prove registration inventory
    -> scan post-baseline retained owners
    -> reproduce each candidate
    -> minimal red/green fixes

WP-3 Verification and approved deployment
  1.3.14 control profile
    -> canary profile and sustained load
    -> acceptance decision
    -> user approval
    -> service repair/deploy
    -> health/runtime proof
    -> rollback rehearsal/record
```

### WP-1 — Git cleanup and Bun canary foundation

Execute `010_git_cleanup.md`, then `020_bun_canary.md`.

Entry gate:

- Current worktree inventory recorded.
- No destructive command has run.
- The expected historical graph is either proven, or cleanup is marked already satisfied/stale and skipped.

Exit gate:

- `preview-dev` contains both historical local commits when the historical graph applies.
- `dev` exactly equals the freshly fetched `origin/dev`.
- Bun canary version and full revision are recorded.
- Root package pins are exact and resolvable; `bun.lock` is regenerated only from those pins.
- `bun install --frozen-lockfile` and `bun run typecheck` pass after regeneration.

### WP-2 — Memory ownership audit and patches

Execute `030_memory_patches.md`.

Entry gate:

- WP-1 is green.
- The exact baseline commit and canary revision are fixed in the evidence record.

Exit gate:

- Inventory tests name all 12 retained stores and four observed buffers.
- Every post-baseline long-lived owner has a finite count/byte/lifetime bound and cleanup path, or is registered with the memory budget.
- The workspace metadata cache has a count cap and expiry removal.
- Each implemented fix has red/green evidence and focused tests.
- `bun run typecheck`, focused tests, full tests, and `bun run privacy:scan` pass.

### WP-3 — Comparative verification and deployment

Execute `040_verification_deploy.md`.

Entry gate:

- WP-2 is green and committed separately from the runtime pin.
- A real, privacy-safe proxy workload and expected response criteria are configured.
- The user has approved any required service interruption for profiling.

Exit gate:

- Control and canary runs use the same workload and sampling window.
- Canary heap growth is at most 32 MiB over the 60-minute measured window and no retained-store counter grows after workload cardinality stabilizes.
- No crash, OOM, request-error regression, or monotonic post-load growth is observed.
- User explicitly approves deployment.
- The managed service runs the expected Bun path/revision and source SHA; `/healthz`, `/v1/models`, `ocx health --json`, GUI bundle proof, and service persistence pass.
- Rollback is either rehearsed before deployment or executed and proven within five minutes in a disposable/local lane.

## Stop conditions

Stop and do not deploy if any condition occurs:

- Package/runtime/type versions cannot be pinned reproducibly.
- Canary fails typecheck or the full suite and the failure is absent under 1.3.14.
- A suspected leak lacks a repeatable probe or three competing hypotheses have not been tested.
- Heap grows by more than 32 MiB during the measured hour, grows monotonically after load stops, or app-owned counters exceed their contracts.
- Canary crashes, corrupts the lockfile, changes request semantics, or materially increases failures/latency.
- Runtime provenance cannot prove the managed service is using the intended canary binary.
- The user has not approved deployment or service interruption.

## Evidence and commit boundaries

Keep untracked evidence in `.tmp/bun-canary-dogfood/`. Record only scalar summaries and commands in this unit.

Recommended local commits:

1. `docs(plan): specify Bun canary dogfood roadmap`
2. `build(bun): pin dogfood canary runtime` — `package.json`, `bun.lock` only
3. `fix(memory): bound workspace metadata retention` — focused source/test diff
4. Additional `fix(memory): ...` commits — one proven root cause each
5. `docs(plan): record Bun canary verification evidence`

Do not push, open a PR, publish, or deploy outside the local source-checkout service without separate explicit authorization.
