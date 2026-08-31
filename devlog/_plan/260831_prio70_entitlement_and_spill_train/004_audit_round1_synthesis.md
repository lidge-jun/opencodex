# 004 — audit round 1: FAIL, and what it changed

An adversarial `gpt-5.6-sol` high-effort plan auditor returned **FAIL** on the
first draft of `010`/`020`/`030`. Four blockers, all re-verified in-tree by the
main session before acceptance. This document records the synthesis
(REVIEW-SYNTHESIS-01) and the plan amendments it forced.

## Blocker 1 (accepted) — wp1 applied model-scoped doubt as account-wide denial

`CachedAccountModels.confirmed` is **one bit for the whole roster**
(`src/codex/model-entitlements.ts:223-234`), and every projection ignores the
account entirely when it is false: `entitledCodexAccountIdsForModel`,
`availableAccountGatedNativeModels`, and `isDirectCallerEntitledToCodexModel` all
require `confirmedAccountIds.has(accountId)` before consulting the model set
(`:547-550`, `:573-593`, `:527`).

So the draft's `usable` flag would have thrown away *affirmative* rows too. A
roster fetched under `0.142.2` still legitimately confirms `gpt-5.5`, `gpt-5.4`,
and `codex-auto-review`. Marking the whole account unconfirmed would hide models
the account demonstrably owns, and would re-fetch every 15 seconds forever for a
genuinely un-entitled account.

`gpt-daybreak-blue-latest` sharpens it: it is in the gated set
(`src/codex/catalog/native-models.ts`) but has **no row in the snapshot at all**,
so no measured minimum exists for it. A blanket version rule would deny it on
every path.

**Amendment.** Separate the two questions the code currently conflates:

- *Was this roster a usable answer at all?* -> stays account-scoped
  (`confirmed`). Only an unparseable response or an empty parsed roster makes it
  false.
- *Is this roster authoritative about a PARTICULAR gated model's absence?* ->
  becomes model-scoped, answered by whether the roster's own
  `clientVersion` is at or above that model's known minimum.

Positive evidence needs no version test: a returned row is a grant regardless of
which version asked. Only *absence* needs the version to be trustworthy. A model
with no known minimum (Daybreak) keeps today's behaviour — omission is denial —
because inventing a floor for it would be a guess.

## Blocker 2 (accepted) — wp2 would enumerate credentials forever when logged out

`MAIN_CODEX_ACCOUNT_ID` is always a candidate
(`src/codex/model-entitlements.ts:500-506`), but with no credential
`accountCredentialSnapshot` returns null, so the account is filtered out before any
cache entry exists (`:539-550`). A "refresh entries that are missing" rule
therefore **misses forever** on a logged-out host and runs the full resolver on
every poll — the exact cost the plan forbade, at ~24 calls/minute.

**Amendment.** The ensure needs a bounded negative memo for "no usable credential
for this account" with its own short TTL, checked before enumeration. Regression:
repeated logged-out ensures perform zero credential enumerations after the first.

## Blocker 3 (accepted) — wp3's drain had no real bound

The async `icacls` runner's timer calls `proc.kill()` and then **still awaits
`proc.exited`** (`src/lib/windows-secret-acl.ts:329-347`). Killing is not
settling: if the child ignores the kill, the await does not return, so a drain that
only awaits the tail inherits an unbounded wait at shutdown.

The draft's escape hatch was also incoherent: it said an expired cap would "leave
the resident durably recorded", but the whole reason this matters is that residents
over 2 MiB are *excluded* from the snapshot (`:1002-1018`). There is nowhere for
it to be recorded.

**Amendment.** wp3 must define settlement, not just waiting:

1. Drain with a wall-clock cap.
2. On cap expiry the fallback must be a real durable write, not the snapshot —
   either force a synchronous publication for the outstanding job, or persist the
   oversized resident to its own spill path directly.
3. `Promise.race` alone is forbidden: a late writer publishing after snapshot
   serialization is the same lost-continuation bug wearing a timeout.

If a bounded settlement cannot be established in wp3's P, the honest move is to
split it: land the drain for the common case and file the pathological
never-exiting-`icacls` case separately, rather than shipping a shutdown hang.

## Blocker 4 (accepted) — wp2's diagnostic had no transport

`/api/models` returns a bare **array** (`src/server/management/model-routes.ts:352-354`),
and both the GUI and `ocx export` depend on that shape
(`gui/src/pages/Models.tsx:402-417`, `src/cli/export-command.ts:169-185`). A
top-level field breaks them; a per-row field duplicates global state.

**Amendment.** Drop the diagnostic from wp2 entirely and make it its own
work-phase (wp4) that picks an owning endpoint — `/api/providers` already carries
`discovery`, so an additive sibling there is the natural home. wp2 stays the
refresh fix.

## Corrections to the research docs (accepted, non-blocking)

The auditor caught five citation errors and one substantive over-claim. The
over-claim matters:

- **`372000` does not feed `NATIVE_GPT56_CONTEXT_WINDOW`.** That constant is
  independently `272_000` and *overrides* the snapshot for runtime projections
  (`src/codex/catalog/metadata.ts:130`, `:155-157`). Verified. So leaving the
  snapshot stale is safe for behaviour — raw pinned-entry consumers still expose
  `372000` (`tests/codex-catalog.test.ts:2901-2909`), which is a documentation
  wart, not a defect. `010`'s decision to not edit the JSON stands, but for a
  better reason than it gave.
- Line corrections: hidden-tab polling is `gui/src/client-resource.ts:197-215,270-294`
  (not 538); `/v1/models` parallel resolution is `src/server/index.ts:1158-1164`
  (not 1155); `src/server/lifecycle.ts:489` does **not** call `process.exit` — the
  real exits are `src/server/management-api.ts:280` and `src/cli/index.ts:360,370`;
  required-ACL throws are `src/lib/windows-secret-acl.ts:877,881` (not 872).

## Confirmed sound (no change needed)

- Every load-bearing factual claim in `001`-`003` held: the floor really is
  `0.142.2`, the snapshot really records it, an empty `Set` really earns
  `confirmed: true` with the 5-minute TTL (the auditor probed it directly: no
  refetch at 15,001 ms, refetch only after 300,001 ms), `flushResponseState` really
  ignores the publication tail, and the 2 MiB exclusion really applies to residents.
- wp1 stays fail-closed: the auditor confirmed no path admits an unentitled account.
  The draft's flaw was over-denial, not under-denial.
- PR #3018 does not publish an unhardened reference: the temp is hardened before
  linking, the copy fallback hardens its destination before returning, and the state
  swap happens only after writer success.
- wp1 regressions are genuinely red today, and both masking tests are real:
  `tests/codex-model-entitlements.test.ts:226-259` gates its mock at minor version
  142, and `:79-92` asserts *confirmed* for an all-filtered roster. That file
  currently passes 20/20.
- Sequencing holds: wp1 and wp2 share `model-entitlements.ts`, so wp2 stacks; wp3
  shares no file with either and is genuinely parallel.

## wp3 test-plan correction

The auditor found drafts 3 and 4 would **pass against the PR head already** —
ordinary ACL failure tombstones and cleans up (`:261-266`,
`spill-store.ts:498-505`), and copy-fallback hardening failure already removes the
destination (`:297-315`). They are worth keeping as coverage but must not be
presented as red-first regressions. Only tests 1 and 2 (the shutdown drain) are
genuine red-first proof.
