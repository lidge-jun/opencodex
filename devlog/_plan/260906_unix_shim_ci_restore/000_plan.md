# 000 — Unix shim CI follow-up roadmap

This is the next independent cycle of the active dev-CI repair goal. The prior key-login cycle is complete: PR3724 landed at41ab5c2dc, its exact-head PR CI passed and the actual dev macOS1 key-login test passed116.67ms. The dev aggregate still failed in a different test; it is not labeled green.

Public baseline: dev41ab5c2dcd49ac6bdfaec4cf091324dbc1d41b95, CI34001170755, macOS2 job101400209887. `tests/codex-integration/codex-shim.test.ts:109` expected the fixture install result's installed flag to be true, received false after6004.17ms. The named test at1444 concerns obsolete-shim auto-restore, but setup failed before those assertions. The shard reported10416pass/1fail. Raw evidence is kept under ignored .tmp/lane-b/key-login-repair-qa/dev-macos-2.log.

## Phase map and next decision

The earlier cycle established a repeatable DNS-dependent timeout and repaired only its fixture. That finding does not explain this shim failure. Consume `010_repair.md` in the shim-repair cycle; no production edit before a bounded causal trace and independent audit. This P amendment pays the newly discovered multi-cycle roadmap debt before further implementation.

Current known call chain: withInstalledShim creates an owned temporary PATH/home and an executable echo launcher; installCodexShim performs the real transactional install and launcher probe. The test sets the successful-probe observation interval to20ms. The production probe runs a Bun child with a5s launcher budget and1s cleanup budget; the child launches a detached process group with stderr and descendant-lease pipes. The historical boolean assertion discards the install result message. Its6s duration alone cannot tell which child/cleanup boundary refused the install.

Existing ownership/context: prior changes51057b611 and2ea9ba7df preserved bounded failure diagnostics and cleanup fail-closed behavior. D does not change shim.ts or this test, has a previous serialized81-test pass, and currently owns a macmini-cf full-suite queue slot. B must respect that slot and not induce competing test load.

## Bounds

Treat any executed launcher-validation or cleanup change as C4. Allow read-only GH logs/history and owned remote macOS probes with pinned Bun1.4.0, temporary PATH/home and the shared test-user lock. Write only the owning test, the demonstrated faulty probe boundary if required, and numbered outcome/contract documentation. No global launcher install, service restart, personal account or credential access, release/deploy, integration-branch direct push, or local test/typecheck/build. Existing no-verify/admin and inherited-agent authorization applies. No requested token/cost cap; six-hour checkpoint is a reporting bound. Investigative security details stay in ignored scratch until the fix is public.

## Baseline discriminator

The first isolated named-case trace passed. Both the fresh install and obsolete refresh ran the unmodified embedded probe with20ms observation,5s launcher and6s parent ceilings; their child results were status0 with expected group/stderr metadata, in169ms and33ms respectively. This does not resolve the intermittent CI failure. Next bounded probe is the owning file/fixture neighborhood or sequential positive repetitions with every failure retained, to distinguish test-state leakage from starter/process/stream timing. No artificial bootstrap stall will be presented as proof of this historical cause.

Prior owner A confirms no reproduced6s positive-fixture failure: its51057b611 change only concerns the existing passive cleanup interval after EPERM; the old deliberately negative timeout case and current unexpected setup refusal must remain separate.
