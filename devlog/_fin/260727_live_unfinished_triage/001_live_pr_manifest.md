# 001 — live PR manifest

Snapshot command: `gh pr list --repo lidge-jun/opencodex --state open --limit 200`
plus per-PR `gh pr view`.

Open PR count: 14.

| # | state | base | head | head sha | merge | review | checks | labels | bucket | rationale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 533 | ready | dev | fix/gui-update-install-failure-recovery | `9de10c7a` | MERGEABLE/UNSTABLE | CHANGES_REQUESTED | target/label success; CodeRabbit pending | bug | needs-human/security | dependency/npm cache ownership and update/install recovery; do not auto-merge with requested changes |
| 528 | ready | dev | fix/image-bridge-p2 | `553e9afc` | MERGEABLE/CLEAN | none | 8 CI jobs success + CodeRabbit success | bug | needs-human/security + request-changes | independent review found stale checks and credential-origin binding risk in `src/images/plan.ts` |
| 527 | ready | codex/catalog-written-signal | codex/app-server-restart | `a64aa585` | MERGEABLE/UNSTABLE | none | enforce-target failure | bug | needs-human/security + needs-author-rebase | wrong base plus stale app-server restart/process-termination boundary |
| 526 | ready | dev | codex/catalog-written-signal | `1ba588ef` | MERGEABLE/CLEAN | none | 10 CI jobs success + CodeRabbit success | bug | takeover-fix/rebase+tests | independent review found stale checks and missing direct filesystem write-path coverage |
| 512 | ready | dev | split/426-01-namespace-foundation | `aef5628f` | MERGEABLE/CLEAN | CHANGES_REQUESTED | CI success | enhancement | needs-human/security | account namespace/auth identity model; requested changes still active |
| 498 | draft | dev | agent/sync-native-subagent-defaults | `c2330797` | CONFLICTING/DIRTY | CHANGES_REQUESTED | label/target success only | enhancement | later/enhancement | draft, 55 files, config/default policy surface |
| 495 | draft | dev | agent/main-account-last-resort | `7e0351d0` | MERGEABLE/UNSTABLE | CHANGES_REQUESTED | label/target success only | enhancement | needs-human/security | account routing policy for main account; draft and requested changes |
| 493 | draft | dev | fix/anthropic-per-account-rate-limits | `5e466a79` | CONFLICTING/DIRTY | CHANGES_REQUESTED | mixed/cancelled historical checks | enhancement | needs-human/security | Claude OAuth quota/account policy surface; draft/conflicting |
| 491 | draft | dev | fix/oauth-login-preserves-api-key | `e0debe22` | CONFLICTING/DIRTY | CHANGES_REQUESTED | target/label success only | bug | needs-human/security | OAuth/API-key preservation touches credential storage |
| 461 | draft | dev | feat/ocx-opencode | `5ef84f48` | CONFLICTING/DIRTY | none | CI success on old head | enhancement | later/enhancement | new launcher/client support surface; draft and conflicting |
| 447 | draft | dev | fix/kiro-multiauth | `48adb2b6` | MERGEABLE/CLEAN | CHANGES_REQUESTED | CI success | bug | needs-human/security | browser-based multi-account login touches auth/credential boundary |
| 429 | draft | dev | fix/cursor-shell-alias-hint | `f408f348` | CONFLICTING/DIRTY | none | CI success on old head | bug | takeover-fix | small Cursor prompt/empty command bug but conflicting and draft |
| 424 | draft | dev | feat/image-bridge | `a8b769c9` | MERGEABLE/UNSTABLE | CHANGES_REQUESTED | target/label success only | enhancement | needs-human/security | image bridge introduces paid xAI calls/artifact/download security surface |
| 355 | draft | dev | feat/gemini-inline-image | `d3c876e6` | MERGEABLE/UNSTABLE | CHANGES_REQUESTED | target/label success only | enhancement | later/enhancement | competing image-output route; draft and requested changes |

## Immediate PR read

- `merge now`: none after independent audit.
- `takeover-fix/rebase+tests`: #526, because checks are stale and direct
  write-path coverage is missing.
- `takeover-fix`: #429 only, because it is small and outside auth/security boundaries.
- `needs-author-rebase` as prerequisite: #527 and conflicting draft PRs #498,
  #493, #491, #461, #429.
- `needs-human/security + request-changes`: #528.
- `needs-human/security`: #533, #527, #512, #495, #493, #491, #447, #424.
- `later/enhancement`: #498, #461, #355.
