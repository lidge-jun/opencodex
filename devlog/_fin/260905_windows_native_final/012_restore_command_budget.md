# 012 — Child layer: bound restore subprocesses, preserve all assertions

Same work-phase repair loop; new small dependent PR atop3629. C2 native-Codex
test-harness surface, one additional test file. No production behavior changes.

MODIFY `tests/codex-integration/codex-restore-app-rewrite.test.ts`:

- Import existing SPAWN_BUDGET_MS. Use it as spawnSync timeout with SIGKILL so a
  timed-out owned child cannot keep the synchronous waiter alive indefinitely.
- Give all five intrinsic-process cases2*SPAWN_BUDGET_MS, keeping the outer case
  bound larger than its command deadline. Pure assertions and script payloads
  remain intact. No skipped/removed case or rewritten expected config value.
- Preserve status, signal and result.error in a useful failure message. Enforce
  nonzero/abnormal completion centrally in runScript so no call site can hide an
  empty failure. Include bounded stdout/stderr tails. No retry.
- A normally disabled OCX_TEST_CODEX_RESTORE_DELAY_MS fault may prepend a
  bounded(0..60000ms) Bun.sleep to the generated child script. It is test-only;
  never enabled for ordinary CI. This is a diagnostic stimulus, not normal
  synchronization. At baseline retain old15s case bounds while adding the fault
  and result diagnostics; the selected first case with16s delay must go red.
- Then apply the intrinsic process/case budgets and require the identical
  delayed case to pass original config-removal/preservation assertions.
- Run a nonzero-exit diagnostic probe using a temporary generated-script mutation
  (not committed), proving status/error text is surfaced. Temporarily disable
  restore in the generated test script to show the original assertions still
  reject retained openai_base_url. Restore all mutations before commit.

Verifier: focused file only, then typecheck/privacy/diff and independent review.
Do not start a new Windows workflow until33947540953's six Windows shards have
finished; then dispatch the stacked fixed head and require every shard green.
Any further failure loops back through diagnosis. New code stays in tests; the
case-budget increase is conditional on causal probes, not a green-on-retry claim.

Audit fold-back: Noether requested direct exercise of the new command deadline.
With the90second case bound, set the helper delay to46000ms: the45second command
deadline must terminate it and surface actual status/signal/error before cleanup.
The validation driver expects that timeout failure. Temporarily omitting the
command limit must let the same46second delayed script finish, failing that
timeout expectation; restore the limit before normal tests or any commit.
These are local focused fault probes, not a Windows full-suite rerun.

Class inventory amendment013 adds only two same-heavy-owner siblings, with their
own bounded holder/nested-child relationships and preserved behavior oracles.
Do not change the remaining unmeasured catalog/leaf-owner candidates.
