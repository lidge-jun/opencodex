# 060 — Audit round 1: nine blockers, and what changed

An independent reviewer audited docs `000`–`050` against the tree at
`124a2b1487996f8a8ebb2067b22c9e758fa6016f` and returned **FAIL, blockers=9**. Every one
was verified against real code. This document records the disposition; the amended rules
here **supersede** the corresponding text in the earlier docs.

## Environment (blocker 8) — fixed, not amended

The worktree had no `node_modules`, so the entire verifier matrix in `050` was
unrunnable: `bun x tsc --noEmit` exited 1 on missing `bun-types`, the suite reported 774
failures from a missing `zod/v4`, and `bun run lint:gui` exited 127 on a missing
`oxlint`. `bun install` now completes (103 packages). `bun run privacy:scan` and
`bun run skill:surface:check` were already exit 0.

**Amendment to `050`:** the verification matrix gains a preflight row — `bun install`
at the repo root, and `cd gui && bun install` before any GUI gate. A verifier that cannot
run is not a verifier.

## Blocker 5 — the insertion point does not exist. FOLDED.

There is no `chooseFailoverAccount`. The real owner is `rotateGenericOAuthAccountOn429`
(`src/oauth/generic-account-failover.ts:157`), whose ring traversal starts *after* the
failed account (`:184`) so repeated 429s walk the roster.

**Amendment to `030`:** rank composes with the ring rather than replacing it.
`eligibleFailoverAccounts` already returns the eligible ids; build that list, apply the
stable rank when quota data exists, and take the first entry. When no quota data exists the
ranked list must be identical to the ring order starting after the failed account, so the
existing deterministic behaviour is preserved exactly.

## Blocker 1 — "pre-request selection" was claimed but not designed. PARTIALLY FOLDED, PARTIALLY DESCOPED.

Correct: `rotateGenericOAuthAccountOn429` runs only inside the `status === 429` branch
(`src/server/responses/core.ts:5574`), so ranking there is recovery ordering, not
pre-flight selection. And `rankAccountsByHeadroom(provider, ids)` takes no model, so
calling the result "model-aware" was false.

**Amendment to `002` and `030`:** the head-to-head table drops the "model-aware" and
"before the request" claims outright. What we deliver in this unit is *recovery ordering
that is quota-aware*, which is still a real improvement over walking the ring blind, and
which we will describe as exactly that.

A genuine pre-dispatch selection seam — choosing the account before the first request,
with model eligibility — is a larger change to the request path and becomes its own
work-phase rather than an unbacked sentence in this one. Recorded as follow-up, not
claimed as shipped.

## Blocker 3 — the live decrement has no denominator. REMOVED.

`ProviderQuota` stores percent and reset, never absolute used/limit
(`src/providers/quota.ts:93`), so `100 / limit` cannot execute from cached state. Worse,
Kiro meters *fractional* credits: one successful turn is not one credit, so any fixed
increment is a fabrication that would misrank accounts.

**Amendment to `030` and `002`:** `markAccountObservedUsage` is deleted from the plan,
and the "live decrement between polls" row is removed from the head-to-head table. We do
not get to claim an advantage we cannot compute. The honest position: our data is as fresh
as the 5-minute TTL and the vendor's own 5-minute update floor allows.

## Blocker 2 — snapshot metadata had no consumer. FOLDED.

`fetchAccountQuota` caches `ProviderQuota | null` (`:1426`), so extracting `.quota`
and dropping `subscriptionTitle` / `exhausted` / `nextResetAt` / `overageEnabled`
orphans all four.

**Amendment to `010`/`020`:** each field must reach a consumer or leave the design.

- `exhausted` + `nextResetAt` → consumed by the exhaustion cooldown in `030`. To reach
  it they need a home: add a module-private `kiroAccountUsageState` map in
  `src/providers/kiro-usage.ts`, written by the fetcher and read by the cooldown seeder.
  It is not part of `ProviderQuota` and is not serialized to any API.
- `overageEnabled` → consumed only as an input to `exhausted`. It stops being a
  returned field and becomes a local variable.
- `subscriptionTitle` → **dropped from this unit.** `ProviderQuota` has no plan-name
  field and the GUI has no place to render one; adding both is scope creep. Plan tier is
  simply not surfaced by this unit. (An earlier version of this line claimed the tier was
  "visible from the limit value" — that was wrong: `ProviderQuota` serializes percent and
  reset, never the absolute limit. Corrected in round 2.)

## Blocker 4 — the Anthropic fail-closed rule breaks Kiro probes. FOLDED.

Sharp catch. `getTokenForAccountQuotaProbe` refuses to refresh a background
`source: "local-cli"` account (`:1549`) because Anthropic's lock can adopt a mismatched
Claude CLI identity. But Kiro's *imported* credentials are marked `local-cli`
(`src/oauth/kiro.ts:301`) for an unrelated reason — they came from the Kiro CLI database.
Reusing that rule verbatim would make every inactive Kiro account's quota go unavailable
the moment its token expired, which is precisely when a pool needs it.

**Amendment to `020`:** the fail-closed branch stays Anthropic-scoped. Kiro resolves
through `getValidAccessSnapshotForAccount(provider, accountId)`
(`src/oauth/index.ts:435`), which is account-scoped and returns the bearer *and* the
`kiro` routing metadata from one snapshot — which also strengthens the anti-cross-pairing
invariant, since token and ARN now provably come from a single read.

## Blocker 6 — the helpers are module-private. FOLDED.

`REQUEST_TIMEOUT_MS`, `normalizeResetAt`, `normalizePercent` and `readQuotaJson` are
private to `quota.ts`.

**Amendment to `010`:** extract them into a new neutral `src/providers/quota-wire.ts`
(timeout constant, number/percent/reset normalizers, bounded JSON reader) that both
`quota.ts` and `kiro-usage.ts` import. Pure move, no behaviour change; `quota.ts`
re-exports nothing new publicly. This is a prerequisite step inside phase 1, and the
existing `tests/provider-quota.test.ts` is the regression proof that the move is inert.

## Blocker 7 — only the ARN region was validated. FOLDED.

`apiRegion` and `ssoRegion` come from external credential files
(`src/oauth/kiro-credentials.ts:285`) and were interpolated into the hostname unchecked,
which makes the claimed request-forgery guard hollow.

**Amendment to `010`:** one `safeRegion()` allowlist parser (`^[a-z0-9-]{1,32}$`)
applies to *every* candidate — ARN field, `apiRegion`, `ssoRegion` — and anything failing
it falls through to the next candidate, then to `us-east-1`. Accept criteria 10 expands to
hostile `apiRegion` and `ssoRegion` cases, not just the ARN.

## Blocker 9 — the `0.25` weight reads as an AGPL port. FOLDED.

Naming kiro-lb's exact constant while claiming independent derivation is the weakest kind
of clean-room claim, and the reviewer is right to refuse it.

**Amendment to `030`:** unknown ordering becomes **categorical**, with no borrowed
constant: `known-healthy > unknown > known-exhausted`, where healthy/exhausted is our own
`exhausted` verdict from `010`. Within the known-healthy bucket, sort by descending
headroom; ties keep ring order. No numeric weight is imported from the reference, and the
comparison document says only that both projects rank unknown between the two extremes —
which is an obvious design necessity, not a borrowed policy.

## Corrections to record

- The real CLI formatting test is `tests/cli-headless-parity.test.ts:744`, not
  `tests/account-cli.test.ts`. `040`'s verifier row is corrected.
- `tests/provider-account-quota.test.ts` lines 206/209/210 are the only Kiro assertions;
  the `xai` substitution preserves intent.
- No import cycle exists: `quota.ts` has no path back to `generic-account-failover.ts`.
- No `src/lab/` reachability is introduced.
- The wire transcription in `001` is accurate.

## Residual

Pre-dispatch, model-aware account selection is deferred to a follow-up work-phase.
Everything else is folded into the amended plan above.
