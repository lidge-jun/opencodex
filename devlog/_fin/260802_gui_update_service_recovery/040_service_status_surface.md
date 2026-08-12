# WP4 — Status must name the failure and the repair

Closes A2/A3 from `002_service_vs_start_asymmetry.md`. Depends on WP1.

Line numbers below were re-derived with `grep -n` against the working tree after
the round-1 audit found every R1 citation off by 5-370 lines.

**Stale check (P, after WP1/WP2/WP3 landed).** Re-derived again — `src/service.ts`
moved by ~230 lines across the three phases:

| Symbol | Then | Now |
|---|---|---|
| darwin `running = ... statusLaunchd()` | 1965 | **2194** |
| `case "status":` | 2130 | **2374** |
| `ops.status()` inside it | 2134 | **2378** |
| `serviceDiagnosticsSummary()` line | 2137 | **2381** |
| `serviceStatusSummary()` | 2010 | **2239** |
| `const service = diagnoseService()` in `src/cli/status.ts` | 171 | 171 (unchanged) |

**What WP1-WP3 already give this phase.** The helpers it needs now exist and are
exported, so the diffs below shrink to wiring:

- `launchdJobMatchesPlist(expectedCommand, deps)` — WP1. Answers "is launchd running
  the plist we have on disk?"
- `confirmServiceServing(deps)` and `installedServiceListenPort()` — WP2. Answer "is
  anything actually listening on the baked port?"
- `buildServiceShellCommand(entry.bun, entry.cli)` via `cliEntry()` — the exact string
  to compare against.

So `serviceStatusReport` composes existing, already-tested pieces rather than
introducing new probing logic.

**Visibility constraint.** `cliEntry` (`:46`) and `buildServiceShellCommand` (`:331`)
are module-private; only `launchdJobMatchesPlist` (`:526`) is exported. So
`serviceStatusReport` must live **in `src/service.ts`**, not in a new module — which
is where the diff below puts it. Do not "extract it for testability": the deps object
is the test seam, and moving it out would force exporting two internals that nothing
else should reach.

## Problem

The reporter ran `ocx service`, got a green checkmark, hit a dead port, and had
no next step. Three surfaces failed them:

1. **`ocx service status` on darwin** returns
   `installed and loaded (launchd; logs: ~/.opencodex/service.log)` — "loaded"
   for a job that is bootstrapped from a *previous* plist and serving nothing,
   and the log path is buried mid-sentence.
2. **No listen port anywhere.** The user cannot tell "pinned to 10100 and dead"
   from "hopped to 51423 and fine". `runtime-port.json` holds the answer and is
   never surfaced.
3. **No repair command.** The Windows branch says
   `run 'ocx service install' to repair`; darwin/linux say nothing. After WP1 the
   correct darwin repair is often `launchctl bootout` first, which no surface
   mentions.

## MODIFY `src/service.ts`

### 1. darwin/linux status gains a liveness dimension

`diagnoseService()` darwin branch (`src/service.ts:1961-1971`) currently:

```ts
const summary = !installed ? `not installed (${diagnostics})`
  : stale ? `installed, but stale (launchd; ${diagnostics})`
    : running ? `installed and loaded (launchd; ${diagnostics})`
      : `installed, not loaded (launchd; ${diagnostics})`;
```

`running` here means "registered with launchd", which is not what the word means
to a reader. Rename the local to `loaded` and let the async status command layer
the real probe on top:

```diff
-    const running = installed && Boolean(statusLaunchd());
+    // `launchctl list` reports a job bootstrapped from an OLD plist exactly like a
+    // serving one, so this is registration, not service. The live probe lives in
+    // serviceStatusReport(); WP1's launchdJobMatchesPlist() answers the staleness half.
+    const loaded = installed && Boolean(statusLaunchd());
```

with `running: loaded` retained in the returned struct for compatibility, and a
comment naming the limitation. Do NOT make `diagnoseService()` async — it is
called from sync paths (`isServiceViable`, tray, `startup-health-cache`).

Optionally fold WP1's `launchdJobMatchesPlist()` into `stale` here. Decide at this
phase's P: it makes `diagnoseService()` shell out on every call, which the sync
callers above may not tolerate. Default is **no** — keep it in the async reporter.

### 2. New async reporter used by the CLI

```ts
/**
 * Status a human can act on: registration state (sync diagnostic), whether a proxy
 * actually answers, and — when it does not — whether launchd is running the plist
 * we think it is. `launchctl list` membership alone cannot distinguish "serving",
 * "bootstrapped from an older plist", and "loaded but never bound"; the 2026-08-02
 * report is the middle one presented as the first.
 */
export async function serviceStatusReport(
  deps: {
    diagnose?: () => ServiceDiagnostic;
    serving?: () => Promise<{ ok: boolean; port: number }>;
    matchesPlist?: () => { loaded: boolean; matchesPlist: boolean };
  } = {},
): Promise<string> {
  const diag = (deps.diagnose ?? diagnoseService)();
  if (!diag.installed) return `❌ ${diag.summary}`;

  // Resolve the port exactly as install/start/repair do, so the two surfaces can
  // never disagree about the same service. A short budget: this is a status read,
  // not a post-install wait.
  const serving = await (deps.serving ?? (() => confirmServiceServing({ timeoutMs: 1_500 })))();
  if (serving.ok) return `✅ ${diag.summary}\n   Serving on port ${serving.port}.`;

  // The dep is consulted FIRST; the platform check only guards the default. Wrapping
  // the whole expression in `platform === "darwin"` would discard an injected seam on
  // Linux/Windows CI and make the stale-plist test unrunnable there.
  const stalePlist = deps.matchesPlist?.() ?? (process.platform === "darwin"
    ? (() => {
        const entry = cliEntry();
        // Pass the INSTALLED port explicitly. The default third argument is
        // resolveServiceListenPort(), which reads OCX_BAKE_PORT/config.port — after a
        // config edit that string would never match the plist and every run would
        // print a false "OLDER plist", sending users to bootout for nothing.
        return launchdJobMatchesPlist(
          buildServiceShellCommand(entry.bun, entry.cli, installedServiceListenPort()),
        );
      })()
    : null);
  const staleLine = stalePlist && stalePlist.loaded && !stalePlist.matchesPlist
    ? `   launchd is running an OLDER plist than the one on disk.\n`
      + `   Fix:    launchctl bootout gui/$(id -u)/${LABEL} && ocx service install\n`
    : "";

  return `⚠️  ${diag.summary}\n`
    + `   Registered, but no proxy is answering on port ${serving.port}.\n`
    + staleLine
    + `   Log:    ${serviceLogPath()}\n`
    + "   Repair: ocx service install\n"
    + "   Meanwhile: ocx start           (serves in the foreground)";
}
```

`buildServiceShellCommand` (`src/service.ts:331`) takes `(bun, cli, port?)`. Two
traps in one call, both of which produce a permanent false "stale" verdict:

1. **Argument order** — call it with named fields rather than spreading `cliEntry()`.
2. **The defaulted third argument** — omitting `port` silently uses
   `resolveServiceListenPort()`, i.e. `OCX_BAKE_PORT`/`config.port`, not the port
   actually baked into the plist. WP2 added `installedServiceListenPort()` for exactly
   this divergence; pass it.

### Why `confirmServiceServing`, not `findLiveProxy`

An earlier draft used `findLiveProxy()`. That resolves through pidfile → runtime-port
→ `config.port`, while WP2's install/start/repair probe `installedServiceListenPort()`.
A service bound to a port that differs from either would let `ocx service install` say
"serving on N" and `ocx service status` say "no proxy is answering" — two verdicts
about one service, which is worse than the bug this unit set out to fix. Both surfaces
now resolve the port the same way.

### 3. Wire it into `case "status"`

The real code (`src/service.ts:2130-2137`) is:

```ts
case "status": {
  if (process.platform === "win32" && backend === "scheduler") {
    console.log(await inspectWindowsSchedulerServiceStatus());
  } else {
    const s = ops.status();
    console.log(s ? `✅ running:\n${s}` : "❌ service not installed/running.");
  }
  console.log(`Diagnostics: ${serviceDiagnosticsSummary()}`);
  break;
}
```

`serviceStatusSummary()` (`src/service.ts:2010`) is **not** called here — its only
non-test caller is the import in `src/cli/index.ts:31`. The non-Windows branch
prints raw `ops.status()` output, which on darwin is a `launchctl list | grep`
line: the rawest possible form of "registration mistaken for service".

```diff
   } else {
-    const s = ops.status();
-    console.log(s ? `✅ running:\n${s}` : "❌ service not installed/running.");
+    console.log(await serviceStatusReport());
   }
   console.log(`Diagnostics: ${serviceDiagnosticsSummary()}`);
```

`serviceStatusReport()` subsumes the old output: it already reports not-installed,
and adds the serving / stale-plist distinction. The `Diagnostics:` line stays — it
carries the log path and any `STALE baked paths` finding.

The Windows scheduler branch keeps `inspectWindowsSchedulerServiceStatus()`,
untouched.

No alias retirement in this phase: WP1 no longer renames
`bakedServicePathsDiagnostic`, so there is nothing to retire. (R1 planned that
rename; it was dropped with the stub narrative — see `003`.)

## MODIFY `src/cli/status.ts` (not `doctor.ts`)

Verified: `src/cli/doctor.ts` does not reference the service diagnostic at all.
The consumer is `src/cli/status.ts:171` (`const service = diagnoseService();`
→ `serviceSummary = service.summary`).

`ocx status` is the sharpest available fix here because it *already computes both
halves and never compares them*: `live` (an identity-probed `findLiveProxy`
result, `src/cli/status.ts:161-169`) sits a dozen lines above `serviceSummary`,
which reports `installed and loaded` regardless. The contradiction the user hit —
registered but not serving — is already fully determined in that function's local
scope and simply not stated.

```diff
 const service = diagnoseService();
-const serviceSummary = service.summary;
+// A service can be registered and still not serve: launchd re-execs a failing
+// command under KeepAlive while `launchctl list` keeps reporting the job. `live`
+// is already identity-probed above, so cross-check rather than report registration
+// as if it were service.
+const serviceSummary = service.installed && !live
+  ? `${service.summary} — registered but NOT serving; see ${serviceLogPath()} and re-run 'ocx service install'`
+  : service.summary;
```

**Required import change.** `src/cli/status.ts:6` currently reads
`import { diagnoseService } from "../service";` — the diff above calls
`serviceLogPath()`, so it must become:

```diff
-import { diagnoseService } from "../service";
+import { diagnoseService, serviceLogPath } from "../service";
```

Without it the file does not compile. Stated explicitly because "the seam is in the
prose but not in the diff" is the failure mode that cost this unit three audit rounds.

`serviceStatusSummary()` (`src/service.ts:2010`) has exactly one non-test caller,
`src/cli/index.ts:31`. Confirm at B whether that call site should also move to the
richer reporter or stay as the terse one-liner.

## MODIFY `tests/service.test.ts`

(Superseded — see the fixture-injected block below, which replaced this
`findProxy`-only sketch after the round-1 audit.)
Every test must inject `diagnose` as well as `serving`. `serviceStatusReport`
resolves `!diag.installed` before it ever probes, so a test supplying only the probe
runs the real `diagnoseService()` and behaves differently on a machine that happens
to have a service installed.

`ServiceDiagnostic` (`src/service.ts:2103`) has 11 required fields, so a partial
literal will not typecheck and there is no existing `baseDiagnostic` fixture in
`tests/service.test.ts` — define one:

```ts
const installedDiag = (): ServiceDiagnostic => ({
  supported: true,
  installed: true,
  enabled: true,
  running: true,
  viable: true,
  startable: true,
  stale: false,
  conflict: false,
  backend: "launchd",
  summary: "installed and loaded (launchd)",
});

test("reports the serving port when a proxy answers", async () => {
  const out = await serviceStatusReport({
    diagnose: installedDiag,
    serving: async () => ({ ok: true, port: 10100 }),
  });
  expect(out).toContain("Serving on port 10100");
});

test("names the log path and the repair command when nothing answers", async () => {
  const out = await serviceStatusReport({
    diagnose: installedDiag,
    serving: async () => ({ ok: false, port: 10100 }),
    matchesPlist: () => ({ loaded: true, matchesPlist: true }),
  });
  expect(out).toContain("no proxy is answering on port 10100");
  expect(out).toContain("ocx service install");
  expect(out).toContain("ocx start");
});

// Injected seam must win on every platform — the default is darwin-gated, the dep is not.
test("adds the bootout hint when launchd runs an older plist", async () => {
  const out = await serviceStatusReport({
    diagnose: installedDiag,
    serving: async () => ({ ok: false, port: 10100 }),
    matchesPlist: () => ({ loaded: true, matchesPlist: false }),
  });
  expect(out).toContain("OLDER plist");
  expect(out).toContain("bootout");
});

test("reports not-installed without probing", async () => {
  let probed = false;
  const out = await serviceStatusReport({
    diagnose: () => ({ ...installedDiag(), installed: false, summary: "not installed" }),
    serving: async () => { probed = true; return { ok: false, port: 0 }; },
  });
  expect(out).toContain("not installed");
  expect(probed).toBe(false);
});
```

`ServiceDiagnostic` is exported, so add it to the test file's type imports.

## Verification

```
bun x tsc --noEmit
bun test tests/service.test.ts
bun run test          # full suite — this phase touches a widely-imported module
```

## Docs

Replacing `ops.status()` drops the raw `launchctl list` line from
`ocx service status`. That is intentional and an improvement, but it is a
user-visible change to a diagnostic command — fold it into the same `docs-site/`
note WP2 already requires rather than shipping it silently.

## Done when

- `ocx service status` distinguishes "registered", "running an older plist", and
  "serving".
- A dead service prints the log path, `ocx service install`, and `ocx start`, plus
  the `launchctl bootout` line when the running job is stale.
- `ocx status` no longer reports `installed and loaded` next to a failed health
  probe without comment.
