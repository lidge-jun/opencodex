# 260724 Issue/PR Triage — Open Snapshot (real-now vs later)

Worktree: `codex/260724-issue-pr-triage` (was detached `921f`, dev tip cc7bb577).
Snapshot taken 2026-07-24. Axis per user: **실제 버그 = 지금**, **커서(Cursor)
계열 = 나중**, **프로바이더 추가/업스트림-추적/로드맵 = 나중**.

Counts at snapshot: 24 open issues, 19 open PRs.

## Classification axis

- **NOW (real bug):** functional defect in proxy/routing/auth/GUI that breaks a
  user workflow and is fixable in this repo (not upstream Codex).
- **LATER — cursor:** Cursor adapter/context bugs (user deprioritized).
- **LATER — upstream:** `upstream-tracking` label; blocked on Codex client.
- **LATER — provider add:** new provider onboarding.
- **LATER — roadmap/feature:** enhancement/roadmap, not a defect.

## Issues

| # | Title (short) | Class | Priority | Notes |
|---|---|---|---|---|
| 398 | Web/Vision sidecar backend fixed to openai/anthropic → 499/502 when limits out | NOW bug | P0 | Whole turn fails (~200s timeout), no graceful degradation. High user impact. |
| 320 | Native auth expiry opens login even when pool is healthy | NOW bug | P0 | Blocks `codex` startup; pool mode should not hard-stop. |
| 338 | Calls super slow (<5 tok/s) vs direct GPT | NOW bug | P1 | Perf regression; needs repro/trace before fix. |
| 349 | Vision sidecar unusable from Codex App (noVisionModels should advertise image) | NOW bug | P1 | Headline feature dead for App users. Pairs w/ #344. |
| 382 | Codex Auth stale weekly + 30d shown together (#315 remnant) | NOW bug | P1 | Has fix PR #390. |
| 396 | Cannot adjust thinking intensity in Claude Desktop | NOW bug | P2 | ccswitch shows it; opencodex path drops it. |
| 395 | Log flooded 404 for anthropic-adapter providers w/o /v1/models (Azure Foundry) | NOW bug | P2 | Log-noise; likely small backoff/cache fix. |
| 340 | Claude settings sidecar dropdowns clipped, options unselectable | NOW bug (GUI) | P2 | Has fix PR #393 (draft). GUI boundary → user approval. |
| 373 | Cursor context output-only after 2.7.35 restart | LATER cursor | — | Follow-up of #245. |
| 399 | Cursor false "Shell/Read blocked" (tool-name mismatch) | LATER cursor | — | Has PR #402 (draft). |
| 241 | Routed models missing from Desktop model picker | LATER upstream | — | `upstream-tracking`. |
| 92 | V2 cross-provider subagent loses NEW_TASK body in encrypted_content | LATER upstream | — | `upstream-tracking`. |
| 201 | Add TRAE International provider | LATER provider | — | roadmap. |
| 178 | Add Factory as a provider | LATER provider | — | roadmap. |
| 177 | Add Warp as a provider | LATER provider | — | roadmap. |
| 344 | Auto-advertise image inputModalities for noVisionModels | LATER feature | — | Enhancement half of #349. |
| 401 | Change voice chat to different model | LATER feature | — | enhancement. |
| 386 | Packaged macOS menu bar companion (release assets) | LATER feature | — | Pairs w/ PR #387. |
| 374 | Subagent model fallback chain (quota-aware) | LATER feature | — | Pairs w/ PR #391. |
| 357 | Complete external aggregated model API | LATER feature | — | Pairs w/ PR #392. |
| 331 | Background helper Sonnet-native fallback has no notice | LATER feature | — | UX. |
| 330 | Logs: per-chat/session token+cost totals | LATER feature | — | enhancement. |
| 294 | Claude account pool parity | LATER roadmap | — | roadmap. |
| 95 | Host opencodex as multi-user proxy (LiteLLM) | LATER roadmap | — | roadmap. |
| 42 | Storage page for session usage/cleanup | LATER roadmap | — | roadmap. |

## PRs

| # | Title (short) | Class | Merge state | Recommended action |
|---|---|---|---|---|
| 397 | fix(openai-chat): keep system messages first | NOW bug fix | MERGEABLE/CLEAN | Review → merge candidate. |
| 394 | fix(anthropic): guard premature no-tool completions | NOW bug fix | CONFLICTING/DIRTY | Rebase on dev, then review. |
| 390 | fix(codex): clear stale weekly quota (#382) | NOW bug fix | MERGEABLE/CLEAN (draft) | Review → mark ready. Fixes #382. |
| 389 | fix(models): switches reflect final visibility | NOW bug fix | MERGEABLE/UNSTABLE | Check failing check, then review. |
| 393 | fix(gui): portal select dropdowns (#340) | NOW bug fix (GUI) | MERGEABLE/CLEAN (draft) | GUI boundary → user approval, then review. Fixes #340. |
| 370 | fix(codex): reset main state after account switch | NOW bug fix | UNKNOWN | Earlier verdict REBUILD_ON_DEV (Parfit). Re-review after rebase. |
| 339 | fix(adapters): preserve finish_reason as stopReason | NOW bug (wrong branch) | CONFLICTING, base=main | Needs retarget to dev by author. |
| 402 | fix(cursor): stop false shell blocked (#399) | LATER cursor | UNSTABLE (draft) | Defer w/ user cursor deprioritization. |
| 376 | fix(cursor): estimate context after restart | LATER cursor | UNKNOWN | Earlier REBUILD_ON_DEV (Galileo). Defer. |
| 403 | feat(grok): auto-configure Grok Build | LATER feature | UNSTABLE | Existing grok-build worktree track. |
| 400 | feat(providers): Upstage Open2 beta bridge | LATER provider | CLOSED | Closed during triage; provider add. |
| 385 | feat(providers): BizRouter preset | LATER provider | UNSTABLE | Provider add. |
| 392 | feat(api-access): gateway + external model catalog | LATER feature | CLEAN (draft) | Pairs w/ #357. |
| 391 | feat: quota-aware subagent model fallback (#374) | LATER feature | CONFLICTING | Pairs w/ #374. |
| 388 | feat: memory observability + watchdog | LATER feature | CONFLICTING (+3887) | Large; defer. |
| 387 | feat: packaged macOS menu bar companion | LATER feature | UNSTABLE | Pairs w/ #386. |
| 355 | feat(google): Gemini inline image output | LATER feature | CONFLICTING (draft) | Earlier DEFER (Hegel). |
| 337 | feat(gui): Codex auto-switch threshold | LATER feature (GUI) | CONFLICTING | GUI boundary; earlier DEFER. |
| 365 | fix: stop repeating multi-agent guidance | LATER (wrong branch) | base=main (draft) | Marked WRONG BRANCH; retarget. |

## NOW queue (priority order)

1. **#398** sidecar backend lock → 499/502 (no fix PR yet) — P0.
2. **#320** native-auth expiry hard-stop despite healthy pool (no fix PR yet) — P0.
3. **#390 → #382** stale weekly quota (fix PR ready to review) — P1.
4. **#389** model switch visibility (fix PR, check CI) — P1.
5. **#397** openai-chat system-first ordering (clean fix PR) — P1.
6. **#394** anthropic premature completion guard (rebase then review) — P1.
7. **#349/#344** vision sidecar image modality (no fix PR yet) — P1.
8. **#338** slow calls (needs repro) — P1.
9. **#396** Claude Desktop thinking intensity (no fix PR) — P2.
10. **#395** anthropic-adapter 404 log flood (no fix PR) — P2.
11. **#393 → #340** GUI dropdown clipping (GUI approval needed) — P2.

## LATER (parked, user-deprioritized)

- Cursor: #399/#402, #373, #376.
- Upstream-tracking: #241, #92.
- Provider adds: #201, #178, #177, #385, (#403 grok). (#400 closed.)
- Roadmap/feature: #401, #386/#387, #374/#391, #357/#392, #331, #330, #294,
  #95, #42, #355, #337, #388.
- Wrong-branch (retarget to dev): #339, #365.
