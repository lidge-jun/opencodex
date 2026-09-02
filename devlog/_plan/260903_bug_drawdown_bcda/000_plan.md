# 000 — bug_drawdown_bcda: Plan

> DIFFLEVEL-ROADMAP-01: write this doc to full diff-level precision (exact paths,
> NEW/MODIFY/DELETE, before/after diffs) BEFORE P -> A. An empty scaffold does not
> satisfy the rule; the A-phase reviewer FAILS outline-only phase docs.

## Objective

Drive every open `bug`-labelled pull request and `bug`-labelled issue in
lidge-jun/opencodex to a terminal state on `dev`: squash-merged, closed with
evidence, or explicitly recorded as blocked. The campaign runs as a chain of
PABCD work-phases in the managed worktree
`/Users/jun/.codex/worktrees/bcda/opencodex`, with parallel `gpt-5.6-sol`
(effort high) read-only investigators feeding each phase's plan.

### Evidence base (captured 2026-09-03, live `gh`)

Open bug-labelled PRs:

| PR | Title | Draft | Mergeable | Head | CI at capture |
|----|-------|-------|-----------|------|----------------|
| #3254 | fix(chat): share transient retry budget across native recovery legs | no | MERGEABLE / UNSTABLE | `49858a2d` | every check SUCCESS (31 checks, CodeRabbit neutral) |
| #3256 | fix(oauth): honor Kiro reset-aligned cooldown without Retry-After | no | MERGEABLE / BLOCKED | `821462f9` | `enforce-target` FAIL `unsponsored_surface`, `hygiene` FAIL |
| #3246 | fix(responses): bridge write_stdin through exec | yes | MERGEABLE / BLOCKED | `db96ae50` | `enforce-target` CANCELLED, hygiene SUCCESS |
| #3270 | fix(usage): aggregate complete ledger incrementally | yes | MERGEABLE / BLOCKED | `f5aaf120` | `enforce-target` FAIL x2 + CANCELLED |

Open bug-labelled issues: #3280 (GUI full-config PUT rejected after providers
JSON save), #3279 (GUI 401 flap on `/api/*` while health is OK), #3245 (macOS
Codex 0.152.0 stream disconnects, `upstream-tracking`), #3152 (dashboard log
panel jitter), #3141 (aggressive `responses-state.json` disk writes), #1527
(Cursor adapter large-context collapse).

## Loop-spec

- Loop archetype: verifier-defined (spec-satisfaction repair). Each phase's
  verifier is the exact-head GitHub check rollup plus a focused local test.
- Write scope: `src/`, `gui/`, `tests/`, `docs-site/`, `devlog/_plan`,
  `devlog/_fin` in this worktree only. Branches carry the `codex/` prefix and
  target `dev` through a pull request.
- Out of scope: releases, tag pushes, promotion to `main`/`preview`, `go/`,
  unrelated dependency bumps, credential-spending actions, and any
  pre-disclosure security note inside a tracked directory.
- User-imposed constraints: never run the repository-wide suite (no bare
  `bun test`, no `bun run test`); push with `--no-verify`; merge with
  `gh pr merge --squash --admin`; close linked issues manually after the change
  lands on `dev`.
- Bounds: for phases that produce a diff, exact-head CI is the verification
  signal, backed by a focused local test. For phases that terminate as
  NEEDS_HUMAN (wp6, wp9) neither exists: there is no PR head and no executable
  RED assertion, and manufacturing one would encode a guess. Their verification
  is the posted analysis — ruled-out causes with file:line citations plus the
  exact capture the reporter must supply.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp0 | `000_plan.md` | This roadmap; locks the phase map | — |
| wp1 | `010_phase1.md` | PR #3254 — land the green approved fix | wp0 |
| wp2 | `020_phase2.md` | PR #3256 — clear `unsponsored_surface`, then land | wp0 |
| wp3 | `030_phase3.md` | PR #3246 — repair, mark ready, land | wp0 |
| wp4 | `040_phase4.md` | PR #3270 — repair, mark ready, land | wp0 |
| wp5 | `050_phase5.md` | Issue #3280 — GUI full-config PUT rejection | wp0 |
| wp6 | `060_phase6.md` | Issue #3279 — dashboard 401 flap | wp0 |
| wp7 | `070_phase7.md` | Issue #3141 — `responses-state.json` write storm | wp0 |
| wp8 | `080_phase8.md` | Issue #3152 — log panel jitter | wp0 |
| wp9 | `090_phase9.md` | Issues #3245 and #1527 — disposition with evidence | wp0 |

## Accept criteria

Mirrored into the goalplan `criteria[]` as `c-1` through `c-11`. Terminal state
is outcome-dependent, not uniformly a merge:

- MERGED items (wp1-wp4, and any issue whose fix lands): the squash-merge sha
  must be an ancestor of `origin/dev`, proved by `git fetch origin dev` plus
  `git merge-base --is-ancestor`; the full exact-head check rollup must have
  been inspected rather than `gh pr checks --required` being empty; and any
  linked issue must be closed with a comment naming the merge commit.
- NEEDS_HUMAN items (wp6 for #3279, wp9 for #3245 and #1527): no merge sha
  exists and none is required. The evidence is the posted analysis — the
  ruled-out causes with file:line citations, and the exact capture the reporter
  must supply. These are terminal despite having no diff.
- BLOCKED / UNSAFE items: terminal on a recorded blocker naming the specific
  gate, dependency, or unreviewed security surface.

A remembered green is never evidence for any of these.
