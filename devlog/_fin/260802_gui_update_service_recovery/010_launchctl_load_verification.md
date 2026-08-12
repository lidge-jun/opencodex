# WP1 — `launchctl load` must not report success for a failed load

Closes D1 from `000_plan.md`. This is the root-cause phase; WP2 and WP3 depend on
the predicate it introduces.

## Problem, measured

```
$ launchctl load -w ~/Library/LaunchAgents/com.opencodex.proxy.plist
Load failed: 5: Input/output error
Try running `launchctl bootstrap` as root for richer errors.
$ echo $?
0
```

macOS 27.0, real installed job. The legacy `load` subcommand writes its failure to
stderr and exits **0**.

The complementary measurement, same host, same plist — this one decides whether
the fix is safe:

```
$ launchctl unload ~/Library/LaunchAgents/com.opencodex.proxy.plist; echo $?
0
$ launchctl load -w ~/Library/LaunchAgents/com.opencodex.proxy.plist; echo $?
0                      # no stderr at all
$ launchctl list | grep opencodex
1228	0	com.opencodex.proxy
$ curl -s -o /dev/null -w '%{http_code}' localhost:10100/healthz
200
```

So `Load failed` appears **only** when the job is already bootstrapped. After a
successful `unload`, the load is clean and silent. That is what makes WP1's throw
safe: the normal install path (`unload` then `load`) does not hit it, and the only
way to reach the throw is the case that is genuinely broken — an `unload` that did
not take, leaving the old job bootstrapped and the new plist unused.

Current code (`src/service.ts`, verified by `grep -n`):

```ts
1290:  try { sh(`launchctl unload "${p}" 2>/dev/null`); } catch { /* not loaded */ }
1291:  sh(`launchctl load -w "${p}"`);
...
1294: function startLaunchd(): void { sh(`launchctl load -w "${plistPath()}"`); }
```

`sh()` (`src/service.ts:355`) is `execSync(...)`, which throws only on a non-zero
exit. So both the install path and the start path treat a failed load as success,
and `case "start"` (`:2092`) prints `✅ service started.`

The failure mode this produces: the job that is actually running keeps its **old**
`ProgramArguments` while a new plist sits unused on disk. `launchctl list` reports
the stale job, so every downstream check agrees the service is fine.

## Design decision

**C1 — parse stderr for `Load failed`.** Minimal, but string-matching a
localized-ish CLI is brittle.

**C2 — migrate to `launchctl bootstrap gui/<uid>` / `bootout`.** The modern API
returns real exit codes. Larger blast radius: `bootout` semantics differ from
`unload`, and the fallback story for older macOS needs care.

**C3 — keep `load -w`, but verify the *outcome* with `launchctl print`.**
Command-agnostic: it asserts the state we actually want rather than trusting any
exit convention.

**Chosen: C3 + the stderr signal as a fast negative.** C3 alone is the correctness
guarantee; the stderr read turns a 2-second failure into an immediate one. C2 is
deliberately deferred — it is a behavior change to the service lifecycle and
belongs in its own unit, not inside a bugfix.

## MODIFY `src/service.ts`

### 1. A launchctl runner that does not lie

Insert next to `sh()` (`:355`):

```ts
/**
 * `launchctl load` writes "Load failed: <n>: <reason>" to stderr and exits 0 — it
 * has done so for every already-bootstrapped job since the legacy subcommands were
 * deprecated. `sh()` is execSync, which throws only on a non-zero exit, so the
 * install and start paths both reported success for a load that did nothing and
 * left the previously bootstrapped job running its OLD ProgramArguments.
 * Measured on macOS 27.0; see 000_plan.md.
 */
export function runLaunchctl(
  args: string[],
  deps: { run?: typeof spawnSync } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const run = deps.run ?? spawnSync;
  const result = run("/bin/launchctl", args, { encoding: "utf8", windowsHide: true });
  // status is null when the child was signalled, and `error` is set when the spawn
  // itself failed (ENOENT on a non-macOS box) — in both cases stdout/stderr may be
  // null. Neither may be reported as success.
  if (result.error) return { ok: false, stdout: "", stderr: String(result.error.message ?? "") };
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
  };
}

/**
 * Whether launchctl output indicates the operation did not take. Needed because
 * `ok` alone is insufficient for the legacy `load`/`unload` subcommands, which
 * report failure on stderr while exiting 0. `bootstrap` exits 5, so for that path
 * this is belt-and-braces rather than the only signal.
 */
export function launchctlLoadFailed(stderr: string): boolean {
  return /\b(?:Load|Bootstrap) failed\b/i.test(stderr);
}
```

**`spawnSync`, not `execFileSync`.** This is the single most important line in the
phase. `execFileSync` discards stderr when the child exits 0 and throws only on a
non-zero exit, so against the exact failing case it returns nothing:

```
execFileSync(["load","-w",plist])  ->  returns, stdout: ""            # stderr LOST
spawnSync   (["load","-w",plist])  ->  status: 0,
                                       stderr: "Load failed: 5: Input/output error\n..."
```

Measured on this host. A runner built on `execFileSync` ships a guard that can
never fire, passes its own mocked tests, and changes nothing on the machine.

Add `spawnSync` to the `node:child_process` import at `src/service.ts:8`
(`execFileSync` and `execSync` are already there). Using `/bin/launchctl` with an
argv array also removes the shell interpolation of `plistPath()` that `sh()` had.

Verified before writing: the block above, run under Bun against the real plist,
returns `{"ok":true,"stdout":"","stderr":"Load failed: 5: Input/output error…"}`
with `launchctlLoadFailed(stderr) === true`, and passes `tsc --noEmit --strict`.

### 2. Outcome verification

```ts
/** launchd domain target for the current user's GUI session. */
function launchdGuiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

/**
 * Whether launchd is running the job from the CURRENT plist. `launchctl list`
 * only proves domain membership — a job bootstrapped from an older plist stays
 * listed forever. `launchctl print` exposes the live `arguments`, which is the
 * only way to catch a load that silently no-op'd.
 */
export function launchdJobMatchesPlist(
  expectedCommand: string,
  deps: { run?: typeof runLaunchctl } = {},
): { loaded: boolean; matchesPlist: boolean } {
  const run = deps.run ?? runLaunchctl;
  const printed = run(["print", `${launchdGuiDomain()}/${LABEL}`]);
  if (!printed.ok) return { loaded: false, matchesPlist: false };
  // `print` writes the arguments block to stdout for a live job (measured: exit 0,
  // stdout contains "arguments"). Search both streams anyway so a future launchctl
  // that moves diagnostics between them cannot silently turn this into a false
  // negative — a false "stale" verdict would send users to `bootout` for nothing.
  const printedText = `${printed.stdout}\n${printed.stderr}`;
  return { loaded: true, matchesPlist: printedText.includes(expectedCommand) };
}
```

The expected command is `buildServiceShellCommand(cliEntry().bun, cliEntry().cli)`
— the same builder that produced the string in `ProgramArguments`
(`src/service.ts:331`), so the comparison cannot drift.

**Fixture discipline:** capture the `launchdJobMatchesPlist` test fixture from a
real `launchctl print gui/<uid>/com.opencodex.proxy` run (tab-indented
`arguments = { ... }` block) during B and paste it in. A hand-written
approximation would make the test agree with the implementation while both
disagree with launchd — the failure mode this unit has already hit twice.

### 3. Use them in the two load sites

```diff
 function installLaunchd(): void {
   ...
   const p = plistPath();
   writeFileSync(p, buildPlist(), "utf8");
-  try { sh(`launchctl unload "${p}" 2>/dev/null`); } catch { /* not loaded */ }
-  sh(`launchctl load -w "${p}"`);
+  runLaunchctl(["unload", p]);   // absent is fine; failure is handled by the verify below
+  const loaded = runLaunchctl(["load", "-w", p]);
+  if (!loaded.ok || launchctlLoadFailed(loaded.stderr)) {
+    // Do NOT write install state for a load that did not take: state that
+    // describes an unused plist is what made this failure invisible.
+    throw new Error(
+      `launchctl could not load ${p}: ${loaded.stderr || "load reported failure"}\n`
+      + "A previous job may still be bootstrapped. Try:\n"
+      + `  launchctl bootout ${launchdGuiDomain()}/${LABEL}\n`
+      + "then re-run 'ocx service install'.",
+    );
+  }
   writeServiceInstallState();
 }

-function startLaunchd(): void { sh(`launchctl load -w "${plistPath()}"`); }
+/**
+ * Deps are named for the layer they replace, not for the process API:
+ * `launchctl` returns a runLaunchctl RESULT ({ ok, stdout, stderr }), and
+ * `matches` returns a launchdJobMatchesPlist result. Neither is a spawnSync
+ * mock — only runLaunchctl itself takes one of those.
+ */
+function startLaunchd(deps: {
+  launchctl?: typeof runLaunchctl;
+  matches?: typeof launchdJobMatchesPlist;
+} = {}): void {
+  const run = deps.launchctl ?? runLaunchctl;
+  const p = plistPath();
+  const loaded = run(["load", "-w", p]);
+  if (loaded.ok && !launchctlLoadFailed(loaded.stderr)) return;
+  // `Load failed` on start is AMBIGUOUS in a way it is not on install: the job may
+  // already be bootstrapped from THIS plist, which is a no-op, not an error.
+  // `install` can assume a stale job (it just rewrote the plist); `start` cannot.
+  // Ask launchd which case this is instead of throwing at a working setup.
+  const entry = cliEntry();
+  const live = (deps.matches ?? launchdJobMatchesPlist)(
+    buildServiceShellCommand(entry.bun, entry.cli),
+  );
+  if (live.loaded && live.matchesPlist) {
+    console.log("ℹ️  service was already loaded from the current plist; nothing to do.");
+    return;
+  }
+  throw new Error(
+    `launchctl could not load ${p}: ${loaded.stderr || "load reported failure"}\n`
+    + (live.loaded
+      ? `launchd is running an OLDER plist. Fix:\n  launchctl bootout ${launchdGuiDomain()}/${LABEL}\n  ocx service install`
+      : "The job is not loaded. Run 'ocx service install' to re-register it."),
+  );
+}
```

**Why `start` and `install` differ.** Measured: `launchctl load -w` emits
`Load failed` for *any* already-bootstrapped job, including one bootstrapped from
the identical plist. `ocx service start` on a healthy running service hits that
every time. Throwing there would break the most common benign invocation — so
`start` disambiguates with `launchctl print` and only throws when the loaded job
is genuinely stale or absent.

`install` needs no such branch: it has just rewritten the plist, so a job that
refuses to reload is stale by definition.

This asymmetry is the single most likely place to get the fix wrong, and it is why
`launchdJobMatchesPlist` is a WP1 deliverable rather than a WP4 convenience.

Required test (add to the WP1 block):

```ts
// A runLaunchctl RESULT, not a spawnSync result: exit 0 with a failure on stderr,
// which is what launchctl emits for every already-bootstrapped job.
const failedLoad = () => ({ ok: true, stdout: "", stderr: "Load failed: 5: Input/output error" });

// A healthy `ocx service start` on an already-running service must not throw:
// launchctl emits `Load failed` for EVERY already-bootstrapped job, including a
// correct one, so an unconditional throw would break the common benign case.
it("treats an already-loaded matching job as a no-op", () => {
  expect(() => startLaunchd({
    launchctl: failedLoad,
    matches: () => ({ loaded: true, matchesPlist: true }),
  })).not.toThrow();
});

// not.toThrow() alone is a weak assertion: this test would still pass if the
// guard regressed and the function returned early for the wrong reason. Assert
// the benign branch was actually taken.
it("says so when the job was already loaded from the current plist", () => {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation(m => { lines.push(String(m)); });
  try {
    startLaunchd({ launchctl: failedLoad, matches: () => ({ loaded: true, matchesPlist: true }) });
  } finally {
    log.mockRestore();
  }
  expect(lines.join("\n")).toContain("already loaded");
});

it("throws with the bootout hint when the loaded job is stale", () => {
  expect(() => startLaunchd({
    launchctl: failedLoad,
    matches: () => ({ loaded: true, matchesPlist: false }),
  })).toThrow(/bootout/);
});

it("throws with the install hint when no job is loaded", () => {
  expect(() => startLaunchd({
    launchctl: failedLoad,
    matches: () => ({ loaded: false, matchesPlist: false }),
  })).toThrow(/service install/);
});
```

No `as never` casts are needed here, unlike the `runLaunchctl` tests: those inject
a `spawnSync`-shaped mock (whose real type has many optional fields), whereas these
inject the narrow result types `runLaunchctl` and `launchdJobMatchesPlist` return.
If a cast turns out to be necessary, the deps types are wrong — fix them rather
than casting.

**Signature constraint:** `startLaunchd` is referenced by identity in
`platformOps` (`src/service.ts:1673`, as `start: startLaunchd`), so it must stay
callable with zero arguments — hence the fully-defaulted deps object, following
the house pattern at `inspectWindowsSchedulerServiceStatus`
(`src/service.ts:473-476`).

`ServiceOps.start` is typed `() => void`; a function whose only parameter is
optional is assignable to it, so `platformOps` needs no change. Confirm that when
implementing — if `ServiceOps` ever tightens to an exact-arity signature, wrap it
as `start: () => startLaunchd()` rather than reintroducing a test-only export.

Verified against the tree: `ServiceOps` (`src/service.ts:1666-1669`) declares
`start: () => void`, and `platformOps` (`:1673`) wires `start: startLaunchd`.
TypeScript assigns a `(deps?: T) => void` to a `() => void` parameter position, so
no wrapper is needed today.

**Test import note:** `tests/service.test.ts:1` currently imports
`{ afterEach, describe, expect, test }` from `bun:test`. The `console.log`
assertion above needs `spyOn` added to that list — it is a standard `bun:test`
export already used elsewhere in the suite (for example
`tests/app-owned-memory.test.ts:1,237`).

Do **not** add a separate `startLaunchdForTests` export; the `ServiceOps` wiring
would then exercise a different function than the tests do.

**`installLaunchd` deliberately has no seam.** It calls `runLaunchctl` directly
because no test drives it today (the four `repairService` cases all inject
`platform: "win32"`). If WP2's blast-radius work ever adds one, it will need the
same optional-deps treatment — and the same care not to declare a seam in prose
without threading it through the body, which is how rounds 3 and 4 of this unit's
audit failed.

#### The gap the benign branch leaves open, and who closes it

`matchesPlist: true` proves launchd is running **the current plist**. It does not
prove the proxy bound a socket: the child can exec correctly and then exit on a
config error, a busy port, or a failed migration, and `launchctl print` will still
show the right `arguments` while `KeepAlive` cycles it.

So the trichotomy here is deliberately about *staleness*, not health:

| `load` result | `matchesPlist` | `startLaunchd` | who checks serving |
|---|---|---|---|
| clean | — | return | WP2's `confirmServiceServing` |
| `Load failed` | true | benign no-op return | WP2's `confirmServiceServing` |
| `Load failed` | false, loaded | throw + bootout hint | n/a — fails first |
| `Load failed` | not loaded | throw + install hint | n/a — fails first |

Both non-throwing paths fall through to WP2's health confirmation in
`case "start"`, so the benign return cannot smuggle a dead service past the
checkmark. **WP1 must not land its `startLaunchd` change without WP2's
confirmation in the same release**, or the benign branch becomes a new way to
report success for a service that is not serving — the exact bug class this unit
exists to close.

### 4. The unload side, deliberately NOT changed here

`stopLaunchd()` (`src/service.ts:1295`) and `uninstallLaunchd()` (`:1297-1300`)
have the same swallow-everything shape:

```ts
function stopLaunchd(): void { try { sh(`launchctl unload "${plistPath()}"`); } catch { /* not loaded */ } }
```

A failed `unload` here is exactly what sets up the failed `load` this phase fixes
— so it is tempting to harden it in the same pass. Do not, for two reasons:

1. `ocx service stop` already has a real outcome verifier downstream
   (`proxyStillLiveAfterStop`, `src/service.ts:1706+`), which asks the port rather
   than trusting the command. Adding a second, weaker check above it would give
   two disagreeing sources of truth for one operation.
2. `stopLaunchd` is called from `stopServiceIfInstalled()` (`:1799`) inside
   another `try/catch` that maps any throw to `false`. Making it throw would change
   that function's semantics for every caller, which is a lifecycle change, not a
   bugfix.

`installLaunchd`'s internal `unload` stays best-effort for the same reason — the
load verification immediately after it is what catches the failure, and it catches
it with a better message than a raw `unload` error would.

## MODIFY `tests/service.test.ts`

```ts
describe("launchctlLoadFailed", () => {
  // The exact stderr measured on macOS 27.0 with exit code 0.
  it("detects the legacy load failure that exits 0", () => {
    expect(launchctlLoadFailed(
      "Load failed: 5: Input/output error\nTry running `launchctl bootstrap` as root for richer errors.",
    )).toBe(true);
  });

  it("detects a bootstrap failure", () => {
    expect(launchctlLoadFailed("Bootstrap failed: 37: Operation already in progress")).toBe(true);
  });

  it("stays false for clean output", () => {
    expect(launchctlLoadFailed("")).toBe(false);
  });
});

describe("runLaunchctl", () => {
  it("reports ok with trimmed stdout on a clean run", () => {
    const out = runLaunchctl(["print", "gui/501/x"], {
      run: (() => ({ status: 0, stdout: "  ok  ", stderr: "" })) as never,
    });
    expect(out).toEqual({ ok: true, stdout: "ok", stderr: "" });
  });

  // THE regression guard: exit 0 WITH stderr. An execFileSync-based runner returns
  // stderr: "" for this exact case, so the whole fix silently no-ops on a real
  // machine while its unit tests stay green. Measured shape, not invented.
  it("surfaces stderr even when the child exits 0", () => {
    const out = runLaunchctl(["load", "-w", "/x.plist"], {
      run: (() => ({
        status: 0,
        stdout: "",
        stderr: "Load failed: 5: Input/output error\nTry running `launchctl bootstrap` as root for richer errors.",
      })) as never,
    });
    expect(out.ok).toBe(true);                          // the exit code really is 0
    expect(launchctlLoadFailed(out.stderr)).toBe(true); // ...and we still catch it
  });

  it("reports not-ok on a real non-zero exit (bootstrap)", () => {
    const out = runLaunchctl(["bootstrap", "gui/501", "/x.plist"], {
      run: (() => ({ status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" })) as never,
    });
    expect(out.ok).toBe(false);
    expect(launchctlLoadFailed(out.stderr)).toBe(true);
  });
});

describe("launchdJobMatchesPlist", () => {
  // Captured from a real `launchctl print gui/$(id -u)/com.opencodex.proxy` run on
  // macOS 27.0. Tabs and nesting are reproduced exactly: the arguments block is
  // tab-indented one level, its entries two. A hand-written approximation would let
  // the test agree with the implementation while both disagree with launchd.
  const cmd = "exec '/pkg/bun' '/pkg/src/cli/index.ts' start --port 10100";
  const printed = (command: string) => [
    "\targuments = {",
    "\t\t/bin/sh",
    "\t\t-lc",
    `\t\tif [ -f '/h/.opencodex/service-api-token' ]; then OPENCODEX_API_AUTH_TOKEN="$(cat '/h/.opencodex/service-api-token')"; export OPENCODEX_API_AUTH_TOKEN; fi; ${command}`,
    "\t}",
  ].join("\n");

  it("reports matching when print shows the current arguments", () => {
    expect(launchdJobMatchesPlist(cmd, {
      run: () => ({ ok: true, stdout: printed(cmd), stderr: "" }),
    })).toEqual({ loaded: true, matchesPlist: true });
  });

  // The regression: loaded, listed, running the PREVIOUS plist. The old command is
  // a complete concrete string — an elided "..." here would make the fixture
  // trivially non-matching for the wrong reason.
  it("reports loaded-but-stale when print shows different arguments", () => {
    const old = "exec '/old/pkg/bun' '/old/pkg/src/cli/index.ts' start --port 10100";
    expect(launchdJobMatchesPlist(cmd, {
      run: () => ({ ok: true, stdout: printed(old), stderr: "" }),
    })).toEqual({ loaded: true, matchesPlist: false });
  });

  it("reports not loaded when print fails", () => {
    expect(launchdJobMatchesPlist(cmd, {
      run: () => ({ ok: false, stdout: "", stderr: "Could not find service" }),
    })).toEqual({ loaded: false, matchesPlist: false });
  });
});
```

### Red-first proof

No seam exists in the *current* source — `startLaunchd` takes no deps and shells
out through `sh()`; the seam is what this phase adds. So the red is demonstrated
at the runtime level instead, with the transcript recorded in the B attest:

```
$ launchctl load -w <plist>; echo "exit=$?"
Load failed: 5: Input/output error
exit=0
```

i.e. the input `sh()` receives is indistinguishable from success. That is the
defect, and it is why the fix cannot be a test-only change.

## Guarding the demoted R1 finding

`bakedServicePathsDiagnostic()` (`src/service.ts:1550`) remains `existsSync`-only.
It is **not** the cause (see `003`), but a present-but-unrunnable baked Bun would
still pass it. Deferred, deliberately: `bundledBunPath()`
(`src/lib/bun-runtime.ts:35-46`) already gates on `isRealBunBinary`, so the only
reachable path is `durableBunRuntime()`'s `process.execPath` fallback
(`src/lib/bun-runtime.ts:62`). Tracked as WP5 rather than smuggled in here.

**If it is ever added, `tests/service.test.ts:816-823` must be updated in the same
commit:** that fixture sets `bunPath` to `service.test.ts` itself (47,317 bytes)
and asserts `toBeNull()`, which a 1MB size floor turns red.

## Verification

```
bun x tsc --noEmit
bun test tests/service.test.ts
bun run test           # src/service.ts is imported by cli/index.ts, cli/status.ts,
                       # codex/autostart-health.ts, server/management/system-restart.ts
```

### Two suites that assert on source TEXT, not behavior

- `tests/uninstall.test.ts:30-35` reads `src/service.ts` as a string and asserts
  it contains `"uninstallLaunchd"`, `"uninstallWindows"`, and
  `"export function uninstallServiceIfInstalled()"`. WP1 does not touch
  `uninstallLaunchd`, so it stays green — but any later phase that converts the
  remaining `sh("launchctl ...")` call sites must keep those identifiers present.
- `tests/service.test.ts:859-896` drives `repairService` (`src/service.ts:1383`)
  with `platform: "win32"` plus explicit deps in all four cases, so none of them
  reach `installLaunchd`. WP1's throw therefore does not break them — confirmed by
  reading the file, not assumed.

Plus a live check on this machine: `ocx service install`, then
`launchctl print gui/$(id -u)/com.opencodex.proxy` to confirm the running
`arguments` match the on-disk plist.

## Done when

- A `load` that prints `Load failed` and exits 0 raises instead of being ignored.
- `installLaunchd` does not write install state for a load that did not take.
- The nine new tests pass and the full suite stays green.

## Does this generalize to Windows and Linux? (WP5/WP6 foundation)

The goal now covers all three platforms, so the question at this gate is whether
WP1's shape is the right foundation or a macOS-specific dead end.

**The `runLaunchctl` half is macOS-specific and should stay that way.** It exists
because `launchctl load` has a broken exit convention. The other two managers do
not share it:

| Platform | Management command | Failure signal |
|---|---|---|
| macOS | `launchctl load -w` | **stderr only; exit 0** — the defect |
| Linux | `systemctl --user enable/restart` | non-zero exit; `sh()` throws correctly |
| Windows | `schtasks /create`, `/run` | non-zero exit; `schtasks()` throws correctly |

So WP5/WP6 must not port `launchctlLoadFailed`. Their defect, if any, is the
second half of this unit's thesis, not the first.

**The serving-confirmation half is exactly what generalizes.** Read against the
tree:

- **Linux** (`src/service.ts:1636-1656`, diagnostic at `:1993-2005`) is the
  strongest of the three: `diagnoseService` consults `systemctl --user is-active`,
  which is a real process-liveness check rather than launchd's mere membership
  test. But `is-active` returns `active` for a process that is running and has
  bound nothing — and under `Restart=on-failure` (`buildUnit`) a crash-loop
  spends most of its time `activating`/`active`. So `viable` can still be true
  with a dead port.
- **Windows** (`installWindows` at `:1354-1357`, `startWindows` at `:1496`) runs
  `schtasks /run` and returns. `/run` reports that the task was *launched*, not
  that its child survived; `deriveWindowsServiceDiagnostic` then computes
  `running` from scheduler registration/enablement. A wrapper whose child exits
  immediately satisfies it.

Both reduce to the same sentence as macOS: **the manager's success signal answers
registration, not service.** WP2's `confirmServiceServing` — probing the baked
port with `proxyIdentityAt` — is platform-neutral by construction and is the piece
WP5/WP6 should adopt, ideally by lifting it into the shared `serviceCommand`
layer rather than re-implementing per platform.

**Conclusion:** WP1 is the right foundation. Its runner is deliberately local to
the platform with the broken exit convention; its verification principle is what
the other two phases inherit. Recorded here so WP5/WP6's P starts from this rather
than re-deriving it.
