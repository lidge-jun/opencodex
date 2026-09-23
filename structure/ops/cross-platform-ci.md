# Cross-platform CI

The [desktop membership contract](../runtime.md#codex-desktop-process-membership) has adapter regression coverage on every host and real PowerShell prefilter regression coverage with synthetic CIM rows on Windows in `tests/clients/desktop-app-restart.test.ts`. A skipped Windows lane does not exercise that native filter; uid-dependent POSIX cases in `tests/clients/desktop-app-restart-posix.test.ts` are skipped on Windows.

`.github/workflows/ci.yml` is the ordinary quality gate for runtime/package changes. A pull
request verifies Linux and TypeScript: Linux runs the suite in four shards with a separate
`gates` job alongside the scoped docs, structure, packaging, keyring, and npm-global jobs. The
`platform-macos` macOS suite, the `widget` macOS widget + Tauri app-bundle build, and the
`desktop-shell` Rust toolchain build are native-gated: they run on the promotion pushes to
`main` and `preview` and on explicit `workflow_dispatch`, and on a pull request only when the
`changes` job's native path filter selects the change. `dev` pushes start nothing — dev
integration is covered by the pull-request run — while `main` and `preview` must remain push
triggers because `release.yml` requires a successful push-event run for the exact release SHA
and does not accept a pull-request run. Windows runs the full suite in nine shards only on manual
`workflow_dispatch` with `lane=all` (or an empty lane), and an aggregate green `ci` check
legitimately includes deliberate skips for every job the event did not request.

This scoping accepts a real coverage loss: a green pull request no longer proves the macOS suite,
the Rust toolchain, or the app bundle. Those regressions are caught at the promotion push to
`preview` or `main`, before publication, and on demand by explicit dispatch — a pull request
that is green is not full-platform proof.

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
A test failure, a process timeout and a Bun runtime crash each fail their job on the first occurrence; the
batch runner still sweeps a crashed or timed-out batch one file per process, but only to attribute a
failure the shard has already taken. The aggregate `ci` gate derives, from the event and the `changes` outputs, which
jobs this run actually requested, then requires `success` from every one of them and `skipped`
from every job the event did not request — so a job that was requested and never started can no
longer report as a deliberate skip. On a `lane=all` dispatch the gate additionally reads the
run's own job list through the Actions API and requires nine concrete successful `windows N/9`
results, because a matrix rollup can report `success` when one matrix leg is skipped. A
release that requires Windows proof still dispatches it for the exact publish SHA.
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

The CI intentionally does not build docs, run coverage, or perform remote Ubuntu/RDP smoke tests.
Those stay outside the default gate until a concrete regression justifies the extra runtime.

The Release workflow remains manual and publish-focused. Before any dry-run or publish step, it
checks that the exact release commit (`GITHUB_SHA`) already has a successful push-event
Cross-platform CI run — a pull-request run does not qualify — that `dev` already outranks the
target, and that the target passes the fresh global tag-ordering gate.
This keeps release runs short and makes release a deployment of a verified commit after the required
`dev` pre-move rather than a second CI pipeline.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.
