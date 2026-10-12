# Lane A — tests hygiene triage

Bundle lane A of the 260923 PR-consolidation round. One branch (codex/260923-bundle-a-tests-hygiene) from origin/dev 685321e297, one commit per carried PR, one PR to dev. Each candidate got a read-only gpt-6-sol soundness review against current dev.

| PR | Author | Verdict | Carry notes |
|---|---|---|---|
| #5607 | FredAmartey | CARRY | Translator budgets disposed per test via onTestFinished; module-level afterEach only fires for the first importing file in a shared process. |
| #5605 | FredAmartey | CARRY-WITH-FIXES | Restore real modules after image-test mock.module overrides. Fix: capture each real module before its first override and restore only captured snapshots (a partial beforeAll must not install an empty module); z-handler-activation restores even if directory cleanup throws. |
| #5570 | FredAmartey | CARRY | Every test file that pins OPENCODEX_HOME restores the inherited value; commit 2 already folded the CodeRabbit ordering finding. |
| #5482 | FredAmartey | CARRY | Capture resolveAdapter before mock.module rewrites the live binding (three files). |
| #5630 | sh940701 | CARRY-WITH-FIXES | Guard the real desktop restart adapter when OCX_TEST_HOME_GUARD=1 and no execFile is injected. Fix: document the armed-test skip and CLI outcome in structure/runtime.md. |
| #5340 | codingbooo | CARRY-WITH-FIXES | README memory inventory counts derived from registries with a per-locale guard test. Fix: rebuild on dev after #5615 (keep its prose), retained stores are now 14 (native_control_replay is pinned, evictOldest returns 0, so the "all evicted" wording changes), recompute readme/i18n-manifest.json hash from the final README, register the new test in layout.json and test-layout-expected.json. |

## Issue #5439

Part 1 (batched runner cannot run on macOS: GNU timeout, mapfile) is already fixed on dev by #5456 (portable process-group timeout fallback, no mapfile). Part 2 (failure counts depend on batch size) is caused by the cross-file leaks that #5570, #5605 and #5607 fix; tests/server/config.test.ts already restores its cwd. The single-owner spend ledger errors are the intended owned-spend-home contract. The PR references the issue with the evidence; closing is the coordinator's call.

## Verification plan

Focused files per carry, including non-isolated same-process pairs that reproduce the leak (the reviewers' named orderings), then bun run typecheck, bun run structure:check, bun run privacy:scan, tests/test-layout*.test.ts and the file-size ratchet test. No full local suite.
