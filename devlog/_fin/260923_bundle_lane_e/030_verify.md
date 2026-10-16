# Verification

Per item, after its commit:

- #5629: bun test tests/server/retry-delay-hardening.test.ts tests/server/retry-after-429.test.ts tests/providers/devin-stated-reset-retry.test.ts tests/providers/devin-stated-reset-hardening.test.ts tests/providers/devin-hardening.test.ts tests/codex-integration/combo-authoritative-reset.test.ts (includes the new repeated-marker negative case).
- #5659: bun test tests/responses/responses-code-mode-goal-helpers.test.ts tests/responses/responses-undeclared-tool-guard.test.ts tests/responses/responses-custom-tool-repair.test.ts tests/responses/responses-bare-echo-helper-fence.test.ts tests/responses/responses-default-namespace-emit-normalize.test.ts tests/responses/legacy-shell-compat.test.ts tests/responses/responses-code-mode-shell-compile.test.ts tests/responses/responses-code-mode-patch-compile.test.ts (includes the raw guard-input, unrelated-name and bare-goal precedence cases).
- #5646 + #5633: bun test tests/responses/ws-ambiguous-resend.test.ts tests/responses/ws-failure-stage.test.ts tests/server/replay-refusal-parity.test.ts tests/lib/ambiguous-resend-composition.test.ts tests/routing/routing-policy-fallback.test.ts tests/lib/upstream-retry.test.ts tests/responses/responses-reset-replay.test.ts tests/responses/responses-opaque-blob-recovery.test.ts tests/server/server-combo-failover-e2e.test.ts.
- #5489: bun test tests/adapters/run-turn-queue.test.ts tests/server/server-combo-zero-output-failover.test.ts tests/server/server-combo-failover-e2e.test.ts tests/responses/responses-stream-tool-events.test.ts tests/adapters/bridge.test.ts tests/responses/responses-undeclared-tool-guard.test.ts, including the new non-streaming case: heartbeat(replayUnsafe) then an undeclared tool call returns the refusal with exactly one target dispatch.

Branch gates: tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/ci-workflows/file-size-ratchet.test.ts tests/ci-workflows/structure-ssot.test.ts, bun run typecheck, bun run structure:check, bun run privacy:scan, git diff --check. No full local suite (owner runs it after every lane lands).

Evidence required before the final report: exact-head hosted CI with every required job completed success at the PR head SHA (run ids and per-job conclusions recorded), and a gpt-6-sol adversarial review of the final diff with verdict PASS and findings folded.
