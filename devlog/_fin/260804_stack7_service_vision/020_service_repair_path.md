# 020 — `ocx update` must repair the service, not re-register it (#970)

## The defect

`ocx update` stops the running proxy before replacing package files, then brings
the background service back. It brings it back by **re-registering** it:
`serviceReinstallArgs()` returns `["service", "install"]`
(`src/service.ts:183-185`), and the Windows scheduler installer always reaches
`schtasks /create` (`src/service.ts:1723-1729`). `/create` requires elevation.

An ordinary `ocx update` from a normal terminal inherits the user's non-admin
token. So on Windows the update stops a working proxy and then cannot put it
back — the failure mode @stephen-drew reports in #970. The direct-start fallback
keeps *a* proxy alive, but the managed service the user installed is gone until
they re-run an elevated install by hand.

Scheduler **repair** does not re-register: it stops, rewrites the wrapper assets,
and `/run`s the existing task (`src/service.ts:1775-1785`). No `/create`, no UAC.

## Why this is a small change, not a 522-line one

`repairService()` and the `ocx service repair` subcommand already exist here
(`src/service.ts:1755`, `src/service.ts:2526`). #970 carries 522 added lines
largely because it also rewrites advice strings, five docs locales, and GUI
surfaces. The behavioral core is the argv one helper returns plus the call sites
that consume it.

### Call sites that re-register after an update

| Path | Today | Runs non-elevated? |
|---|---|---|
| `bin/ocx.mjs:136-150`, invoked `:244-253` | inlines the install argv | yes |
| `src/update/index.ts:298-320` | `serviceReinstallArgs()` | yes |
| `src/update/job.ts:737-744`, invoked `:807-814` | `serviceReinstallArgs()` | yes |
| `src/server/startup-action-control.ts:109-117` | already picks `repair` for repair mode | n/a — correct |

The dashboard Startup action is already right, and
`tests/startup-action-control-elevation.test.ts:152` already asserts repair is
never elevated. Only the three update paths are wrong.

## The safety question the PR does not answer

`repairService()` **throws** when `!diag.installed` (`src/service.ts:1758-1770`).
The update path runs it *after* `ocx stop`. If stopping deregistered the service,
substituting repair would throw exactly where install used to succeed.

It does not. Stop never deletes registration on any platform:

| Platform | Stop does | Registration lives in | `installed` derives from |
|---|---|---|---|
| macOS | `launchctl unload` (`src/service.ts:1667`) | the plist, deleted only by `uninstallLaunchd` (`:1669-1673`) | `existsSync(plistPath())` (`:2372-2381`) |
| Windows scheduler | `schtasks /end` (`:1885-1891`) | the task, deleted only by `/delete` (`:1894-1908`) | non-empty `/query /xml` (`:2383-2400`) |
| Windows WinSW | `stopwait` (`src/lib/winsw.ts:330-332`) | the service; only `nonexistent` means absent | `:2323-2334` |
| Linux | `systemctl --user stop` (`:2067`) | the unit file, deleted only by `uninstallSystemd` (`:2069-2072`) | `existsSync(unitPath())` (`:2402-2414`) |

`stopServiceIfInstalled()` (`:2204-2225`) calls exactly those three and no
uninstall. **Verdict: the substitution is safe on all three platforms** when the
path began with a genuinely installed service.

Repair also re-bakes the port the same way install does — `OCX_BAKE_PORT` feeds
`resolveServiceListenPort()` (`:318-335`), which every backend's asset writer
consumes (`buildPlist` `:1607`, `buildUnit` `:2010`, `buildWindowsServiceScript`
`:1693`, WinSW XML `src/lib/winsw.ts:79-92`). So the update path's existing
`OCX_BAKE_PORT` handling keeps working unchanged.

On macOS and Linux repair delegates straight to `installLaunchd`/`installSystemd`
(`:1787-1793`), so the service-manager outcome is identical. The change is
Windows-meaningful and non-Windows-neutral.

## The Windows GUI updater never reaches the command at all (audit B3)

Changing the argv is not enough on the surface that matters most.
`restartAfterUpdate()` sets `skipServiceInstall = true` unconditionally when the
worker is a non-elevated Windows process (`src/update/job.ts:775-790`):

```ts
// Windows GUI update worker sets OCX_SERVICE=1 and is never elevated.
// `schtasks /create` will UAC-fail and can race the subsequent direct start.
if (process.platform === "win32" && process.env.OCX_SERVICE === "1") {
  updateJob(job, {}, "Skipping service reinstall from the non-elevated update worker; ...");
  skipServiceInstall = true;
```

The dashboard-triggered update is the common GUI path, and it skips the refresh
entirely — so a pure argv change would fix the CLI while leaving the GUI exactly
as broken.

The skip's own comment names its justification: `schtasks /create` needs UAC.
**Repair does not call `/create`** (`src/service.ts:1775-1785`), so the
justification does not survive this change. The skip must be narrowed to the
install argv rather than left standing: a non-elevated Windows worker should run
`service repair` and fall through to the direct start only if that fails.

This makes the reconstruction *larger* than a find-and-replace, and it is the
part of #970 that actually delivers the fix to the user who reported it.

## The caveat #970 introduces and does not handle

`bin/ocx.mjs:136-150` decides "a service manages this proxy" from the mere
existence of `service-state.json`. That marker can be **stale** — present while
the actual registration is gone. Today `install` recreates the service from a
stale marker. Under a blind `repair` substitution it throws "not installed", and
the user silently loses their managed service; only the direct-start fallback
(`bin/ocx.mjs:253-297`) keeps a proxy alive.

`src/update/index.ts` does not have this hole: it records `isServiceInstalled()`
before stopping (`:188-194`).

**Our reconstruction closes it — but not by reading the failure** (audit B4).
`repairService()` throws a plain `Error` for unsupported, conflict, ownership,
auth, absent-registration, asset-write, start, and health failures alike
(`src/service.ts:1755-1770`), and `bin/ocx.mjs` spawns with inherited stdio and
sees only an exit status (`bin/ocx.mjs:251`). "Not installed" is not
distinguishable from any other failure, so message-matching is unimplementable
and a blanket "install after any repair failure" would reintroduce the UAC path
and could re-register a service the user had just deliberately uninstalled.

Instead: after a failed repair, consult **structured state** and install only
when it reports the service genuinely absent while the managed-service marker
still expresses intent. State beats error-message parsing.

The mechanism differs by caller, and `bin/ocx.mjs` is the constraint.
**It is plain Node ESM** (`#!/usr/bin/env node`) and imports only `.mjs`
siblings — `bun-binary-validator.mjs`, `npm-invocation.mjs`,
`tray-update-plan.mjs` (`bin/ocx.mjs:11-19`). It cannot import
`diagnoseService()` from `src/service.ts`, so naming that function here would
have been as unimplementable as the message-parsing it replaced.

It does not need to. `bin/ocx.mjs` **already** spawns `ocx status --json` and
parses it in exactly this code path (`bin/ocx.mjs:258`), and that payload
carries `startup.serviceInstalled` and `startup.serviceStale`
(`src/codex/autostart-health.ts:123-127`, surfaced through `src/cli/status.ts:180`).
The existing probe reads only `proxy.running`/`startup.serviceViable`; reading
`serviceInstalled` from the same response is a field access, not a new
mechanism.

So: repair fails → the status probe reports `serviceInstalled === false` →
install once → otherwise fall through to the direct start without re-registering.
Callers inside the TypeScript runtime (`src/update/index.ts`,
`src/update/job.ts`) can call `diagnoseService()` directly.

**Implementation note:** that probe currently runs only on the *success* path,
after a service command exits 0 (`bin/ocx.mjs:253`). The failure path must move
or duplicate it. The planned failure-path test is what catches this.

A straight cherry-pick of #970 would import the stale-marker regression; a naive
fix for it would import a worse one.

## Planned diff

1. `src/service.ts` — `serviceReinstallArgs()` returns `["service", "repair"]`;
   keep the export name for out-of-module callers. `serviceRepairCommand()`
   (`:500-511`) returns the backend-neutral `ocx service repair` instead of
   synthesizing `install --native`.
2. `bin/ocx.mjs` — refresh via repair; on failure read `startup.serviceInstalled`
   from the `status --json` probe it already performs (`:258`) and install only
   for a genuinely absent service, before the direct-start fallback.
3. `src/update/index.ts` — consume the repair argv; existing non-viable/failed
   fallbacks unchanged.
4. `src/update/job.ts` — consume the repair argv **and** narrow the
   Windows/`OCX_SERVICE=1` skip (`:775-790`) so it no longer suppresses a
   non-registering repair.
4. Advice strings that fire only for an **installed** service become repair:
   `src/cli/status.ts:171-177`, `src/service.ts:1927`, `:2341-2349`, `:2464-2474`,
   `src/lib/winsw.ts:370-372`. First-install and missing-unit guidance
   (`src/service.ts:1768-1770`, `:2045-2050`) stays install.
5. `src/cli/doctor.ts:687-696` currently sees only `serviceViable`, which
   conflates "absent" with "installed but stale". It needs the installed/stale
   inputs before it can choose correctly — otherwise it would advise repair to a
   user who has no service at all.
6. Docs: the English lifecycle page omits `repair` from the subcommand table and
   its status example literally reads `Repair: ocx service install`
   (`docs-site/.../reference/cli/lifecycle.md:176-192`, `:229-236`). Same gap in
   ko/ja/zh-cn/ru.

## Tests that must move, and the red-green plan

These currently pin `service install` in an update/recovery path and will fail
until updated — which is the proof the change is load-bearing:

- `tests/update-job.test.ts:115-119`, `:126-134`
- `tests/winsw.test.ts:252-256`
- `tests/service.test.ts:1243-1251`
- `tests/doctor.test.ts:473-479`
- `tests/update-stop-first.test.ts:58-72` (wording plus a stronger argv assertion)
- `tests/windows-deploy-close-regressions.test.ts:45` — static guard describing
  the install-only Windows behavior (audit B3)

New coverage:

- the update refresh argv is `service repair` — ablate by restoring the install
  argv and watch it go red;
- **a non-elevated Windows worker (`OCX_SERVICE=1`) now receives
  `service repair`** rather than skipping the refresh — the audit-B3 guard;
  ablate by restoring the unconditional skip and watch it go red;
- a stale `service-state.json` with no real registration still ends with a
  managed service (repair fails, diagnostic reports absent, install runs) —
  ablate by removing the diagnostic recheck and watch it go red;
- a repair that fails for a reason **other** than absence does NOT trigger an
  install — the audit-B4 guard against reintroducing UAC.

Already-passing coverage that constrains us and must stay green:
`tests/service.test.ts:897-912` (scheduler repair does no `/create`), `:914-920`
(repair rejects a genuinely absent service), `tests/winsw.test.ts:213-225`,
`tests/update-job.test.ts:304-350` (`OCX_BAKE_PORT` set and restored).
