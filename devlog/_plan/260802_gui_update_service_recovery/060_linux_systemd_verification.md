# WP5 — Linux systemd: what the shared fix already covers, and what it does not

Extends the unit from macOS to Linux. Written at this phase's P rather than in the
WP0 roadmap: the original report was macOS-only, and Linux entered scope after the
first four phases landed (LOOP-UNIT-CHAIN-01 amendment).

## Starting position — measure before designing

Unlike macOS, most of this is already done. WP2 gated on `process.platform === "win32"`,
not on darwin, so **Linux inherited the serving confirmation for free**:

| Surface | Linux today | Source |
|---|---|---|
| `ocx service install` | confirms serving on the baked port | `case "install"`, `src/service.ts:2377` |
| `ocx service start` | confirms serving | `case "start"` |
| `ocx service repair` | confirms serving | repair branch |
| `ocx service status` | 3-state report | `serviceStatusReport()` |
| baked-port read | `systemdListenPort()` parses `ExecStart=` | `src/service.ts` |
| update worker | health-gated, not viability-gated | `src/update/job.ts` |

So the question this phase must answer is narrow: **is anything left that is
specific to systemd?**

## D1 — `systemctl` does not share launchctl's exit-code defect

Verified by reading, and stated so the next reader does not port a fix that has no
cause here. `installSystemd` (`src/service.ts:1865-1877`) runs three commands through
`sh()` (`execSync`):

```
sh("systemctl --user daemon-reload");
sh(`systemctl --user enable ${TASK}`);
sh(`systemctl --user restart ${TASK}`);
```

`systemctl` returns a non-zero exit on failure, so `execSync` throws and the failure
propagates. There is no "reports failure on stderr while exiting 0" analogue.
**`runLaunchctl`/`launchctlLoadFailed` must NOT be ported.** WP1 is macOS-specific by
cause, not by accident.

## D2 — `is-active` is stronger than `launchctl list`, and still not proof

`diagnoseService`'s linux branch (`src/service.ts:2223-2233`):

```ts
const enabled = installed && (... `systemctl --user is-enabled ${TASK}` === "enabled");
const running = installed && (... `systemctl --user is-active ${TASK}` === "active");
const viable  = installed && enabled && running && !stale;
```

This is genuinely better than darwin's `launchctl list | grep`: `is-active` reports
process liveness, not mere registration. But it still cannot see a bound socket. A
proxy that starts, fails to bind, and stays up reports `active`; and under
`Restart=on-failure` (`buildUnit`, `src/service.ts:1821`) a crash-loop spends much of
its time `activating`/`active`.

That gap is already closed at the surfaces that matter — install/start/repair/status
all probe the port now. What remains is that `viable` itself is still consulted by
`isServiceViable()`, which feeds the tray and `startup-health-cache`. Those are out of
this unit's scope (they are display paths, not recovery paths), and widening
`diagnoseService` to shell out per call was explicitly rejected in WP4. **Recorded as
a known limit, not fixed here.**

## D3 — the one real Linux-specific gap: `startSystemd` cannot detect a stale unit

macOS got `launchdJobMatchesPlist` because `launchctl load` can silently leave an
older plist running. systemd has the same failure in a different shape: writing
`~/.config/systemd/user/opencodex-proxy.service` does **not** change the running unit
until `daemon-reload`. `installSystemd` calls it; `startSystemd`
(`src/service.ts:1878-1886`) does not:

```ts
function startSystemd(): void {
  ensureUserBusEnv();
  if (!existsSync(unitPath())) { ...exit 1... }
  sh(`systemctl --user start ${TASK}`);
}
```

So `ocx service start` after a hand-edited or externally-rewritten unit starts the
**previously loaded** definition, exactly the macOS stale-plist case. systemd exposes
it: `systemctl --user show -p NeedDaemonReload` returns `NeedDaemonReload=yes`.

**Query verified against the systemd manual, not assumed.** `NeedDaemonReload` is a
**per-unit** property (`systemctl show -p NeedDaemonReload UNIT`), emitted as a bare
`NeedDaemonReload=yes` / `=no` line. `yes` means "systemd detected that its loaded
unit-file configuration is out of date" — precisely the state D3 describes. The
documented remedy is `daemon-reload`, which reloads the manager configuration and
does **not** restart the service, which is what makes the fix below safe to run
unconditionally before `start`.

Two API details that matter for the implementation:

- Pass the unit name. Without it, `show` returns the **manager's** properties, which
  is a different question.
- `--value` would return a bare `yes`/`no`. The regex below matches the `key=value`
  form instead, so it works with or without that flag and tolerates the multi-unit
  output shape (`Id=…` interleaved) if a caller ever passes more than one unit.

### Change

```ts
/**
 * Whether systemd's in-memory unit differs from the file on disk. The systemd
 * analogue of launchd's stale-plist case: writing the unit file does not change the
 * loaded definition until `daemon-reload`, so `start` would run the previous one.
 */
export function systemdNeedsDaemonReload(
  deps: { show?: () => string } = {},
): boolean {
  try {
    const out = (deps.show ?? (() => sh(`systemctl --user show -p NeedDaemonReload ${TASK}`)))();
    return /NeedDaemonReload\s*=\s*yes/i.test(out);
  } catch {
    return false; // cannot tell -> do not block a start that would otherwise work
  }
}
```

```diff
 function startSystemd(): void {
   ensureUserBusEnv();
   if (!existsSync(unitPath())) { ... }
+  // The unit file on disk may be newer than what systemd has loaded; starting now
+  // would run the previous definition. Reload first — idempotent and non-disruptive.
+  //
+  // `start` alone is not enough after a reload: it is a no-op on an already-active
+  // unit, so a stale process would keep running the OLD ExecStart. NeedDaemonReload
+  // compares disk against loaded, never loaded against running, so the only way to
+  // guarantee the running process matches the file is to restart it.
+  if (systemdNeedsDaemonReload()) {
+    console.log("ℹ️  unit file changed on disk; reloading systemd and restarting the service.");
+    sh("systemctl --user daemon-reload");
+    sh(`systemctl --user restart ${TASK}`);
+    return;
+  }
   sh(`systemctl --user start ${TASK}`);
 }
```

`restart` rather than `start` on that branch is the whole point: without it the fix
would cover only the stopped-unit case and leave the live stale process — which is the
exact shape of the macOS bug this unit started from, reproduced on Linux.

Reloading rather than erroring is right here, unlike macOS: `daemon-reload` is safe,
idempotent, and systemd's own documented remedy, while `launchctl bootout` tears down
a running job and needs a human decision. `restart` is likewise ordinary systemd
practice; it is only reached when the definition actually changed.

### Tests

```ts
describe("systemdNeedsDaemonReload", () => {
  test("detects a unit changed on disk", () => {
    expect(systemdNeedsDaemonReload({ show: () => "NeedDaemonReload=yes" })).toBe(true);
  });

  test("is false when systemd is already in sync", () => {
    expect(systemdNeedsDaemonReload({ show: () => "NeedDaemonReload=no" })).toBe(false);
  });

  // No user bus / not installed: never block a start we cannot judge.
  test("is false when the query fails", () => {
    expect(systemdNeedsDaemonReload({ show: () => { throw new Error("no bus"); } })).toBe(false);
  });
});
```

Those three only exercise the regex. The actual bug is an **ordering** property of
`startSystemd`, which cannot be driven on macOS — so pin it the way this file already
pins the sibling case at `tests/service.test.ts:132-145`, by asserting source order:

```ts
test("service start reloads systemd before starting a changed unit", async () => {
  const service = await readText("src/service.ts");
  const startSystemd = service.slice(
    service.indexOf("function startSystemd()"),
    service.indexOf("function stopSystemd()"),
  );

  const needsReloadAt = startSystemd.indexOf("systemdNeedsDaemonReload()");
  const reloadAt = startSystemd.indexOf("systemctl --user daemon-reload");
  const restartAt = startSystemd.indexOf("systemctl --user restart");
  const startAt = startSystemd.indexOf("systemctl --user start");

  expect(needsReloadAt).toBeGreaterThan(-1);
  expect(needsReloadAt).toBeLessThan(reloadAt);
  expect(reloadAt).toBeLessThan(restartAt);
  // A changed unit must be RESTARTED, not started: `start` is a no-op on an active
  // unit and would leave the stale process running.
  expect(restartAt).toBeLessThan(startAt);
});
```

Source-text assertions are normally weak, but here they are the honest instrument:
the property is "these commands run in this order", the host cannot execute systemd,
and the file already uses this precedent for the adjacent invariant.

## D4 — `systemdListenPort` needs a real-unit fixture

WP2 added it with hand-written inputs. `buildUnit()` is deterministic, so the test can
assert against the actual generated unit rather than an approximation:

```ts
test("reads the port out of a unit produced by buildUnit", () => {
  expect(systemdListenPort({ readUnit: () => buildUnit() })).toBe(resolveServiceListenPort());
});
```

`buildUnit` is already exported and already imported by `tests/service.test.ts`.

## Out of scope

## D6 — residual Linux modes this phase does NOT close

Named so the "only D3+D4" claim is not read as "Linux is now complete".

**F9, the user-bus gap.** `ensureUserBusEnv` (`src/service.ts:1855-1858`) sets only
`XDG_RUNTIME_DIR`, never `DBUS_SESSION_BUS_ADDRESS`. Over SSH with a runtime dir
present but no user bus, `isSystemd()` still returns true through the
`userRuntimeDir()` fallback (`:1863`), so `installSystemd` proceeds and dies on a raw
`execSync` throw from `daemon-reload`. D1 is technically satisfied — the failure does
propagate — but the user gets an unmapped stack trace instead of the linger/bus
guidance the situation calls for. Mapping that error is a self-contained follow-up,
not part of the serving-verification thesis.

**`startSystemd` never re-`enable`s.** A unit disabled out of band starts once and
does not return at login. `diagnoseService` reports it (`enabled: false`), so it is
visible — just not from `start`. Left alone deliberately: `start` meaning "start" and
not "start and also change boot policy" is the more predictable contract.

**A proxy that fails to bind and exits 0** is not restarted by `Restart=on-failure`
(`:1821`), and `is-active` then reads `inactive` — so status is honest and the user is
not misled. That is D5's asymmetry seen from the other side, and it is why D5 is
recorded rather than patched blind.

## Out of scope

## D5 — `Restart=on-failure` does not cover a clean exit

`buildUnit()` (`src/service.ts:1819-1822`) emits:

```
Type=simple
Restart=on-failure
RestartSec=5
```

`on-failure` restarts on a non-zero exit, a signal, a timeout, or a watchdog — but
**not on a clean `exit 0`**. macOS's plist uses `KeepAlive`, which restarts
unconditionally, so the two platforms do not actually offer the same guarantee.

A proxy that decides to shut down cleanly — an unhandled config error that calls
`process.exit(0)`, an `ocx stop` racing an update, a drain that completes and returns
— leaves a systemd unit sitting in `inactive (dead)` while `is-enabled` still says
`enabled`. `diagnoseService` then reports `running: false`, which is at least honest,
but nothing brings the proxy back until the next login.

**Deliberately NOT changed here.** `Restart=always` would be the parity fix, and it
is a one-word diff — but it changes shutdown semantics for every existing Linux
install: `ocx stop` would fight the supervisor unless the stop path also runs
`systemctl --user stop`, and `stopSystemd` (`src/service.ts:1887`) does exactly that,
so the change is probably safe. "Probably safe" is not the standard for a supervisor
policy change on a platform this machine cannot test.

Recorded as a known asymmetry with a named remedy, for a unit that can verify it on
a real systemd host. Filing it here rather than silently matching macOS is the point:
the gap is now written down instead of being discovered by the next reporter.

## Out of scope

- Porting `runLaunchctl` (D1: no cause).
- Making `diagnoseService` probe the port (D2: rejected in WP4, tray/startup-health
  paths call it synchronously).
- `loginctl enable-linger` guidance, which already exists in `case "install"`.

## Verification

```
bun x tsc --noEmit
bun test tests/service.test.ts
bun run test
```

**Platform limit, stated plainly:** this machine is macOS, so the systemd code paths
cannot be executed here. Every claim above is from reading the source, and the changes
are verified through injected seams rather than a live systemd bus. `installSystemd`
is already unreachable in tests by design (`RepairServiceDeps.platform` exists so
"Linux CI cannot hit real installSystemd", `src/service.ts:1601`).

## Done when

- `ocx service start` on Linux reloads a changed unit instead of starting the old one.
- `systemdNeedsDaemonReload` is covered for yes/no/unavailable.
- `systemdListenPort` is asserted against a real `buildUnit()` output.
- The three non-gaps (D1, D2, and the already-inherited WP2 coverage) are recorded so
  a later reader does not re-open them.
