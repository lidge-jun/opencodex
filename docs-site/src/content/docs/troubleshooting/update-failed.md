---
title: Update Failed on Windows
description: What state an OpenCodex install is in after ocx update fails during the npm install step, how to finish the update safely, and which leftover folders you may delete.
---

This page is for an `ocx update` or dashboard update that stops partway, most often on Windows,
with a result like this (reported as issue
[#5624](https://github.com/lidge-jun/opencodex/issues/5624)):

```text
update command failed (1)
exit 1 · code: ENOTDIR · syscall: mkdir
```

and, afterwards, a folder next to the package that cannot be deleted because `bunx.exe` is in use
(`EPERM`).

## What state you are in

The updater stops the proxy, installs the new version into a separate staging folder, checks it,
and only then swaps it in. When the install step fails, the swap never happens: the previous version
stays installed and runnable, and the updater restarts the previous background service (or the
previous proxy) before it exits. You do not need to reinstall to get back to a working proxy.

Check that with:

```bash
ocx --version
ocx status
```

The dashboard job only records the exit status, because the installer's own output can contain local
paths. Running `ocx update` in a terminal shows the step that failed and the next step to take.

## Finish the update

1. Close anything that may still run OpenCodex files: the Codex app, terminals that started
   `ocx` or `bunx`, and the OpenCodex tray. A running `bun.exe` or `bunx.exe` keeps its files
   locked on Windows.
2. Run `ocx update` again from a terminal.
3. If it fails the same way, run `ocx status` and let any in-progress recovery finish. If the
   updater restarted the proxy, stop it through its owner (`ocx stop`, its service, or the desktop
   app) and confirm it has stopped. Reinstall with the same package manager that owns the install;
   for an npm install managed by the OpenCodex service:

   ```bash
   ocx stop
   npm install -g --allow-scripts=bun @bitkyc08/opencodex@latest
   ocx service restart
   ```

   Restart through the owning service or desktop app after installation completes; use `ocx start`
   when unmanaged. Replace `latest` with `preview` if you follow the preview channel.

## Leftover folders

They sit next to the package in npm's global folder, usually
`%APPDATA%\npm\node_modules\@bitkyc08\` on Windows.

| Folder | Created by | What to do |
|---|---|---|
| `.opencodex-<random>` | npm itself, while replacing the package during a direct `npm install -g` | Delete it once no OpenCodex process runs from it |
| `.ocx-staging-<timestamp>` | the OpenCodex updater's staging install | A marked stage older than half an hour is reported but left in place; delete it by hand once no OpenCodex process runs from it. A stage without an `.ocx-update-owner.json` marker has an unverified origin — an interrupted update can leave one, but so can anything else that chose the prefix — so confirm it belongs to OpenCodex before deleting it |
| `.ocx-backup-<timestamp>` | the updater's copy of the previous version | Leave it; it is removed automatically after the new version starts healthy, and restored if it does not |

None of these folders blocks the next update by pathname: every attempt stages into a new folder.
Retained staging contents still consume disk space, though, and enough leftovers can make a later
staging attempt fail with `ENOSPC`. The updater leaves leftover staging folders in place during
later updates; it reports marked stages older than half an hour after checking their recorded
ownership marker. Delete a leftover only after confirming that no OpenCodex process runs from it.

If a folder will not delete, a process is still running from it. Signing out or restarting Windows
releases the lock.

## If the proxy answers 503 after a manual install

Installing over a running proxy makes it answer `503` with `package_tree_changed` until it
restarts. Releases after 2.64.0 can restart themselves after a few seconds once the package tree
and its Bun runtime are complete. An incomplete or failed Bun postinstall prevents that recovery.
`ocx restart` or `ocx service restart` can find a proxy in that state, but restarting still requires
a complete runtime and package tree. With 2.64.0 and earlier, the
proxy stays in that state, and `ocx restart` may report that no proxy is running while the old one
still holds the port; use `ocx service restart`, or end the process whose `pid` the `/healthz`
response shows and then run `ocx start`.

If the installer has exited or failed, inspect its error and run `ocx status`. Let any in-progress
recovery finish, stop any running proxy through its owner (`ocx stop`, its service, or the desktop
app), and confirm it has stopped. Reinstall with the same package manager, allowing Bun's
postinstall to complete, then start again through the owning service or desktop app (`ocx start`
when unmanaged).

## If the update stops at the npm cache check

`ENOTDIR` on `mkdir` means npm tried to create a folder where a path component was a file, or
a link whose target no longer exists. One confirmed cause
([#6288](https://github.com/lidge-jun/opencodex/issues/6288)) is a `%LOCALAPPDATA%\npm-cache`
junction that pointed to another drive after the target folder had been deleted or the drive had
been removed.

The updater checks npm's cache folder before it stops the proxy, and the npm staging install uses
the same folder that `npm config get cache` reports. If the cache folder cannot be used, the update
stops with `cache_root_dangling_link` or `cache_root_not_directory` and leaves the proxy running:

- `cache_root_dangling_link`: the cache folder is a link or junction whose target is missing.
  Recreate the target folder, or remove the link so npm can create a normal folder.
- `cache_root_not_directory`: the cache folder, or a folder above it, is a file or sits on a drive
  that is not available. Move the file aside, or point npm at another cache with
  `npm config set cache <folder>`.

Then run `ocx update` again. If `ENOTDIR` persists after the check passes, open an issue with the
full terminal output of `ocx update` and the output of `npm config get prefix` and
`npm config get cache`.

## Desktop app update stalls or fails on "Installing update…"

In the OpenCodex desktop app, **Install update** downloads the installer from GitHub
Releases before replacing the app and restarting. A failed download or installation with
a known version shows a manual-download hint and a link to that version's release page.

If `Installing update…` stalls or times out, GitHub release downloads may be slow or
blocked by your network. Use the release link in the error, or find the same version on
the [OpenCodex releases page](https://github.com/lidge-jun/opencodex/releases), and download
the installer for your operating system and architecture. Preview versions have their own
release pages; choose the version the app offered.

Before running the installer, stop the proxy through its owner and confirm it has stopped:

1. Quit the OpenCodex desktop app from its tray menu to stop an app-owned proxy.
2. If a service owns the proxy, stop it through the service's controls (`ocx stop` for an
   OpenCodex-managed service). For an unmanaged terminal proxy, stop it in that terminal.
3. On Windows, use this process listing to help identify any remaining runtime:

   ```powershell
   Get-Process -Name ocx, opencodex-desktop, bun, bunx -ErrorAction SilentlyContinue
   ```

   The listing does not establish which app owns a process. Identify the OpenCodex runtime
   and stop it through its owning app or service; a `bun` process may belong to another app.
   Wait for the owning app and proxy to exit before installing.

Run the downloaded installer, then reopen the desktop app or restart the owning service.
