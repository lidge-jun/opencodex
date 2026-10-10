# Stack CI and parent review follow-up

Runtime7043e2b42 addresses the maintainer's raw-range and monthly-provenance findings; independent review and static checks passed. UI cascaded to a7a0ab832; Reserve replayed cleanly to380966e5f. `git range-diff` proves all three Reserve commits unchanged by the cascade. Every resulting head needs fresh CI; earlier green runs are historical evidence only.

Reserve run33938170402 at76affe17c failed test4/4 job101230129450 in five auth fixture cases. The fixture reused the same account/token between tests but reset only lifecycle tracking, leaving a valid process-local Reserve authorization. Consequently later fixtures used the legitimate cache instead of their new WHAM response; assertions saw zero reads or the previous grant. Add the existing clearMainAccountInfoCache invalidation in beforeEach/afterEach. This fixes fixture ownership without adding a test-only production reset or weakening assertions. The expected WHAM and refusal assertions remain exact. Other job results are still being collected; no failure is labeled a flake.

Fresh C adversarial source audit by Nash found no cross-lane blocker on76affe17c. Cascade integration re-review is pending. No local suites, account changes or live-service mutations.

Later checkpoints: CI12f2f1f1a test4/4 passed, confirming the deferred-observer repair removed the repeated timeout. Test3/4 then failed one existing source-string oracle in loopback-listener-admission.test.ts: its expected Claude handler call omitted the newly threaded admission. Update the exact expected call to include admission while retaining the listener-policy/CORS checks. No production behavior or assertion scope is relaxed.

Runtime473934e9a validates persisted policy percentages; UIb3539dd9c and Reserve9966d25a9 cascade it cleanly. Range-diff reports all five Reserve commits identical across that cascade. Earlier CI results remain historical, not final-head approval.

CI12f2f1f1a test2/4 job101233776066 failed all16 ingress cases during fixture setup, before any request: the fixture used internal __main__ as a public namespace target. The real config schema correctly requires @main and fell back to default config. Use MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET and assert the saved configuration loads with the intended hostname/selector before starting either listener. Preserve every runtime assertion and the actual config loader.
