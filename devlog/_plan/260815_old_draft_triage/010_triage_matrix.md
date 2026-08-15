# 010 - Old-draft triage matrix (wp1 deliverable)
 
Evidence: 4 sol/medium subagents, 2026-08-15, against origin/dev 420db6274. All 18 are drafts.
 
## CLOSE (2)
 
| PR | Reason |
|----|--------|
| #1498 feat(combos) economy routing | Superseded by quota/cost policy routing (src/routing/evaluator.ts) + #1702; 31 unresolved threads with P1 accounting defects; 755 commits behind |
| #1367 feat(responses) bounded JSON fallback | Targets a retired seam (registry-only compat + terminal-repair architecture on dev); 10 unresolved blockers; 936 commits behind |
 
## KEEP-DRAFT (6)
 
| PR | Gaps |
|----|------|
| #1552 Command Code OAuth pool | 2565-line auth-boundary change; needs maintainer security sponsorship, real GUI screenshot, rebase |
| #1703 claude classifier affinity | Real defect but implementation can silently cross provider privacy/billing boundaries; maintainer design hold |
| #1645 vision chat/Google sidecars | 5 verified blockers incl. OAuth-over-HTTP loopback and missing image-boundary checks |
| #1557 least-privilege catalog endpoint | Response not projected through closed allowlist DTO; not fail-closed; unsponsored auth-cors surface |
| #1526 reset-credit operation identity | Real idempotency gap but 5748-line auth/persistence authority; needs split or exceptional security review |
| #1624 quota recovery policy contract | Sound but dormant no-op contract; land only with the #657 runtime slice |
 
## CHERRY-PICK light (6) - repair then land
 
| PR | Repair scope |
|----|--------------|
| #1664 MiniMax Code/CLI | Replace detached-startup argv construction with compiled-aware launcher (src/cli/minimax.ts:261); rebase (124 behind); full gates |
| #1669 modelPickerOrder | Fail-soft string-array normalization + malformed-input regression + docs contradiction fix |
| #1660 terminal guard openai-chat | Resolve src/types.ts conflict; add explicit-false + combo/routed-compaction exclusion tests; provider-option docs |
| #1652 streamAborted | Cover WS finalize + relay-eager paths; fix trackSseForRequestLog cancellation race; drop unrelated fixture churn |
| #1165 imageInput combo control | Fix double expansion of combo continuations; combo set round-trip; add Turkish/zh-TW locale keys; test coverage |
| #1644 Factory Droid docs | Name the droid provider id in config; define text-only accepted schema + rejection behavior (EN+KO); docs build |
 
## CHERRY-PICK heavy (4) - one worker attempt each
 
| PR | Repair scope |
|----|--------------|
| #1655 empty-completion guard | Reimplement on current core.ts: bound retained events/bytes, usage preservation, guard composition, retry-cause record, integration tests; currently CI-red |
| #1569 native chat->chat | Rebuild around shared openai-chat request builder + bounded SSE parser; redactSecretString on structured provider errors; URL normalization |
| #1584 request pacing | Reconcile 4 conflicting files (ProviderSettings, responses/core, fetch-helpers, policy-fallback); remove real-timer flake tests; 358 behind |
| #1521 service tiers | Port per-model resolver across 4 conflicts (openai-chat adapter, provider-fetch, 2 test files) onto current service-tier gating; #1436 |
 
