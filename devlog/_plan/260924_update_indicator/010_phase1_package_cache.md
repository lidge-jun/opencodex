# 010 — Package cache freshness and asynchronous checks

## Commit contract

Goal: a service-owned package install refreshes `version.json` after bind and while running; explicit management checks do not block the Bun request loop; a cache older than 40 hours cannot claim an available update. This is commit 1 / work-phase wp1 of `000_plan.md`, decision D5. It has no preceding implementation commit. Commits 2–4 may consume the unchanged package badge shape and its read-only GET.

IN: npm, pnpm and Bun package installs; registry discovery; cache and dismissal; scheduler lifetime; `/api/update/check`, `/api/update/run`, package badge; focused tests; structure and public management API docs. OUT: desktop snapshot, native tray, GUI navigation, npm Windows tray, auto-install policy, Lab boundary modules, authentication semantics, updater signature/integrity checks, and change to detached installer worker. No GUI i18n key is introduced.

The proposed opt-out is **new** `OCX_DISABLE_UPDATE_CHECK=1`, applying only to automatic scheduler startup. Search at this HEAD found no existing `OCX_DISABLE_UPDATE_CHECK`, `NO_UPDATE`, or `checkForUpdates` symbol under `src/config*`, `src/update`, or `src/server/index.ts`; `OCX_SERVICE` currently gates interactive prompting, not update checks (`src/update/notify.ts:125-132`). Explicit checks remain user-initiated. The source/mise guard is required regardless of the env var. Do not reinterpret `OCX_SERVICE` as an opt-out.

## Existing contracts to preserve

`registrySpawnTarget` rejects unowned pnpm queries and carries owner environment plus Windows invocation options (`src/update/index.ts:188-228`); `latestVersion` currently uses `spawnSync` and a 12-second timeout (`src/update/index.ts:272-290`). `resolveCurrentPnpmGlobalOwner` performs synchronous manager probes (`src/update/index.ts:97-123`), so an async registry child alone is insufficient on pnpm. `checkForUpdate` is the existing response builder, including source/mise guidance (`src/update/job.ts:486-524`); its injectable `latestVersion` dependency is declared in `src/update/check-types.ts:3-9`. `startUpdateJob` checks synchronously before creating a job (`src/update/job.ts:619-663`), and an injected `checkForUpdateFn` lets the request supply an already checked answer. The badge reader currently has no refresh dependency (`src/update/badge.ts:32-75`), and its GET only calls that reader (`src/server/management/sidebar-routes.ts:100-103`). The interactive prompt spawns `__refresh-version` (`src/update/notify.ts:174-206,238-247`), while the CLI invokes the prompt before server bind (`src/cli/index.ts:489`; test: `tests/update/update-notify.test.ts:127-139`). Server stop delegates cleanup through `runListenerShutdown` (`src/server/index.ts:749-793`); the synchronous Lab activation point is `src/server/index.ts:858-866`. Its specific structure owner is `structure/adapters/compatibility-lab.md:3-18`; this commit leaves that contract text accurate, so it is reviewed without editing it.

Other existing symbols used by the proposed blocks: package/channel/install detection at `src/update/index.ts:58-80,173-185`; `registrySpawnTarget` at `src/update/index.ts:217-228`; pnpm owner lookup and running shim at `src/update/index.ts:87-123`; `unprivilegedOwnershipMutationEnvironment` import at `src/update/index.ts:14`; `VersionCache`, `readVersionCache`, `writeVersionCache`, and `isSourceBuildVersion` at `src/update/notify.ts:19-63,121-123`; `detectInstallOwnership` and `miseUpdateCommand` at `src/update/index.ts:70-80`; `UpdateCheckResult`, `checkForUpdate`, and `startUpdateJob` at `src/update/job.ts:82-92,486-524,619-663`; `normalizeUpdateChannel` at `src/update/job.ts:256`; `readUpdateBadge` at `src/update/badge.ts:48-75`; the GUI package consumers at `gui/src/pages/use-dashboard-data.ts:823,907`; the route handler at `src/server/management/config-routes.ts:290,750-777`. Runtime standard-library `spawn`, `Worker`, timers, and `Request` are platform APIs, not repository symbols.

## File change map and executable edits

| Path | Action | Edit anchor |
| --- | --- | --- |
| `src/update/index.ts` | MODIFY | Export the existing registry target builder/type only |
| `src/update/pnpm-owner-worker.ts` | NEW | Complete worker source below |
| `tests/fixtures/pnpm-owner-stall-worker.ts` | NEW | Worker deadline regression fixture below |
| `src/update/async-check.ts` | NEW | Complete async lookup source below |
| `src/update/notify.ts` | MODIFY | Export interval, add write-through, stop prompt launch |
| `src/update/refresh-scheduler.ts` | NEW | Complete coordinator source below |
| `src/update/badge.ts` | MODIFY | 40-hour validity and read-only state |
| `src/server/management/config-routes.ts` | MODIFY | Await coordinated checks for check/run |
| `src/server/management/context.ts` | MODIFY | Inject one delayed check at the management route boundary for regression proof |
| `src/server/index.ts` | MODIFY | Paired, idempotent listener start/stop hook below |
| `tests/update/update-refresh.test.ts` | NEW | Complete source below |
| `tests/server/update-async-routes.test.ts` | NEW | Complete source below |
| `tests/update/update-notify.test.ts`, `tests/update/update-badge.test.ts`, `tests/update/update-job.test.ts`, `tests/server/sidebar-routes.test.ts` | MODIFY | Cases and exact assertions below |
| `tests/preload.ts` | MODIFY | Suppress automatic registry checks in all Bun test-started servers |
| `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json` | MODIFY | Two explicit registrations below |
| `structure/runtime.md`, `structure/ops/service-and-sidecars.md`, `structure/gui-and-management-api.md` | MODIFY | Exact contract text below |
| `docs-site/src/content/docs/reference/management-api.md` and existing `fr`, `ja`, `ko`, `ru`, `tr`, `zh-cn`, `zh-tw` siblings | MODIFY | Row replacements and locale instruction below |

No DELETE path. No source, test, config, or other doc file is modified in this docs-only pass; this table is the later implementation commit's map.

### `src/update/index.ts` — MODIFY

Change the declaration `function registrySpawnTarget(` at line 217 to `export function registrySpawnTarget(`. Keep lines 218–228 byte-for-byte, as well as the synchronous `latestVersion` for the detached worker. Export its return type for the async module:

```ts
export type RegistrySpawnTarget = SpawnTarget;
```

Place that alias after `SpawnTarget` at line 193. The async module below uses exactly the same `registrySpawnTarget`, including `pnpmOwnerInvocation` (`src/update/index.ts:201-228`) and `unprivilegedOwnershipMutationEnvironment` (`src/update/index.ts:14,286`). Do not duplicate target construction. No other existing export changes.

Preserve pnpm's running-shim proof across the Worker boundary. Replace the first line of `runningPnpmShimPath` (`src/update/index.ts:87-95`) and the signature/call in `resolveCurrentPnpmGlobalOwner` (`src/update/index.ts:114-123`) as follows; all other function lines stay unchanged:

```ts
function runningPnpmShimPath(invoked = process.argv[1]): string | undefined {
  if (!invoked) return undefined;
  const name = invoked.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  if (!new Set(["ocx", "opencodex", "ocx.cmd", "opencodex.cmd", "ocx.ps1", "opencodex.ps1"]).has(name ?? "")) {
    return undefined;
  }
  return resolve(invoked);
}

export function resolveCurrentPnpmGlobalOwner(invoked = process.argv[1]): PnpmGlobalOwnerResult {
  return resolvePnpmGlobalOwner({
    packageName: PKG,
    packagePath: packageRoot(),
    commandPaths: resolvePnpmCommands(),
    runningShimPath: runningPnpmShimPath(invoked),
    runPnpm: runPnpmCandidate,
  });
}
```

### `src/update/pnpm-owner-worker.ts` — NEW; complete file

The worker is only used for pnpm. It runs the existing ownership proof off the request thread; it never serializes an owner to disk or a response. Bun's module worker loads this TypeScript source at runtime. A worker error/timeout yields null; it must not fall back to unowned `pnpm` on PATH.

```ts
import { resolveCurrentPnpmGlobalOwner } from "./index";

onmessage = event => {
  try {
    const invoked = typeof event.data === "string" ? event.data : "";
    if (!invoked) { postMessage(null); return; }
    const result = resolveCurrentPnpmGlobalOwner(invoked);
    postMessage(result.ok ? result.owner : null);
  } catch {
    postMessage(null);
  }
};
```

### `src/update/async-check.ts` — NEW; complete file

This module owns bounded asynchronous package-manager lookup. Its `pnpmOwner` worker has an independent 12-second deadline because owner discovery may run several synchronous manager probes. The registry child has its own 12-second deadline. `spawn`'s `error` and `close` can both fire; `finish` settles once. Output is limited while streaming, so a noisy manager cannot grow memory indefinitely. No stderr/stdout is logged or returned. The worker is terminated on completion. Tests inject `spawnFn` and `ownerFn`, avoiding an installed registry or pnpm owner. The optional worker URL/deadline/invocation parameters below permit a real Bun Worker startup/deadline test without invoking a package manager; production retains the fixed source URL and 12-second deadline.

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { unprivilegedOwnershipMutationEnvironment } from "../service/ownership-mutation-lease.mjs";
import { PKG, registrySpawnTarget, type Channel, type Installer } from "./index";
import type { PnpmGlobalOwner } from "./pnpm-global-install.mjs";

export const REGISTRY_DEADLINE_MS = 12_000;
export const REGISTRY_OUTPUT_LIMIT = 4_096;

export interface PnpmOwnerDeps {
  workerUrl?: URL;
  deadlineMs?: number;
  invoked?: string;
}

export async function pnpmOwner(deps: PnpmOwnerDeps = {}): Promise<PnpmGlobalOwner | null> {
  return new Promise(resolve => {
    let worker: Worker;
    try {
      worker = new Worker((deps.workerUrl ?? new URL("./pnpm-owner-worker.ts", import.meta.url)).href);
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (owner: PnpmGlobalOwner | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(owner);
    };
    const timer = setTimeout(() => finish(null), deps.deadlineMs ?? REGISTRY_DEADLINE_MS);
    worker.onmessage = event => finish(event.data as PnpmGlobalOwner | null);
    worker.onerror = () => finish(null);
    try { worker.postMessage(deps.invoked ?? process.argv[1] ?? ""); }
    catch { finish(null); }
  });
}

export interface AsyncLookupDeps {
  ownerFn: () => Promise<PnpmGlobalOwner | null>;
  spawnFn: typeof spawn;
  deadlineMs?: number;
}

const defaultDeps: AsyncLookupDeps = { ownerFn: pnpmOwner, spawnFn: spawn };

export async function latestVersionAsync(
  channel: Channel,
  installer: Installer,
  deps: AsyncLookupDeps = defaultDeps,
): Promise<string | null> {
  if (installer === "source" || installer === "mise") return null;
  let owner: PnpmGlobalOwner | null | undefined;
  try { owner = installer === "pnpm" ? await deps.ownerFn() : undefined; }
  catch { return null; }
  if (installer === "pnpm" && !owner) return null;
  const target = registrySpawnTarget(installer, ["view", `${PKG}@${channel}`, "version"], owner);
  if (!target) return null;

  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = deps.spawnFn(target.bin, target.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: unprivilegedOwnershipMutationEnvironment(target.env ?? process.env),
        ...target.options,
      }) as ChildProcessWithoutNullStreams;
    } catch {
      resolve(null);
      return;
    }
    child.stdin.end();
    let done = false;
    let bytes = 0;
    let stdout = "";
    let failed = false;
    const finish = (version: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(version);
    };
    const accept = (chunk: Buffer, capture: boolean) => {
      bytes += chunk.length;
      if (bytes > REGISTRY_OUTPUT_LIMIT) {
        failed = true;
        child.kill();
      } else if (capture) {
        stdout += chunk.toString("utf8");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => accept(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => accept(chunk, false));
    child.once("error", () => finish(null));
    child.once("close", code => {
      const value = stdout.trim();
      finish(!failed && code === 0 && (channel === "latest"
        ? /^\d+\.\d+\.\d+$/.test(value)
        : /^\d+\.\d+\.\d+(?:-preview\.\d+)?$/.test(value))
        ? value : null);
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, deps.deadlineMs ?? REGISTRY_DEADLINE_MS);
  });
}
```

Implementation check: `ChildProcessWithoutNullStreams` is valid only with all three pipes; keep `stdio` as shown. If Bun's Worker constructor cannot load the TypeScript URL on a supported platform, the focused pnpm test must fail and B must replace it with a bundled Bun worker launch before shipping; never fall back to synchronous owner discovery in the handler.

`tests/fixtures/pnpm-owner-stall-worker.ts` — NEW; complete file. It deliberately receives a message and never replies. It is loaded only by the deadline test; the empty-invocation production-worker test below proves the actual `pnpm-owner-worker.ts` can start and exchange a message without launching pnpm.

```ts
onmessage = () => {};
```

### `src/update/notify.ts` — MODIFY

Export the existing interval (`src/update/notify.ts:20`) for the scheduler and add a single write-through function after `writeVersionCache` (`src/update/notify.ts:57-63`). The read occurs at commit time, after lookup completion. A dismissal follows only the exact same latest version; a different channel has no inherited dismissal. Atomic `writeVersionCache` remains the sole file writer. Since all new writes are synchronous and occur in one Bun event loop, their completion order is serialized; channel mismatch is rechecked by the next scheduler tick. No new persisted field is needed.

```ts
export const REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000;

export function writeFreshVersionCache(channel: Channel, latest: string, nowMs = Date.now()): void {
  const previous = readVersionCache(channel);
  writeVersionCache({
    latest_version: latest,
    last_checked_at: new Date(nowMs).toISOString(),
    dismissed_version: previous?.latest_version === latest && previous.dismissed_version === latest
      ? latest : undefined,
    tag: channel,
  });
}
```

Remove the original non-exported interval declaration, leaving exactly one. Replace lines 197–207 with the following compatibility body for the existing hidden CLI command, which is already detached and is not on the request loop:

```ts
export async function refreshVersionCache(channel: Channel): Promise<void> {
  const latest = latestVersion(channel);
  if (latest) writeFreshVersionCache(channel, latest);
}
```

Remove only `triggerBackgroundRefreshIfStale(channel, cache);` at line 245. Keep `triggerBackgroundRefreshIfStale`, its imports, and the hidden `__refresh-version` dispatch exported for compatibility, but `maybeShowUpdatePrompt` no longer launches it. A normal interactive `ocx start` gets the same scheduler after bind. This prevents two local writers on each new startup. Leave the pre-bind update prompt and its dismissal untouched.

### `src/update/refresh-scheduler.ts` — NEW; complete file

> **wp1 Check amendments (authoritative over the block below):** in-flight entries carry their `epoch`, and an automatic tick joins only a same-generation flight (a stopped listener's flight cannot write for the new one); every flight takes a per-channel sequence number and writes only when it is newer than the last flight that wrote that channel, so an explicit caller that kept an old flight writable across stop/start cannot overwrite a newer result. Regressions: `restart does not join the stopped listener's pending lookup` and `an older explicit flight cannot overwrite a newer generation's write` in `tests/update/update-refresh.test.ts`. The shipped file is `src/update/refresh-scheduler.ts` at commit 1.

The same coordinator serves background and explicit checks. `check` coalesces per channel. Explicit checks bypass staleness/backoff, but join an in-flight lookup; a failed lookup returns the existing `latest_unavailable` response via `checkForUpdate`. The flight records explicit interest before awaiting. Its successful completion writes through when any caller explicitly requested the result, even if `stop()` changed the generation meanwhile; only a purely automatic late result is suppressed. This keeps one cache write for concurrent explicit callers. `start` is a synchronous timer registration and queues the first due lookup in a microtask; it does no filesystem or registry work between `Bun.serve` and Lab activation. The module singleton uses paired start/stop references: each successful `startServer` call registers one reference, and stopping one listener cannot disarm another. The scheduler has injected clock/timer/lookup dependencies for deterministic tests.

```ts
import { checkForUpdate, type UpdateCheckResult } from "./job";
import { currentVersion, defaultUpdateTag, detectInstall, detectInstallOwnership, miseUpdateCommand, type Channel, type Installer } from "./index";
import { isSourceBuildVersion, readVersionCache, REFRESH_INTERVAL_MS, writeFreshVersionCache } from "./notify";
import { latestVersionAsync } from "./async-check";

export const STALENESS_TICK_MS = 60 * 60 * 1000;
export const RETRY_BASE_MS = 60_000;
export const RETRY_CAP_MS = STALENESS_TICK_MS;

export interface RefreshDeps {
  now: () => number;
  lookup: (channel: Channel, installer: Installer) => Promise<string | null>;
  current: () => string;
  install: () => Installer;
  ownership: typeof detectInstallOwnership;
  guidance: typeof miseUpdateCommand;
  read: typeof readVersionCache;
  write: typeof writeFreshVersionCache;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  disabled: () => boolean;
}

const defaults: RefreshDeps = {
  now: Date.now,
  lookup: latestVersionAsync,
  current: currentVersion,
  install: detectInstall,
  ownership: detectInstallOwnership,
  guidance: miseUpdateCommand,
  read: readVersionCache,
  write: writeFreshVersionCache,
  setTimer: setTimeout,
  clearTimer: clearTimeout,
  disabled: () => process.env.OCX_DISABLE_UPDATE_CHECK === "1",
};

export function createRefreshScheduler(deps: RefreshDeps = defaults) {
  const inFlight = new Map<Channel, { task: Promise<string | null>; markExplicit: () => void }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let starts = 0;
  let failures = 0;
  let retryAt = 0;
  let generation = 0;

  const eligible = () => {
    const version = deps.current();
    const installer = deps.install();
    return !deps.disabled() && version !== "?" && !isSourceBuildVersion(version)
      && installer !== "source" && installer !== "mise";
  };
  const channel = () => defaultUpdateTag(deps.current());
  const stale = (tag: Channel) => {
    const checked = Date.parse(deps.read(tag)?.last_checked_at ?? "");
    return !Number.isFinite(checked) || checked > deps.now() || deps.now() - checked >= REFRESH_INTERVAL_MS;
  };
  const schedule = (delay: number) => {
    if (!running) return;
    if (timer) deps.clearTimer(timer);
    timer = deps.setTimer(() => { timer = undefined; void tick(); }, delay);
    timer.unref?.();
  };
  const lookup = (tag: Channel, automatic: boolean): Promise<string | null> => {
    const existing = inFlight.get(tag);
    if (existing) {
      if (!automatic) existing.markExplicit();
      return existing.task;
    }
    const epoch = generation;
    let explicitInterest = !automatic;
    const task = Promise.resolve().then(() => deps.lookup(tag, deps.install())).then(latest => {
      if (latest && (explicitInterest || (automatic && running && epoch === generation))) {
        deps.write(tag, latest, deps.now());
      }
      if (automatic && running && epoch === generation) {
        failures = latest ? 0 : failures + 1;
        retryAt = latest ? 0 : deps.now() + Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 6));
      }
      return latest;
    }).catch(() => {
      if (automatic && running && epoch === generation) {
        failures += 1;
        retryAt = deps.now() + Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 6));
      }
      return null;
    }).finally(() => { if (inFlight.get(tag)?.task === task) inFlight.delete(tag); });
    inFlight.set(tag, { task, markExplicit: () => { explicitInterest = true; } });
    return task;
  };
  const tick = async () => {
    if (!running || !eligible()) return;
    const tag = channel();
    if (stale(tag) && deps.now() >= retryAt) await lookup(tag, true);
    schedule(retryAt > deps.now() ? Math.min(STALENESS_TICK_MS, retryAt - deps.now()) : STALENESS_TICK_MS);
  };
  return {
    start() {
      starts += 1;
      if (starts !== 1 || !eligible()) return;
      running = true;
      schedule(0);
    },
    stop() {
      if (starts === 0) return;
      starts -= 1;
      if (starts !== 0) return;
      running = false;
      generation += 1;
      if (timer) deps.clearTimer(timer);
      timer = undefined;
    },
    async check(tag: Channel): Promise<UpdateCheckResult> {
      const installer = deps.install();
      const latest = installer === "source" || installer === "mise" ? null : await lookup(tag, false);
      return checkForUpdate(tag, {
        currentVersion: deps.current,
        detectInstall: deps.install,
        detectInstallOwnership: deps.ownership,
        miseUpdateCommand: deps.guidance,
        latestVersion: () => latest,
      });
    },
  };
}

export const packageRefresh = createRefreshScheduler();
```

The `detectInstallOwnership`/`miseUpdateCommand` inputs preserve the existing mise guidance (`src/update/index.ts:70-80`). An explicit caller marks an automatic flight before it settles, so the flight writes exactly once even after the final listener stops. A purely automatic flight retains the generation guard. `CACHE_MAX_AGE_MS` is defined once in `notify.ts` below; the badge imports it.

### `src/update/badge.ts` — MODIFY

Replace the stale top comment (`src/update/badge.ts:1-14`) with: “The badge reads the package cache only. The server scheduler and explicit checks produce it; GET never launches a lookup. A missing, wrong-channel or 40-hour-old cache reports unknown.” Define the constant in `notify.ts` beside `REFRESH_INTERVAL_MS` and import it from `./notify` to avoid a badge→scheduler→job→notify→badge runtime cycle. The final declaration is:

```ts
export const CACHE_MAX_AGE_MS = 40 * 60 * 60 * 1000;
```

Add optional `now?: () => number` to `UpdateBadgeDeps` (existing callers such as `tests/update/update-mise.test.ts:324-332` remain valid), `now: Date.now` to `defaultDeps`, and update the badge test fixture. Immediately after `if (!cache) return base;` insert:

```ts
  const checked = Date.parse(cache.last_checked_at);
  const now = deps.now?.() ?? Date.now();
  if (!Number.isFinite(checked) || checked > now || now - checked >= CACHE_MAX_AGE_MS) return base;
```

Import `CACHE_MAX_AGE_MS` from `./notify` and return `base` so stale `latestVersion` is not offered as installable. No route or JSON shape changes. `tests/update/update-badge.test.ts:58-64` pins the fixture's existing dependency keys; keep those keys unchanged because `now` is optional and defaults at the read site.

### `src/server/management/config-routes.ts` — MODIFY

In `src/server/management/context.ts`, add the two imports immediately after its existing `OcxConfig` type import (`:1`):

```ts
import type { Channel } from "../../update/index";
import type { UpdateCheckResult } from "../../update/job";
```

Inside `ManagementApiDeps`, immediately after `requestMetrics?` (`:51`), add:

```ts
checkPackageUpdate?: (channel: Channel) => Promise<UpdateCheckResult>;
```

Production passes no seam and always uses the coordinator; a route test injects a delayed package result without source-checkout detection or a real registry child. In the check branch (`src/server/management/config-routes.ts:750-757`), keep current invalid-tag validation and channel normalization, replace `checkForUpdate` import and final return:

```ts
const { normalizeUpdateChannel } = await import("../../update/job");
const { packageRefresh } = await import("../../update/refresh-scheduler");
// existing rawTag validation unchanged
return jsonResponse(await (deps.checkPackageUpdate ?? packageRefresh.check)(normalizeUpdateChannel(rawTag)));
```

In the run branch (`src/server/management/config-routes.ts:759-777`), keep body parsing, validation and existing `UpdateJobError` catch. Inside its existing `try`, replace the return with:

```ts
const channel = normalizeUpdateChannel(body.tag as string | undefined);
const { packageRefresh } = await import("../../update/refresh-scheduler");
const checked = await (deps.checkPackageUpdate ?? packageRefresh.check)(channel);
return jsonResponse({ ok: true, job: startUpdateJob(channel, body.restart !== false, {
  checkForUpdateFn: () => checked,
}) });
```

The checked result is already built by `checkForUpdate`, so `startUpdateJob` still owns its existing 409 lock and worker creation. The detached worker continues its own synchronous integrity/update logic (`src/update/job.ts:619-680`). A registry failure gives `latest_unavailable`; source and mise preserve their existing `UpdateJobError` codes. An explicit preview check may replace the single-file cache; the scheduler's default-channel `readVersionCache` mismatch causes a new lookup on its next hourly tick. Document that maximum mismatch window; if immediate repair is required, B may queue a default-channel tick after an explicit opposite-channel write without changing the badge GET.

### `src/server/index.ts` — MODIFY

Add one import near the existing startup lifecycle imports (`src/server/index.ts:63-64`):

```ts
import { packageRefresh } from "../update/refresh-scheduler";
```

Each `startServer` owns exactly one start reference. The existing `server.stop` wrapper can be called twice, so release that reference once. Immediately before `Object.defineProperty(server, "stop", {` (`src/server/index.ts:749`), insert:

```ts
let packageRefreshStopped = false;
```

Inside that wrapper before `packageTreeIntegrity.dispose()` (`src/server/index.ts:757`), insert:

```ts
if (!packageRefreshStopped) {
  packageRefreshStopped = true;
  packageRefresh.stop();
}
```

Immediately before `return server;` (`src/server/index.ts:877`), after Lab activation and reset-credit activation, add `packageRefresh.start();`. Both methods are synchronous. Net growth is 7 lines including the import, below the 893-line source cap from the current 883 lines (10 lines headroom). Avoid any await between `Bun.serve` (`src/server/index.ts:690`) and Lab activation (`src/server/index.ts:864`); `tests/lab/core-lab-boundary.test.ts:1052` checks this boundary. On a bind or activation failure, no scheduler reference was registered; the return immediately follows the start call.

### Tests and fixture map — MODIFY/NEW

`tests/update/update-refresh.test.ts` — NEW; complete file. This virtual clock exercises startup, staleness, coalescing, backoff, cancellation, and the opt-out without a live registry. Windows invocation behavior is already covered by `tests/update/update-pnpm.test.ts:84-108` and its owner-binding tests; B also checks the same `registrySpawnTarget` is used.

```ts
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRefreshScheduler, RETRY_BASE_MS, STALENESS_TICK_MS, type RefreshDeps } from "../../src/update/refresh-scheduler";
import { latestVersionAsync, pnpmOwner, REGISTRY_DEADLINE_MS, REGISTRY_OUTPUT_LIMIT } from "../../src/update/async-check";
import type { VersionCache } from "../../src/update/notify";
import type { Channel, Installer } from "../../src/update/index";

function fixture(installer: Installer = "npm", disabled = false, lookupFn?: RefreshDeps["lookup"]) {
  let now = 1_700_000_000_000;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const cache = new Map<Channel, VersionCache>();
  const calls: Channel[] = [];
  const replies: Array<Promise<string | null>> = [];
  const writes: VersionCache[] = [];
  const deps: RefreshDeps = {
    now: () => now,
    current: () => "2.7.43",
    install: () => installer,
    ownership: () => ({ installer, owner: null }) as ReturnType<RefreshDeps["ownership"]>,
    guidance: () => null,
    disabled: () => disabled,
    read: tag => cache.get(tag) ?? null,
    write: (tag, latest, at) => {
      const previous = cache.get(tag);
      const value: VersionCache = {
        tag, latest_version: latest, last_checked_at: new Date(at).toISOString(),
        dismissed_version: previous?.latest_version === latest && previous.dismissed_version === latest
          ? latest : undefined,
      };
      cache.set(tag, value);
      writes.push(value);
    },
    lookup: async (tag, activeInstaller) => {
      calls.push(tag);
      return lookupFn ? lookupFn(tag, activeInstaller) : replies.length ? await replies.shift()! : "2.7.44";
    },
    setTimer: ((run: () => void, delay: number) => {
      const id = ++nextId;
      timers.set(id, { at: now + delay, run });
      return { id, unref() {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: ((timer: ReturnType<typeof setTimeout>) => {
      timers.delete((timer as unknown as { id: number }).id);
    }) as typeof clearTimeout,
  };
  async function advance(ms: number) {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(id); timer.run(); }
    }
    for (let index = 0; index < 8; index++) await Promise.resolve();
  }
  // Bounded condition wait for chains longer than advance()'s eight fixed turns (the real async
  // lookup's fake child settles over ~16 microtask turns). Fails loudly instead of hanging.
  async function settle(done: () => boolean, turns = 64) {
    for (let index = 0; index < turns && !done(); index++) await Promise.resolve();
    if (!done()) throw new Error(`condition not reached within ${turns} microtask turns`);
  }
  return { scheduler: createRefreshScheduler(deps), calls, replies, writes, cache, timers, advance, settle, now: () => now };
}

describe("package cache refresh", () => {
  test("missing cache refreshes immediately and writes through", async () => {
    const f = fixture();
    f.scheduler.start();
    await f.advance(0);
    expect(f.calls).toEqual(["latest"]);
    expect(f.cache.get("latest")?.latest_version).toBe("2.7.44");
    f.scheduler.stop();
  });

  test("fresh cache is checked hourly and refreshed at 20 hours", async () => {
    const f = fixture();
    f.cache.set("latest", { tag: "latest", latest_version: "2.7.43", last_checked_at: new Date(f.now()).toISOString() });
    f.scheduler.start();
    await f.advance(0);
    for (let hour = 0; hour < 19; hour++) await f.advance(STALENESS_TICK_MS);
    expect(f.calls).toHaveLength(0);
    await f.advance(STALENESS_TICK_MS);
    expect(f.calls).toEqual(["latest"]);
    f.scheduler.stop();
  });

  test("explicit checks coalesce per channel", async () => {
    const f = fixture();
    let release!: (value: string | null) => void;
    f.replies.push(new Promise(resolve => { release = resolve; }));
    const a = f.scheduler.check("latest");
    const b = f.scheduler.check("latest");
    await Promise.resolve();
    expect(f.calls).toEqual(["latest"]);
    release("2.7.44");
    expect((await a).latestVersion).toBe("2.7.44");
    expect((await b).latestVersion).toBe("2.7.44");
    expect(f.writes).toHaveLength(1);
  });

  test("background and explicit checks join the same channel flight", async () => {
    const f = fixture();
    let release!: (value: string | null) => void;
    f.replies.push(new Promise(resolve => { release = resolve; }));
    f.scheduler.start();
    await f.advance(0);
    const explicit = f.scheduler.check("latest");
    expect(f.calls).toEqual(["latest"]);
    release("2.7.44");
    expect((await explicit).latestVersion).toBe("2.7.44");
    expect(f.writes).toHaveLength(1);
    f.scheduler.stop();
  });

  test("explicit interest writes a joined automatic result after stop", async () => {
    const f = fixture();
    let release!: (value: string | null) => void;
    f.replies.push(new Promise(resolve => { release = resolve; }));
    f.scheduler.start();
    await f.advance(0);
    const explicit = f.scheduler.check("latest");
    expect(f.calls).toEqual(["latest"]);
    f.scheduler.stop();
    release("2.7.44");
    expect((await explicit).latestVersion).toBe("2.7.44");
    expect(f.cache.get("latest")?.latest_version).toBe("2.7.44");
    expect(f.writes).toHaveLength(1);
    expect(f.timers.size).toBe(0);
  });

  test("one listener stopping leaves the other listener's refresh active", async () => {
    const f = fixture();
    f.scheduler.start();
    f.scheduler.start();
    f.scheduler.stop();
    await f.advance(0);
    expect(f.calls).toEqual(["latest"]);
    expect(f.cache.get("latest")?.latest_version).toBe("2.7.44");
    expect(f.timers.size).toBe(1);
    f.scheduler.stop();
    expect(f.timers.size).toBe(0);
  });

  test("different channels have separate flights", async () => {
    const f = fixture();
    await Promise.all([f.scheduler.check("latest"), f.scheduler.check("preview")]);
    expect(f.calls).toEqual(["latest", "preview"]);
    expect(f.writes.map(value => value.tag)).toEqual(["latest", "preview"]);
  });

  test("failed lookup does not stamp and retries with exponential delay", async () => {
    const f = fixture();
    f.replies.push(Promise.resolve(null), Promise.resolve(null), Promise.resolve("2.7.44"));
    f.scheduler.start();
    await f.advance(0);
    expect(f.cache.size).toBe(0);
    await f.advance(RETRY_BASE_MS);
    expect(f.calls).toHaveLength(2);
    await f.advance(RETRY_BASE_MS * 2);
    expect(f.calls).toHaveLength(3);
    expect(f.cache.get("latest")?.latest_version).toBe("2.7.44");
    f.scheduler.stop();
  });

  test("repeated failure caps retry at one hour", async () => {
    const f = fixture();
    for (let n = 0; n < 9; n++) f.replies.push(Promise.resolve(null));
    f.scheduler.start();
    await f.advance(0);
    for (const minutes of [1, 2, 4, 8, 16, 32, 60]) await f.advance(minutes * 60_000);
    expect(f.calls).toHaveLength(8);
    await f.advance(59 * 60_000);
    expect(f.calls).toHaveLength(8);
    await f.advance(60_000);
    expect(f.calls).toHaveLength(9);
    f.scheduler.stop();
  });

  test("invalid and wrong-channel caches refresh immediately", async () => {
    const invalid = fixture();
    invalid.cache.set("latest", { tag: "latest", latest_version: "2.7.44", last_checked_at: "bad" });
    invalid.scheduler.start();
    await invalid.advance(0);
    expect(invalid.calls).toEqual(["latest"]);
    invalid.scheduler.stop();
    const mismatch = fixture();
    mismatch.cache.set("preview", { tag: "preview", latest_version: "2.8.0-preview.1", last_checked_at: new Date(mismatch.now()).toISOString() });
    mismatch.scheduler.start();
    await mismatch.advance(0);
    expect(mismatch.calls).toEqual(["latest"]);
    mismatch.scheduler.stop();
  });

  test("stop cancels timer and suppresses a late automatic write", async () => {
    const f = fixture();
    let release!: (value: string | null) => void;
    f.replies.push(new Promise(resolve => { release = resolve; }));
    f.scheduler.start();
    await f.advance(0);
    f.scheduler.stop();
    release("2.7.44");
    await f.advance(STALENESS_TICK_MS);
    expect(f.writes).toHaveLength(0);
    expect(f.timers.size).toBe(0);
  });

  test.each(["source", "mise"] as Installer[])("%s never starts automatic lookup", async installer => {
    const f = fixture(installer);
    f.scheduler.start();
    await f.advance(0);
    expect(f.calls).toHaveLength(0);
    expect(f.timers.size).toBe(0);
  });

  test("opt-out stops only automatic checks", async () => {
    const f = fixture("npm", true);
    f.scheduler.start();
    await f.advance(0);
    expect(f.calls).toHaveLength(0);
    expect((await f.scheduler.check("latest")).latestVersion).toBe("2.7.44");
  });
});

test("an absent pnpm owner cannot reach the registry child", async () => {
  let spawned = false;
  expect(await latestVersionAsync("latest", "pnpm", {
    ownerFn: async () => null,
    spawnFn: (() => { spawned = true; throw new Error("unexpected child"); }) as never,
  })).toBeNull();
  expect(spawned).toBe(false);
});

test("pnpm owner resolution failure is unavailable, not an unowned PATH lookup", async () => {
  let spawned = false;
  expect(await latestVersionAsync("latest", "pnpm", {
    ownerFn: async () => { throw new Error("owner probe failed"); },
    spawnFn: (() => { spawned = true; throw new Error("unexpected child"); }) as never,
  })).toBeNull();
  expect(spawned).toBe(false);
});

const CAN_RUN_BUN_WORKER = ["darwin", "linux", "win32"].includes(process.platform)
  && typeof Worker === "function";

test.skipIf(!CAN_RUN_BUN_WORKER)("production pnpm worker starts and answers an empty invocation", async () => {
  const worker = new Worker(new URL("../../src/update/pnpm-owner-worker.ts", import.meta.url).href);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = new Promise<unknown>((resolve, reject) => {
      worker.onmessage = event => resolve(event.data);
      worker.onerror = reject;
    });
    worker.postMessage("");
    expect(await Promise.race([
      answer,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("pnpm worker did not reply")), 2_000); }),
    ])).toBeNull();
  } finally {
    if (timeout) clearTimeout(timeout);
    await worker.terminate();
  }
});

test.skipIf(!CAN_RUN_BUN_WORKER)("pnpm worker deadline terminates an unresponsive worker", async () => {
  const started = performance.now();
  const result = await pnpmOwner({
    workerUrl: new URL("../fixtures/pnpm-owner-stall-worker.ts", import.meta.url),
    deadlineMs: 25,
    invoked: "held-shim",
  });
  expect(result).toBeNull();
  expect(performance.now() - started).toBeLessThan(2_000);
});

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killed: false,
    kill() { this.killed = true; this.emit("close", null); return true; },
  });
}

// Each named failure enters through the scheduler's actual lookup dependency.
// The injected write seam is the version.json writer; empty writes/cache mean no stamp.
for (const scenario of [
  { name: "child error event", output: "", exitCode: 0, error: true },
  { name: "nonzero child exit", output: "2.7.44\n", exitCode: 1, error: false },
  { name: "malformed zero-exit output", output: "not-a-version\n", exitCode: 0, error: false },
  { name: "empty zero-exit output", output: "", exitCode: 0, error: false },
  { name: "multiline zero-exit output", output: "2.7.44\n2.7.45\n", exitCode: 0, error: false },
]) {
  test(`registry ${scenario.name} returns null and retries after backoff`, async () => {
    const observed: Array<string | null> = [];
    let spawned = 0;
    const f = fixture("npm", false, async (tag, installer) => {
      const result = await latestVersionAsync(tag, installer, {
        ownerFn: async () => null,
        spawnFn: (() => {
          const child = fakeChild();
          const attempt = ++spawned;
          queueMicrotask(() => {
            if (attempt === 1) {
              if (scenario.output) child.stdout.write(scenario.output);
              if (scenario.error) child.emit("error", new Error("registry child failed"));
              child.emit("close", scenario.exitCode);
            } else {
              child.stdout.write("2.7.44\n");
              child.emit("close", 0);
            }
          });
          return child;
        }) as never,
      });
      observed.push(result);
      return result;
    });
    f.scheduler.start();
    await f.advance(0);
    await f.settle(() => f.timers.size === 1);
    expect(observed).toEqual([null]);
    expect(f.calls).toEqual(["latest"]);
    expect(f.writes).toHaveLength(0);
    expect(f.cache.size).toBe(0);
    expect(f.timers.size).toBe(1);
    expect([...f.timers.values()].map(timer => timer.at)).toEqual([f.now() + RETRY_BASE_MS]);
    await f.advance(RETRY_BASE_MS - 1);
    expect(f.calls).toHaveLength(1);
    await f.advance(1);
    await f.settle(() => f.writes.length === 1);
    expect(f.calls).toEqual(["latest", "latest"]);
    expect(observed).toEqual([null, "2.7.44"]);
    expect(f.writes).toHaveLength(1);
    expect(f.cache.get("latest")?.latest_version).toBe("2.7.44");
    f.scheduler.stop();
  });
}

test("registry output is bounded and killed without leaking text", async () => {
  const child = fakeChild();
  const result = latestVersionAsync("latest", "npm", {
    ownerFn: async () => null,
    spawnFn: (() => child) as never,
  });
  child.stderr.write(Buffer.alloc(REGISTRY_OUTPUT_LIMIT + 1));
  expect(await result).toBeNull();
  expect(child.killed).toBe(true);
});

test("registry deadline kills an unresponsive child", async () => {
  expect(REGISTRY_DEADLINE_MS).toBe(12_000);
  const child = fakeChild();
  const result = latestVersionAsync("latest", "npm", {
    ownerFn: async () => null,
    spawnFn: (() => child) as never,
    deadlineMs: 1,
  });
  expect(await result).toBeNull();
  expect(child.killed).toBe(true);
});
```

`tests/update/update-notify.test.ts` — MODIFY: add a check that the pre-bind prompt still reads cache and no longer invokes `triggerBackgroundRefreshIfStale`, and add same-version/new-version/channel-mismatch dismissal persistence assertions.

`tests/update/update-badge.test.ts` — MODIFY: add injected `now` to helper (`tests/update/update-badge.test.ts:6-20`), test 39h59m known, 40h unknown, invalid/future timestamp unknown, and assert repeated read has no lookup hook. The final guard is:

```ts
const now = deps.now?.() ?? Date.now();
if (!Number.isFinite(checked) || checked > now || now - checked >= CACHE_MAX_AGE_MS) return base;
```

`tests/update/update-job.test.ts` — MODIFY: add `startUpdateJob uses injected prechecked result without a second registry call` using the existing `StartUpdateJobDeps` seam (`src/update/job.ts:126-130,619-642`). `tests/server/sidebar-routes.test.ts` — MODIFY: add repeated GET with an injected/controlled cache and assert no cache timestamp change; existing badge route test is `tests/server/sidebar-routes.test.ts:99-112`.

`tests/preload.ts` — MODIFY: after `process.env.OCX_TEST_PRELOAD_PID = String(process.pid);` (`tests/preload.ts:82`), add exactly:

```ts
process.env.OCX_DISABLE_UPDATE_CHECK = "1";
```

This is the main plan's test-started-server guard. It must run before the lock and before tests start listeners. Tests of scheduler eligibility inject `disabled` into `createRefreshScheduler` rather than mutating the preload environment.

`tests/server/update-async-routes.test.ts` — NEW; complete file. The delayed test traverses real management dispatch with an injected npm result, waits for the lookup to be entered, then proves a timer completes while that request is unresolved. The injected seam is the only source of the answer, so a regression that bypasses it or synchronously calls `checkForUpdate` fails. It proves request-loop responsiveness at the management dispatch boundary; it does not claim a live listener `/healthz` result. The source-checkout cases preserve existing guidance.

```ts
import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";

const config = { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;

async function call(method: string, path: string, body?: object, deps: ManagementApiDeps = {}) {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const request = new Request(url, {
    method,
    headers: { host: "127.0.0.1:10100", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return handleManagementAPI(request, url, config, deps, "admin-token");
}

describe("asynchronous package update routes", () => {
  test("non-source check leaves the event loop responsive while lookup is pending", async () => {
    let lookupEntered!: () => void;
    const entered = new Promise<void>(resolve => { lookupEntered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let settled = false;
    const pending = call("GET", "/api/update/check?tag=latest", undefined, {
      checkPackageUpdate: async channel => {
        expect(channel).toBe("latest");
        lookupEntered();
        await gate;
        return {
          currentVersion: "2.7.43", latestVersion: "2.7.44", channel,
          installer: "npm", updateAvailable: true, canUpdate: true,
          command: "npm install -g @bitkyc08/opencodex@2.7.44", releaseNotesUrl: "https://example.test/releases",
        };
      },
    }).then(response => { settled = true; return response; });
    try {
      await entered;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    const response = await pending;
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.installer).toBe("npm");
    expect(body.latestVersion).toBe("2.7.44");
  });

  test("source checkout check returns guidance without registry work", async () => {
    const response = await call("GET", "/api/update/check?tag=latest");
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.installer).toBe("source");
    expect(body.canUpdate).toBe(false);
  });

  test("source checkout run rejects a worker", async () => {
    const response = await call("POST", "/api/update/run", { tag: "latest", restart: false });
    expect(response?.status).toBe(409);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.code).toBe("source_checkout");
  });
});
```

Register both new tests:

```json
// scripts/test-layout/layout.json — explicit object, alphabetical neighbors
"update-async-routes.test.ts": "server",
"update-refresh.test.ts": "update",
```

```json
// tests/fixtures/test-layout-expected.json — top-level object, alphabetical neighbors
"update-async-routes.test.ts": "server",
"update-refresh.test.ts": "update",
```

The snippets are JSON member edits, not standalone JSON documents; preserve commas/indentation as adjacent entries. `tests/test-layout-tooling.test.ts` checks both registries. No existing test must be moved to break the file-size ratchet.

### Structure and docs-site — MODIFY

`structure/runtime.md` is exactly 600/600 lines (`structure/manifest.json` sets `sizeBudgetLines: 600`). Make **one line for one line** replacement at its support row, and no other insertion or deletion in this file. Before (current `structure/runtime.md:159`):

```md
| Support | `src/lib/`, `src/storage/`, `src/usage/`, `src/update/`, `src/generated/` |
```

After (still one line; link the detailed owner contract rather than adding prose here):

```md
| Support | `src/lib/`, `src/storage/`, `src/usage/`, `src/update/` ([package refresh](ops/service-and-sidecars.md#package-cache-refresh)), `src/generated/` |
```

`structure/ops/service-and-sidecars.md`: append the following section after the existing mise updater paragraph (`structure/ops/service-and-sidecars.md:248`), which is its current final paragraph. All new scheduler prose belongs here:

```md
## Package cache refresh

`src/update/refresh-scheduler.ts` owns the package cache timer and per-channel singleflight for the running proxy. Eligible npm, pnpm and Bun installs refresh missing or 20-hour-stale `version.json` after bind, check staleness hourly and retry failures with bounded backoff. Each server start owns one scheduler reference; the last matching stop disarms the timer. A stopped automatic lookup cannot write a late result, but an explicit check joining that lookup marks explicit interest and writes its successful result even if the last listener stops before it resolves. Source/mise installs and `OCX_DISABLE_UPDATE_CHECK=1` do not start automatic lookup; explicit requests remain available.

`src/update/async-check.ts` uses the existing owner-bound registry target with a bounded asynchronous child; pnpm owner discovery runs in `src/update/pnpm-owner-worker.ts` off the request loop. `src/update/notify.ts` writes successful results atomically and preserves a dismissal only for the same channel and version. The interactive pre-bind prompt reads the cache and does not launch a second detached refresh. `src/update/badge.ts` only reads the cache and reports unknown at 40 hours.
```

Verify the runtime line delta is zero (`wc -l structure/runtime.md` remains 600), then run `bun run structure:check` after the implementation edits. wp4 may separately replace the `src/tray/` surfaces row, also one line for one line; it must preserve this support-row link.

`structure/gui-and-management-api.md`: replace the Updates table cell (`structure/gui-and-management-api.md:168`) with its existing job/PID sentences plus: “`GET /api/update/check` and `POST /api/update/run` await one per-channel asynchronous registry lookup and write successful results through to the package cache; run passes that result to the job starter. `GET /api/update/badge` only reads the cache and reports unknown after 40 hours, on missing cache, or on channel mismatch.” Keep its existing `src/server/management/sidebar-routes.ts` owner row (`structure/gui-and-management-api.md:195`). These are present-tense changes for the implementation commit; do not land them ahead of source.

`docs-site/src/content/docs/reference/management-api.md`: change the check row (`:268`) purpose to “Asynchronously check the `latest` or `preview` package channel and refresh the package cache on success”; change the run row (`:269`) purpose to “Asynchronously check a fresh package version, then start an update job, optionally followed by restart”; change the badge row (`:547`) purpose to “Read cached package badge state without a registry lookup; missing, wrong-channel or 40-hour-old cache returns `unknown: true`.” Add one short paragraph below that row: “The proxy checks an eligible package install after startup when its cache is missing or older than 20 hours, and checks freshness hourly. Set `OCX_DISABLE_UPDATE_CHECK=1` to disable automatic checks. Explicit check and run requests still work.”

Apply semantically identical row and paragraph changes to the existing siblings `docs-site/src/content/docs/{fr,ja,ko,ru,tr,zh-cn,zh-tw}/reference/management-api.md`; translate “automatic checks only; explicit requests still work” and the 20-hour/40-hour values in each locale. Do not change absent de/vi siblings or any GUI catalog: no `gui/src/i18n/{en,de,fr,ja,ko,ru,tr,vi,zh,zh-TW}.ts` key is added. `docs-site/AGENTS.md` requires the docs build after implementation.

## Field/value chains (PLAN-FIELD-CHAIN-01)

| Value or state | Creation | Serialization | Deserialization | Every consumer |
| --- | --- | --- | --- | --- |
| `OCX_DISABLE_UPDATE_CHECK=1` | Operator environment; new guard in `src/update/refresh-scheduler.ts` | N/A, environment string | `process.env` equality in scheduler | Scheduler `start`/`tick`; explicit check intentionally ignores it |
| Per-channel flight `{ task, markExplicit }`, failures, retryAt, generation, start references | `createRefreshScheduler` | N/A, process-local only | N/A | `lookup` marks explicit interest before awaiting; successful flight writes once despite a later stop; `tick`/`stop` gate purely automatic writes; paired `start`/`stop` retain the timer until the final server stops |
| Fresh `latest_version`, `last_checked_at`, `dismissed_version`, `tag` | `writeFreshVersionCache` in `src/update/notify.ts` | Existing atomic JSON writer `src/update/notify.ts:57-63` | Existing `readVersionCache` at `src/update/notify.ts:40-55` | Prompt `src/update/notify.ts:152-160,244-247`; badge `src/update/badge.ts:66-75`; scheduler stale test; wp4 npm tray reads badge later |
| `unknown: true` after 40 hours | Badge guard in `src/update/badge.ts` | Existing `jsonResponse` via `src/server/management/sidebar-routes.ts:100-103` | Dashboard's existing badge JSON consumer; wp2 desktop badge extends shape later | Sidebar indicator; wp4 tray uses same badge scalar. No new enum value or response field |
| Async `UpdateCheckResult` | `checkForUpdate` with injected resolved latest in `src/update/refresh-scheduler.ts` | Existing check JSON and job-state JSON in `src/server/management/config-routes.ts:750-777`, `src/update/job.ts:649-663` | Existing management client/GUI request flow; no schema revision | `/api/update/check`, `startUpdateJob`, status polling, GUI package update dialog; wp3 desktop flow branches away |
| Injected `checkPackageUpdate` function | Test supplies `ManagementApiDeps` in `src/server/management/context.ts`; production leaves it absent | N/A, process-local function only | N/A | Both check and run branches in `src/server/management/config-routes.ts`; production fallback is `packageRefresh.check` |
| Worker pnpm owner | `resolveCurrentPnpmGlobalOwner` in `src/update/pnpm-owner-worker.ts` | Structured clone over worker message, no disk | `pnpmOwner` event handler in `src/update/async-check.ts` | `registrySpawnTarget` pnpm branch; no API response or persistent consumer |

Search B must recheck all existing `VersionCache`, `UpdateBadge`, `UpdateCheckResult`, `latestVersion`, `readVersionCache`, and each channel literal consumer; the relevant current definitions are `src/update/notify.ts:23-29`, `src/update/badge.ts:19-36`, `src/update/job.ts:82-92`, and `src/update/index.ts:61-62`.

## Conditional activation matrix (C-ACTIVATION-GROUNDING-01)

| Guard/fallback | Test activation | Observable result |
| --- | --- | --- |
| source/mise/unknown version or opt-out | Inject each installer/version/env into scheduler | No timer or lookup; explicit check retains source/mise guidance |
| missing, invalid timestamp, wrong channel, ≥20h stale | Seed temp cache for each | Immediate queued lookup; otherwise hourly timer |
| concurrent same channel / different channels | Hold injected lookup promises | One call for same channel, two for distinct channels |
| child `error` event | `registry child error event returns null and retries after backoff` emits `error` then `close` | First lookup null, no `version.json` write, retry at `RETRY_BASE_MS` and success on the next child |
| nonzero child exit | `registry nonzero child exit returns null and retries after backoff` emits valid stdout then closes 1 | First lookup null, no `version.json` write, retry at `RETRY_BASE_MS` and success on the next child |
| malformed, empty, multiline zero-exit output | `registry malformed zero-exit output returns null and retries after backoff`, `registry empty zero-exit output returns null and retries after backoff`, and `registry multiline zero-exit output returns null and retries after backoff` each close 0 | Each first lookup null with no `version.json` write, then retries at `RETRY_BASE_MS` and succeeds |
| >4 KiB output / 12s deadline | `registry output is bounded and killed without leaking text`; `registry deadline kills an unresponsive child` | Null lookup; child killed on limit/deadline |
| pnpm ownership absent/worker error/timeout | Fake worker or run worker with invalid owner | Null result; no unowned PATH query |
| repeated failure / recovery | Resolve null 7 times then valid version | Delay 1,2,4,8,16,32,60m cap; success resets failure count |
| stop during timer or lookup | Stop before timer, then while held lookup settles | No new automatic lookup and no late automatic cache write |
| automatic lookup joined by explicit check, then stop | Start held automatic lookup, call explicit check, stop final listener, resolve version | Explicit result is returned and persisted once to `version.json` despite changed generation; no timer remains |
| two server start references in one process | Start scheduler twice, stop once, advance due timer; stop second | Refresh still runs after first stop; final stop disarms timer; repeated stop cannot underflow references |
| explicit lookup when scheduler stopped/opted out | Invoke `packageRefresh.check` with the scheduler fixture | User request succeeds and writes cache |
| non-source route with delayed lookup | Inject npm `checkPackageUpdate` through `ManagementApiDeps`, call `/api/update/check`, run a timer before releasing the lookup | Timer fires and route remains pending; after release HTTP 200 includes npm version; no registry process |
| Bun pnpm worker startup/deadline | On macOS/Linux/Windows with Worker, load production TS worker with empty invocation; load stall fixture with 25 ms deadline | Production worker answers null; stalled worker resolves null before 2 s and is terminated; unsupported platforms skip explicitly |
| same version dismissal / new version / channel switch | Seed dismissed cache and resolve each version/channel | Dismissal kept only for identical version/channel; other result clears it |
| fresh vs 40h badge boundary | Seed 39h59m and 40h timestamps | Known then `unknown: true`, `latestVersion: null`, no registry process |
| `/api/update/run` unavailable/already running | Resolve null or hold existing running job | Existing 409 code; no worker launched |
| no await before Lab activation | Run existing Lab source guard | `tests/lab/core-lab-boundary.test.ts` passes |

## Ratchet and verification

At this HEAD `src/server/index.ts` is 883/893 (`tests/fixtures/file-size-baseline.json:34`), leaving 10 lines; planned net +7 makes 890/893. Every other grown TS file is absent from the named baseline and uses the default 2,000-line ceiling: `src/update/index.ts` 883/2000, `notify.ts` 270/2000, `badge.ts` 75/2000, `src/server/management/config-routes.ts` 1112/2000, `src/server/management/context.ts` 153/2000, `tests/update/update-notify.test.ts` 165/2000, `update-badge.test.ts` 74/2000, `update-job.test.ts` 1943/2000, and `tests/server/sidebar-routes.test.ts` 304/2000. The new TS files start at 0/2000. `update-job.test.ts` has 57 lines to the default ceiling; if the new case exceeds it, place it in `update-refresh.test.ts`. The file-size ratchet scans `.json` and `.md` as well as TypeScript (`scripts/file-size-ratchet.ts:4-20`): `scripts/test-layout/layout.json` is 1813/2000 and `tests/fixtures/test-layout-expected.json` is 1620/2000, both absent from the named baseline and subject to the default ceiling. Structure and docs-site Markdown also remain subject to the ratchet and their separate checks; this `devlog/` plan is excluded from the ratchet. `structure/runtime.md` is 600/600 and must remain 600 after its one-line replacement; `structure/ops/service-and-sidecars.md` is 248/600 before its new section. Recount against the shared tree immediately before B. No cap is raised. `src/update/job.ts` remains unchanged at 1993 lines, preserving its six-line headroom.

Run after B: `bun test tests/update/update-refresh.test.ts tests/update/update-notify.test.ts tests/update/update-badge.test.ts tests/update/update-job.test.ts tests/update/update-pnpm.test.ts tests/server/update-async-routes.test.ts tests/server/sidebar-routes.test.ts tests/lab/core-lab-boundary.test.ts tests/test-layout-tooling.test.ts`; `bun run typecheck`; `bun run structure:check`; `bun run privacy:scan`; `cd docs-site && bun install --frozen-lockfile && bun run build` (docs-site requirement). Test command directly names target tests; `typecheck` reads `src/**/*.ts` via `tsconfig.json`, not prose; structure checker reads `structure/**` through `scripts/structure-ssot.ts`; privacy scan reads tracked source and devlog; docs build reads docs-site pages. Exact-head hosted CI remains the PR gate. Do not claim unrun gates passed.

Commands rerun during this docs-only revision, before B and after root dependencies were installed:

| Command | Exit | Result and scope |
| --- | ---: | --- |
| `bun test tests/update/update-notify.test.ts tests/update/update-badge.test.ts tests/update/update-job.test.ts tests/update/update-pnpm.test.ts` | 0 | 124 pass, 0 fail; existing source behavior only |
| `bun test tests/server/sidebar-routes.test.ts tests/lab/core-lab-boundary.test.ts` | 0 | 37 pass, 0 fail; existing route and Lab guards |
| `bun test tests/test-layout-tooling.test.ts` | 0 | 16 pass, 0 fail; current test map only |
| `bun run typecheck` | 0 | Current source typechecks; proposed new code does not exist yet |
| `bun run structure:check` | 0 | Current structure files pass; this plan's future net-zero edit is not applied |
| `bun run privacy:scan` | 0 | Current tracked paths pass; this document is still untracked and must be scanned after staging by main |

Additional verification for the fake-child and ratchet correction in this docs-only pass:

| Verifier | Exit | Result and scope |
| --- | ---: | --- |
| `Bun.Transpiler({ loader: "ts" }).transformSync` on the fenced `tests/update/update-refresh.test.ts` block | 0 | Proposed 350-line test block parses; future source and behavior are not yet executable |
| `bun test tests/ci-workflows/file-size-ratchet.test.ts tests/test-layout-tooling.test.ts` | 0 | 25 pass, 0 fail; existing scanner and layout registries only, not this plan |
| `wc -l scripts/test-layout/layout.json tests/fixtures/test-layout-expected.json` | 0 | 1813 and 1620 lines, both below the default 2000-line ceiling |

The earlier pre-install test load errors and docs-site `astro` failure are superseded by the fresh results above for root tests and typecheck. `docs-site/node_modules` is still absent, so the docs build remains deferred until the implementation cycle installs its dependencies; it would also write outside this leaf's one-document scope. Tests naming `update-refresh.test.ts` and `update-async-routes.test.ts` run only after B creates them. No Bun behavior test reads this Markdown plan; review its code blocks and source anchors directly.

## Risks and rollback

The worker API and `spawn` event behavior must be tested under Bun on macOS and Windows. A spawned child can outlive `kill()` briefly; the 12-second timer settles the request even if `close` is late. A 12-second pnpm owner proof plus 12-second registry query can take up to 24 seconds end to end, yet neither blocks the request loop. Explicit preview cache writes can hide the default channel until its next hourly tick; route responses remain correct per channel. File writes remain atomic but are best-effort (`src/update/notify.ts:57-63`); write failure must not be reported as a successful persistent refresh in verification. An opt-out environment variable is a new public behavior and needs docs. Rollback commit 1 as one unit; legacy `version.json` schema is unchanged, so no migration or data deletion is needed. Do not weaken management auth, updater integrity checks, or the synchronous Lab activation boundary to make this work.

## wp1 P revalidation (2026-09-24)

Previous cycle (wp0) concluded: roadmap locked at ff8db308e6 after architect ALIGNED and audit PASS; next direction is to execute this document unchanged. Stale check at the start of wp1: `git diff 6c171aa5a6..HEAD` touches only this unit's devlog files, so every source anchor above is current; line counts match (src/server/index.ts 883/893, src/update/index.ts 883, notify.ts 270, badge.ts 75, config-routes.ts 1112, tests/update/update-job.test.ts 1943, structure/runtime.md 600/600, structure/ops/service-and-sidecars.md 248). No amendment. Architect consultation for this unit (000_plan.md) covers this document at revision 5; no design decision changes in this cycle.
