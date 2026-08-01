# _plan close-out audit — 2026-07-03

Exhaustive closeability audit of every `devlog/_plan/` item. Method: 5 parallel Opus reviewers
(read-only), each verifying whether an item's work FULLY landed in current code (git branch dev),
checked against actual src + `git log`/`git show`, not the devlog's own status line. Main session
spot-checked the closeable verdicts (all cited commits exist; 717d2ff ∈ origin/main + v2.6.14 tag;
key symbols present). 15 items closed (2 mine + 13 audited); 7 genuinely open remain.

## Closed → `_fin` (15)

Mine (implemented + committed this session): `260703_oauth-multi-account-refresh-and-tos` (token
guardian), `issue_052_provider-model-allowlist`.

Audited CLOSEABLE (work landed + tested; devlog status lines were stale):

| Item | Evidence |
|---|---|
| 260701_deployability-hardening | 717d2ff/f34f742 ∈ origin/main, tag v2.6.14; fingerprint headers `anthropic.ts:313-314` |
| 260701_runtime-state-consolidation | verified no-op; reset exports + `codex-routing.test.ts:73-85` |
| 260701_anthropic-reasoning-none-gate | `5ac3573`; gate `anthropic.ts:283`; `anthropic-reasoning.test.ts` |
| 260701_openai-chat-eof-fail-closed | `3ac5dc2`/`f34f742`; `openai-chat.ts:235/347`; `openai-chat-eof.test.ts` |
| 260701_cache-audit-hardening | phases 10/4/5/2/3 landed (`116133c`,`7c91870`); usage cache tokens end-to-end |
| 260702_cursor-live-stability-rca | all WP0-3/WP2b/P0 landed `9340872`/`72c9c9f`; cursor tests |
| 260702_google-models-proxy-support | `84cef2f`+`6cb379b`; `effectiveGoogleMode`, cooldown, x-goog-api-key |
| 260702_tool-use-prompting-calibration | `cc59cc5`; tool-catalog-nudge + cursor calibration + tests |
| 260703_abort-helper-consolidation | `1524e96`; helpers moved to upstream-retry, exports preserved |
| 260703_chatgpt-upstream-reset-retry | `00e6e20`/`9bbba06`; `upstream-retry.ts`, 5 call sites, tests |
| 260703_sse-midstream-reset-tail | `685b7c4`; `relaySseWithFailedTail` + win32 gate + tests |
| issue_local_catalog-sync-hardening | `13c03e6`/`b5c4848`; Gap A/B + `codex-catalog-sync-hardening.test.ts` |
| 260702_cursor-toolcall-mcp-empty-rca | **closed as SUPERSEDED**: symptoms fixed via WP2 (`9340872`); this doc's own proposed fix (proactive field-4) + `run_shell` flip were deliberately NOT taken |
| 380_prompt-caching-strategy | **re-audited → CLOSEABLE** (initial OPEN verdict was wrong). Actionable core landed across ~11 commits — Phase 1/3 telemetry, Phase 2 prompt_cache_key preserve, Phase 5 Anthropic cache_control. Phase 4 (derived key) + Phase 6 (routing) are doc-declared future/optional. See its `10_closeout.md`. |
| 260702_codex-history-sync-hardening | **re-audited → CLOSEABLE** (initial PARTIAL verdict superseded). Design A + the routing-fallback fix (root `model_provider="opencodex"`, `744cc9e`) shipped and work; Design B (openai-id override) is a parked optional alternative, not a live defect. See its `03_closeout.md`. |

## Second-pass re-audit note (2026-07-03)

After 380 was found mis-verdicted, all 6 remaining items were re-checked broadly (substance, not
narrow artifacts). **380** and **260702_codex-history-sync-hardening** were under-counted and are now
closed. The other 4 are genuinely open by structural fact (verified): catalog-split (no `src/codex-catalog/`
dir, file 1085 lines), server-ts-split (2/5 modules, `server.ts` 2425 lines), 500_storage (no Storage
page/`/api/storage`), issue_017 (Codex platform limit, needs reporter). **issue_044** is genuinely
PARTIAL — primary symptom fixed (`2481c80`); the cancel-path 499 finalization is a real secondary gap
(`consumeForInspection` early-return skips `onDone`; `cancelled` suppresses `onTerminal`).

## Remain in `_plan` — genuinely OPEN/PARTIAL (7)

| Item | Why it can't close | Remaining work |
|---|---|---|
| 260701_codex-catalog-split | OPEN — only the golden-test oracle landed; the 3-way split never happened, `codex-catalog.ts` grew to 1085 lines | extract persistence→discovery→build behind a barrel, keep golden snapshot byte-identical |
| 260701_server-ts-split | PARTIAL — 2 of 5 modules extracted (`177c06e`,`76e38ce`); 3 still in `server.ts` (2425 lines) | extract request-log / responses-handler / turn-lifecycle |
| 500_storage-page-session-cleanup | OPEN — documentation-only epic for GH #42; no Storage page / `/api/storage` built | implement diagnostics → cleanup UI |
| issue_017_mobile-thread-bypass-proxy | OPEN — Codex platform limitation, not a proxy defect; blocked on reporter repro (v2.1.11+) | optional: diagnostic hint on the ChatGPT-account model-policy 400 |
| issue_044_request-log-native-passthrough-gap | PARTIAL — primary symptom fixed (`2481c80`, `server.ts:446`); cancel-path finalization (review #1/#2/#4) still open | 499 `client_cancel` finalize on pure-cancel path + regression test |
