# Spark short-quota attribution fix (#4122) — plan

## Reader summary

Problem: on a Pro pool account that served a GPT-5.3-Codex-Spark request, the dashboard shows an
account-level "5h" quota bar that does not exist at the account level; peer Pro accounts with
identical upstream limits show none. Answer: the response-header quota path learns which model the
response was for, and when that model belongs to the Spark limit family the 5h primary window is
filed under the model's custom windows instead of the account-level short slot. What changes: pool
accounts with identical limits display identically, and the main-account hard lock and five-hour
auto-refresh scheduling stop reading a model-specific window as account policy.

## Loop spec

- Loop archetype: satisfy-spec (single work-phase wp1, one PABCD cycle; not multi-cycle, so no
  docs-first roadmap cycle).
- Trigger: user directive to fix lidge-jun/opencodex#4122 and land it on dev via PR.
- Goal: header-observed 5h windows on Spark-model responses no longer occupy the account-level
  short-quota slot; genuine account-level 5h windows (Plus/Team, non-Spark models) unchanged; PR
  merged to dev with green final-head CI.
- Non-goals: WHAM parseUsageQuota mapping (already correct); GUI changes; docs-site; migration or
  cleanup of already-polluted cache entries (on disk they expire via the six-hour hydration TTL;
  in a long-running process the tuple persists in memory until restart or the next genuine short
  write — cleanup stays explicitly out of scope); release or promotion; no local
  test/typecheck/build runs (standing user rule: push with --no-verify, remote CI is the gate —
  recorded NOT RUN below). Accepted consequence (reviewer finding 2, folded): once Spark responses
  stop writing the account-level short slot, a Spark-saturated account is no longer preemptively
  avoided for Spark-routed requests — routing evidence reads only the account slot
  (src/routing/quota.ts:40-61, src/codex/quota.ts:67-80, src/codex/routing.ts:373-379). Bounded:
  Spark requests only, the 429 quota-rotation path absorbs it, and WHAM-only accounts already
  behave this way. Spark-aware exhaustion from customWindows is a tracked follow-up, not this PR.
- Verifier: remote CI on the PR's exact final head — .github/workflows/ci.yml pull_request trigger
  (line 7), job test (line 263, gated on the changes filter at line 266 which covers src/** and
  tests/** at lines 191/193) runs bash scripts/ci/run-bun-test-batches.sh (line 325) whose
  `find tests -type f` selection (script line 197) includes
  tests/codex-integration/codex-quota-parser-parity.test.ts; job platform-macos (line 475, gate
  478) runs the macOS suite sharded over tests (line 615). (Audit correction: the lines this plan
  first cited, 706/839, belong to workflow_dispatch-gated jobs and were wrong.)
  Conditional paths and their activation: the Spark-attribution branch activates when
  parseUpstreamQuotaHeaders receives modelId in the Spark family plus a sub-day primary window —
  proven by a regression row asserting customWindows gain and short* absence; the non-Spark branch
  activates with the same headers and a non-Spark modelId — proven by a row asserting short* is
  still written; the label-merge branch activates when existing customWindows hold a Spark Weekly
  entry — proven by a row asserting it survives the header update.
- Stop condition: PR merged into dev and landing verified via fetched dev ancestry, or a
  BLOCKED/NEEDS_HUMAN outcome with evidence.
- Memory artifact: this unit directory plus the session goalplan
  (.codexclaw/goalplans/hotl-fix-lidge-jun-opencodex-4122-and-land-it-on/).
- Expected terminal outcomes: DONE = goal criteria c1-c4 met with fresh evidence; BLOCKED =
  irreducible CI failure or merge-policy denial; NEEDS_HUMAN = authority gap.
- Escalation: any requirement to run local suites, push without --no-verify, change merge policy,
  or expand scope beyond the listed files returns to the user. Reviewer-subagent FAIL after one
  fold/rebut cycle returns to P with a revised plan rather than forcing B.
- HOTL resource bounds: tools = this worktree shell/git/gh and read-only upstream GETs;
  credentials = existing gh auth only; write scope = this worktree plus issues/PRs on
  lidge-jun/opencodex; token/wall-clock budget = none set by user.

## Root cause (evidence)

Two writers share one per-account snapshot in src/codex/quota.ts:

1. WHAM path: parseUsageQuota maps the account primary window by duration and files
   additional_rate_limits (metered_feature codex_bengalfox) under customWindows only
   (src/codex/quota.ts:723+). Correct for Pro: weekly-only primary.
2. Header path: parseUpstreamQuotaHeaders (src/codex/quota.ts:410) files any sub-day primary
   window as account-level shortPercent/shortResetAt/shortWindowSeconds. It has no model context,
   so on a Spark-model response — where upstream reports the Spark governing limit as the primary
   window — the model-specific 5h window lands in the account slot.

Live proof on 2026-09-09: three Pro accounts returned identical wham/usage shapes (primary
604800s; Spark 5h/weekly in additional_rate_limits), yet only the Spark-serving account's cache
carried shortPercent 4 / shortWindowSeconds 18000, with shortResetAt exactly equal to the Spark 5h
reset_at. Downstream consumers that trust the account slot: main-account hard lock
(src/codex/main-account-hard-lock.ts:30-34 prioritizes short over weekly), five-hour auto-refresh
scheduling (src/codex/quota-auto-refresh.ts:62,88), pool evidence (src/routing/quota.ts).

## File-change map (diff level)

1. src/codex/quota.ts
   - Add module-local helper isCodexSparkModel(modelId): modelId.includes("codex-spark").
     Necessity search: existing inline equivalents at src/adapters/openai-responses.ts:343,492 and
     src/responses/hosted-tool-policy.ts:6; no shared helper exists. Reusing those call sites is
     out of scope; the helper is introduced where the new branch needs it.
   - parseUpstreamQuotaHeaders(headers, options?: { modelId?: string }): in the primaryIsShort
     branch, when options.modelId is Spark-family, emit
     customWindows: [{ label: "GPT-5.3-Codex-Spark 5h", percent, resetAt }] instead of account-level
     short*; weekly continues to come from the secondary window. Label matches the WHAM parser's
     Spark 5h label so both wires write the same slot.
   - applyAccountQuotaFromUpstreamHeaders(accountId, headers, writerGeneration?, mainWriter?,
     options?: { modelId?: string }): forward options to the parser; when the parsed quota carries
     customWindows, merge label-wise with the account's existing cached customWindows (replace same
     label, keep others) before setAccountQuotaFromParsed, so a header update never drops the
     WHAM-recorded Spark Weekly window (#4007 retention preserved; mergeAccountQuota semantics
     unchanged — an explicit list still replaces). Provenance amendment (reviewer finding 3,
     folded): call hydrateAccountQuotasFromDisk() before reading the cached entry so the first
     call in a process does not merge against an empty map; the pre-merged list goes ONLY into the
     legacy quota argument — the policyQuota argument keeps the UNMERGED parse result so
     legacy-cache customWindows are never injected into the identity-bound policy snapshot
     (setAccountQuotaFromParsed's legacy/policy split at src/codex/quota.ts:245-252 stays intact).
   - Refresh the stale comment ("Pro stays weekly-only") to describe the model-specific case.
   - Field chain (PLAN-FIELD-CHAIN-01): the options value is created at the three callers below,
     consumed only inside parseUpstreamQuotaHeaders/applyAccountQuotaFromUpstreamHeaders; no
     serialization, no persistence, no enum. Consumers of the written slots (hard lock,
     auto-refresh, routing evidence, CLI/GUI display) are behaviorally affected only by the
     corrected attribution — no signature changes.
2. src/server/responses/core.ts — FOUR write paths, all with route in scope:
   a. line ~1380 (429/402 quota-refresh-before-rejection path): pass { modelId: route.modelId }.
   b. line ~5660 (post-response capture for forward-pool responses, behind
      isCodexWsQuotaObservedResponse dedup): pass { modelId: route.modelId }.
   c. line ~1022 (codexWsQuotaObserver callback for WebSocket quota frames): the FACTORY
      codexWsQuotaObserver(authCtx, provider) gains a third parameter modelId and forwards it as
      options; the CodexWsQuotaObserver TYPE (src/server/responses/codex-ws-metadata.ts:8) is
      unchanged so direct observer constructions in tests/responses/responses-account-label.test.ts
      keep compiling; all six factory call sites (lines ~1476, 5053, 5131, 5237, 5357, 5457) pass
      route.modelId.
   Found during the main agent's own audit pass after plan v1 named only two core.ts sites —
   folded into the plan before the reviewer round closed (AUDIT-LOOP-01 amendment).
3. src/server/responses/compact.ts (line ~1013): pass { modelId: route.modelId } (route in scope;
   selectedModelId = route.modelId at line 582).
4. src/codex/quota-auto-refresh.ts — NO CHANGE, recorded with reason: warmCodexAccount there sends
   DEFAULT_MODEL gpt-5.4-mini (src/codex/warmup.ts:284), never a Spark model, so the warmup header
   path cannot observe a Spark limit; omitting modelId preserves current behavior.
5. tests/codex-integration/codex-quota-parser-parity.test.ts — add regression rows (existing file
   already owns #4007 Spark/header interaction and parser parity; no new file, so no layout.json
   or fixture registration needed):
   a. Spark model + 5h primary headers → account-level short* absent; customWindows contains
      "GPT-5.3-Codex-Spark 5h" with the header percent/reset; weekly taken from secondary.
   b. Same update with a pre-existing "GPT-5.3-Codex-Spark Weekly" customWindow → weekly entry
      survives (label-merge), Spark 5h replaced.
   c. Non-Spark model + identical 5h headers → account-level short* still written (Plus/Team
      behavior preserved).
   d. No modelId (legacy caller shape) → behavior identical to today.
   Red evidence: rows a/b fail against the unpatched parser (short* is written today). Local
   red-green execution is NOT RUN per the standing user rule; the assertion construction is
   verified by review against the current code path and the remote CI run is the green gate.

## Scope

IN: the five items above. OUT: parseUsageQuota WHAM mapping, mergeAccountQuota global semantics,
GUI, docs-site, cache migration, warmup model selection, release/promotion.

## SoT sync (C phase)

structure/08_openai-provider-tiers.md documents quota windows (5h/weekly application around lines
96-99, 132, 140, 177). In C, check whether any statement now contradicts model-attributed short
windows and patch that file if so; otherwise record "checked, no contradiction".

## Enforcement / bypass (PLAN-BYPASS-NAMED-01)

This plan adds no enforcement layer. Tier: N/A; executing surface: none; known bypass: a future
caller can omit modelId and reproduce the old misattribution — mitigated only by the regression
tests and code review; residual risk accepted; final layer: none.

## Verification gate mapping

- Local bun test / typecheck / build: NOT RUN (standing user rule: never run local suites; push
  with --no-verify).
- Remote: PR CI (ci.yml, pull_request trigger, sharded bun test over tests/) must be green on the
  exact final head before merge; merge per MAINTAINERS.md maintainer PR-only path with the decision
  and exact-head CI evidence recorded in the PR.
