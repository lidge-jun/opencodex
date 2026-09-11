# WP-3 — Comparative Memory Verification, Deployment, and Rollback

## Acceptance contract

Use a 10-minute warm-up and a 60-minute measured load window. Sample once per minute.

Canary passes only if all conditions hold:

- `heapUsed(end) - heapUsed(start) <= 32 MiB` over the measured 60 minutes;
- linear heap slope is `<= 0.5 MiB/min` during that window;
- after traffic stops and two 60-second sweeps pass, heap does not remain monotonically increasing for five samples;
- each registered retained store stays within its local cap and aggregate budget contract;
- observed in-flight buffers return to zero active operations after drain;
- request error rate does not exceed the 1.3.14 control by more than 0.5 percentage points;
- no crash, OOM, corrupted response, stalled stream, or failed health check occurs;
- RSS/native growth without heap/app-owner growth is classified separately and cannot be called an OpenCodex heap leak.

The 32 MiB threshold is deliberately much smaller than the 256 MiB app-owned budget. It measures incremental steady-state growth after warm-up, not permitted total retained state.

## Evidence directory

All profiles may contain object names or operational metadata and must remain untracked:

```bash
cd /Users/jun/Developer/opencodex
mkdir -p .tmp/bun-canary-dogfood/{control,canary,logs,profiles}
git check-ignore .tmp/bun-canary-dogfood
```

If `git check-ignore` fails, stop; do not generate snapshots in a tracked path.

Record identities:

```bash
git rev-parse HEAD > .tmp/bun-canary-dogfood/source-sha.txt
"$HOME/.bun/bin/bun" --version > .tmp/bun-canary-dogfood/canary/version.txt
"$HOME/.bun/bin/bun" --revision > .tmp/bun-canary-dogfood/canary/revision.txt
```

## Build and static gates

Run under the pinned canary:

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run privacy:scan
bun run build:gui
git diff --check
```

Generated `gui/dist` changes are expected for source-checkout dogfood but must be reviewed according to repository convention; do not silently commit unrelated generated output.

## Workload definition

Use real `/v1/responses` traffic through the proxy, not `/healthz` alone. The load request must use a low-cost test model/account chosen by the user and must not be written into the devlog. Store the request body in ignored scratch:

```bash
test -s .tmp/bun-canary-dogfood/request.json
python3 -m json.tool .tmp/bun-canary-dogfood/request.json >/dev/null
```

The JSON must request deterministic, bounded output (for example, a short text response with no tools). Do not put API keys in the JSON. Authentication remains in the existing local OpenCodex configuration.

Configure the load without introducing a dependency:

```bash
export OCX_LOAD_URL='http://127.0.0.1:10100/v1/responses'
export OCX_LOAD_CONCURRENCY='4'
export OCX_WARMUP_MINUTES='10'
export OCX_MEASURE_MINUTES='60'
```

Use a bounded Bun load harness implemented in ignored scratch or add a repository script in a separately reviewed commit. Required harness behavior:

- at most four concurrent requests;
- one request body read at startup;
- per-request 120-second AbortSignal timeout;
- consume every response body completely;
- count success, HTTP failure, timeout, and malformed terminal response;
- never print request/response bodies or headers;
- emit one scalar JSON summary per minute;
- stop exactly after warm-up + measurement duration and await all in-flight requests.

## Scalar memory sampling

Use the authenticated CLI path rather than unauthenticated direct access to `/api/system/memory`:

```bash
while :; do
  date -u +%FT%TZ
  ./bin/ocx.mjs system status --json
  sleep 60
done > .tmp/bun-canary-dogfood/canary/memory-samples.jsonl
```

Start this sampler immediately before the load harness and stop it after the two-minute post-load sweep window. Extract only scalar `memory` fields for committed evidence. Never commit the raw API output or heap snapshots.

At minimum retain:

```text
timestamp, pid, bunVersion, bunRevision, uptimeSeconds
rss, heapUsed, heapTotal, external, arrayBuffers, observedBytes, observedMetric
jscHeap.heapSize, jscHeap.heapCapacity, jscHeap.objectCount
responseState totals/counters
appOwnedBytes totals, each static store's count/bytes, observed active/current/high-water
activeTurnCount, isDraining
```

## Control run: Bun 1.3.14

The control must use the same source SHA, package graph, service settings, model, request body, concurrency, durations, and machine state. Install or select the exact stable binary without overwriting the canary evidence:

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
export PATH="$HOME/.bun/bin:$PATH"
bun --version
bun --revision
```

If installing stable replaces the canary binary, record both revisions first and reinstall the captured canary revision before the canary run. Do not call a moving `--canary` build the same artifact if its revision changed between runs.

Service interruption and runtime rebake require user approval:

```bash
# USER APPROVAL REQUIRED
export OPENCODEX_BUN_PATH="$HOME/.bun/bin/bun"
./bin/ocx.mjs service repair
./bin/ocx.mjs service status
./bin/ocx.mjs health --json
```

Run warm-up/load/sampling and save under `.tmp/bun-canary-dogfood/control/`.

## Canary run

Reinstall or restore the exact previously recorded canary revision. Verify `bun --revision` exactly matches the recorded value; if the installer only supplies a newer moving canary, the comparison is invalid and must restart with the new identity.

```bash
# USER APPROVAL REQUIRED
export OPENCODEX_BUN_PATH="$HOME/.bun/bin/bun"
test "$(bun --revision)" = "$(cat .tmp/bun-canary-dogfood/canary/revision.txt)"
./bin/ocx.mjs service repair
./bin/ocx.mjs service status
./bin/ocx.mjs health --json
```

Run the identical warm-up/load/sampling procedure and save under `.tmp/bun-canary-dogfood/canary/`.

## `--smol` and heap snapshots

`--smol` makes GC run more frequently and may slow execution. It is a discriminator, not the only production mode:

1. Run the primary control/canary comparison with normal GC.
2. Repeat a shorter 10-minute warm-up + 20-minute measured canary run with `--smol`.
3. If growth disappears only under `--smol`, investigate GC/allocator cadence; do not declare the app fixed.

For a controlled foreground process, Bun's official profiler writes a V8-format heap snapshot on exit:

```bash
mkdir -p .tmp/bun-canary-dogfood/profiles/canary
bun --heap-prof \
  --heap-prof-dir .tmp/bun-canary-dogfood/profiles/canary \
  --smol \
  src/cli/index.ts start --port 10100
```

This command conflicts with a service already using port 10100. Stop/replace the service only with user approval, and ensure one owner controls Codex config. Gracefully terminate the foreground process after the workload so the exit snapshot is written. Repeat with 1.3.14 using the same source/workload.

Alternative in-process snapshots may use `Bun.generateHeapSnapshot("v8")`, but adding a production endpoint for snapshots is OUT. If needed, create a scratch-only instrumented launcher under `.tmp/`; never expose heap contents through `/api/*` or commit them.

Compare snapshots in Chrome DevTools or Safari/WebKit tools. Record only dominant constructor/retainer deltas and scalar byte counts in the final devlog attestation.

## Result calculation

Define measurement start as the first sample after the 10-minute warm-up and measurement end as the sample nearest 60 minutes later.

```text
heap_growth_mib = (end.heapUsed - start.heapUsed) / 1048576
slope_mib_per_min = least-squares slope of all measured heapUsed samples / 1048576
```

Also calculate RSS, external, ArrayBuffers, JSC heap, response-state, aggregate retained bytes, and each store. Compare canary minus control; do not average away monotonic growth.

Classification:

- heap + named owner grow together: application retention candidate;
- heap grows, all named owners flat: unregistered JS owner; inspect heap dominators;
- external/ArrayBuffers grow with image/stream load: native buffer lifetime candidate;
- RSS grows while heap/external/app owners flatten and later plateaus: allocator retention, not automatically a leak;
- all counters fall after drain/sweep: bounded transient pressure.

## Pre-deploy gate

Deployment is blocked until this exact checklist is complete:

```text
[ ] package and lock pins are reproducible
[ ] typecheck passes
[ ] focused memory tests pass
[ ] full test suite passes
[ ] privacy scan passes
[ ] GUI build passes
[ ] 1.3.14 control completed
[ ] exact canary revision completed
[ ] 60-minute canary heap growth <= 32 MiB
[ ] heap slope <= 0.5 MiB/min
[ ] post-load counters stabilize
[ ] no request/crash/semantic regression
[ ] rollback rehearsal is documented
[ ] user explicitly approved deployment
```

## Local managed-service deployment

The following writes persistent service state and requires explicit user approval:

```bash
cd /Users/jun/Developer/opencodex
export PATH="$HOME/.bun/bin:$PATH"
export OPENCODEX_BUN_PATH="$HOME/.bun/bin/bun"

test "$(bun --revision)" = "$(cat .tmp/bun-canary-dogfood/canary/revision.txt)"
git status --short --branch

# USER APPROVAL REQUIRED
./bin/ocx.mjs service repair
```

If no service is installed, use `./bin/ocx.mjs service install` instead, again only after approval.

## Deployment proof

Registration alone is not success. Prove the serving process, revision, source path, endpoints, and built GUI:

```bash
./bin/ocx.mjs service status
./bin/ocx.mjs health --json
curl -fsS --max-time 5 http://127.0.0.1:10100/healthz
curl -fsS --max-time 10 http://127.0.0.1:10100/v1/models >/dev/null
./bin/ocx.mjs system status --json > .tmp/bun-canary-dogfood/deployed-system.json
```

Required assertions from `system status --json`:

- `memory.bunRevision` equals the recorded canary revision;
- `memory.pid` is non-null and matches the managed process;
- uptime advances across two samples;
- app-owned stores and observed buffers are present;
- health remains green.

On macOS, inspect durable and live launchd state without editing it:

```bash
/usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$HOME/Library/LaunchAgents/com.opencodex.proxy.plist"
launchctl print "gui/$(id -u)/com.opencodex.proxy"
ps -axo pid=,command= | rg '/Users/jun/Developer/opencodex/.+src/cli/index.ts start|src/cli/index.ts start'
```

The program arguments and live process must name the intended Bun executable and this checkout's `src/cli/index.ts`.

Prove served GUI assets are current:

```bash
curl -fsS http://127.0.0.1:10100/ > .tmp/bun-canary-dogfood/deployed-index.html
rg -o 'assets/[^" ]+\.(js|css)' .tmp/bun-canary-dogfood/deployed-index.html
rg -o 'assets/[^" ]+\.(js|css)' gui/dist/index.html
```

The served asset names must match `gui/dist/index.html`.

## Rollback plan

Rollback triggers:

- health or model endpoint failure;
- canary crash/restart loop;
- heap acceptance regression in service operation;
- request error/latency regression;
- runtime revision/path mismatch;
- new Bun semantic incompatibility.

Keep rollback within five minutes by isolating the canary pin commit and recording the pre-canary source SHA/revision.

### 1. Revert repository pin/patch if required

Prefer reverting the isolated canary pin commit; do not reset unrelated work:

```bash
git log --oneline -- package.json bun.lock
git revert <CANARY_PIN_COMMIT_SHA>
```

Revert an application memory patch only if it independently causes the incident. Do not automatically discard proven leak fixes when switching runtimes.

### 2. Restore Bun 1.3.14

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
export PATH="$HOME/.bun/bin:$PATH"
test "$(bun --version)" = "1.3.14"
bun --revision
bun install --frozen-lockfile
bun run typecheck
```

### 3. Re-bake and prove the service

```bash
# USER APPROVAL REQUIRED
export OPENCODEX_BUN_PATH="$HOME/.bun/bin/bun"
./bin/ocx.mjs service repair
./bin/ocx.mjs service status
./bin/ocx.mjs health --json
curl -fsS --max-time 5 http://127.0.0.1:10100/healthz
curl -fsS --max-time 10 http://127.0.0.1:10100/v1/models >/dev/null
./bin/ocx.mjs system status --json
```

Rollback succeeds only when the reported Bun version is 1.3.14, the PID is healthy and stable, the process path is correct, and both endpoints respond. Record elapsed rollback time and the reason; do not delete canary evidence until diagnosis is complete.

## Final attestation to append to `000_plan.md`

Append a concise table after execution:

```text
source SHA
canary version and revision
control version and revision
package/lock commit
memory-fix commits
typecheck/test/privacy/build results
control heap growth/slope
canary heap growth/slope
RSS/external/app-owned interpretation
deployment approval timestamp
service PID/runtime path/revision
health/models/GUI proof
rollback rehearsal duration and result
terminal decision: deploy, rollback, or blocked
```
