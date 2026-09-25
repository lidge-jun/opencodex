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
3. If it fails the same way, stop the proxy first and install by hand. Stopping first matters:
   installing over a running proxy makes it refuse requests until it restarts.

   ```bash
   ocx stop
   npm install -g --allow-scripts=bun @bitkyc08/opencodex@latest
   ocx service restart
   ```

   Use `ocx start` in place of `ocx service restart` when no background service is installed.
   Replace `latest` with `preview` if you follow the preview channel.

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
restarts. Releases after 2.64.0 restart themselves after a few seconds, and `ocx restart` or
`ocx service restart` can find and restart a proxy in that state. With 2.64.0 and earlier, the
proxy stays in that state, and `ocx restart` may report that no proxy is running while the old one
still holds the port; use `ocx service restart`, or end the process whose `pid` the `/healthz`
response shows and then run `ocx start`.

## What is not known yet

The report's `ENOTDIR` on `mkdir` means npm tried to create a folder where a path component was a
file. The job log withholds the path, so which component that was is not known, and the leftover
folders above have not been shown to cause it. If it keeps happening, open an issue with the full
terminal output of `ocx update` and the output of `npm config get prefix` and
`npm config get cache` (for example, a cache on a different drive).
