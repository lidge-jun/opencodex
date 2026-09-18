# Measured desktop-app topology on three platforms

Research document for `000_plan.md`. Measurements taken 2026-09-13 on live hosts.
No diffs here by LEXICO-SPLIT-01; the implementation designs are in `010`, `020`, `030`.

Every value below was read from a running installation. Nothing is inferred from
documentation or from the existing Windows implementation.

## 1. macOS

Two hosts were measured: the maintainer's laptop (`local`) and `macmini-cf`.

| | local | macmini-cf |
|---|---|---|
| Bundle | `/Applications/ChatGPT.app` | `/Applications/ChatGPT.app` |
| `CFBundleIdentifier` | `com.openai.codex` | `com.openai.codex` |
| `CFBundleName` | `ChatGPT` | `ChatGPT` |
| `CFBundleShortVersionString` | 26.908.40834 | 26.901.51231 |
| Root process | pid 15901, ppid 1 | pid 25712, ppid 1 |
| Root argv[0] | `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT` | same |
| bun | `~/.bun/bin/bun` 1.4.0 | `~/.bun/bin/bun` 1.3.14 |
| opencodex checkout | this worktree | `~/Developer/opencodex` |

The bundle **name** is `ChatGPT` but the bundle **identifier** is `com.openai.codex`.
Discovery must key on the identifier: the display name is shared with a different
OpenAI product and is the wrong thing to match.

`mdfind "kMDItemCFBundleIdentifier == 'com.openai.codex'"` resolves to the bundle on
both hosts, and `osascript -e 'id of app "ChatGPT"'` returns `com.openai.codex`.

### 1.1 Process shape

```
15901     1  /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
16733 15901  /Applications/ChatGPT.app/Contents/Resources/codex ... app-server ...
28300 16733  /Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host
16722 15901  .../bare-modifier-monitor --key DoubleShift
15910/15911/15913/16916 15901  GPU, network, storage, audio services + renderers
```

Two findings that the implementation must respect:

**Crashpad handlers are launchd children, not app children.** pids 72689 and 72691
were still alive under ppid 1 from an app instance that had already exited. A "root
process" rule of "parent is not in the tree" would classify a stale crashpad handler
as a restart target. Membership must therefore be decided by executable path inside
the bundle **and** liveness of the shell, and a surviving crashpad handler must not
block the relaunch.

**The app-server is inside the bundle.** `Contents/Resources/codex ... app-server` is
matched by `isCodexAppServerCommandLine`, so `--restart-codex` already signals it and
the app simply respawns it. This is the measured reason the flag appears to do
nothing (`000_plan.md` §3).

### 1.2 Quit and relaunch primitives

- `osascript -e 'quit app id "com.openai.codex"'` delivers `kAEQuitApplication`. This
  is the graceful path: the app runs its termination handlers and the helper tree
  goes with the root. Delivery is synchronous, **termination is not** — the caller
  must poll for the root pid to disappear.
- `kill -TERM <root>` bypasses `applicationShouldTerminate:`. Usable as the fallback
  when the Apple event cannot be delivered, not as the first choice.
- `open -b com.openai.codex` starts the app through LaunchServices and **works when
  the app is not running**. That is the relaunch primitive.
- `open -n` requests a second instance. An Electron app holding
  `requestSingleInstanceLock()` hands the request to the existing instance instead,
  so `-n` does not reliably produce a second instance — and we do not want one.
  Relaunch uses plain `open -b`.

**Precondition, measured rather than assumed:** `open -b` launches into the invoking
user's **GUI session**. Issued over ssh to a Mac where that user has no logged-in
window session, it relaunches into nothing. Both macOS hosts here have an active
session, so the wp4 proof holds — but a headless macOS host would stop the app and
not visibly bring it back, and the operator-facing text must not promise otherwise.

An unknown bundle id makes `open` exit non-zero with
`LSCopyApplicationURLsForBundleIdentifier() failed`, which is a usable fail-closed
signal rather than a silent no-op.

### 1.3 The local host cannot prove its own restart

The shell running `ocx` on the local host is a descendant of the app:

```
31497 -> 16733 (bundled codex app-server) -> 15901 (ChatGPT) -> 1 (launchd)
```

Quitting the app kills the session issuing the command. This is not a corner case to
document away — it is the maintainer's normal working shape, and it is what wp5
exists for. `macmini-cf` is the macOS host used for the destructive proof, because
the command there is issued over ssh and is not inside the app tree.

## 2. Linux

Host `lidge`, Ubuntu 24.04.4 LTS, x86_64.

- Package: `chatgpt` 26.903.71938 amd64 ("ChatGPT by OpenAI"), installed via dpkg.
- Binary root: `/usr/lib/chatgpt/ChatGPT`.
- Launcher: `/usr/bin/chatgpt`.
- Desktop entry: `/usr/share/applications/chatgpt.desktop`, `Exec=chatgpt %U`,
  registering `x-scheme-handler/codex` among its MIME types.
- User data directory: `~/.config/Codex` — note the directory is `Codex` even though
  the package and binary are `chatgpt`.
- Codex CLI also present at `/usr/local/bin/codex` (codex-cli 0.154.0); the desktop
  app and the CLI are separate installs on this host.

### 2.1 Process shape

```
3284901  /usr/lib/chatgpt/ChatGPT
3284907  /usr/lib/chatgpt/browser_crashpad_handler --database=~/.config/Codex/Crash Reports ...
3284913  /usr/lib/chatgpt/ChatGPT --type=zygote --user-data-dir=/home/lidgeai/.config/Codex ...
3284951  /usr/lib/chatgpt/ChatGPT --type=gpu-process ...
3284953  /usr/lib/chatgpt/ChatGPT --type=utility --utility-sub-type=network.mojom.NetworkService ...
```

Every process in the tree runs an executable under `/usr/lib/chatgpt/`, which is the
install root and therefore the membership test. Electron child processes are
distinguished only by `--type=`; the root is the one without it.

`~/.codex/app-server-control/` on this host contains `app-server-control.sock` and
`desktop-ssh-websocket-v0.sock`, which is how the desktop app is reached over SSH.

### 2.2 Relaunch from a non-graphical session

This is the part with no Windows or macOS analogue. `open -b` and
`Start-Process shell:AppsFolder\...` both hand the launch to a session-aware
service. Linux has no such indirection: a process started from an ssh session has
no `DISPLAY`, no `WAYLAND_DISPLAY`, no `DBUS_SESSION_BUS_ADDRESS` and no
`XDG_RUNTIME_DIR`, and the relaunched app would fail to reach the user's compositor.

The environment must therefore be **inherited from the process being replaced**:
read `/proc/<root>/environ` before terminating it, carry forward only the graphical
session variables, and start the launcher detached with `setsid`. Nothing else in
that environment is copied — it is a process environment belonging to another
session and may contain credentials.

## 3. Windows

Host `mini`, Windows (measured through MSYS/MINGW64).

- Package: `OpenAI.Codex_26.903.9818.0_x64__2p2nqsd0c76g0` (MSIX).
- Processes: `ChatGPT.exe` (pids 13860, 16944, 19696 at measurement time).
- `ocx` present at `/c/nvm4w/nodejs/ocx`, reporting opencodex 2.52.0.

This matches what `src/codex/desktop-app-restart.ts` already implements: runtime
package discovery through `Get-AppxPackage -Name OpenAI.Codex` with an
`OpenAI.CodexBeta` fallback, current-user scoping through `GetOwner`, graceful
`CloseMainWindow()`, forced `taskkill /PID <pid> /T /F`, and relaunch through
`Start-Process 'shell:AppsFolder\<PackageFamilyName>!App'`.

The Windows behaviour is the reference the other two platforms are being brought up
to, and it is not being changed except where the shared ladder replaces duplicated
logic.

## 4. What generalises and what does not

| Step | macOS | Linux | Windows |
|---|---|---|---|
| Identity | bundle id `com.openai.codex` | install root `/usr/lib/chatgpt` | Appx package family |
| Discovery | LaunchServices / known bundle path | launcher + dpkg install root | `Get-AppxPackage` |
| Membership | exe under bundle, same uid | exe under install root, same uid | exe under `InstallLocation`, `GetOwner` = me |
| Graceful stop | `osascript` quit Apple event | `SIGTERM` to root | `CloseMainWindow()` |
| Forced stop | `SIGKILL` | `SIGKILL` | `taskkill /T /F` |
| Relaunch | `open -b <bundleId>` | `setsid <launcher>` + inherited session env | `Start-Process shell:AppsFolder\<aumid>` |
| PID-reuse guard | process start time | `/proc/<pid>/stat` start time | `CreationDate` |

The **ladder** — discover, enumerate, find roots, check self-ancestry, graceful,
wait, re-verify identity, force, wait, refuse-or-relaunch — is identical on all
three. Only the seven rows above differ, which is what makes a single shared
orchestrator with three small adapters the right shape rather than three parallel
implementations.
