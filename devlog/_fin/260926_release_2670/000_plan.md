# 260926 release 2.67.0 — plan

## Reader summary

`dev` at `08fd8a6284` carries 55 commits since v2.66.0: the twelve-PR sweep #5858, the
Windows cleanup fixes #5863, the main-account 98% hard lock for either window (#5870) and the
single-line quota strip (#5872). Its version line is already 2.67.0 (#5852). The owner asked
(2026-09-26) for cross-platform CI regression verification and a release, with unlimited kimi
subagents, and for the local checkout to be fast-forwarded afterwards. No pull request lands in
this round unless a regression is proven; the candidate is `dev` as it stands.

## Loop spec

- Archetype: satisfy-spec, multi-cycle HOTL; one PABCD cycle per work-phase; wp1 is this
  docs-only roadmap.
- Goal: candidate green on Cross-platform CI lane=all, regression review with no unfixed
  blocker, `dev` pre-moved to 2.68.0, 2.67.0 and 2.67.0-preview.20260926 published and
  verified, local `dev`/`main`/`preview` equal to origin.
- Non-goals: landing open contributor PRs; raising any file-size cap; direct pushes to
  `dev`/`main`/`preview`; security write-ups in tracked directories; rewriting history.
- Verifier: job tables of the lane=all run at the candidate, push-event CI and Service lifecycle at
  both promotion SHAs, `release.yml` outcome rows, npm dist-tags, `gh release view`,
  `latest.json`, `git rev-parse` local vs origin.
- Stop condition: 2.67.0 published and verified, or a terminal outcome below.
- Terminal outcomes: DONE; UNSAFE if a proven regression cannot be fixed in-round (release
  withheld); BLOCKED for a release gate that cannot pass after documented retries; NEEDS_HUMAN
  for an owner decision (for example a security-sensitive fix).
- Resource bounds: no token or wall-clock budget set by the owner. Tool scope: gh (dispatch of
  `ci.yml`, `dev-version-bump.yml`, `release.yml`; job reruns; PR creation; admin merges with
  `--match-head-commit`), git in the native checkout and `/tmp` scratch worktrees, local bun
  tests. Kimi subagents (read-only leaves) for architecture, regression review and audit.
- Memory artifact: this unit, the goalplan under
  `.codexclaw/goalplans/release-opencodex-2-67-0-preview-stable-from-the/`, `030_done.md` at the end.

## Phase map

| wp | Doc | Change | Depends on |
|---|---|---|---|
| wp1 | 000 (this) | roadmap | — |
| wp2 | [010](010_wp2_candidate_ci_review.md) | candidate CI, regression review, fixes if proven | wp1 |
| wp3 | [020](020_wp3_release.md) | pre-move, promotion, publish, verify, local ff, close | wp2 |

## Cross-cutting rules

1. Exact-head evidence: a run counts only when its `headSha` is the SHA being judged and every
   job concluded `success` at its latest attempt (`privacy gate` skipped on
   `workflow_dispatch` by design).
2. Windows runner-stall signatures (`spawnSync ETIMEDOUT`, 480 s batch timeout with each file
   passing alone, `EPERM` on temp cleanup) get one `gh run rerun --job`. A second identical
   failure, or any non-Windows failure, is a defect.
3. A defect gets a focused fix PR to `dev` merged at a green exact head; the candidate moves to
   the new `dev` tip and gets a new lane=all run. Review findings follow the same rule only
   when confirmed by reading the code at the candidate or by a failing test.
4. Runners: competing queued or in-progress runs may be cancelled by hand one at a time after
   reading workflow, branch and event. Never cancel runs on `main`, `preview`, the candidate
   run, this round's PR runs, or `Release`.
5. `PV=2.67.0-preview.20260926` is fixed now (KST publish day) and reused by every later
   command, even if the publish crosses midnight.
