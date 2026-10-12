# 070 — done: 2.66.0 release round

## Outcome

2.66.0 shipped from `dev` candidate `82cb66e82da2f4bbcd094086ad2970d19c1612cd` as preview `2.66.0-preview.20260925` and stable
`2.66.0`. Every PR in scope landed; none was dropped. `dev` now carries 2.67.0.

## What landed on `dev`

| Order | PR | Merge commit | Notes |
|---|---|---|---|
| wp2 | #5847 direct-encoder heartbeat keepalives | `86e386b821` | owner's local fix; closed the #5806 x #5820 union regression |
| wp3 | #5006 Codex pool alias and `auto` | `6975fc37fe` | green at head; union re-proved locally |
| wp4 | #5837 linear fragmented stream work | `34ef9b12d6` | review findings fixed by the author |
| wp4 | #5835 release bounded response resources | `e34cb3db3a` | |
| wp4 | #5826 native Claude tiers 1M | `bcdbfc6ba7` | |
| wp5 | #5838 durable management mutations | `b0efef5db0` | security sign-off; two dev-parity follow-ups |
| wp5 | #5757 Claude-intercept proxy authentication | `8182562648` | security sign-off |
| wp8 | #5754 hosted search for runTurn adapters | `db12855fab` | stale contract test updated by maintainer commit `223c46bbcc` |
| wp6 | #5776 external Codex ownership reporting | `4183609d55` | structure budget fix |
| wp5 | #5839 Cursor foreground shell fail-closed | `929d4ff8e1` | security sign-off; behavior change below |
| wp6 | #5780 remove only recorded catalog backups | `9c28acf6a1` | structure budget and wording fixes |
| wp6 | #5778 single-target retry after cooldown | `82cb66e82d` | ratchet cap restored, cases moved |
| wp7 | #5852 dev pre-move to 2.67.0 | `ba3b3c56fa` | prepared by hand (see 060) |

Promotions: #5854 `preview` `0c37e74002`, #5855 `main` `e70b3d86fb` (merge commits from the candidate with
`-s ours`; main tree identical to the candidate, preview differs only in the four version lines).

## Evidence

- Candidate: Cross-platform CI lane=all run `36142367892` (`workflow_dispatch`, attempt 1): 39 success, privacy gate skipped by design.
- Promotion SHAs: push-event Cross-platform CI `36145445621` (preview) and `36145464653` (main) success;
  Service lifecycle `36145445278` and `36145464796` success.
- Release runs: preview `36148350474` success; stable `36150657310` success. Both runs ended with npm registry verification pending (publish acknowledged, read-back not yet visible); a direct registry read at 15:21Z showed `latest` = 2.66.0 and `preview` = 2.66.0-preview.20260925. GitHub releases `v2.66.0` and `v2.66.0-preview.20260925` each carry 25 assets; `latest.json` reports 2.66.0 with signatures for darwin-aarch64, darwin-x86_64, windows-x86_64, linux-x86_64 and linux-x86_64-deb.
- Every PR merged at an exact head whose required checks ran and passed (details in each PR's integration comment
  or owner review). Security sign-offs live on #5838, #5757, #5839 as approving reviews; the reviews themselves
  stayed in scratch.

## Behavior change to call out

#5839: Cursor foreground native shells (`shellArgs`, `shellStreamArgs`) are now refused before spawn on every
platform until a kernel-backed descendant owner exists (ADR-0122). It affects only installs that opted into
`nativeLocalExec` (default off); background shells and other native operations are unchanged.

## What did not go to plan

- Close/reopen does not rebuild a PR's merge ref; seven reopened runs re-tested the stale pre-#5847 merge. Fresh
  CI needs a new head (`gh pr update-branch` or a push). Cost: one CI wave.
- #5754's earlier CI had never run tests (fork approval pending), so a contract test it contradicts was only found
  by the local union check.
- Docs-only budget overruns (`structure/config.md`, `structure/catalog.md` at 600 lines) appeared only after
  `dev` merged into #5776 and #5780; the per-PR structure gate cannot see them earlier.
- A maintainer test move (#5778) carried a duplicated helper block that bun tolerated and `tsc` never saw,
  because `tsconfig.json` includes only `src`. The independent audit caught it.
- Kimi hit its 5-hour quota mid-round; later subagents ran on gpt-6-luna and then gpt-6-sol at the owner's request.
- A full `test:changed` inside `~/.codex/worktrees` fails fixture cleanup by design (real Codex home guard);
  local suites ran in a `/tmp` worktree at the same commit.

## Follow-ups (not in this release)

- Two accepted review follow-ups on #5838 and one on #5780 are tracked in those pull requests' review threads;
  details stay there until they are fixed.
- `main`'s `dev-version-bump.yml` is now the hardened #5786 version after this promotion; the next pre-move
  can use the workflow again.
- Deferred PRs from the readiness review remain open: #5790, #5147, #5831, #5758, #5836, #5756.
