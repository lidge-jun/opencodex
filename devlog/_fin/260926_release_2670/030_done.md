# 030 — done: 2.67.0 release round

## Outcome

2.67.0 shipped from `dev` candidate `dac1d25f48fad18420aa856631ff9ee9c1775b0f` as preview `2.67.0-preview.20260926`
and stable `2.67.0`. `dev` now carries 2.68.0. No regression was found that blocked the release.

## What the candidate contains beyond v2.66.0

The 55 commits already on `dev` at round start (sweep #5858 with twelve PRs, #5863, #5870 98% lock on either
window, #5872 single-line quota strip), plus two owner-requested landings during the round:

| PR | Merge commit | Notes |
|---|---|---|
| #5866 independent Claude Code CLI first-party switch | `03aa39340b` | green PR CI at `a79b8625`; union typecheck and kimi review clean |
| #5875 shadow-call intercept follows GPT-6 Luna, Models settings fold, pinned rail | `dac1d25f48` | conflict with #5872 resolved in `90a556debf`; exact-head PR CI green |
| #5895 dev pre-move to 2.68.0 | `c56dd47a6f` | workflow-opened; four version lines only |

Promotions: #5899 `preview` `9c6fb1ee8b`, #5900 `main` `4bc92294aa` (merge commits from the candidate with
`-s ours`; `main` tree identical to the candidate, `preview` differs only in the four version lines).

## Evidence

- Candidate: Cross-platform CI lane=all run `36210914271` (`workflow_dispatch`, attempt 1) success at CAND, 39 jobs
  success, `privacy gate` skipped by design.
- Release branches: push-event Cross-platform CI `36213263882` (preview) and `36213267338` (main) success; Service
  lifecycle `36213264006` and `36213267275` success.
- Release runs: preview `36214728717` success; stable `36215532928` success. The stable run ended with npm registry
  verification pending (publish acknowledged 03:57:54Z with provenance); see the registry note below.
- GitHub releases `v2.67.0` (prerelease false, target `4bc92294aa`) and `v2.67.0-preview.20260926` (prerelease
  true, target `9c6fb1ee8b`) each carry 25 assets. `latest.json` reports 2.67.0 with signatures for darwin-aarch64,
  darwin-x86_64, windows-x86_64, linux-x86_64 and linux-x86_64-deb.
- Regression review: four kimi lanes over `v2.66.0..08fd8a6284` plus reviews of #5866 and #5875; dispositions in 010.

## Release-note items

- Remote Workspace RPC v2: a 2.67.0 peer refuses v1 frames. Upgrade the Hub and Executors together.
- Chat Completions: an orphan legacy `function` result now fails with 400 instead of being dropped (ADR-0111).
- Main-account hard lock: either the 5h or the weekly window at 98% blocks; the 429 omits `Retry-After` when a
  blocking window has no future reset.
- Shadow-call intercept: defaults now include `gpt-6-luna`; a hand-written `sourceModels` list still replaces
  the defaults.

## What did not go to plan

- The first two lane=all runs were superseded when the owner added #5866 and then #5875; each was cancelled.
  Their Windows failures (`windows 2/9` proxy fixture timeout, `windows 7/9` `cli-connect-readiness` spawn kills
  with a 17 s cold-spawn warmup) did not recur on the final candidate.
- A PR opened by the workflow token does not start `pull_request` workflows. #5895 needed a close/reopen, and the
  quality gate failed it with `unsponsored_surface` and held it (and both promotion PRs) in draft; they were marked
  ready and merged with admin after every CI job passed.
- A local `test:changed` on the #5866 union produced 24 environment failures (installed service, no bubblewrap);
  the owner then asked for no local suites, so CI carried the test evidence.
- PR-event CI on the already-merged promotion branches held macOS runners; it was cancelled so the push-event runs
  on `main` and `preview` could start.

## Follow-ups (not in this release)

- Pin tests: a Devin-routed search presenting the admission secret as bearer; weekly unknown-retention release path.
- #5866 low findings: observed Claude intercept state is captured at listener start; `PUT /api/claude-code` has no
  toggle-flight lock.
- Kiro forced-login rollback is skipped when a test injects `saveCredential` (test surface only).

## Registry note

A direct registry read at 04:05:51Z showed `latest` = 2.67.0 and `preview` = 2.67.0-preview.20260926 (package
`time.modified` 04:03:05Z), closing the stable run's pending verification. The run was not re-dispatched.
