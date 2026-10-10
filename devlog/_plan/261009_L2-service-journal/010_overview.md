# L2 service, restart, and config journal — roadmap

Lane L2 of the 2026-10-09 coordinator split carries three held contributor PRs onto `dev`.
Each unit ends at merge-ready: exact-head hosted CI green plus an independent review PASS.
This lane does not merge, release, comment on, or close other authors' PRs.

## Loop spec

- Surface: Codex-home config writers, service-record restart admission, Windows durable-launcher runtime selection. Class C4 (ownership, admission, and recovery guards).
- Tool and credential scope: `gh` against `lidge-jun/opencodex` for codex/* branches, PRs to `dev`, and CI reads/reruns only. No contributor-fork pushes, no workflow approvals.
- Write scope: `.tmp/lanes/L2-service-journal{,-2,-3}` worktrees only. Never the shared base worktree, `~/.opencodex`, `~/.codex`, or the running Desktop sidecar on port 10100.
- Budget: the host goal budget; the wall-clock bound is one working day per unit before it is reported as BLOCKED or NEEDS_HUMAN.
- Verification: focused test files and `bun run typecheck`, `structure:check`, and `privacy:scan` locally. The full suite and the platform matrix run in hosted CI.

## Units (dependency order)

| wp | Doc | PR source | Branch / worktree | Outcome |
|---|---|---|---|---|
| wp1 | this file | — | `codex/service-restart-journal-carry` | roadmap |
| wp2 | 020 | #6649 restart half (agentHits) | same branch, `L2-service-journal` | carry PR, ships this roadmap (contract docs only) |
| wp3 | 030 | #6774 (luvs01, from c7ac1a03 by Devin AI) | `codex/codex-config-write-lock-carry`, `-2` | carry PR |
| wp4 | 040 | #6695 (ismell0992-afk) | `codex/runtime-write-preflight`, `-3` | carry PR, redesigned |

The order follows dependency structure. wp2 and wp3 both touch recovery and ownership guards, but their files do not overlap (`src/cli/update-restart*` vs `src/codex/*`). wp4 touches `src/service/*` and `src/codex/shim.ts`, which neither earlier unit edits. The three PRs are independent and are not stacked; each rebases on the latest `origin/dev` before its final push.

## Cross-lane boundary

L1 (Desktop sidecar CLI authority) owns `bin/ocx.mjs`, `src/update/runtime-ownership.mjs`, `src/update/install-detection.mjs`, and Desktop detection. No L2 unit edits those files. wp2 consumes shared service-state parsing and lease APIs unchanged. Before each B phase, check whether L1's branch touches any file in that unit's change map, and record the result in the unit doc.

## Architect consultation

Three read-only gpt-6.1-sol architects produced proposals against `origin/dev` c15037b324 (agents 01a11e35-f359 wp2, 01a11e35-f422 wp3, 01a11e35-f578 wp4). Main dispositions are recorded per decision ID in 020–040.

The same architects ran a reflection check on this plan. All three returned MISALIGNED with specific gaps, and every gap is folded into the unit docs: 020 and 040 have a "Reflection dispositions" section, and 030's contract absorbs them directly. Detailed pre-merge review findings for 030 stay in gitignored `.tmp/L2-scratch/`, following the AGENTS.md security-notes rule.

## Roadmap lock (wp1)

- **Audit trail.** Independent gpt-6.1-sol auditor 01a11e3f: FAIL with five blockers (publication safety, recovery write points, guard activation, absent config root, production admission), folded; FAIL with three, folded; then PASS at 9d256c895d. Each unit doc carries its "A-audit dispositions".
- **Entry condition for each unit.** P revalidates the unit doc against the then-current `origin/dev`. It records whether L1's branch `codex/desktop-sidecar-cli-authority` touches any file in the unit's change map (`git diff --name-only origin/dev...codex/desktop-sidecar-cli-authority`). It also records whether `dev` moved any file the unit edits since c15037b324.
- **Exit condition for each unit.** The PR targets `dev` with the full template, co-author trailers, and exact-head CI green. An independent sol review passes; wp2 and wp3 also need a security review. The PR is left unmerged and reported merge-ready.
- **Publication.** This roadmap ships with the wp2 PR. 030 stays a scope note until the #6774 carry merges; its outcome is then recorded in `devlog/_fin/`.
