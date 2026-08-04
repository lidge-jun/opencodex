# WP3 — The update worker must confirm serving, not trust `viable`

Closes D3 from `000_plan.md`. Depends on WP1 (stronger `stale`) and WP2
(install-time verification).

**Stale check (P, after WP1 and WP2 landed).** `src/update/job.ts` was not touched
by either, so every citation below still holds — verified with `grep -n`:
`RESTART_HEALTH_TIMEOUT_MS` 45, `healthTimeoutMs` 639, the `viable` early return
782, `awaitRestartedProxyHealthy`'s deadline 1022, `RESTART_TIMEOUT_MS` 44 with its
call site 761.

What *did* change is the premise, and the first draft of this paragraph got it wrong.

On macOS and Linux, WP2 has already closed the hole this phase was written for. The
chain: the worker sets `OCX_BAKE_PORT` before spawning the child
(`src/update/job.ts:757-762`) → the child's `resolveServiceListenPort()` gives that
variable precedence (`src/service.ts:317-329`) → `reportServiceServing` probes that
exact port for 20s and sets `process.exitCode = 1` when nothing answers. So on the
originally reported platform the child's **exit code is already a port assertion**,
not a registration one, and `serviceOk = result.status === 0` catches the failure
before `viable` is ever consulted.

The residual paths — the honest scope of this phase — are three the first draft never
named:

1. **Windows.** `case "install"` still prints the checkmark unconditionally there
   (`src/service.ts:2318-2321`, gated out of WP2 by design), and the worker only skips
   the reinstall when `OCX_SERVICE === "1"` (`src/update/job.ts:734-738`). A
   CLI-initiated update on Windows therefore lands on exactly
   `exit 0 + viable + dead port`.
2. **A flapping supervisor.** WP2's install probe returns on the first successful
   poll, so a service that binds for two seconds and then dies exits 0 legitimately.
3. **A child CLI older than WP2.** The worker executes the *newly installed* CLI; a
   downgrade, or an update to a target predating WP2, carries no serving check at all.

State it plainly: on macOS this is defence in depth behind WP2, not the primary fix.
Its real value is (1) and (3).

**Known limitation, inherited:** `serviceRestartServed` also returns on the first
successful probe, so it does not distinguish serving from flapping any better than
WP2 does — it only asks again, later. Closing case (2) properly needs a stability
window like `awaitRestartedProxyHealthy`'s (`src/update/job.ts:1030-1050`), which this
phase deliberately does not duplicate. Recorded rather than silently accepted.

**Serial cost.** `SERVICE_RECOVERY_HEALTH_MS` (25s) sits *after* WP2's
`SERVICE_INSTALL_HEALTH_MS` (20s, `src/service.ts:384`), so a macOS reinstall that
exits 0 but never serves now spends up to 45s before the direct-start fallback, inside
a `RESTART_TIMEOUT_MS` of 60s. That is the reason the recovery window is 25s and not
larger.

## Problem

`src/update/job.ts:778-792`:

```ts
if (serviceOk) {
  const viable = (io.serviceViableFn ?? isServiceViable)();
  if (viable) return;               // <-- cancels the direct-start fallback
  updateJob(job, {}, "Service reinstall exited 0 but the background service is not viable ...");
}
```

`viable` is a *static registration* predicate: `installed && running && !stale`,
where `running` is `launchctl list | grep` being non-empty. A crash-looping job
satisfies it. So the one recovery path built specifically so that "browser-dashboard
updates do not require a viable Background Service" is skipped in exactly the
case it exists for.

WP1 makes a failed `launchctl load` raise, and WP2 makes `service install` refuse
to claim success without a listener — so by the time WP3 runs, a non-zero
`runService` exit already covers the common case. WP3 closes the remaining hole:
the worker must stop treating a *static registration predicate* as proof of
recovery. The only thing that proves recovery is a listener answering on the
captured port.

## MODIFY `src/update/job.ts`

### 1. Replace the early return with a health-gated one

```diff
       if (serviceOk) {
-        // Exit 0 is not enough: a reinstall can leave stale/missing assets (or a
-        // disabled/conflicting manager) that never brings /healthz back. Fall through
-        // to a direct start so browser-dashboard updates do not require a viable
-        // Background Service for recovery.
-        const viable = (io.serviceViableFn ?? isServiceViable)();
-        if (viable) return;
-        updateJob(
-          job,
-          {},
-          "Service reinstall exited 0 but the background service is not viable (stale or missing assets, disabled, or conflicting); falling back to a direct proxy start.",
-        );
+        // Exit 0 is not enough, and neither is `viable`. Registration state cannot
+        // distinguish a serving supervisor from one re-exec'ing a broken command
+        // every few seconds — `launchctl list` reports both. The 2026-08-02 report
+        // is exactly that: reinstall exited 0, viable was true, nothing listened,
+        // and this early return skipped the direct-start fallback built for it.
+        // Ask the port, not the registry.
+        const viable = (io.serviceViableFn ?? isServiceViable)();
+        if (viable) {
+          const serving = await serviceRestartServed(job, port, hostname, io);
+          if (serving) return;
+          updateJob(
+            job,
+            {},
+            `Service reinstall exited 0 and reported viable, but nothing answered on ${hostname}:${port} `
+            + `within ${Math.trunc(SERVICE_RECOVERY_HEALTH_MS / 1000)}s; falling back to a direct proxy start.`,
+          );
+        } else {
+          updateJob(
+            job,
+            {},
+            "Service reinstall exited 0 but the background service is not viable (stale or missing assets, disabled, or conflicting); falling back to a direct proxy start.",
+          );
+        }
       }
```

### 2. The new helper

Insert above `restartAfterUpdate` (near `src/update/job.ts:670`):

```ts
/** Health window for a service-managed restart before falling back to a direct start. */
export const SERVICE_RECOVERY_HEALTH_MS = 25_000;

/**
 * Whether the reinstalled service actually produced a listener on the captured
 * target. Deliberately shorter than RESTART_HEALTH_TIMEOUT_MS: this is not the
 * final verdict, only the decision of whether to also try a direct start. Being
 * wrong here costs one extra start attempt; being wrong the other way leaves the
 * user with no proxy at all.
 */
async function serviceRestartServed(
  job: UpdateJobState,
  port: number,
  hostname: string,
  io: RestartIo = {},
): Promise<boolean> {
  const probe = io.probeProxy ?? (async (p: number, h?: string) => (
    !!(await proxyIdentityAt(p, { hostname: h }))
  ));
  const sleep = io.sleepMs ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = io.now ?? (() => Date.now());
  // NOT io.healthTimeoutMs: that field is the final /healthz appearance window
  // consumed by awaitRestartedProxyHealthy (src/update/job.ts:1022). Overloading it
  // would couple "should we also try a direct start?" to "did the update succeed?",
  // so a test tightening one would silently retune the other.
  const deadline = now() + (io.serviceHealthTimeoutMs ?? SERVICE_RECOVERY_HEALTH_MS);
  for (;;) {
    if (await probe(port, hostname)) {
      updateJob(job, {}, `Service-managed proxy answered on ${hostname}:${port}.`);
      return true;
    }
    if (now() >= deadline) return false;
    await sleep(500);
  }
}
```

Add the new field to `RestartIo` (`src/update/job.ts:624-669`), next to the
existing `healthTimeoutMs` and with a comment distinguishing the two:

```diff
   /** Override the /healthz appearance window (default {@link RESTART_HEALTH_TIMEOUT_MS}). */
   healthTimeoutMs?: number;
+  /**
+   * Override the window for deciding whether a service-managed restart served
+   * (default {@link SERVICE_RECOVERY_HEALTH_MS}). Distinct from healthTimeoutMs:
+   * this one only chooses whether to ALSO attempt a direct start.
+   */
+  serviceHealthTimeoutMs?: number;
```

### 3. Make the reinstall-failure message actionable

The worker runs `ocx service install` in a child process. After WP1,
`installLaunchd()` throws when the load did not take, so that child exits non-zero
and the existing `serviceOk = result.status === 0` branch already handles it — no
new guard is needed here. (R1 attributed this to an `assertBakedRuntimeRunnable`
helper; that helper belonged to the retracted stub narrative and does not exist.
WP1's throw is the real source of the non-zero exit.)

What is still wrong is the message:

```diff
         if (!serviceOk) {
-          updateJob(job, {}, `Service reinstall failed (exit ${result.status ?? "?"}); falling back to a direct proxy start. Run 'ocx service install' as administrator to refresh the background service manager.`);
+          updateJob(
+            job,
+            {},
+            `Service reinstall failed (exit ${result.status ?? "?"}); falling back to a direct proxy start.`
+            + (process.platform === "win32"
+              ? " Run 'ocx service install' as administrator to refresh the background service manager."
+              : " Run 'ocx service install' by hand to see the reason, then 'ocx service status'."),
+          );
         }
```

The "as administrator" advice is Windows-specific and is noise on macOS/Linux,
where the failure is almost always a bad baked path rather than elevation.

**WP2 makes this urgent rather than cosmetic.** Before WP2 a non-zero exit from
`ocx service install` on macOS was rare (the command essentially could not fail).
WP2 added exactly such an exit — a service that registers but does not serve — so
this branch now fires on macOS routinely, and the current message tells the user to
re-run the command "as administrator", which is meaningless there and hides the real
cause. Verified at `src/update/job.ts:771`: the string is unconditional.

The replacement message must also point at what WP2 actually reported, since the
child already printed the log path and the serving-vs-registered distinction:

```
  Service reinstall failed (exit 1); falling back to a direct proxy start.
  Run 'ocx service install' by hand to see the reason, then 'ocx service status'.
```

**Two more copies of the same advice live in `src/update/index.ts`**, both unguarded:
`:346` ("Run 'ocx service install' as administrator, then 'ocx start --port …'") and
`:353` ("… to refresh the background service"). That is the CLI update path rather
than the GUI worker, but it reaches the same macOS users for the same reason. Gate
all three in this commit rather than leaving two behind — a half-applied fix here is
worse than none, because the remaining copies make the guarded one look like a typo.

## MODIFY `tests/update-job.test.ts`

Clock convention: the file uses a local `let now = 0` with
`sleepMs: async ms => { now += ms; }` (`tests/update-job.test.ts:436`, `:463`,
`:492`). There is no `advancingClock()` helper in `tests/` — do not invent one.

Fixture convention, likewise from the file: every sibling builds an
`UpdateJobState` inline and `writeFileSync`s it to `updateJobPath(job.id)`, and the
service cases `delete process.env.OCX_SERVICE` around the call (restoring it in a
`finally`). The blocks below elide that for readability — write it out when
implementing:

```ts
const job: UpdateJobState = {
  id: "svc-health-gate",
  status: "restarting",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  currentVersion: "2.7.26",
  latestVersion: "2.7.28",
  channel: "latest",
  installer: "npm",
  restart: true,
  command: "",
  log: [],
};
writeFileSync(updateJobPath(job.id), JSON.stringify(job));
const captured = { port: 18765, hostname: "127.0.0.1" };
```

```ts
describe("restartAfterUpdate — service recovery is health-gated", () => {
  // The regression: viable=true, service registered, nothing listening.
  it("falls through to a direct start when a viable service never serves", async () => {
    const spawned: number[] = [];
    let now = 0;
    await restartAfterUpdateForTests(job, captured, {
      serviceInstalledFn: () => true,
      serviceViableFn: () => true,          // registration says healthy
      runService: () => ({ status: 0 }),    // reinstall exits 0
      probeProxy: async () => false,        // ...but nothing answers
      waitForPort: async () => true,
      spawnStart: (_j, _i, port) => { spawned.push(port ?? 0); },
      sleepMs: async ms => { now += ms; },
      now: () => now,
      serviceHealthTimeoutMs: 1_000,
    });
    expect(spawned).toEqual([captured.port]);
  });

  it("returns without a direct start when the service does serve", async () => {
    const spawned: number[] = [];
    let now = 0;
    await restartAfterUpdateForTests(job, captured, {
      serviceInstalledFn: () => true,
      serviceViableFn: () => true,
      runService: () => ({ status: 0 }),
      probeProxy: async () => true,
      waitForPort: async () => true,
      spawnStart: (_j, _i, port) => { spawned.push(port ?? 0); },
      sleepMs: async ms => { now += ms; },
      now: () => now,
    });
    expect(spawned).toEqual([]);
  });

  it("still falls back when the service is not viable at all", async () => {
    const spawned: number[] = [];
    let now = 0;
    await restartAfterUpdateForTests(job, captured, {
      serviceInstalledFn: () => true,
      serviceViableFn: () => false,
      runService: () => ({ status: 0 }),
      probeProxy: async () => false,
      waitForPort: async () => true,
      spawnStart: (_j, _i, port) => { spawned.push(port ?? 0); },
      sleepMs: async ms => { now += ms; },
      now: () => now,
    });
    expect(spawned).toEqual([captured.port]);
  });
});
```

`spawnStart` is recorded as an array rather than a `mock()` to match the existing
style in this file (`tests/update-job.test.ts:153`, `:248`, `:278`).

### Existing seam — verified, no new export needed

`restartAfterUpdateForTests` already exists and is imported at
`tests/update-job.test.ts:12`, and `serviceViableFn` is already injectable
(used at `:308`, `:349`, `:386`). No visibility changes are required.

### Pre-existing test that this change WILL break

`tests/update-job.test.ts:286-325` ("bakes the captured port for the service
reinstall") drives `serviceInstalledFn: () => true` + `serviceViableFn: () => true`
+ `runService: () => ({ status: 0 })` and supplies **no** `probeProxy` and **no**
`spawnStart`. Under the current code it returns at the `viable` early return.

**It will FAIL, not merely slow down.** Correcting the first draft, which claimed its
assertions "still hold": with no `probeProxy`, `serviceRestartServed` returns false,
execution falls through to the direct-start path, and that path calls `waitFn` a
**second** time at `src/update/job.ts:811`. The test's
`expect(waited).toEqual([{ port: 18765, hostname: "127.0.0.1" }])` then sees two
entries and fails. With no `spawnStart` injected it also enters the real 90s
ghost-LISTEN wait at `:832`.

Fix: add `probeProxy: async () => true`, which restores the early return. That test's
intent is the `OCX_BAKE_PORT` lifecycle, not the recovery decision. Do not weaken
`SERVICE_RECOVERY_HEALTH_MS` to make a test fast — inject the probe.

Prove it: run that single test against the modified worker BEFORE fixing the fixture
and record the two-entry `waited` failure in the B attest. A green run recorded
without that step would be exactly the "validated against a model, not the artifact"
failure this unit has already hit.

The sibling cases pass `serviceViableFn: () => false` and take the unchanged `else`
branch, so they need no edits: they sit at `tests/update-job.test.ts:349` and `:386`
(their `test(` lines begin at `:328` and `:364`), plus a fourth at `:403`/`:428`.
Confirm by running the file rather than by reading it.

### Red-first proof

Run the first test against unmodified `job.ts`: `spawnStart` is called 0 times
because the `viable` early return fires. Record that failure in the B attest.

## Verification

```
bun x tsc --noEmit
bun test tests/update-job.test.ts tests/update-stop-first.test.ts tests/service.test.ts
bun run test
```

## Done when

- A viable-but-silent service no longer cancels the direct-start fallback.
- A genuinely serving service still returns early (no redundant second proxy).
- Non-Windows reinstall failures stop advising `as administrator`.
