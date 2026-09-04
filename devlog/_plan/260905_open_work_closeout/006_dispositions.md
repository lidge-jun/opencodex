# 006 — Consolidated dispositions

Source: lane docs 001-005 (claude-opus-5, read-only, each re-read the index before verdict).
Base at research: `0f27bbeb3`; `origin/dev` advanced to `6580694c7` during research (one
commit touching two test files no candidate uses — re-checked by each plan writer).

## Family 1 — bug-labelled PRs (14)

| PR | Disposition | WP | Reason (evidence in lane doc) |
|----|-------------|----|-------------------------------|
| #3515 | LAND_AS_IS | wp1 | Green, approved; paired 499/502 regressions (001) |
| #3529 | LAND_AS_IS | wp1 | 3 tests RED on dev → GREEN; draft checklist is the only gate (001) |
| #3525 | LAND_AS_IS | wp1 | 6 tests RED → GREEN; exact-head CI green (001) |
| #3490 | LAND_AS_IS | wp1 | TOML table-header comment misparse reproduced RED, fixed GREEN (001) |
| #3484 | LAND_AS_IS | wp1 | Defect at `integration-routes.ts:379`; MERGEABLE, green (002) |
| #3480 | LAND_AS_IS | wp1 | Author rebased mid-review; only stale CHANGES_REQUESTED remains (002) |
| #3502 | LAND_WITH_FIX | wp2 | Three src defects live on dev; CONFLICTING; docs prose contradicts #3520 (001) |
| #3519 | LAND_WITH_FIX | wp2 | Reviewer blockers fixed on new head; docs-site sync missing (001) |
| #3489 | LAND_WITH_FIX | wp2 | Approved, green; conflict is `tests/providers/` rename + one comment line (002) |
| #3469 | LAND_WITH_FIX | wp2 | Approved, green; conflict is two test renames (002) |
| #3524 | REIMPLEMENT | wp2 | Unguarded startup `throw` reproduced; red hygiene; OAuth security surface (001) |
| #3407 | REIMPLEMENT | wp2 | Real config-path defect; 5 failing jobs, 121 behind, 166 KB PNG tracked (002) |
| #3348 | REIMPLEMENT | wp2 | 410/413 now fine; bundles disk persistence + undisclosed policy-fallback 503; split in three (002) |
| #3388 | DEFER | — | Draft, 132 behind, shards never ran; 327 lines on protected `responses/core.ts` with no review (002) |

## Family 2 — V2 passthrough (1)

| PR | Disposition | WP | Reason |
|----|-------------|----|--------|
| #3444 | LAND_WITH_FIX | wp3 | Regression proven RED on dev; hygiene fail is `unsponsored_surface` on `auth-cors.ts` (one policy row), not a defect (003) |

## Family 3 — usage/quota (4)

| PR | Disposition | WP | Reason |
|----|-------------|----|--------|
| #3447 | LAND_WITH_FIX | wp4 | Merges clean under rename detection; fix unpinned bearer in `fetchAntigravityQuota` + regression; CodeRabbit "Critical" is a false positive (003) |
| #2783 | LAND_WITH_FIX | wp4 | Three maintainer blockers still present, each localized; six bounded fixes; rebase after #3447 (003) |
| #2973 | LAND_WITH_FIX | wp4 | No substantive defect outstanding; four mechanical conflicts (003) |
| #2956 | DEFER | — | 474 behind, zero human review, two semantic conflicts (003) |

## Family 4 — else: PRs (11)

| PR | Disposition | WP | Reason |
|----|-------------|----|--------|
| #3323 | LAND_AS_IS | wp1 | Removes repo-root temp write; green (004) |
| #3530 | LAND_WITH_FIX | wp5 | `test 1/4` failure was real on the previous head and is fixed; removal test exercises the wrong seam (004) |
| #3329 | LAND_WITH_FIX | wp5 | Drops quota reset metadata for 5xx-wrapped failures (004) |
| #3421 | LAND_WITH_FIX | wp5 | Container excludes compat manifest; Compose binds 0.0.0.0 (004) |
| #2432 | LAND_WITH_FIX | wp5 | Real undocumented sentinel; stale + doc-comment naming unexported symbol (004) |
| #3531 | LAND_WITH_FIX | wp5 | Compact subset of #3528; breaks #2960 regression (label bypasses alias display) (004) |
| #3487 | REIMPLEMENT | wp5 | Correct one-line fix at a path the reorg moved (004) |
| #3528 | SUPERSEDED | — | Alias half byte-identical to #3531; `ocx effort` half is separate scope (004) |
| #3508 | DEFER | — | `logs-filter.ts` never imported by `Logs.tsx`; unreachable duplicate (004) |
| #3383 | DEFER | — | 121 behind, 15 conflicting files incl. composition root, no CI (004) |
| #2716 | DEFER | — | 118 behind, 12 conflicting files, no exact-head CI (004) |

## Family 4 — else: bug issues (12)

| Issue | Disposition | WP | Reason |
|-------|-------------|----|--------|
| #3522 | SUPERSEDED_BY_PR #3525 | wp1 | Instrumentation only; issue stays open after merge (005) |
| #3467 | SUPERSEDED_BY_PR #3469 | wp2 | Close with landing SHA (005) |
| #3462 | SUPERSEDED_BY_PR #3489 | wp2 | Do not auto-close; IPv6 path not executed (005) |
| #3406 | SUPERSEDED_BY_PR #3407 | wp2 | Reimplemented in wp2; close with landing SHA (005) |
| #3424 | SUPERSEDED (fixed) | wp6 | Fixed in `878f75417` (v2.41.0); close with that SHA (005) |
| #3464 | IMPLEMENT | wp5 | launchd bakes package-local paths (`service.ts:66-73,490-507`); skew is warn-only (005) |
| #3425 | IMPLEMENT | wp5 | `isTerminalShortWindow` needs future `shortResetAt` (`routing.ts:409-422`); 502 transient; unowned (005) |
| #3506 | DEFER | — | Needs a client progress-marker contract; #2628 settled ownership (005) |
| #3433 | DEFER | — | Reporter data brackets a Hermes plugin change; remaining ask is diagnostics (005) |
| #3352 | DEFER | — | Fail-closed entitlement by design; security-policy change (005) |
| #3320 | DEFER | — | Production XML writes SID; needs live XML (005) |
| #3245 | DEFER | — | 426 intentional; break precedes the Responses bridge (005) |

## Counts

LAND_AS_IS 7 · LAND_WITH_FIX 13 · REIMPLEMENT 5 · IMPLEMENT 2 · SUPERSEDED 6 · DEFER 10.


## Drift corrections from plan writers (origin/dev = `79e03643d` at plan time)

- `79e03643d` (#3518) migrated `server`/`storage`/`ci-workflows` test domains: #3515, #3529,
  #3525, #3484, #3323 flipped to CONFLICTING on relocated test files only (mechanical). wp1 is a
  rebase-then-merge train, not a pure merge train (010 §2).
- #3490 needs a `tests/layout.json` entry + test placed under `tests/codex-integration/`
  or `tests/test-layout.test.ts` goes red (010).
- #3530 merged as `6580694c7` with its removal-test gap unfixed → maintainer follow-up E0 in wp5 (050).
- #3531's head moved; the #2960 label regression is already fixed by the author; carry as E4 (050).
- #3528 dropped its alias half; SUPERSEDED reasoning must cite scope split, not byte identity (050).
- #3329 moved out of wp5: hand re-resolution of `src/server/responses/core.ts` and unresolved
  commit authorship (`" " <wj@nas-backup>`). Recorded as LAND_WITH_FIX pending a dedicated
  layer appended after wp5 (E7) if authorship can be resolved via the PR author login; else DEFER.
- #3489 commit email is `<opencodex-fix@local>`; trailer must use the GitHub noreply form.
- #3502 splits into B1 (OAuth policy, needs `maintainer-sponsored`) + B2 (Kiro continuation) (020).
- #3444: label path is insufficient (42 behind > READINESS_LATEST_DEV_BEHIND_MAX 10); maintainer
  carry branch chosen (030).
- Sandbox-red verifiers (EADDRINUSE on `Bun.serve({port:0})`, missing `gui/node_modules`) are
  hosted-CI-only and must not be read as regressions (020, 040).

