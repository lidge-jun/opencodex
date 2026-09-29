# 022 wp2 results: local regression on the integration head

Head 441aeb179e in /private/tmp/rt2710-verify; base dev 37ad7e771b in /private/tmp/rt2710-base.
Machine: macOS, 15 cores, load average 4-11 from unrelated desktop processes during the runs; a real
opencodex proxy listens on 127.0.0.1:10100.

## Gates

| Gate | Result |
|---|---|
| typecheck | exit 0 |
| lint:gui | exit 0 |
| build:gui | exit 0 |
| privacy:scan | exit 0 |
| structure:check | exit 0 |
| skill:surface:check | exit 0 |
| gui `bun test tests` | exit 0 |
| docs-site `bun run build` | exit 0 |
| focused files (wp1) | 321 tests, 0 fail, 1 skip (real-Windows readback) |
| full `bun run test` | exit 1 twice (196 and 116 failures); every failure classified below as pre-existing |

## Classification of full-suite failures

| Failing files | Evidence | Class |
|---|---|---|
| tests/claude-integration/{claude-picker-runtime, claude-picker-ca, claude-management-api, claude-models-discovery, claude-picker-recovery} | Pattern: one server-starting test hangs to its timeout, bun kills a dangling child, then the rest of that worker fails with `SpendLedgerOwnerError` (SPEND_LEDGER_OWNER_HOME_CONFLICT). The whole directory (64 files) at head: 1190 pass, 0 fail. The same directory at base: 7 fail with the identical hang + SpendLedgerOwnerError cascade in claude-models-discovery. The five files alone at head: 129/129 pass. | pre-existing flake (suite-level hang cascade), not introduced by the union |
| tests/service/shutdown-launcher.test.ts (3 cases, 20s) | Fails identically alone at head and alone at base; leaves orphan `--ocx-internal-launch-proof` proxies (cleaned up after each run). Also in the first base full run. | pre-existing, environment |
| tests/cli/cli-headless-parity.test.ts (2) | Passes alone at head (91 tests with shutdown-launcher: only the 3 launcher cases fail). | load flake |
| Base-only: CLI subcommand help x4, ocx models x2 (timeouts) | Did not recur at head. | load flake |

No new file was added to the failing set by the union, and no failure reproduces at head in
isolation while passing at base. The union's own code paths have no new child-process spawns
(`git diff 37ad7e771b..441aeb179e -- src` adds only one bounded `fetch` in
src/integrations/cursor-local-installer.ts).

Follow-up (outside this unit): the claude-integration hang cascade and the launcher orphan cases are
worth their own issue; they are reproducible on a loaded macOS host at dev.

## Independent review

Kimi reviewer 01a0eb66 reviewed the union diff (shared files between PRs, i18n, test-layout rosters,
skill surface, structure docs, F1-F4): PASS; one Low finding rebutted in 021.

Cross-platform coverage (Linux, Windows, macOS shards) comes from the single CI run in wp3.

