# 261001 overnight triage and 2.75.0 release

## Objective

Process the PRs and issues that arrived overnight (2026-09-30 evening to 2026-10-01 morning KST),
land the sound ones on `dev`, fix the two new bug issues, act on the NAVER WORKS mail that asks
for a link, then release `dev` as 2.75.0 (stable) after one green final Cross-platform CI run.

## Inputs

| Item | Kind | State at P | Plan |
|---|---|---|---|
| #6339 | PR, Grok CLI version 0.2.93 → 1.0.22 (HTTP 426) | review MERGE_AFTER_FIXES | carried as #6341 with 1.0.25 (official installer's current stable) and a literal header pin; merged 6f2f6ae9cf |
| #6299 | PR, Devin late reasoning signatures | review MERGE_AFTER_FIXES (translations) | translate the docs note, carry if re-drafted |
| #6278 | PR, GUI quota popover hover gap | review MERGE_AFTER_FIXES (aria-describedby) | verify GUI tests with deps, carry |
| #6336 | PR, Cheaper Inference preset | review DO_NOT_MERGE | post reason: missing resale/routing authorization (MAINTAINERS.md), structure doc over budget |
| #6335 | PR, desktop zoom | review NEEDS_AUTHOR | post reason: shell/runtime version-skew zoom ownership |
| #6338 | issue, subagent-models bare native ids | fix in progress | land fix, close issue |
| #6340 | issue, Anthropic pool 403 failover | fix in progress | land fix with security review, close issue |
| #6337 | issue | already closed by author as superseded by #6338 | none |
| #6334 | feature request | keep open | none |
| WORKS mail 554 | TokenLab asks for a guide link under the TokenLab provider entry | Aside exec read it | PR #6342 adds the English and Korean guide links |

## Constraints

- Linear PABCD, one work-phase per cycle, each with an independent `gpt-6.1-sol` audit or review.
- At most six concurrent `gpt-6.1-sol` subagents.
- No local full test suite; per-PR gate is reviewer evidence plus `bun x tsc --noEmit` and the
  changed test files on the current `origin/dev`.
- Cross-platform CI runs only at the end: one `workflow_dispatch` on the final `dev` tip, then the
  push-event runs that release.yml requires on the promotion merge commits. Per-PR runs triggered by
  maintainer pushes are cancelled.
- External facts (vendor versions, sponsor mail, provider evidence) are gathered with Aside.
- Merges use the `dev` maintainer-integration exception; release follows MAINTAINERS.md and the
  2.71.0 procedure in `devlog/_fin/260929_release_2_71_0/041_wp4_execution.md`.

## Owner decisions recorded for this unit

- CI timing: the repository owner (@lidge-jun) instructed on 2026-10-01 that Cross-platform CI runs
  only once at the end. `MAINTAINERS.md` requires successful required checks before merge; the `dev`
  ruleset declares no required status checks (only the pull-request rule), and the owner's instruction
  governs here. Every integration comment states that the Cross-platform run for that head was
  deferred by owner instruction and names the lighter checks that did pass (hygiene, enforce-target,
  label, resolve-pr). Any failure in the final run is fixed forward before release.
- Promotion: the owner authorized release in this session ("배포까지하자"). Promotion PRs into
  `preview` and `main` merge as owner-authorized promotions, as in 2.71.0 (#6227/#6228). The
  push-event Cross-platform CI and Service lifecycle runs on each resulting merge SHA must succeed
  before the matching release dispatch.
- Attribution: carry commits use full trailers, `Co-authored-by: <login> <<id>+<login>@users.noreply.github.com>`,
  with the numeric id from `gh api users/<login> -q .id`, written into the squash commit message.

## Work-phase map

| Work-phase | Doc | Output |
|---|---|---|
| wp1 | this directory | locked roadmap |
| wp2 | 010_phase1_prs.md | overnight PRs landed or answered |
| wp3 | 020_phase2_issue_6338.md | #6338 fixed and closed |
| wp4 | 030_phase3_issue_6340.md | #6340 fixed, security-reviewed and closed |
| wp5 | 040_phase4_dev_ci.md | duplicates closed; final `dev` Cross-platform CI green |
| wp6 | 050_phase5_release.md | 2.75.0 released to npm `latest` and `preview` |

Roadmap audit: gpt-6.1-sol auditor, round 1 fail (4 blockers), round 2 near-pass; all folded or rebutted by owner instruction. Locked for wp2-wp6.
