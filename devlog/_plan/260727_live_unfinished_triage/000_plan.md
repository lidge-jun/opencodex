# 000 — live unfinished triage plan

Snapshot time: 2026-07-27T10:41:30Z.
Repository: `lidge-jun/opencodex`.
Working branch: `codex/260727-live-triage`, based on local `dev` after rebase onto
`origin/dev@7fcaa9119`.

## Loop spec

- Archetype: spec-satisfaction triage and repair loop.
- Trigger: maintainer requested live re-triage of every unfinished issue and PR, then
  safe processing one item per PABCD cycle.
- Goal: produce a current manifest and process safe bugfix/simple items against `dev`.
- Non-goals: no `main`, `preview`, or release branch changes; no automatic merge of
  auth/security/permission/data-migration/privilege-boundary changes; no new UX
  decisions except the already approved `OpenRouter Free` separate-provider direction.
- Verifier: `gh` live state, PR diff/check/review inspection, and action URLs for any
  GitHub comments/merges/closes.
- Stop condition: all live items are either processed or left in a justified
  terminal bucket.
- Memory artifact: this numbered devlog folder plus the cxc goalplan ledger.
- Resource bounds: local filesystem and GitHub via `gh`; no provider/model settings
  changes; no production release.
- Escalation condition: security/auth/credential/process-kill/paid-provider routing
  surfaces stay `needs-human/security` unless a maintainer explicitly narrows the
  decision.

## Current branch evidence

`git fetch --prune origin` moved `origin/dev` from `c05e88fdc` to `7fcaa9119`.
Local `dev` had two existing devlog commits and was rebased on top of `origin/dev`.

Current bases:

| ref | sha |
| --- | --- |
| `origin/dev` | `7fcaa9119` |
| local `dev` after rebase | `5bef68f5` |
| worktree branch | `5bef68f5` |

## Work-phase map

This first work-phase is docs-only. It creates the live manifest and appends concrete
follow-up work-phases. Later phases must process exactly one PR or one issue each.

Initial next candidates from the live manifest:

| next WP | item | planned bucket | action |
| --- | --- | --- | --- |
| WP1 | PR #526 | takeover-fix/rebase+tests | independent review found stale checks and missing direct write-path coverage |
| WP2 | PR #528 | needs-human/security + request-changes | credential-origin binding blocker in image bridge; do not merge |
| WP3 | issue #543 | comment/request-changes | answer with existing `ocx debug claude` capture switch and request marker frames |
| WP4 | issue #547 | comment/request-changes | new Claude Desktop custom-model visibility report; request exact config/log evidence |
| WP5 | issue #545 | takeover-fix/investigate | continue the 64-token classifier investigation; logging sub-bug already fixed in `7fcaa9119` |
| WP6 | PR #527 | needs-human/security + needs-author-rebase | wrong base plus process-termination/restart boundary |
| WP7 | issue #418 | takeover-fix/investigate | investigate V2 custom-parent to custom-child delegation failure |
| WP8 | issue #509 | takeover-fix/investigate | investigate JS heap watchdog gap |
