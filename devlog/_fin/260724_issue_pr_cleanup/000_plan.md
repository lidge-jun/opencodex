# 260724 Issue/PR Cleanup Loop — 000 Plan (HOTL, 12 work-phases)

Goal: `opencodex-open-issue-pr-cleanup-loop-hotl-12-pab`.
Branch: `codex/260724-issue-pr-triage` off `origin/dev` (tip cc7bb577).
Sol medium subagents: unlimited (A-gate reviews + B-gate help).
Merge authority: maintainer pre-approved the specific mutations named per WP.
Never main/preview. Every merge requires CI-green + mergeable head on dev.

## Dependency-ordered work-phase map

Ordering rationale: the two files with cross-PR overlap are
`src/server/responses/core.ts` (touched by #390 and #394) — so #390 merges
before #394 and #394 rebases after. Investigations (no repo mutation) are
cheap and unblock their code cycles, so each investigation cycle precedes its
optional fix. GUI merge (#393/#340) is last because CI on that head is still
finishing.

| WP | Unit | Type | Decade doc | Depends on |
|----|------|------|-----------|------------|
| WP1 | Roadmap (this) | docs | — | — |
| WP2 | #398 sidecar graceful degradation + 2 follow-up issues | code + issues | 010 | — |
| WP3 | #320 native-auth-expiry investigation | investigate + comment | 020 | — |
| WP4 | #390 → #382 merge | merge | 030 | — |
| WP5 | #389 model-switch visibility + ocx sync | investigate → merge/report | 040 | — |
| WP6 | #397 openai-chat system-first merge | merge | 050 | — |
| WP7 | #394 rebase on dev + merge | rebase + merge | 060 | WP4 (core.ts) |
| WP8 | vision sidecar #349/#344 investigate + fix | investigate + maybe code | 070 | — |
| WP9 | #338 slow-calls close + re-test request | comment + close | 080 | — |
| WP10 | #396 close (Claude Desktop unofficial) | comment + close | 090 | — |
| WP11 | #395 404 log-flood investigate + comment | investigate + comment | 100 | — |
| WP12 | #340 verify + merge #393 | verify + merge | 110 | — |

## Scope

IN: `src/`, `gui/` (GUI only for #393/#340), `devlog/`, and GitHub issue/PR
state for #398/#320/#390/#382/#389/#397/#394/#349/#344/#338/#396/#395/#340/#393.
OUT: main/preview; provider-add PRs (#403/#385/#177/#178/#201); cursor items
(#399/#402/#373/#376); upstream-tracking (#241/#92); other roadmap/features.

## Terminal outcomes per WP

DONE = named artifact exists (merged SHA / posted comment URL / created issue
numbers / landed code+tests). NOOP if already handled. BLOCKED if a merge
needs author-side conflict resolution. NEEDS_HUMAN if a mutation exceeds
pre-approved scope. UNSAFE for security-boundary changes (auth/credential/
release workflow) without explicit review.

## Verification

`gh pr/issue` state, `git log` SHAs, `bun run typecheck` + focused `bun test`
output captured as checkOutput for any code cycle.
