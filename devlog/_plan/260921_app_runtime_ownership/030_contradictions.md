# Contradiction round 1

Three read-only lenses were run against the charter and the user's answers. They returned 22
contradictions, 17 of them high. Recorded here so the plan has to answer them rather than
rediscover them.

## The premise that did not survive

**The verification hosts were miscounted, and that was my error.** The host I took for a Mac is
in fact the Windows machine, and the Linux one failed to resolve because I used the wrong short
name. With the right name and a permitted account all three platforms are reachable; see
`040_verification_hosts.md`. The contradiction that survives is narrower: the Linux box has no
`ocx` installed, so the npm side of the coexistence scenario does not exist there yet.

**The sync button's silence is not a permission problem.** There are two different sync buttons and
they behave differently. The dashboard's model sync (`gui/src/pages/use-dashboard-data.ts:779`)
posts to `/api/sync` and renders both a success and a failure toast
(`dashboard-overview-sections.tsx:243`, backend at
`src/server/management/config-routes.ts:700`). The Integrations client sync
(`gui/src/pages/Integrations.tsx:73`) posts to `/api/machine/sync`, **ignores the status and the
body entirely**, and only clears a busy flag — so it cannot report anything, ever, no matter what
the server says. Neither path calls an OS elevation API. Elevating the app would not change either.

## Ownership cannot be expressed yet

- Ownership is the process-local `spawned_by_us` boolean; persisted service state has no consent
  field and no desktop-owner field, so "asked once" and "permanent owner" cannot both be enforced
  across an app restart.
- Disabling the npm service's autostart does not survive `ocx service repair` or `ocx update`: a
  disabled registration still counts as installed, repair re-enables and restarts it, and the
  recorded `launcherPath` still names the npm launcher.
- The app's Start at Login and the service's autostart are independent switches with no
  mutual-exclusion invariant, so both can fire at the next login and race for the port.
- The app cannot prove the process answering the port is the child it spawned: any successful
  health response after `spawn()` yields `Some(child)` and therefore app ownership.
- A plain `POST /api/stop` cannot perform the promised graceful takeover of a *managed* runtime.
  The endpoint deliberately refuses launchd/systemd self-unload and the Windows respawn case unless
  a receipt-backed `ocx stop` owns the teardown, so the app either stalls on 409 or bypasses the
  drain and client-restore contract.
- Cmd+Q reaches `shutdown_child()` with no `ExitRequested` interception, and the updater's
  `app.restart()` takes the same hard-kill path.

## Elevation is the wrong tool

Everything this app owns is per-user: the app spawns its sidecar as the current user, macOS uses
`~/Library/LaunchAgents`, Linux uses `systemctl --user`, and the Windows task is registered
`InteractiveToken` with `LeastPrivilege`. Windows already has a *conditional* elevation
fallback that only crosses UAC after an access-denied create — and which explicitly fails when a
*different* administrator supplies the credentials, because that account cannot read the staged
payload. An unconditional up-front prompt would therefore be both unnecessary and, for a standard
account, misleading.

Separately, and worth fixing regardless: `ProxyClient` sends the admin token to `127.0.0.1`
without `no_proxy()`, and the pinned reqwest enables system proxies by default.

## Evidence CI does not provide

- Nothing installs an MSI, a deb or an AppImage anywhere in the repository; no `msiexec`, no
  `dpkg -i`, no AppImage execution.
- The service-lifecycle workflow installs a service *from a source checkout* — it never models an
  npm-installed runtime being handed to an installed app.
- That workflow's path filter names `src/service.ts` and omits both `src/service/**` and
  `desktop/**`, so the ownership implementation can land green without any lifecycle evidence.
- `platform-windows` runs only on `workflow_dispatch`, by recorded decision.
- The Windows release lane builds an MSI and then runs POSIX syntax under PowerShell.
- `publish` depends only on `validate-dispatch`, so a version can go public while packaging fails.

## Open assumptions

1. Linux has a host (Ubuntu 24.04 GNOME) but no npm `ocx` on it, so the coexistence scenario has to be
   staged there before it can be exercised.
2. `.deb` and AppImage are one "Linux" in the charter but two update contracts — the manifest
   names AppImage only.
3. "Cmd+Q keeps it in the menu bar" has no literal equivalent on Windows or Linux; the portable
   statement is that closing the window and quitting the window are different actions, and only the
   explicit tray Quit ends the runtime.
4. Which of the two sync buttons the user pressed is not yet known.

