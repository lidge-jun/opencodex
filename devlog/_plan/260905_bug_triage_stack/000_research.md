# 000 — Live bug manifest and disposition research

Snapshot: 2026-09-04T22:28:45Z. Worktree `/Users/jun/.codex/worktrees/ef41/opencodex`,
HEAD `6d9639165` (== `origin/dev` at snapshot; `origin/dev` advanced to `980a9fbed`
(#3537, Astra pricing) during the evidence pass). `git diff 6d9639165 980a9fbed` touches
`src/providers/registry.ts`, `src/codex/catalog/native-models.ts`, provider-fetch and
providers docs — line numbers below are qualified to `6d9639165`; the *behavior* the
anchors prove is unchanged on `980a9fbed` (auditor re-verified: registry mapping at
dev:1629, Daybreak-only gate at dev:47). Implementation cycles branch from fresh
`origin/dev` and re-anchor at their own P.

Session `01a06e87-0804-7ed1-a317-a724b8ee1c35`, goalplan
`opencodex-open-bug-triage-and-stacked-pr-fix-tra`. Eleven parallel read-only evidence
lanes (subagents) produced the findings; every verdict names its `path:line` anchors.
Raw lane outputs are in scratch (`.tmp/triage/lanes/`), not tracked.

## Constraints carried from the user

- No repository-wide local suite (`bun run test` / bare `bun test`). Focused files,
  `bun run typecheck`, `bun run test:changed` only.
- Push with `git push --no-verify` (pre-push hook runs the forbidden suite).
- Hosted CI is trailing: push first, watch exact-head `gh pr checks`, fix forward.
- Fixes land as a dependency-ordered stacked PR chain (first base `dev`, each next base
  the previous head branch). No merges authorized.
- Issues are closed only with a concrete `dev` commit/PR reference.

## Open bug-labelled issues (live scan: exactly 12, no extras)

| Issue | Title (short) | Verdict | Basis |
|---|---|---|---|
| #3424 | opencode-go muse-spark-1.3-contributor 500 | **ALREADY_FIXED_ON_DEV** | #3317 `878f75417` added `"muse-spark-1.3-contributor": "openai-responses"` to `modelWireDefaults` (`src/providers/registry.ts:1627`); pinned by `tests/providers/muse-spark-web-search-compat.test.ts:117`. |
| #3352 | Plus account GPT-5.6 401 via proxy | **ALREADY_FIXED_ON_DEV** | #3460 `f3d0edb34`: `ACCOUNT_GATED_NATIVE_OPENAI_MODELS` now holds only Daybreak (`src/codex/catalog/native-models.ts:55`); gate at `src/codex/auth-context.ts:408/435` no longer applies to Sol/Terra/Luna; pinned by `tests/codex-integration/native-model-toggle.test.ts:120` and `codex-model-entitlements.test.ts:458`. Last reporter comment (05:52Z) predates the merge (11:16Z). `plan:null` is a separate WHAM-usage symptom (`src/codex/auth-api.ts:888-943`), not roster evidence. |
| #3467 | Google "User location is not supported" → invalid_request | **CARRY PR #3469** → 010 | `src/adapters/google-errors.ts:74` still returns `invalid request` for any 400; `src/lib/errors.ts:273/286` maps to `invalid_request_error`. PR preimage blobs equal HEAD for all runtime files; conflict is only the tests/ layout move (#3513/#3518). |
| #3462 | Discovery blocked under Mihomo IPv6 fake-ip | **FIXABLE** → 020 | `fdfe:dcba:9876::/48` classifies as `private-network address` (`src/lib/destination-policy.ts:191`) so `isBenchmarkDnsAnswer` (`:138`) never admits it. PR #3489 touches only the no-proxy TUN gate, not this range. |
| #3464 | mise upgrade leaves launchd proxy stale | **FIXABLE (partial)** → 030 | `buildPlist` (`src/service.ts:490-515`) bakes `cliEntry()` Bun+CLI paths; systemd already uses `stableLauncherEntry()` (`:3301`). #2909 explicitly left launchd untouched. Launcher parity fixes *which version starts next*; it cannot replace an already-running proxy, so the PR is `Refs #3464` and the issue stays open for the running-mismatch half (audit blocker 2). |
| #3522 | Windows spill failures behind healthy readiness | **CARRY PR #3525** → 040 | `src/responses/state.ts:383` discards the exception, `responseStateMetrics()` (`:2151`) is 12 numerics; seven of eight PR paths byte-identical to dev, the eighth is a tests/ move. Observability fix only; issue stays open per maintainer plan. |
| #3406 | Dashboard Codex disable dialog misleading | **CARRY PR #3407** → 050 | `IntegrationsOverview.tsx:691` picks Grok copy; `overview-clients.ts:191` `togglePath: null`; `native-integration-routes.ts:686` passes `getConfigPath()`. Base-to-current drift: `8b30d60b3` (collapsed-client revert) and `413227888` (#3477 journal dialog). |
| #3425 | Keeps routing to 5h-exhausted account after 502s | **NEEDS_INFO** | Plain 502 is `transient` (`src/codex/routing.ts:447`; `:445` is the 429/402 quota branch); failure failover threshold is independent config (`:2459`); no forced WHAM refresh after 502 (`src/codex/quota.ts:421`), stale snapshot can persist. Aggregate log cannot distinguish stale-snapshot / disabled failover / fixed-account / interleaved success. Ask listed in lane output. |
| #3320 | Windows non-ASCII scheduler task misclassified | **NEEDS_INFO** | Decoding fixed by #3438 `c85c48249` (`src/lib/windows-user-principal.ts:150/190`, `tests/windows/windows-user-principal-nonascii.test.ts:69`); SID-form `<UserId>` is accepted (`src/service.ts:1909/2136`). Reporter's XML was post-patch; pre-repair evidence needed. |
| #3245 | macOS Codex 0.152 stream disconnect | **NEEDS_INFO / UPSTREAM** | 426 deliberate (`src/server/index.ts:1144`), POST fallback covered (`tests/server/server-auth.test.ts:1384`); probe showed no POST reached the proxy. |
| #3506 | Cursor/Grok 4.6 no-progress loop | **UPSTREAM** | Maintainer keeps as tracker; liveness only measures protocol frames (`src/adapters/cursor/live-transport.ts:863`). |
| #3433 | Hermes zero cache hits | **PRODUCT_DECISION** | `session_id` synthesis needs positive per-session provenance (`src/claude/inbound.ts:543`, `src/server/claude-messages.ts:799`); reporter's client-side split-affinity workaround already works with existing forwarding. |

## Actions derived

- Close with evidence comment: #3424, #3352.
- Stacked fix chain (dependency-ordered by blast radius, smallest first so lower PRs
  can land independently): 010 → 020 → 030 → 040 → 050. See `005_stack_order.md`.
- Leave open, no action this cycle: #3425, #3320, #3245, #3506, #3433.

## Attribution (verified via `gh pr view --json commits`)

- #3469 → `Co-authored-by: agentHits <zvercombat26rus@icloud.com>`
- #3525 → `Co-authored-by: Ingwannu <ingwannu@users.noreply.github.com>`
- #3407 → `Co-authored-by: turin <koomj5258@gmail.com>`
- #3489 is not carried (does not fix #3462); no trailer needed for 020.


## Audit round 1 (A phase, astra reviewer) — GO-WITH-FIXES, 4 blockers, all folded

1. 010 precedence: location detection must sit *after* the auth (`UNAUTHENTICATED`) and
   rate-limit branches in `classifyGoogle`, with enum-driven adapter→envelope tests.
   Folded into 010 §Amendments (top of doc).
2. 030 `Closes` → `Refs` (running-process mismatch not addressed). Folded here, 005, 030.
3. Stack fix-forward must propagate to children (rebase descendants, re-verify base
   ancestry, fresh exact-head checks). Folded into 005 step 5.
4. Baseline/anchor inaccuracies (`routing.ts:445`→`:447`, "no files differ",
   040 "HEAD == origin/dev"). Corrected in place.

