# WP2 — `service install` must prove the service can serve

Closes D2 from `000_plan.md`. Depends on WP1's `runLaunchctl` /
`launchdJobMatchesPlist`.

## Problem

WP1 makes a failed load raise. That is necessary and not sufficient: a load can
*succeed* and still leave nothing listening — a bad `--port`, a config the proxy
rejects at startup, a runtime that execs and immediately exits. `installLaunchd()`
returns void either way, and `serviceCommand` prints

```
✅ opencodex service installed + started (auto-starts on login, auto-restarts on crash).
```

unconditionally inside `case "install":`. That message is what the user acted on
when they re-ran `ocx service` and 10100 stayed silent.

**Line numbers refreshed after WP1 (commit 663cfbea) shifted this file by ~113
lines.** Current positions, re-derived with `grep -n`:

| Symbol | Line |
|---|---|
| `case "install":` | 2191 |
| its `console.log` | 2195-2197 |
| `case "start":` | 2205 |
| `ops.start()` | 2206 |
| its `console.log` | 2207 |
| `resolveServiceListenPort` | 317 |
| proxy-liveness import | 9 |

`installSystemd()` has the same shape. Windows is excluded: its
`deriveWindowsServiceDiagnostic` already inspects registration health, and its
failure modes (UAC, schtasks XML) belong to a different unit.

## Design decision

**C1 — trust WP1's load verification.** Zero added latency, but blind to
"loaded fine, never served".

**C2 — poll `/healthz` on the baked port after load.** Directly asserts the thing
the user cares about.

**Chosen: C2, scoped to the baked port.** The waiting half is bounded and only
paid by `install`/`start`, which are slow hand-typed commands already. See the
budget note below for the one caller where that latency is not free.

## MODIFY `src/service.ts`

### Post-load health confirmation

New exported helper in `src/service.ts`:

```ts
export const SERVICE_INSTALL_HEALTH_MS = 20_000;

/**
 * After load/enable, confirm the supervisor actually produced a listener on the
 * port this install just baked. Registration is not service: `launchctl list`
 * reports a job that never bound, which is how the 2026-08-02 dashboard update
 * ended with a green checkmark and a dead port.
 *
 * Probes the BAKED target, not the pidfile. `findLiveProxy()` resolves through
 * pidfile -> runtime-port -> config, and after a service reinstall the pidfile is
 * stale or absent by construction — so a service serving correctly on the baked
 * port would report unhealthy. Ask the port we just wrote into the plist.
 *
 * Soft: returns the outcome, never throws; the caller chooses between a checkmark
 * and an actionable warning.
 */
export async function confirmServiceServing(
  deps: {
    port?: number;
    hostname?: string;
    probe?: (port: number, hostname: string) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: true; port: number } | { ok: false; port: number }> {
  const port = deps.port ?? resolveServiceListenPort();
  const hostname = deps.hostname ?? loadConfig().hostname ?? "127.0.0.1";
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const probe = deps.probe ?? (async (p, h) => !!(await proxyIdentityAt(p, { hostname: h })));
  const deadline = now() + (deps.timeoutMs ?? SERVICE_INSTALL_HEALTH_MS);
  for (;;) {
    if (await probe(port, hostname)) return { ok: true, port };
    if (now() >= deadline) return { ok: false, port };
    await sleep(500);
  }
}
```

**Why not `findLiveProxy`** (the R1 design, rejected in audit): it is imported at
`src/service.ts:9` and the injection shape at `src/service.ts:486`
(`inspectWindowsSchedulerServiceStatus`) is the house style — but it resolves the
target through the pidfile, which a service reinstall has just invalidated. A
service serving on the baked port with a stale pidfile would report `ok: false`
and exit 1. `proxyIdentityAt` is the same identity-checked `/healthz` probe
without the resolution step; it is already imported in `src/update/job.ts:23` and
needs adding to `src/service.ts`.

Read precisely (`src/server/proxy-liveness.ts:134-200`), `findLiveProxy` tries
three targets in order:

1. `readPid()` → `readRuntimePort(pid)` → probe that port;
2. `readRuntimePort()` with no pid → probe that port;
3. `loadConfig().port ?? 10100` → probe that.

**A stale pidfile alone does not make it report dead** — step 3 catches the
ordinary case. The accurate objection is that step 3's target and the baked port
are computed by two different rules, and they disagree in exactly the scenario
this unit exists for. `resolveServiceListenPort()` (`src/service.ts:317-329`):

- prefers `OCX_BAKE_PORT`, which the update worker sets around the reinstall
  (`src/update/job.ts:757-758`), while `findLiveProxy` never reads it;
- normalizes `config.port === 0` (ephemeral — valid for interactive `ocx start`)
  to `10100`, while `findLiveProxy`'s fallback takes `config.port ?? 10100` raw.

So during an update restart the two can name different ports. `findLiveProxy`
answers *where do our records say a proxy is?*; a post-install confirmation must
answer *did the thing we just installed bind?* Only the second question is the one
being asked here.

### Which port to probe — install and start differ

On the **install** path the two cannot drift: `buildPlist()` →
`buildServiceShellCommand(bun, cli, port = resolveServiceListenPort())` runs in the
same process, same env, moments before the probe. `resolveServiceListenPort()` is
the correct default there.

On the **start** path it can. `case "start"` never rewrites the plist, so an
install made under `OCX_BAKE_PORT`, or any later `config.port` edit, leaves launchd
serving the baked port while `resolveServiceListenPort()` now returns a different
one. A healthy service would print the warning and set `process.exitCode = 1`.

`start` must therefore probe the **installed artifact's** port, not the config's:

```ts
/**
 * The `--port <n>` actually baked into the installed launchd plist, or null when it
 * cannot be read. macOS only — deliberately named for launchd rather than "service"
 * so no caller assumes it covers systemd or the Windows wrapper.
 *
 * Anchored on the closing `</string>` and matched LAST: the command also contains
 * the Bun and CLI paths, and a path that happened to contain the literal
 * `start --port 9999` would otherwise shadow the real argument.
 */
export function launchdListenPort(
  deps: { readPlist?: () => string } = {},
): number | null {
  try {
    const text = (deps.readPlist ?? (() => readFileSync(plistPath(), "utf8")))();
    const matches = [...text.matchAll(/start --port (\d{1,5})\s*<\/string>/g)];
    const last = matches.at(-1);
    if (!last) return null;
    const n = Number(last[1]);
    return n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}
```

`case "start"` passes `{ port: launchdListenPort() ?? resolveServiceListenPort() }`;
`case "install"` keeps the plain default. The regex matches the exact tail
`buildServiceShellCommand` emits (`... start --port ${port}`), which `buildPlist`
then closes with `</string>`.

**XML escaping does not interfere — measured, not assumed.** `buildPlist()` runs the
command through `plistString()`, which escapes `& < > " '`. The port tail contains
none of them, so it survives verbatim. Against the real installed plist on this
machine:

```
$ grep -o "start --port [0-9]*" ~/Library/LaunchAgents/com.opencodex.proxy.plist
start --port 10100

$ /\bstart --port (\d{1,5})\b/.exec(readFileSync(plistPath(), "utf8"))
match: 10100
```

The surrounding quotes around `<bun>` and `<cli>` *are* escaped to `&apos;`, which
is why this helper matches only the unescaped tail rather than the whole command.
`launchdJobMatchesPlist` has the opposite requirement — it compares against
`launchctl print` output, which is unescaped — so the two must not share a matcher.

### Linux symmetry

`launchdListenPort` returns null on Linux, so `case "start"` and the repair branch
fall back to `resolveServiceListenPort()` there — inheriting exactly the drift this
phase closes for macOS. Harmless in the repair path (`installSystemd` rewrites the
unit immediately before the probe) but real for `start`, which does not.

The systemd unit carries the same tail: `buildUnit()` emits
`ExecStart=... ${buildServiceShellCommand(bun, cli)}` (`src/service.ts:1704`), so the
parser already written applies unchanged apart from its source file and the absence
of `</string>`:

```ts
/** The `--port <n>` baked into the installed systemd user unit. Linux only. */
export function systemdListenPort(deps: { readUnit?: () => string } = {}): number | null {
  try {
    const text = (deps.readUnit ?? (() => readFileSync(unitPath(), "utf8")))();
    const matches = [...text.matchAll(/start --port (\d{1,5})(?:\s|"|$)/gm)];
    const last = matches.at(-1);
    if (!last) return null;
    const n = Number(last[1]);
    return n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}
```

Callers use `launchdListenPort() ?? systemdListenPort() ?? resolveServiceListenPort()`
— each returns null off its own platform, so the chain needs no platform branch.
Mirror the five launchd tests for it, including the unreadable case (which is what
macOS hits on every call).

**Fallback rationale — this is a platform-portability decision, not a convenience.**
`case "start"` is shared by all three platforms, and `plistPath()` is macOS-only: on
Linux and Windows the read throws and the helper returns `null` on *every*
invocation. `?? resolveServiceListenPort()` is what keeps those platforms on today's
behavior while macOS gets the precise baked port.

Do not "tighten" this into a refusal. Doing so would break `ocx service start` on
Linux and Windows outright. Secondarily, an unreadable plist on macOS is a question
for WP1's load verification or WP4's status, not for a command the user invoked to
*start* something.

Required test (fifth case):

```ts
describe("launchdListenPort", () => {
  test("reads the port baked into the plist, not the current config", () => {
    expect(launchdListenPort({
      readPlist: () => "<string>… exec '/b' '/c' start --port 18222</string>",
    })).toBe(18222);
  });

  test("prefers the argument tail over a path that looks like one", () => {
    expect(launchdListenPort({
      readPlist: () => "<string>exec '/opt/start --port 9999/bun' '/c' start --port 18222</string>",
    })).toBe(18222);
  });

  test("returns null when there is no port to read", () => {
    expect(launchdListenPort({ readPlist: () => "<string>no port here</string>" })).toBeNull();
  });

  test("rejects out-of-range ports rather than probing them", () => {
    expect(launchdListenPort({ readPlist: () => "<string>start --port 0</string>" })).toBeNull();
    expect(launchdListenPort({ readPlist: () => "<string>start --port 70000</string>" })).toBeNull();
  });

  // Linux/Windows: plistPath() has nothing to read, so every call must degrade.
  test("returns null when the plist cannot be read", () => {
    expect(launchdListenPort({ readPlist: () => { throw new Error("ENOENT"); } })).toBeNull();
  });
});
```

### Import diff (the phase's one new module edge)

`src/service.ts:9` currently imports only `findLiveProxy, SERVICE_STOP_LIVENESS`:

```diff
-import { findLiveProxy, SERVICE_STOP_LIVENESS } from "./server/proxy-liveness";
+import { findLiveProxy, proxyIdentityAt, SERVICE_STOP_LIVENESS } from "./server/proxy-liveness";
```

`proxyIdentityAt` is already exported from that module and already used the same
way in `src/update/job.ts:23`, so this adds no new dependency direction.

### 4. Report honestly from `serviceCommand`

`src/service.ts:2195-2197` — the `console.log` inside `case "install":` — currently
prints an unconditional success line. Replace with:

```diff
     case "install":
       assertServiceEnvironmentMatchesInstall();
       assertServiceAuthEnvironment();
       await ops.install();
-      console.log(backend === "native"
-        ? "✅ opencodex native service installed + started (windowless, starts at boot, auto-restarts on crash)."
-        : "✅ opencodex service installed + started (auto-starts on login, auto-restarts on crash).");
+      {
+        const serving = await confirmServiceServing();
+        if (serving.ok) {
+          console.log(backend === "native"
+            ? `✅ opencodex native service installed + serving on port ${serving.port} (windowless, starts at boot, auto-restarts on crash).`
+            : `✅ opencodex service installed + serving on port ${serving.port} (auto-starts on login, auto-restarts on crash).`);
+        } else {
+          // Registration succeeded but no listener appeared. Saying "installed +
+          // started" here is what sent the 2026-08-02 reporter in a circle.
+          console.error(
+            `⚠️  Service registered, but no proxy answered within ${Math.trunc(SERVICE_INSTALL_HEALTH_MS / 1000)}s.`
+            + `\n   The supervisor may be re-exec'ing a failing command. Check: ${serviceLogPath()}`
+            + "\n   Then run 'ocx service status' — and 'ocx start' to serve in the foreground meanwhile.",
+          );
+          process.exitCode = 1;
+        }
+      }
```

`case "start":` (label at `src/service.ts:2205`; `ops.start()` at `:2206` and the
checkmark at `:2207`) gets the same treatment — it has the identical unconditional
`✅ service started.`

**Coupling (from WP1):** `startLaunchd`'s benign "already loaded from the current
plist" no-op returns without proving anything about serving. WP1's
`010_launchctl_load_verification.md` states that WP1 must not ship without this
phase for exactly that reason — the confirmation below is what closes it, and it
lives in `case "start"`, not inside `startLaunchd`.

### Blast radius: `repairService`

`installLaunchd` is also reached from `repairService()` (`src/service.ts:1496`,
verified with `grep -n` after WP1 shifted the file).

**Correction:** only WP1's throw reaches repair. `command === "repair"` is handled
at `src/service.ts:2176-2182` and `return`s *before* the `switch`, printing an
unconditional `✅ opencodex background service repaired`. The confirmation added
below lives in `case "install"` / `case "start"`, which repair never enters.

So `ocx service repair` gains WP1's "the load did not take" failure — a real new
failure mode that belongs in the D summary and the docs note — but keeps its
unconditional success line for the "loaded fine, serving nothing" case.

Closing that needs a platform gate, because the repair branch is **not** darwin-only.
`repairService` dispatches by platform (`src/service.ts:1523-1535`): scheduler/native
on Windows, `installLaunchd` on darwin, `installSystemd` on linux. The
`command === "repair"` branch at `:2176-2182` runs on all three. An ungated
confirmation would make a Windows scheduler repair wait 20s and exit 1 — a platform
this phase explicitly excludes, since `deriveWindowsServiceDiagnostic` already
inspects registration health.

```diff
     await repairService();
-    console.log("✅ opencodex background service repaired (assets refreshed, no Task Scheduler re-registration).");
+    if (process.platform === "win32") {
+      console.log("✅ opencodex background service repaired (assets refreshed, no Task Scheduler re-registration).");
+    } else {
+      // Same scope as install/start: Windows keeps its existing registration-health
+      // reporting, macOS/Linux gain the serving check.
+      const serving = await confirmServiceServing({
+        port: launchdListenPort() ?? resolveServiceListenPort(),
+      });
+      if (serving.ok) {
+        console.log(`✅ opencodex background service repaired and serving on port ${serving.port}.`);
+      } else {
+        console.error(
+          `⚠️  Service assets refreshed, but no proxy answered on port ${serving.port} within `
+          + `${Math.trunc(SERVICE_INSTALL_HEALTH_MS / 1000)}s. Check ${serviceLogPath()}.`,
+        );
+        process.exitCode = 1;
+      }
+    }
     return;
```

Port selection matches `start` rather than `install`. On darwin `repairService` does
call `installLaunchd`, which rewrites the plist — so `resolveServiceListenPort()`
alone would be defensible — but having two commands disagree on how they pick the
port is how drift gets reintroduced later. One rule: read the artifact, fall back to
config.

**Discriminator caveat.** `repairService` takes its own `platform` test seam
(`RepairServiceDeps.platform`, `src/service.ts:1485-1486`, defaulting to
`process.platform` "so Linux CI cannot hit real installSystemd"), while the gate
above reads `process.platform` directly. A test that injects
`repairService({ platform: "win32" })` on a macOS runner would take the Windows
repair path *and* the macOS confirmation branch — the two can disagree.

That mismatch is invisible today because `serviceCommand` calls `repairService()`
with no deps, so both read the same value. But it is a live trap for the new test:
drive the gate through an injected platform rather than the real one. The cleanest
shape is to give `serviceCommand`'s repair branch the same seam the rest of the file
uses — an optional deps argument threaded from the caller — rather than reading
`process.platform` inline. Decide that at B; do not leave the test asserting against
the host's real platform, which would make it pass on macOS CI and skip on Linux.

Include it. A repair that reports success while nothing serves is the same defect
class this unit exists to close, and leaving it out would make the fix inconsistent
across three commands that all mean "make the service work".

Required test for the branch (it is otherwise only asserted in prose, which is the
failure mode this unit has hit three times):

```ts
describe("service repair reports serving, not just repaired", () => {
  // Skip on Windows rather than asserting against the host: the gate reads
  // process.platform and serviceCommand has no seam for it (see the caveat above).
  const onUnix = process.platform === "win32" ? test.skip : test;

  onUnix("prints the serving port when a proxy answers", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation(m => { lines.push(String(m)); });
    const prevExit = process.exitCode;
    try {
      await serviceCommand("repair", {
        repair: async () => {},
        confirmServing: async () => ({ ok: true as const, port: 10100 }),
      });
      expect(lines.join("\n")).toContain("serving on port 10100");
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      log.mockRestore();
      process.exitCode = prevExit;
    }
  });

  onUnix("sets exitCode 1 and names the log when nothing answers", async () => {
    const errors: string[] = [];
    const err = spyOn(console, "error").mockImplementation(m => { errors.push(String(m)); });
    const prevExit = process.exitCode;
    try {
      await serviceCommand("repair", {
        repair: async () => {},
        confirmServing: async () => ({ ok: false as const, port: 10100 }),
      });
      expect(errors.join("\n")).toContain("no proxy answered");
      expect(process.exitCode).toBe(1);
    } finally {
      err.mockRestore();
      process.exitCode = prevExit;
    }
  });
});
```

This requires `serviceCommand` to accept an optional deps object (`repair`,
`confirmServing`) — it currently takes only `...args: (string | undefined)[]`.
Adding it is the same move that resolves the platform-discriminator caveat above:
thread the seam from the caller instead of reading globals inside the branch. If
that turns out to be a larger change than this phase warrants, the fallback is to
extract the branch body into an exported `runServiceRepair(deps)` and test that
directly — but decide at B and say which, rather than leaving the test as prose.

Existing coverage is unaffected: all four `repairService` tests
(`tests/service.test.ts`, starting at `:859`, `:875`, `:885`, `:896`) inject
`platform: "win32"` with explicit deps, so none reach `installLaunchd`. Verified by
reading the file. If the repair-branch confirmation above is added, those tests stay
green — they never enter `serviceCommand` — but the new branch needs its own test.

### Budget: the update worker's `RESTART_TIMEOUT_MS`

The update worker runs `ocx service install` under `RESTART_TIMEOUT_MS = 60_000`
(`src/update/job.ts:44`, invoked at `:761`). Adding up to
`SERVICE_INSTALL_HEALTH_MS = 20_000` leaves 40s for the rest of install, which is
ample — but the number is deliberately below half the budget for that reason. Do
not raise it without re-checking that call site.

Two interactions with the worker, both intended:

1. **`process.exitCode = 1` makes the worker fall back.** A registered-but-silent
   service now yields `result.status !== 0` at `src/update/job.ts:761`, so the
   worker logs the reinstall-failed line and proceeds to a direct proxy start —
   the recovery we want. But that message ends with "Run 'ocx service install' as
   administrator", which is Windows-specific and would now fire on macOS. WP3
   already plans to platform-gate that string; this phase is why it matters.
2. **The 20s wait partly overlaps `isServiceViable()`** at `src/update/job.ts:777`.
   Deliberate: `viable` answers registration, this answers serving, and WP3 replaces
   the `viable` early-return with a real health gate. Do not "optimize" either away
   in isolation — they close different halves.

## MODIFY `tests/service.test.ts`

Clock convention follows the existing files (`let now = 0`; `sleep` advances it),
not an `advancingClock()` helper — that helper does not exist anywhere in `tests/`.

```ts
describe("confirmServiceServing", () => {
  it("returns the baked port once the proxy answers", async () => {
    let calls = 0;
    const out = await confirmServiceServing({
      port: 10100, hostname: "127.0.0.1",
      probe: async () => ++calls >= 2,
      sleep: async () => {}, now: () => 0, timeoutMs: 5_000,
    });
    expect(out).toEqual({ ok: true, port: 10100 });
  });

  it("gives up at the deadline instead of hanging", async () => {
    let now = 0;
    const out = await confirmServiceServing({
      port: 10100, probe: async () => false,
      sleep: async ms => { now += ms; }, now: () => now, timeoutMs: 2_000,
    });
    expect(out).toEqual({ ok: false, port: 10100 });
  });

  it("probes at least once even with a zero budget", async () => {
    let probes = 0;
    await confirmServiceServing({
      port: 10100, probe: async () => { probes += 1; return false; },
      sleep: async () => {}, now: () => 0, timeoutMs: 0,
    });
    expect(probes).toBe(1);
  });

  // The regression: a stale pidfile must not make a serving service look dead.
  it("probes the baked port rather than resolving through the pidfile", async () => {
    const seen: number[] = [];
    await confirmServiceServing({
      port: 18999, probe: async p => { seen.push(p); return true; },
      sleep: async () => {}, now: () => 0,
    });
    expect(seen).toEqual([18999]);
  });
});
```

## Docs

`ocx service install` gaining a non-zero exit and a new warning is user-facing.
Update the service page under `docs-site/` in this phase (English source; do not
let translated locales contradict it) — AGENTS.md review guidelines require it.

Cover all three affected commands: `install`, `start`, and (with the addition
above) `repair`. State plainly that a non-zero exit now means "registered but not
serving" rather than "not installed" — that is the distinction a user hitting this
will need.

## Verification

```
bun x tsc --noEmit
bun test tests/service.test.ts tests/service-stop-verification.test.ts
bun run test
```

Plus a real render check: build the plist in a scratch `OPENCODEX_HOME` and
confirm `ProgramArguments` still contains the expected
`exec '<bun>' '<cli>' start --port <n>` shape.

## Done when

- A registered-but-silent service produces a warning and a non-zero exit, not a
  green checkmark.
- The confirmation probes the baked port, proven by the fourth test.
- Healthy installs are unchanged except the port now appears in the success line.
- `ocx service repair`'s new failure mode is documented.
