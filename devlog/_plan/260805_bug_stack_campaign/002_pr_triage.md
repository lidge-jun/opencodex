# 002 — Open PR triage (2026-08-05, vs origin/dev e44d234f0)

Source: sol-medium explorer lane B. 30 open PRs, all targeting `dev`.
Classification: 15 bug, 3 code/docs improvement, 12 feature/program.
No bug/improvement PR has an equivalent fix already merged on dev.

## Bug PRs

| PR | Author | Subject | Draft | CI | Merge state |
|---:|--------|---------|:-----:|----|-------------|
| #988 | Wibias | GUI providers quota/auth, Claude pool toggle, combos/models layout, dev session bootstrap | no | full PASS | MERGEABLE/CLEAN — only clean bug PR |
| #983 | DevMello | stop counting base64 attachments as raw characters in token estimates | no | policy-only | MERGEABLE/UNSTABLE |
| #978 | DevMello | send thinkingLevel for any model with an effort ladder (google) | no | policy-only | MERGEABLE/UNSTABLE |
| #985 | DevMello | deliver structured output to routed openai-chat models | yes | policy-only | MERGEABLE/UNSTABLE |
| #1006 | Michael-Han0608 | bounded JSON policy on HTTP SSE for DeepSeek Flash | no | policy-only | MERGEABLE/UNSTABLE |
| #1000 | WZBbiao | avoid false project config warnings | no | policy-only | MERGEABLE/UNSTABLE |
| #947 | WZBbiao | prevent Darwin rewrite stalls (streaming) | no | policy-only | MERGEABLE/UNSTABLE |
| #997 | Yuxin-Qiao | isolate usage-log fixtures from the real OpenCodex home | no | policy-only | MERGEABLE/UNSTABLE |
| #966 | Yuxin-Qiao | keep pre-connection DNS/network failures off account health (#914) | yes | policy-only | CONFLICTING/DIRTY; prior audit left mixed-5xx/redirect counterexamples |
| #928 | 0xWinner98 | repair sparse Responses snapshots (streaming) | yes | policy-only | CONFLICTING/DIRTY; changes requested |
| #933 | IMHinnG | enforce type:"object" on all tool parameters (openai-chat) | yes | FAIL (Ubuntu/Windows/macOS + enforce-target) | MERGEABLE/UNSTABLE |
| #940 | mouzhi | DeepSeek Responses UUID item ids for Codex | yes | policy-only | CONFLICTING/DIRTY; changes requested |
| #922 | luvs01 | isolate provider host transport health | no | policy-only | MERGEABLE/UNSTABLE; changes requested; #966 supersedes but is unfinished |
| #936 | lidge-jun | harden credential and runtime trust boundaries (rebase of #916) | yes | full PASS | CONFLICTING/DIRTY; needs explicit security review |
| #557 | lidge-jun | harden npm cache recovery preflight logs (update) | no | FAIL (Ubuntu/Windows; macOS cancelled) | MERGEABLE/UNSTABLE |

## Improvement PRs

| PR | Author | Subject | Note |
|---:|--------|---------|------|
| #999 | Yuxin-Qiao | docs: Desktop remote allowlist limitation (#241) | docs-only, draft |
| #569 | diegocantarero | post-sync readiness endpoint + bounded `ocx ready` wait | draft, CI PASS but CONFLICTING/DIRTY |
| #1002 | hanjianjun | configurable sidecar reasoning (vision) | includes ignored-CLI-setting defect |

## Feature programs — out of scope (12)

#811, #1003, #1004, #1005, #715, #961, #581, #998, #937, #872, #870, #812.

## Issue↔PR coupling for the stack

- #914 ↔ PR #966 (conflicting, audit counterexamples) and PR #922 (superseded
  but unfinished) — the stack should land its own clean fix and route both
  PRs to a disposition.
- #938 ↔ PR #940 (conflicting, changes requested) — same handling.
- #893 ↔ PR #928 (conflicting, changes requested).
- #875 ↔ PR #1006 (mergeable but policy-only CI; unverified against live
  DeepSeek).
