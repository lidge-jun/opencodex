# WP6 — Windows: the platform this unit deliberately gated out

Final phase. Closes the three-platform sweep by deciding what Windows should
inherit from WP1-WP5 and what it must keep.

## Why Windows was gated out, and whether that still holds

WP2/WP4 wrote `process.platform === "win32"` gates around the serving confirmation
with a stated reason: *"Windows keeps its existing registration-health reporting —
its `deriveWindowsServiceDiagnostic` already inspects that."* This phase tests that
justification rather than inheriting it.

### What Windows genuinely already has

`deriveWindowsServiceDiagnostic` (`src/service.ts:2173-2199`) is by far the richest
of the three platforms. It computes `stale`, `conflict`, `viable`, and `startable`
from registration XML, on-disk asset presence, the recorded backend, and baked-path
staleness — where darwin had `launchctl list | grep` and Linux had `is-active`.

`inspectWindowsSchedulerServiceStatus` (`src/service.ts:473-496`) already pairs that
registration state with an **identity-checked live-proxy probe** and renders the two
separately (`formatWindowsSchedulerServiceStatus`). So `ocx service status` on the
Windows scheduler backend has answered "registered vs. serving" since before this
unit existed. That is a real asymmetry in Windows's favour, and it is why WP4 left it
alone.

### The gap the justification does not cover

`status` is not `install`. `case "install"` (`src/service.ts:2374-2377`) still prints

```
✅ opencodex service installed + started (auto-starts on login, auto-restarts on crash).
```

unconditionally on Windows, and `case "start"` does the same. Under the covers:

- **Scheduler** — `installWindows` (`:1565`) ends with
  `schtasks(["/run", "/tn", TASK])`. `/run` reports that the task was *launched*, not
  that its child survived. A wrapper whose `ocx start` exits immediately (port busy,
  bad config, dead baked path) satisfies it.
- **Native/WinSW** — `startWinswService()` (`src/lib/winsw.ts:325`) is
  `runWinsw(["start"])`, which asks the SCM to start the service and returns when the
  SCM accepts it. `installWinswService` verifies the *account* was applied
  (`assertServiceAccountApplied`) but nothing verifies a bound socket.

So Windows sits exactly where macOS did before WP2 — for `install`/`start`, not for
`status`. The reviewer-confirmed path from WP3 makes it concrete: a CLI-initiated
update on Windows reaches `exit 0 + viable + dead port`, because the worker only
skips the reinstall when `OCX_SERVICE === "1"` (`src/update/job.ts:734-738`).

## D1 — extend the serving confirmation to Windows install/start

The helper is already platform-neutral: `confirmServiceServing` probes a port with
`proxyIdentityAt` and has no Unix-specific code. Only the port reader is missing —
`launchdListenPort` and `systemdListenPort` both return null on Windows, so
`installedServiceListenPort()` falls back to `resolveServiceListenPort()`.

That fallback is *correct at install* (same process, same env, wrapper written moments
earlier) and *wrong at start*, exactly as it was on macOS. The wrapper carries the
port in the same `--port <n>` shape:

```ts
/** The `--port <n>` baked into the installed Windows service wrapper. Windows only. */
export function windowsListenPort(deps: { readScript?: () => string } = {}): number | null {
  try {
    const text = (deps.readScript ?? (() => readFileSync(windowsServiceScriptPath(), "utf8")))();
    const last = [...text.matchAll(/start --port (\d{1,5})(?:\s|"|$)/gm)].at(-1);
    if (!last) return null;
    const n = Number(last[1]);
    return n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}
```

and joins the chain:

```diff
 export function installedServiceListenPort(): number {
-  return launchdListenPort() ?? systemdListenPort() ?? resolveServiceListenPort();
+  return launchdListenPort() ?? systemdListenPort() ?? windowsListenPort() ?? resolveServiceListenPort();
 }
```

**Measured, not assumed.** `buildWindowsServiceScript()` is exported and platform
independent, so the wrapper text can be read on this macOS host. Its command line is:

```
"%OCX_BUN%" "%OCX_CLI%" start --port 10100 >>"%OCX_SERVICE_LOG%" 2>&1
```

The port is a **literal**, not a `%VAR%` indirection — the batch file interpolates
the Bun and CLI paths through variables but writes the port inline. The proposed
regex returns `10100` against that real output, verified by execution.

### Two wrappers, not one

The scheduler backend and the native backend bake the port into **different files**:

| Backend | Artifact | Shape |
|---|---|---|
| scheduler | `opencodex-service.cmd` (`windowsServiceScriptPath()`) | `… start --port 10100 >>"%OCX_SERVICE_LOG%"` |
| native | WinSW XML (`winswXmlPath()`) | `<arguments>"&lt;cli&gt;" start --port 10100</arguments>` |

`buildWinswXml` (`src/lib/winsw.ts:80-110`) computes its own `safeListenPort` with the
same `OCX_BAKE_PORT` → `config.port` → 10100 precedence, then XML-escapes the whole
argument string. The `"` around the CLI path becomes `&quot;`, but `start --port <n>`
contains nothing escapable, so the same regex applies.

Two artifacts means two readers, kept separate rather than branched inside one
function — a single reader that picks its file from `readServiceBackend()` would be
untestable without also faking install state, and would silently read the wrong file
whenever the recorded backend disagrees with what is on disk (the `stale` /
`backendStateMismatch` cases `deriveWindowsServiceDiagnostic` exists to catch):

```ts
/** The `--port <n>` baked into the scheduler wrapper (`opencodex-service.cmd`). */
export function windowsListenPort(deps: { readScript?: () => string } = {}): number | null {
  return parseBakedPort(deps.readScript ?? (() => readFileSync(windowsServiceScriptPath(), "utf8")));
}

/** The `--port <n>` baked into the WinSW XML's <arguments>. Native backend only. */
export function winswListenPort(deps: { readXml?: () => string } = {}): number | null {
  return parseBakedPort(deps.readXml ?? (() => readFileSync(winswXmlPath(), "utf8")));
}

/**
 * Shared tail parser. Terminators cover all three artifact shapes: whitespace (batch,
 * systemd), `"` (systemd's quoted ExecStart), `<` (`</arguments>`), and `&` (an
 * XML-escaped quote immediately after the port).
 */
function parseBakedPort(read: () => string): number | null {
  try {
    const last = [...read().matchAll(/start --port (\d{1,5})(?:\s|"|&|<|$)/gm)].at(-1);
    if (!last) return null;
    const n = Number(last[1]);
    return n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}
```

`winswXmlPath` is already exported (`src/lib/winsw.ts:43`), so no visibility change is
needed. Both readers return null off Windows — and `winswListenPort` returns null on a
scheduler install too, since the XML is absent — so the chain stays branch-free:

```diff
 export function installedServiceListenPort(): number {
-  return launchdListenPort() ?? systemdListenPort() ?? resolveServiceListenPort();
+  return launchdListenPort()
+    ?? systemdListenPort()
+    ?? windowsListenPort()
+    ?? winswListenPort()
+    ?? resolveServiceListenPort();
 }
```

Ordering note: a machine can transiently hold both artifacts (`installWindowsNative`
removes the `.cmd`, but a failed switch can leave either behind — the `conflict` case).
Scheduler first matches `readServiceBackend()`'s own default, which treats legacy/v1
state as scheduler.

Then the three gates in `serviceCommand` lose their `win32` special-case:

```diff
-      if (process.platform === "win32") {
-        console.log(backend === "native" ? "✅ …native…" : "✅ …scheduler…");
-      } else {
-        await reportServiceServing("installed", { port: resolveServiceListenPort() });
-      }
+      await reportServiceServing("installed", { port: resolveServiceListenPort() });
```

with the same shape for `start` and `repair`.

**Decision to make at A:** the WinSW backend has its own `install` semantics
(`installWinswService` can throw on account verification). Confirm the confirmation
runs *after* that, not instead of it.

### Timeout math, and why elevation is not in the path

Removing the gate adds up to `SERVICE_INSTALL_HEALTH_MS` (20s) to a Windows install.
Two things bound it:

- **The GUI update worker never reaches it.** It skips the service reinstall on
  Windows entirely (`src/update/job.ts:734-738`, `OCX_SERVICE === "1"`), so the wait
  lands only on hand-typed invocations. Where the worker *does* apply on other
  platforms, 20s + `SERVICE_RECOVERY_HEALTH_MS` (25s) = 45s still fits
  `RESTART_TIMEOUT_MS` of 60s — identical to macOS and Linux. (The comment at
  `src/update/job.ts:686-688` says "on macOS/Linux"; leave it, since Windows is
  excluded by the guard above rather than by the arithmetic.)
- **Elevation is a different surface.** `installWindows` runs a **non-elevated**
  `schtasks /create` and throws on UAC denial *before* any confirmation would run. The
  elevated path is `finalizeWindowsSchedulerServiceRegistration`
  (`src/service.ts:1039`, `ELEVATION_REQUEST_TIMEOUT_MS` = 120s), reached from
  `src/server/startup-action-control.ts`, not from `serviceCommand`. So the new wait
  cannot stack onto the 120s elevation race — they are on different call paths.

Stated explicitly because "does this stack with UAC?" is the first question a Windows
reviewer will ask, and the answer is not obvious from the diff.

## D2 — leave `case "status"` alone on the scheduler backend

`inspectWindowsSchedulerServiceStatus` already answers the question better than
`serviceStatusReport` would, because it distinguishes three *registration* states
(present / absent / unknown) that the Unix reporter collapses. Replacing it would be
a regression.

The native/WinSW backend falls into the Unix branch of `case "status"` (the condition
at `src/service.ts:2464` is `win32 && backend === "scheduler"`), so it already gets
`serviceStatusReport()` as of WP4. That is **not** an all-clear:

1. **Port** — it resolves correctly only once D1 covers the WinSW XML as well as the
   `.cmd`. See the two-wrappers section above.
2. **The repair hint is wrong for it.** `serviceStatusReport` prints
   `Repair: ocx service install`, which on a native install runs `installWindows`'s
   *transactional backend switch* (`src/service.ts:1571-1585`): it tears down WinSW
   and replaces it with the scheduler. A user following our own advice would silently
   change backends. Make the hint backend-aware:

```diff
-    + "   Repair: ocx service install\n"
+    + `   Repair: ocx service install${readServiceBackend() === "native" ? " --native" : ""}\n`
```

   Guard the call so non-Windows platforms do not read Windows install state — or use
   the `backend` value `serviceCommand` already computed and pass it in as a dep.

## D3 — do NOT port WP1 or WP5's reload

`schtasks` and `sc.exe` return non-zero on failure and `schtasks()`
(`src/service.ts:...`) already maps errors through `toWindowsSchtasksError`. There is
no exit-0-on-failure analogue, and no in-memory-vs-disk definition split like
systemd's. Stated so a later reader does not port either fix without cause.

Confirmed: `querySchtasks`, `runWinsw`, and `scQc` are all `execFileSync`, which
throws on a non-zero exit, and `schtasks()` (`src/service.ts:599`) rethrows through
`toWindowsSchtasksError`.

One nuance worth naming so the distinction stays clear: `schtasks /run` **does** exit
0 for a task whose action dies immediately. That is not a lying exit code — the task
really was launched — it is launch-vs-survival, which is exactly what D1's serving
confirmation is for. WP1's defect was different in kind: `launchctl` reported an
operation as failed *on stderr* while exiting 0.

## Tests

```ts
describe("windowsListenPort", () => {
  test("reads the port baked into the wrapper", () => {
    expect(windowsListenPort({ readScript: () => '"%OCX_BUN%" "%OCX_CLI%" start --port 18222 >>"%LOG%" 2>&1' })).toBe(18222);
  });

  test("prefers the argument tail over a path that looks like one", () => {
    expect(windowsListenPort({
      readScript: () => 'set OCX_BUN=C:\\start --port 9999\\bun.exe\n"%OCX_BUN%" "%OCX_CLI%" start --port 18222\n',
    })).toBe(18222);
  });

  test("returns null off Windows / when the wrapper cannot be read", () => {
    expect(windowsListenPort({ readScript: () => { throw new Error("ENOENT"); } })).toBeNull();
  });

  test("rejects out-of-range ports", () => {
    expect(windowsListenPort({ readScript: () => "start --port 0" })).toBeNull();
    expect(windowsListenPort({ readScript: () => "start --port 70000" })).toBeNull();
  });

  // The generated wrapper is the real contract; assert against it, not a sketch.
  test("reads the port out of a real generated wrapper", () => {
    expect(windowsListenPort({ readScript: () => buildWindowsServiceScript() })).toBe(resolveServiceListenPort());
  });
});

describe("winswListenPort", () => {
  test("reads the port out of the WinSW <arguments> element", () => {
    expect(winswListenPort({
      readXml: () => '  <arguments>&quot;C:\\pkg\\cli.ts&quot; start --port 18222</arguments>',
    })).toBe(18222);
  });

  test("returns null when the XML is absent (scheduler install, or off Windows)", () => {
    expect(winswListenPort({ readXml: () => { throw new Error("ENOENT"); } })).toBeNull();
  });

  // The generated XML is the real contract. buildWinswXml is exported at
  // src/lib/winsw.ts:76 as (entry: WinswEntry, env?, port?) — no export change needed.
  test("reads the port out of a real generated WinSW XML", () => {
    const xml = buildWinswXml({ bun: "C:\\pkg\\bun.exe", cli: "C:\\pkg\\src\\cli\\index.ts" });
    expect(winswListenPort({ readXml: () => xml })).toBe(resolveServiceListenPort());
  });
});
```

**Both artifacts measured on this macOS host** — both builders are platform
independent, so their real output is executable here even though the services are not:

```
buildWindowsServiceScript()
  "%OCX_BUN%" "%OCX_CLI%" start --port 10100 >>"%OCX_SERVICE_LOG%" 2>&1
  regex -> 10100

buildWinswXml({ bun, cli })
  <arguments>&quot;C:\pkg\src\cli\index.ts&quot; start --port 10100</arguments>
  regex -> 10100
```

The XML case is why the terminator class includes `<`: the port is followed directly
by `</arguments>`. Note the escaped quotes land *before* the port, not after, so `&`
is belt-and-braces rather than load-bearing — kept because a future
`<arguments>` ordering change should not silently break the parser.

`buildWindowsServiceScript` is already exported and imported by
`tests/service.test.ts`; `buildWinswXml` and `winswXmlPath` are exported from
`src/lib/winsw.ts` (`:76`, `:43`), so this phase needs no visibility changes.

## Platform limit

This host is macOS: no `schtasks`, no `sc.exe`, no SCM. Every claim above is from
reading the source, and the change is verified through injected seams plus the real
generated wrapper text. The CI matrix runs Windows, so the suite is the real gate —
`bun run test` locally proves only that nothing regressed on this platform.

## Done when

- `ocx service install|start|repair` confirm serving on Windows, using the port read
  back out of the generated wrapper.
- `windowsListenPort` is covered including the real `buildWindowsServiceScript()`
  output.
- The scheduler `status` path is untouched, with the reason recorded.
- D3's two non-ports are written down.
