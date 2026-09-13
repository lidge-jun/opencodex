# 006 — Consolidated dispositions

Source: lane docs 001–005, 007, 008 (claude-opus-5, read-only, each re-read the index before
verdict). Base at research: `origin/dev` = `7dc7dc99e`. Every LAND row below is conditional on
exact-head hosted CI: lanes B and C found that contributor PRs have **no `ci.yml` run at head**
(fork approval gate, `action_required`); the green marks are hygiene gates only. Every LAND
therefore dispatches CI on the carry head before merge.

## Coverage arithmetic (target 25–30 removed)

| Bucket | Items | Count |
|--------|-------|-------|
| PR merge, no sponsorship needed (wp1) | #4041 #4015 #4012 #4014 #4004 #4039 #4043 #4034 #4006 | 9 |
| PR merge, maintainer-sponsored security review (wp1b) | #3997 #4025 | 2 |
| PR merge, other authors (wp2) | #4018 #4008 #3981 #3979 #3964 #3920 #3863 | 7 |
| PR merge, small non-bug (wp3) | #3980 #3897 #3963 #3984(with fix) | 4 |
| PR merge, sponsor pair (wp3) | #3914 → #3915 | 2 |
| Issues closed by those merges | #4003 #4005 #3996 #4017 #4007 #3916 #3894 | 7 |
| Issues CLOSE with evidence (wp5) | #3994 #3989 #3464 #3320 #3245 #3266 #4001 #3255 | 8 |
| PRs CLOSE with evidence (wp5) | #4016 #2805 #2527 #2462 | 4 |
| Bounded worker fixes for open bug issues (wp4) | #4032 #4035 #4023 #3807 | 4 |
| Bun 1.4.2 (wp6) | new maintainer PR | +1 PR opened, 0 removed |
| **Total removable** | | **47** (24 PR merges + 12 closes + 7 auto-closed issues + 4 issue fixes) |

Floor without wp1b (no sponsorship) and without wp4: 40. The goal's 25–30 is met by wp1 + wp2 +
wp5 alone (9 + 7 + 5 linked issues + 12 closes = 33; #3894 belongs to wp3 and #3996 to wp1b); wp3/wp4 are surplus and can be trimmed if
CI capacity or time runs short.

## Family 1 — luvs01 fixture/bug train (lane 001)

| PR | Disposition | WP | Reason (evidence in lane doc) |
|----|-------------|----|-------------------------------|
| #4041 | LAND_AS_IS | wp1 | Wall-clock flake → fake timers; 6 pass; 0 behind dev (001 §#4041) |
| #4015 | LAND_AS_IS | wp1 | Windows fixture determinism, test-only; 20/20 SUCCESS at head (001 §#4015) |
| #4012 | LAND_AS_IS | wp1 | Test-only; lone FAILURE is hygiene comment-upsert 502 (run 34207070507, job 101998940221), not a check failure; APPROVED (001 §#4012) |
| #4014 | LAND_AS_IS | wp1 | Prompt-probe admission barrier, test-only; 75 pass (001 §#4014) |
| #4004 | LAND_AS_IS | wp1 | Child-deadline bound; closes #4003; APPROVED; shares `tests/clients/client-connect.test.ts` with #4006 → order before #4006 (001) |
| #4039 | LAND_AS_IS | wp1 | TOML terminator defect RED(4)→GREEN(26); 17/17 SUCCESS (001 §#4039) |
| #4043 | LAND_AS_IS | wp1 | Effort-cap validation gap RED(16)→GREEN(37) (001 §#4043) |
| #4034 | LAND_AS_IS | wp1 | v1 delegation guidance dedup RED(3)→GREEN(63); consumer suite 144 pass (001 §#4034) |
| #4006 | LAND_AS_IS | wp1 | Hashless journal data loss RED(8)→GREEN(34); closes #4005 (001 §#4006) |
| #3997 | LAND_AS_IS + sponsor | wp1b | Pool cooldown fallback RED(3)→GREEN(87); hygiene fails only on `unsponsored_surface` for `src/codex/auth-context.ts` (001 §#3997); closes #3996 |
| #4025 | LAND_AS_IS + sponsor | wp1b | Startup policy binding RED(15)→GREEN(31); same policy row + `auth-collision.ts`; apply after #3997 (merge-tree clean, 104 pass combined) (001 §#4025) |
| #4036 | DEFER | — | Reverses Windows reclaim fixes `933f3e6e7`/`92b121436`; unbindable-port vs killable-unverified-holder is a maintainer call (001 §#4036) |

## Family 2 — bug/compat PRs, other authors (lane 002)

| PR | Disposition | WP | Reason |
|----|-------------|----|--------|
| #4018 | LAND_AS_IS | wp2 | Spark 5h window dropped by `parseUsageQuota`; closes #4017; shares `src/codex/quota.ts` with #4008 (disjoint hunks, 17 pass combined) (002 §#4018) |
| #4008 | LAND_AS_IS | wp2 | `mergeAccountQuota` drops `customWindows` on partial header updates; closes #4007 (002 §#4008) |
| #3981 | LAND_AS_IS | wp2 | Stale app-server observation after catalog write; invalidation at both write sites (002 §#3981) |
| #3979 | LAND_AS_IS | wp2 | Inactivity timer armed after terminal event; one `clearInactivity()` (002 §#3979) |
| #3964 | LAND_AS_IS | wp2 | Direct Meta 400s on `search_content_types`; one URL added to strict set (002 §#3964) |
| #3920 | LAND_AS_IS | wp2 | `ocx recover-history --ocx-compaction`, additive; closes #3916; sole toucher of test-layout registries in this family → land last in wp2 (002 §#3920) |
| #3863 | LAND_AS_IS | wp2 | `landed-via-maintainer` covers only the startup-health slice (`9d8d11abd`, 2/16 files); combo-capability and storage-skip still absent from dev (002 §#3863) |
| #4016 | CLOSE | wp5 | Superseded duplicate of #3954 (same author/file); reverts `5cd71ec91` and `89b69a00a`; TS1117 (002 §#4016) |
| #3954 | REIMPLEMENT | DEFER→later | Session-header defect plausible but branch reverts two landed commits, fails tsc, 6 own tests fail; not in this cycle (002 §#3954) |
| #3848 | DEFER | — | CONFLICTING on `src/codex/auth-api.ts`; policy revision flagged by maintainer (002) |

## Family 3 — small non-bug PRs and sponsor pair (lanes 003, 005)

| PR | Disposition | WP | Reason |
|----|-------------|----|--------|
| #3980 | LAND_AS_IS | wp3 | Shared-`freePort` fixture inversion; test-only 12/-6; 47/47 (003 §#3980) |
| #3897 | LAND_AS_IS | wp3 | Import cycle at `src/router.ts:13` ↔ `api-key-selection.ts:6`; 10-line extraction + compat re-export; closes #3894 (003 §#3897) |
| #3963 | LAND_AS_IS | wp3 | Docs-only deletion of 60 devlog assets; no dev file references a deleted asset (003 §#3963) |
| #3984 | LAND_WITH_FIX | wp3 | Correct `useCallback` fix; hygiene/enforce-target FAIL `missing_regression_test` → carry with a hook-dependency regression test (003 §#3984) |
| #3914 | LAND_WITH_FIX | wp3 | Sponsor mechanism + OrcaRouter; 25 pass/0 fail at head; conflict only `scripts/test-layout/layout.json` + `tests/fixtures/test-layout-expected.json` (regenerate) (005 §#3914) |
| #3915 | LAND_WITH_FIX | wp3 | PackyCode preset; **depends on #3914**. 030 rehearsal: do NOT rebase (4 of 7 commits are byte-identical duplicates of #3914 and rebasing conflicts across nine i18n files); cherry-pick the three PackyCode-unique commits onto the merged #3914 result → two additive doc hunks, 67/0 + GUI 8/0 (030 §#3915) |
| #3648 #3748 #3742 #4040 #3987 #4033 #4042 #3983 #3982 | DEFER | — | New product surface / dead code / security review / protected core path (003) |

## Family 4 — bug issues (lane 004)

| Issue | Disposition | WP | Reason |
|-------|-------------|----|--------|
| #4032 | REIMPLEMENT (C1) | wp4 | `capabilityRecord?.context_length` missing from list at `src/providers/provider-fetch.ts:1399` while `max_output_tokens` read at `:1420`; 128k floor at `parsing.ts:566` (004 §#4032) |
| #4035 | REIMPLEMENT (C2) | wp4 | Dead `configured` pin never cleared: `src/codex/runtime.ts:647` skips persist when source is `fallback` (004 §#4035) |
| #4023 | REIMPLEMENT (C2) | wp4 | `management-api.ts:315` unloads before `:348` awaits teardown; `service.ts:3866` exempts non-Windows (004 §#4023) |
| #3807 | REIMPLEMENT (C2) | wp4 | Guard at `responses/core.ts:6092-6106` unchanged since #3471; only tests landed (`9cde6e735`). Reviewer must confirm anthropic path tolerates synthesized call_id (004 §#3807) |
| #3807 (rescoped at 040) | REIMPLEMENT (C2, narrower) | wp4 | 040 found the reported seed shape already admitted by `externalTaskInputContent()` (`a73bb160f`, v2.44.0); the live gap is the admission test checking for the *field* (`"call_id" in item`) so `call_id: null`/`""` still 400s. Fix is a `hasPairingKey()` predicate in `task-input.ts`; `core.ts` stays byte-identical so #3259 keeps its protection. Needs reporter confirmation of the rescope (040 §item 4) |
| #3994 | CLOSE | wp5 | Reporter-declared duplicate of #3795, fixed by #3791 in v2.46.0 (004 §#3994) |
| #3989 | CLOSE | wp5 | Fixed on dev: `src/integrations/registry.ts:193` `sourcePreservingYaml`, landed `a0e794d1d` via #4030 (004 §#3989) |
| #3464 | CLOSE | wp5 | Fixed on dev: `service.ts:497` `buildPlist` takes `deps.launcher`; four named regression tests (004 §#3464) |
| #3320 | CLOSE | wp5 | needs-info; maintainer asked 2026-09-04, no reply (004 §#3320) |
| #3245 | CLOSE | wp5 | needs-info/upstream; reporter's probe shows no POST reached the proxy; three asks unanswered (004 §#3245) |
| #3782 #3781 #3775 #3765 #3761 #3926 #3719 #3675 #3661 #3657 #3522 #3506 #3433 | DEFER | — | Product judgment, live credentials, or upstream contract (004 §DEFER) |

## Family 5 — feature issues, large/stale PRs (lanes 005, 008)

| Item | Disposition | WP | Reason |
|------|-------------|----|--------|
| PR #2805 | CLOSE | wp5 | Abandoned 3196-line registry refactor, 1724 behind, registry since rewritten (005 §#2805) |
| PR #2527 | CLOSE | wp5 | Capability shipped via `848a66d15` (`src/codex/catalog/sync.ts:1689`); note global vs provider-scoped follow-up in comment (008 §#2527) |
| PR #2462 | CLOSE | wp5 | 95-file SaaS console, no review ever, 2183 behind; redirect to roadmap #95 (008 §#2462) |
| Issue #3266 | CLOSE | wp5 | Reporter's corrected data: 19 stalls / 134,716 attempts, all rescued by failover (005 §#3266) |
| Issue #4001 | CLOSE | wp5 | 1st-party half closed via #3998/#3999; file import exists on dev (005 §#4001) |
| Issue #3255 | CLOSE | wp5 | Reporter conceded; axes separate at `src/codex/catalog/effort.ts` (005 §#3255) |
| All other lane 005/008 items | DEFER / KEEP OPEN | — | Product direction, security review (#2230 embedded secret, #3639 EntraID, #3080 sessions), active author pushes (#2527 #2355 #2351 on 09-05), roadmap trackers (005, 008) |

## Family 6 — Bun 1.4.2 (lane 007)

| Item | Disposition | WP | Reason |
|------|-------------|----|--------|
| Bun pin 1.4.0 → 1.4.2 | LAND_WITH_FIX (maintainer PR) | wp6 | 4 files move together: `package.json` (2 lines), `Dockerfile:4` digest `sha256:9114c058…`, `tests/ci-workflows/install-scripts.test.ts:68,71` hard pin, `bun.lock` (regenerated with `bun install --lockfile-only`); 352 pass/1 skip, tsc clean, re-verified at 060. Do NOT touch `MIN_FIXED_BUN_VERSION`/`MIN_BOUNDED_CODEX_WS_BUN_VERSION` thresholds or `container-bootstrap.test.ts:214` fixture (007 §traps, 060) |
| `cleanup-orphaned-workflows.yml:40` 1.3.14 | LAND_WITH_FIX (separate commit, same PR) | wp6 | Literal `bun-version: 1.4.2`, not the `setup-project-bun` composite 007 suggested: `tests/ci-workflows/cleanup-orphaned-workflows.test.ts:70-72` asserts the SHA-pinned `oven-sh/setup-bun` reference directly (composite → 6/1 fail; literal → 7/0, verified at 060) |

## Conflict map (parallel lane safety)

| File | Touched by | Rule |
|------|-----------|------|
| `tests/clients/client-connect.test.ts` | #4004, #4006 (wp1) | serialize: #4004 before #4006 |
| `src/codex/auth-context.ts`, `main-account-hard-lock-auth.test.ts` | #3997, #4025 (wp1b) | serialize: #3997 before #4025; no other wp touches |
| `src/codex/quota.ts` | #4018, #4008 (wp2) | disjoint hunks, verified stackable |
| `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json` | #3920 (wp2), #3914/#3915 (wp3), new tests in wp3 (#3984) and wp4 (#4032) | **No regeneration command exists** (030 §6: only `scripts/test-layout/move.ts:167` writes `layout.json`, and only to append `migrated`). Both are hand-maintained sorted JSON; re-insert the entry in sorted position on rebase and verify with `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` |
| ~20 sponsor files incl. `gui/src/components/ProviderSponsor.tsx` | #3914, #3915 | serialize inside wp3 |
| 9 `gui/src/i18n/*.ts` | #3863 (wp2), #3914/#3915 (wp3), deferred lane C items | serialize: #3863 and #3914 must not run concurrently (020 §#3863); wp2 lands #3863 before wp3 starts the sponsor pair |
| `src/codex/catalog/provider-fetch.ts`, `src/codex/runtime.ts`, `src/server/management-api.ts`, `src/server/responses/core.ts`, `src/service.ts` | wp4 only | no overlap with wp1/wp2/wp3 |
| `package.json`, `bun.lock`, `Dockerfile`, `tests/ci-workflows/install-scripts.test.ts` | wp6 only | land last, alone; `bun install --lockfile-only` on rebased head |

wp1, wp2, wp3, wp4 are file-disjoint across work-phases and may run in parallel worktrees;
wp5 is GitHub-only; wp6 lands last so a red lane is attributable to the runtime change.



## Audit residuals folded at A (reviewer verdict NEAR-PASS, no blockers)

- R1/R3/R4/R5: arithmetic, i18n contention, and the provider-fetch path corrected in place (000, 006).
- R6/R8: 010 ledger pointer and count corrected in place.
- R7: Co-authored-by trailers in 020/030 that use commit-metadata addresses must be resolved at
  execution with `gh api users/<login> --jq '"\(.id)+\(.login)@users.noreply.github.com"'` and the
  noreply form preferred; keep the commit address only if the id cannot be established.
- R9: #3920's `Closes #3916` is a maintainer judgment (recovery command vs restore-time migration);
  decide before writing the #3920 PR body. If not closed, wp2's linked-issue count drops by one.

## Corrections to lane docs recorded by the decade-doc writers

- 002 → 020: `gh pr diff 3964 | git apply` fails on the PR's binary screenshot; every wp2 carry uses `git fetch origin refs/pull/N/head` + `merge --squash`. `.commits[0].authors[0]` for #3981/#3979 is an automation identity with empty login; the correct trailer is `Co-authored-by: yansigit <44089734+yansigit@users.noreply.github.com>`.
- 001 → 010: #4012's 502 hygiene run `34207070507` was already superseded by `34210075482` (success) at the same head; no re-run needed. Seven ready PRs (#4041 #4015 #4012 #4014 #4004 #4039 #4034) merge in place after one workflow approval; the four drafts (#4043 #4006 #3997 #4025) are carried because `enforce-pr-target.yml:1044` keeps a contributor draft in draft until the author ticks the checklist. Trailer: `Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>`.
- 004 → 040: #4023 uses option (b) (a `self-unload` risk keyed on `OCX_SERVICE=1` + definition file → 409 `self_unload_service`) because reordering teardown breaks the landed #3008 assertion at `grok-lifecycle.test.ts:448`. #3807 rescoped as above.
- 007 → 060: workflow drift repair uses the literal version (see Family 6).
- 003/005 → 030: layout registries are hand-maintained (see conflict map).


