# Release train 5 — lane roadmap

Coordinator: this task (heartbeat `opencodex-rt5-coordinator-heartbeat`, 15 min). Survey tables (scratch, gitignored): `.tmp/rt5-survey/{pr-a,pr-b,pr-c,issue-a,issue-b}.md`, produced by five read-only gpt-6-sol subagents on dev `eb7f0f0970`.

## Rules for this train

- Threads are Opus 5.5 lanes in their own worktrees, each running its own cxc-loop. Sol runs only as subagents inside a lane.
- Priority: severity plus provider compatibility. GUI-only changes are deferred unless the user asked for them (claude-cli API group).
- Lanes push their own `codex/rt5-*` branches and open PRs to `dev`; the coordinator reviews heuristically and merges.
- Dev merge gate: Ubuntu PR CI (typecheck, test shards, gates, required hygiene). CodeRabbit ignored. Manual cross-platform CI (`workflow_dispatch` lane=all) runs once on the final dev head.
- Carries keep a `Co-authored-by` trailer for the original author.

## Lanes

| Lane | Items | Why |
|---|---|---|
| 010 claude-cli-api | user requirement | Move claude-cli into the dashboard API group; warn on click that it is not API-key usage |
| 020 provider-small | #6130 + #6131 (#6118), #5964, #5539 (carry), #6121, #6150 | Small provider-compat fixes: Kiro image caps, Command Code echo, effort wire mapper, retry policy save, compaction image resend |
| 030 devin | #6091, #6092, #6116, #6090, #6096 (carry) | Devin catalog/wire/reasoning/quota/auth; shared adapter files so one lane serializes them |
| 040 reasoning-zen | #6123 narrowed carry (#6122), #5995 carry | Raw chain-of-thought exposure on iOS remote; keyless Zen compatibility |
| 050 platform-service | #6139 implement, #6144, #6110, #6030, then #6158/#6155/#6085 if time | macOS bundled keyring break, version-skew takeover, service launchers and ownership |
| 060 account-pool | #6154 (#6153), #5831, #5956, #5561 implement, #5099 carry | Quota pacing, lock recovery, low-quota policy, model-aware Anthropic pool |
| coordinator | #6148, #6146 | Merge directly after head recheck |

## Deferred this train

GUI-only: #6094/#6093, #6149, #6151, #5253, #3379, #4932, #4649, #5408, #5617. Large or design-level drafts: #6079, #6077, #5955, #5424, #4259, #4022, #3025, #5374, #5782, #5947, #5950, #5905, #5912, #5800 and the P3 roadmap issues; see the survey tables for per-item reasons.

## Integration order for shared files (audit round 1)

The coordinator merges one PR at a time; every lane rebases onto the latest origin/dev before each push and after any coordinator merge that conflicts. Known overlaps and owners:

- `src/server/chat-native.ts`: #5539 (provider-small) lands before #5995 (reasoning-zen); reasoning-zen rebases.
- `src/server/responses/adapter-dispatch.ts`, `run-turn-execution.ts`, `src/types/provider.ts`: order #6096 (devin) → #6123 carry (reasoning-zen) → #5099 carry (account-pool, last in that lane).
- `src/config/schema/leaf-validators.ts`: #6121 (provider-small) lands before #5956 (account-pool).
- `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json`: every lane appends; conflicts are resolved at rebase by keeping both entries.

## Wave 2 (dispatched after wave-1 lanes report)

Lane 070 provider-carry: #4177 (P1 cross-provider blocked-model redirects), #3282 (P1 Copilot context tier, fix failing tests), #4228 (P2 Command Code projectContext opt-in). Held to wave 2 because #4228 shares Command Code files with provider-small (#5964), and #4177 touches the router, which the other lanes also reach.

## Explicit deferrals added by audit round 1

- #6013 (Claude pool per-account pause/threshold, L): mostly dashboard controls; account-pool lane already carries #5561 on the same pool. Next train.
- #3376 (quota history and reset scheduling, L): design-level and depends on #6154 pacing landing first.
- #2511 (per-provider image byte budget, L): the Kiro image caps (#6130/#6131) and compaction image fix (#6150) cover the reported failures this train; the general budget is a follow-up.

## Security-boundary review required before merge

The coordinator reviews these diffs by hand (auth, credentials, OAuth, workflows, dependency install) before merging: #6139 (native dependency packaging), #6154 (credential-scoped quota state), #6090 and #6096 (Devin credentials/OAuth), #5831 (main-account locks), #5995 (keyless provider identity), #5099 (OAuth failover health store). Already merged after review: #6148 (dependency lock, approved, full CI green) and #6146 (workflow PR identity scoped to this repository, full PR CI green).

## Audit round 2 corrections

- #3833 moves out of wave 2 into deferral: its 37-file integration is GUI-heavy, which this train defers. Wave 2 keeps #4177, #3282, #4228.
- Security review before merge also covers #3282 (provider credentials), #4228 (outbound local-file content, must stay opt-in), #5956 and #5561 (account-pool credential selection).
- #2511 corrected disposition: DEFER as a distinct feature. A general per-provider request-byte ceiling is not delivered by #6130/#6131/#6150; it stays open for a later train because it is L effort (survey rates current impact P2) and needs a design for downscale-then-prune ordering across providers.
