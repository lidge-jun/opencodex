# Cross-platform CI

`.github/workflows/catalog-async-contracts.yml` runs the Rust-owned Bun-module catalog contracts on Linux, macOS and Windows for affected pull requests or manual dispatch. The portable fixture uses synthetic homes and cleared child environments. This read-only workflow has no secrets, publication step or release-eligibility effect.

The [desktop membership contract](../runtime.md#codex-desktop-process-membership) has adapter regression coverage on every host and real PowerShell prefilter regression coverage with synthetic CIM rows on Windows in `tests/clients/desktop-app-restart.test.ts`. A skipped Windows lane does not exercise that native filter; uid-dependent POSIX cases in `tests/clients/desktop-app-restart-posix.test.ts` are skipped on Windows.

`.github/workflows/ci.yml` runs scoped Ubuntu checks for pull requests and has no push or
schedule trigger. By default PRs run `gates` and `test changed`; a full Linux suite is selected
for `ci:full` or CI, harness, toolchain and dependency changes. macOS and Windows jobs run on
manual dispatch from `dev`, not on PRs. A full `lane=all` dispatch provides evidence for its exact
source SHA; a PR green or a narrower dispatch is not full-platform evidence. After a batch of
merges, maintainers run one full dispatch on `dev` rather than one per PR.

The manual `windows-native-claim` lane runs the instrumented native-main quota
provenance test on one hosted Windows runner, without starting the full matrix.
It is diagnostic evidence only: it cannot mark a commit green for release.

Two paths sit outside the `ci` filter on purpose and get narrow jobs instead of the full matrix.
A change under `.github/actions/` runs `setup-action` on Linux for PRs and on Linux, Windows and macOS for full dispatch: it runs the
composite Bun setup and requires the installed runtime to equal the version `package.json`
declares. A change under `native/remote-workspace-helper/` runs `remote-helper` on the same three
runners on full dispatch and Linux for PRs: `cargo fmt` on Linux, then `cargo clippy -D warnings` and `cargo test` everywhere, where
the live confinement tests compile only on macOS and Windows. Both filters also list `ci.yml`,
both stay pull-request scope like `docs` and `structure`, their outputs are validated before any
job reads them, and the aggregate gate expects each job exactly when its filter output is `true`.

`privacy:scan` runs inside `gates`, and `gates` is scoped to the `ci` filter. The `privacy
gate` job is its exact complement on pull requests — it runs wherever the `ci` filter declines —
so every pull request scans exactly once and the coverage does not depend on an enumerated path
list. The aggregate derives the same expectation from its `scoped` result.

The macOS suite has four duration-weighted shards (`macos N/4`, `TEST_SHARD=N/4`), each capped
at 20 minutes. With the widget/bundle job, `lane=all` requests at least five macOS jobs for five
runner slots; a `ci.yml` change also selects the setup-action macOS leg. The unsharded `macos
control` runs only on a `lane=macos-control` dispatch: on `lane=all` it repeated the suite the
four shards had already passed on the same commit, on one worker, for 50 to 60 minutes, and
every release waited for it. Release evidence (`.github/scripts/release-evidence.cjs`) therefore
does not require it.
Widget/bundle waits for `gates`, so the requests need not overlap and a queue is possible rather
than guaranteed. The fourth shard adds setup overhead while dividing the same suite.

No recovery retry can turn a failed workflow green. Linux, Windows, macOS shards and macOS control use
`scripts/ci/run-bun-test-batches.sh`, but
each lane owns its measured process shape: Linux keeps the default twelve files and 120 seconds;
Windows uses six files and 480 seconds. macOS control uses twelve files, 300 seconds and one
worker across an unsharded 1/1 selection. Windows and macOS control select all test families, while Linux leaves the
storage-policy and api-usage families to its dedicated jobs. The Windows step disables the
user-scoped test-run queue with `OCX_TEST_NO_QUEUE=1`: the batches already run sequentially in one
dedicated job, and queueing a new batch behind a surviving process from the preceding batch spends
the process timeout without executing tests. The per-process home isolation and live-home/service
manager guards remain active because the preload installs them before the lock boundary.
Test teardown follows the [sandbox cleanup contract](test-sandbox-cleanup.md).
`tests/preload.ts` resolves cleanup dependencies after home/lock admission and before test cases; teardown awaits native-main startup releases and config hardening, then the sandbox's registered ACL child reaps before removing that root. Its synchronous exit fallback leaves an undrained root for ownership-checked stale recovery instead of blocking child cleanup with removal retries. `tests/ci-workflows/test-sandbox-cleanup.test.ts` pins that ordering with a delayed reap.
`tests/helpers/test-sandbox-cleanup.ts` exposes case-scoped lifecycle ownership: cancellation starts listener stops while owned asynchronous work settles, and repeated close/stop calls share one promise. After teardown starts, only the lifecycle's own abort reason is absorbed; any other error, including a foreign AbortError, still fails its case. Callers settle that lifecycle before draining producers/reaps and restoring or removing a home. The helper does not replace fixture-specific cleanup or claim OS ACL coverage for synthetic tests.
Shard membership follows recorded duration: `scripts/ci/test-durations.tsv` weighs each file on
Linux and macOS and `scripts/ci/test-durations.windows.tsv` on Windows (selected by `RUNNER_OS`;
`BUN_TEST_DURATIONS_FILE` overrides both), because Windows per-file cost is not a constant multiple
of the other two and one table cannot balance all three (#6982). The heaviest file goes to the
least-loaded shard, and a file without a row weighs the table's
median, so an empty table reproduces sorted round-robin exactly. Every shard computes the whole
assignment and refuses to run unless it covers every selected file once. A batch also closes
before its predicted duration passes half the process timeout, which only adds process
boundaries. `scripts/ci/test-durations.ts refresh` regenerates each table from its own platforms'
hosted job logs (`--table` selects the Windows table).
A test failure, a process timeout and a Bun runtime crash each fail their job on the first occurrence; the
batch runner still sweeps a crashed or timed-out batch one file per process, but only to attribute a
failure the shard has already taken. The aggregate `ci` gate derives, from the event and the `changes` outputs, which
jobs this run actually requested, then requires `success` from every one of them and `skipped`
from every job the event did not request — so a job that was requested and never started can no
longer report as a deliberate skip. Whenever Windows is requested the gate additionally reads the
run's own job list through the Actions API and requires nine concrete successful `windows N/9`
results, because a matrix rollup can report `success` when one matrix leg is skipped. A
release that requires Windows proof still dispatches it for the exact publish SHA.
Test sandboxes keep the runner's `LOCALAPPDATA`, so Windows PowerShell 5.1 children reuse the
image's warm module-analysis cache. Replacing it with a freshly built seed made every child
re-analyze modules and timed out seven shards on the first run of #6670.
`scripts/test.ts` pins the default `BUN_RUNTIME_TRANSPILER_CACHE_PATH` beneath its exclusively
created test root, in a `bun-transpiler-cache` directory (mode 0700 on POSIX). Cached JavaScript is
executable input, so the runner never adopts, repairs, migrates or deletes the old fixed host-TEMP
cache. Nested sandboxes and fixture children inherit the owning environment's cache even when
HOME changes; only that owner's cleanup removes it. Separate environments and CI batches start
with separate caches. This gives up automatic cross-batch reuse: cold Windows startup coverage
must be evaluated without raising test deadlines or weakening assertions. An explicit override,
including "" or "0" to disable caching, is preserved and remains the operator's protected-path
responsibility. `tests/ci-workflows/test-runner.test.ts` covers isolation, legacy-path refusal,
cleanup ownership, overrides and actual Bun children with different homes.
The published launcher (`bin/ocx.mjs`) starts the bundled Bun, which is not the test-runner Bun.
Bun keys `.pile` entries by source hash and deletes an entry written in another release's format,
so the two versions sharing one cache evict each other on every start, and each launcher child
loaded its CLI graph cold (a 15 s Windows `spawnSync` timeout in run 38697651428). The launcher
therefore passes its child a `bun-<version>` leaf appended beneath the configured cache
(`src/lib/bun-transpiler-cache-scope.mjs`); `tests/cli/bun-transpiler-cache-scope.test.ts`
covers it.
Server children started on the bundled runtime from a different Bun (startup-health probe,
dashboard startup install, Windows tray) get the same scope through `durableBunChildEnv` in
`src/lib/bun-runtime.ts`. Scoping never leaves the configured path: when the path's own leaf is
already `bun-<version>` of the runtime being started it is kept unchanged, and a changed version
nests one more `bun-<version>` level beneath it.
Startup ACL reads use .NET, never module-autoloaded `Get-Acl`/`Set-Acl`
(`tests/ci-workflows/ci-review-lanes.test.ts` scans `src/`).
Local `bun run typecheck` uses the installed Bun runtime's native checker with the root
`tsconfig.json`, strict options and `src/` scope. `--no-script` prevents a future package `check`
script from replacing type checking, and the command emits no files. `bun run typecheck:tsc`
retains the installed TypeScript compiler for comparison and fallback. CI and release preflight
invoke `tsc` directly; GUI build checks and the separate `testRunnerBun` pin keep their own roles.
The `prepublishOnly` hook runs `typecheck:tsc` after `audit:high` and before `build:gui`,
stopping on either audit or compiler failure.
`tests/ci-workflows/ci-gui-typecheck-gate.test.ts` exercises both package commands against the root
compiler options, including strict failures in unimported source files and a conflicting `check` script,
and runs the publish hook with safe audit/build recorders to verify compiler selection and fail-fast order.
Across the jobs, the workflow runs:

```bash
bun install --frozen-lockfile
bun x tsc --noEmit
bun test --isolate tests
bun run privacy:scan
bun build scripts/release.ts --target=bun --outdir=.tmp/ci-release-script-check
cd gui && bun install --frozen-lockfile && bun run lint && bun run build
bun run src/cli/index.ts help
```

and the Node-only global-install smoke path:

```bash
npm install
npm run build:gui
npm pack --json > pack.json
npm install -g ./bitkyc08-opencodex-*.tgz
ocx help
```

The scoped docs job builds the site. CI does not run coverage or perform remote Ubuntu/RDP smoke tests.
Those stay outside the default gate until a concrete regression justifies the extra runtime.

The manual Release workflow selects a source with qualifying full `dev` dispatch evidence and
uses a separately identified trusted workflow revision. Publication remains held. History
reconciliation and the attested resume follow the [release workflow](docs-and-release.md#release-workflow).
Review of the legacy history mapping, security review, actual dry-run evidence and cutover settings
remain open; a CI run alone does not authorize publication.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.
