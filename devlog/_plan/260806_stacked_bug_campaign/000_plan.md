# 000 — Plan: stacked bug campaign with contributor attribution (2026-08-06)

## Objective

Land a maintainer-authored **stacked PR chain** (`stack 01..N`) against `dev`
that covers the great majority of open bug issues and open contributor bug/fix
PRs at the 2026-08-06 cutoff, **crediting every original contributor by name**.

The campaign explicitly does *not* merge contributor PRs. Each contributor's
work is either cherry-picked with authorship preserved or reimplemented with a
`Co-authored-by:` trailer plus a named citation of their PR/issue. Their PR then
receives a comment saying where their work landed and that their name went with
it.

## Base

| Fact | Value |
|------|-------|
| Worktree | `/Users/jun/.codex/worktrees/42d5/opencodex` |
| Cutoff snapshot | 2026-08-06T13:49:07Z (`.snapshot_issues.json`, `.snapshot_prs.json`) |
| Snapshot base | `origin/dev` = `43a1fdc45` |
| Working base | `origin/dev` = `e9d957bf6` (advanced during triage when #1129 merged) |
| Stack branch prefix | `codex/260806-stackNN-<slug>` |
| Open at cutoff | 49 issues, 34 PRs |

`e9d957bf6` is the working base because #1129 merged mid-triage; the two extra
commits are the maintainer's own restore-watchdog test margin and its merge.
No in-scope item depends on the difference.

## Scope rules

In scope:

- Bugs and code-level bug-like defects open at the cutoff.
- Contributor PRs that fix such a defect, whatever their state (draft,
  conflicting, over-scoped) — the *fix* is what matters, not the packaging.

Out of scope, recorded with a reason rather than silently dropped:

- Items opened after the cutoff.
- Feature programs (provider onboarding, cost overlay, remote E2EE, OMP,
  account-picker slices, localization mega-PRs).
- Roadmap/tracking issues and upstream-owned defects.
- `needs-info` issues with no reproduction on the current tree.
- Maintainer PRs already in flight (`#557`, `#1008`) — left alone deliberately.
- Release automation, version bumps, and any publish action.

## Method

`cxc-loop` HOTL over `cxc-pabcd`. Work-phase 1 (this unit) is docs-only: freeze
the snapshot, triage everything, and write every implementation phase's decade
doc to diff-level precision. Implementation begins at work-phase 2, one decade
doc per PABCD cycle, one stack PR per cycle.

Triage was executed by four parallel sol-medium lanes (two issue lanes, two PR
lanes), each required to confirm the defect against the current tree with
`path:line` citations rather than restating the reporter's claim. Their verdicts
are recorded in `001_issue_triage.md` and `002_pr_triage.md`.

## Attribution contract (the point of this campaign)

Every stack commit that derives from contributor work carries:

1. `Co-authored-by: <Display Name> <email>` using the identity from the
   contributor's own commits on their PR head.
2. A commit body naming the source PR and, where applicable, the issue.
3. A PR description crediting the contributor in prose, not only in a trailer.

Where a fix is reimplemented rather than cherry-picked, the contributor is still
credited — they found the defect and proved the code path, which is the
expensive part. The reimplementation reason is stated plainly in the PR body so
the record is honest in both directions.

## Work-phase map

Dependency-ordered. Each row is one PABCD cycle and one stacked PR; each stacks
on the previous head, and stack 01 targets `dev`.

| Phase | Doc | Subject | Issue | Source PR(s) | Credited |
|-------|-----|---------|-------|--------------|----------|
| 1 | (this unit) | Triage + roadmap | — | — | — |
| 2 | `010` | Bounded translated-SSE inspection | #1112 | #1114 | ingwannu |
| 3 | `020` | Empty native-profile stage sweep | #1120 | #1124 | ingwannu |
| 4 | `030` | Native-main ACL timeout retry | — | #1130 | luvs01 |
| 5 | `040` | Bounded rollout inspection | — | #1115 | Simon |
| 6 | `050` | Anthropic response-model identity | #1117 | #1122, #1121 | Giulio Leone, ingwannu |
| 7 | `060` | GitHub Copilot Responses normalization | #1110 | #1111 | Simon |
| 8 | `070` | Darwin eager rewrite relay gate | #1127 | #947 | 0xWinner98, biao |
| 9 | `080` | Vision raw-body image synchronization | — | #1047 | Bailey |
| 10 | `090` | Gemini/CCA reasoning-effort documentation + coverage | — | #978 | Pranav Yerramaneni |
| 11 | `100` | Routed structured-output schema preservation | — | #985 | Pranav Yerramaneni |
| 12 | `110` | Cursor structured-edit conversion | #1017 | #1036 | NexusCore |
| 13 | `120` | Reasoning-replay empty-delta handoff | — | #1126 | NexusCore |
| 14 | `130` | Usage-log attempt persistence | — | #1093 | Takashi Yamashiro |
| 15 | `140` | Effort-picker fail-closed + Pi loopback export | — | #1092, #1085 | Eachann, n3wr1ch |
| 16 | `150` | Test-home isolation + Desktop allowlist docs | #241 | #997, #999 | Yuxin Qiao |
| 17 | `160` | Closeout: attribution comments, full suite, dispositions | — | — | — |

Phase order puts small merge-clean adoptions first so the stack has a stable
base, then the larger adapted reimplementations. Phases 2-5 are near-verbatim
adoptions; 6-15 are adapted or reimplemented.

## Verification floor per implementation phase

- `bun run typecheck` exit 0
- the phase's focused test files, 0 failures
- `bun run privacy:scan` green
- `bun run lint:gui` + `bun run build:gui` when the phase touches `gui/`
- one full `bun run test` near the end of the campaign

A remembered pass is not evidence; each phase records its command output.

## Authorization boundary

Authorized for this campaign: pushing `codex/260806-stack*` branches, creating
the stack PRs, and commenting on superseded contributor PRs.

Not authorized without a fresh request: merging anything, closing any PR or
issue, force-pushing contributor branches, pushing `dev`/`main`/`preview`,
deleting branches, npm publish, releases.
