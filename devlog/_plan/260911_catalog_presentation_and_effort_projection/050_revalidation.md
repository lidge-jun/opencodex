# P revalidation — second session, 2026-09-11

Session `01a08e7d-be48-72f0-9063-fb3f26ea2eb8` (hook-bound, CODEX_THREAD_ID verified
against the SessionStart line) resumed this unit after the first session stopped at
plan-only. This document is the P-phase revalidation record for the resumed cycle.

## What changed since the plan was written

1. **The user authorised the full cycle.** The first session's stop condition was
   plan-only; the user then instructed this session to proceed (`진행해줘`) and to
   use `xai/grok-4.6` subagents without a cap. `000_plan.md` loop spec updated.
2. **Phases 1 and 4 are already implemented, uncommitted**, on branch
   `codex/260911-clamp-expiry` (base: `dev` @ `babb76449`). `git diff` shows:
   - `src/codex/runtime.ts` — `liveRemovedEfforts` + `UNCLAMPABLE_REASONING_EFFORTS`;
     `effortClampAppliesToRuntime` is now version-aware on the same-path branch
     (Phase 1) and inert when only `max`/`ultra` are named (CLAMP-04).
   - `src/cli/doctor.ts`, `src/cli/status.ts`, `src/server/management/config-routes.ts`
     — all three surfaces now read the same predicate (Phase 4 core).
   - Tests inverted per GAP-1: `codex-runtime.test.ts` (601-region seeds changed to
     `["xhigh"]`, three new tests), `cli-status-json.test.ts:396,421`,
     `settings-stream-mode.test.ts:163,190`.
   The authorship of this diff is not recorded anywhere this session can see — no
   other cxc session file exists and the ledger has no B entry. Treated as user-
   authorised work in progress and adopted as this cycle's B baseline.
3. **GAP-1 resolved: CLAMP-04 ships.** The tree is the decision. See `040_open_gaps.md`.
4. **Phase 3 stays withdrawn** (GAP-2). The account-roster probe needs a live ChatGPT
   token; not attempted.

## Remaining B scope (revalidated against `030_test_impact.md`)

- `src/codex/catalog/effort.ts` — the CLAMP-01 predicate at the keep-filter
  (`clampEntryToCodexSupportedEfforts`, :357), gated default-repair at BOTH
  `:363-367` (Reserve branch) and `:378` (shared block). The CLAMP-05 reserve keep
  falls out of the filter — `:466,472` are effects, NO splice special-case
  (A-audit round 2 correction). **Not yet implemented** — the tree diff does
  not touch `effort.ts`, so until B lands it, `liveRemovedEfforts` is a forward
  reference and status/doctor would under-report a clamp that sync still applies.
- Test inversions still pending: `codex-catalog.test.ts` :7051, :7077, :7095, :7107;
  `codex-runtime.test.ts:1005`; reserve keep-case added near `reserve-catalog.test.ts:239`.
- Must-stay-green: `reserve-catalog.test.ts:239,252`,
  `client-catalog-compatibility.test.ts:37,51,76,97` (CLAMP-02 / #4207 gate),
  `codex-catalog.test.ts:7086,7115`.
- Docs-site: Phase 2 changes user-visible behaviour, so a docs note is owed (Phase 4).

## Verifier re-run

`bun test tests/codex-integration/codex-runtime.test.ts tests/codex-integration/catalog-go-exact-efforts.test.ts`
— attempted at P; queued behind a concurrent `bun run test:changed` (pid 11292,
started 12:20:56 by a process outside this session). Result recorded in C with the
fresh run. The verifier command exists and reads the target (unchanged from `010_evidence.md` §5).

## Collision note

A `bun run test:changed` run owned by another process is active in this working
tree. This session re-checks `git status`/`git diff` before every B edit and does
not revert hunks it did not write.
## A-audit round 1 synthesis (2026-09-11, reviewer `xai/grok-4.6` "Tesla")

VERDICT: FAIL, two blockers. Both accepted, none rebutted.

1. **Reserve keep must fall out of the `:357` keep-filter, not a `:466/:472` splice
   exception.** Correct — a splice special-case would leave an empty-ladder Reserve
   row. `000_plan.md` Phase 2 mechanism and CLAMP-05 paragraphs rewritten: the
   predicate site is the filter at `effort.ts:357`; the Reserve default-repair is
   `:363-367` (not `:378`, which is unreachable for Reserve because of the early
   return); `:466/:472` are pure effects.
2. **Phases 1+4 must not land without Phase 2.** Correct — `liveRemovedEfforts`
   already hides rungs the clamp still removes. Recorded as a landing constraint in
   `000_plan.md`: one branch, one landing.

Reviewer-verified facts folded into `030_test_impact.md`: the default-repair test
lives at `codex-runtime.test.ts:1005` (not 940); the must-keep persist-seed line
numbers are stale and those tests are located by name.

Verifier baselines the reviewer ran fresh: Phase 1 pair 45 pass / 0 fail; Phase 2
gate trio 346 pass / 0 fail (pre-CLAMP-01 baseline — inverting them is B's work).

## B-phase discoveries (2026-09-11)

- **030's invert list missed one test.** `bun run test:changed` caught
  `codex-convergence-account-selectors.test.ts:916` ("convergence clamps native, routed,
  and account rows to observed runtime support") still expecting `max`/`ultra` stripped.
  Inverted: the four rows now assert the surviving-rungs invariant (observed ∪
  {max,ultra}), and the full-ladder routed row proves the exemption ran (ladder and
  `ultra` default verbatim). The generic invariant replaced a blanket `toContain` because
  account-projection rows legitimately ship narrow ladders (`["medium","max"]`) — the
  exemption preserves, never adds.
- **Pre-existing environmental failures, proved on base.** `test:changed` also failed
  cursor-integration-status (gateway `apiKeyMode`), update-pnpm ×3 (EFAULT / POSIX shims
  on Windows), and a 5s bearer-admission timeout. A pristine worktree at the merge base
  (`babb76449`) fails the same five, so they are not this diff's. Worktree removed after
  the check.
- **codexclaw tooling issue filed.** `cxc session current`/`session bind` cannot resolve
  the native session cwd on this desktop install (CODEX_THREAD_ID is set and matches the
  SessionStart binding): https://github.com/lidge-jun/codexclaw/issues/134
*** End Patch
