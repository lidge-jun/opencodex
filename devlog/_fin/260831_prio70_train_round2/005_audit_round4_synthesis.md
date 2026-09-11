# 005 — audit round 4: FAIL, four blockers, and the first one is a migration hazard

Fresh reviewer, correctly-staged tree. Confirmed closed from round 3: the wp3
route→legacy sequence is reachable and `rememberOriginal` does run first; wp2 can carry
ownership on the job object; wp6's return genuinely cannot express the joiner state, and
extending the primitive is in scope. Score-matrix sums all check out.

What is left is four blockers, and the first is the most consequential thing any round
has found.

## Blocker 1 — wp3's provenance field would break the manifests it exists to repair

Two independent problems in the round-3 amendment.

**It is not crash-safe.** The manifest is written before routing
(`src/codex/history-provider.ts:1152`), and routing can still fail afterwards
(`:1230` throws `history_apply_partial_route`). Recording "a routed relabel occurred"
at `rememberOriginal` claims something that has not happened yet; recording it after the
write opens the mirror-image window where the relabel lands and the flag does not.
Either way a crash produces a manifest whose provenance disagrees with the database.

**It is not backward compatible.** `CodexHistoryBackupManifest` is `version: 1` with a
fixed entry shape and no provenance field (`src/codex/history-manifest.ts:7-19`). Every
manifest on every user's disk lacks it. The round-3 rule — refuse when provenance is
unavailable — therefore refuses *every existing manifest*, which is precisely the
population #3026 is about. The fix would brick the thing it repairs on first contact.

I wrote "an ambiguous integrity check must fail closed" in round 3 and did not ask what
the ambiguous set contained. It contained everything.

The corrected shape:

- Provenance is a **versioned, crash-recoverable tri-state**: `relabel-pending`,
  `relabel-committed`, and absent. The pending marker is written before the routing
  write and resolved after it, so a crash leaves a state that says "unknown, and here is
  why" rather than a confident wrong answer.
- **Absent provenance is compatible, not refused.** A version-1 entry whose post-image
  matches the recorded original exactly restores as it always has. Refusal is reserved
  for the genuinely ambiguous case: absent provenance *and* `0 → 1` drift.
- The stale tuple-predicate paragraph at `030:78` is still sitting in the doc as
  normative implementation text. It has to go, or an implementer will follow the
  instruction rather than the amendment above it.

## Blocker 2 — the transfer leaks when the fallback writer is never reached

Round 3 replaced "release at supersession" with "settle only at swap or
terminalization". There is a path with neither: `setResidentEntry` can make a queued
candidate stale through its failure branch without cancelling the pending job
(`src/responses/state.ts:781`), and the fallback loop then skips that job on the
`states.get(job.id) !== candidate` guard (`:546`) before `installShutdownFallbackSpill`
runs.

Under the round-3 rule that reservation is never settled. It survives for process
lifetime, and since reservations count against the cap, the effective budget ratchets
down every time it happens until nothing can spill at all. A disk-cap fix that
monotonically shrinks the usable cap is worse than the overshoot.

Ownership must settle on the pre-write mismatch and on every no-swap/no-write return,
not only on the two success-shaped endings.

## Blocker 3 — wp4's injected clock has eight call sites, not two

`computeCodexUsageScore` takes `(quota, plan)` and no clock at all
(`src/codex/routing.ts:363-367`). Adding a third parameter touches eight call sites:
`routing.ts:1169`, `:1356`, `:1377`, `:1600`, `:1720`, `:1755`, `:1848`, and
`subagent-model-fallback.ts:229`.

Two of those already receive a `now` and drop it before scoring —
`reevaluateAffinityQuota` (`routing.ts:1745`) and `isNativeModelQuotaExhausted`
(`subagent-model-fallback.ts:218`). The second is a consumer the phase never mentioned:
subagent model fallback reads the same score, so a stale terminal reading would push
subagents off a model whose window has already reset. Its test file is absent from the
verification list.

## Blocker 4 — 70 is EX_SOFTWARE

The round-3 amendment claimed 70 sits outside the `sysexits` block. It does not:
`sysexits.h` runs 64-78 and 70 is `EX_SOFTWARE`. It is unused in this repository, so
nothing would have collided today, but the justification written into the doc was false
and the next person to audit the choice would have found the same thing.

Take 79 — immediately above the `sysexits` range, below `128 + signal`, and unused
across `src/cli/`, `bin/ocx.mjs` and `src/update/`. Define it once in a plain-ESM module
both TypeScript and `bin/ocx.mjs` can import.

## Housekeeping

`000_plan.md`'s audit paragraph still says one round. Updated to four.
