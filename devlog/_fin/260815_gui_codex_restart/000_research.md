# 000 — Research: dashboard-driven Codex app-server restart

Unit: `260815_gui_codex_restart`
Class: C4 (new management endpoint + cross-platform process control + GUI surface)
Trigger: SSH remote workspaces showed a stale model picker for ten days while the
on-disk catalog was current. The manual recovery was a hand-run
`ocx sync --restart-codex` on every host.

## 1. The defect this unit addresses

Codex builds a static model manager from the catalog once at app-server startup and
never rereads the file (`src/codex/app-server-processes.ts:764-770`). An app-server
that booted before a catalog write keeps serving the old roster forever. Every check
a user can run reads the file; the picker renders memory.

Detection already exists and already fired. The observed hosts printed
`WARNING: N Codex app-server process(es) still running` on each sync. Nobody read it:
the warning goes to stderr, and the process that keeps an SSH workspace's app-server
alive is the Codex app, not a human at a terminal.

## 2. What exists today

### 2.1 Two unrelated restart systems

| System | Entry | What it restarts | Where |
|---|---|---|---|
| Proxy self-restart | `POST /api/system/restart`, `ocx restart` | the **ocx proxy process** | `src/server/management/system-routes.ts:110` -> `acceptSystemRestart` (`src/server/management/system-restart.ts:344`) |
| Codex app-server stop | `ocx sync --restart-codex` (CLI only) | **Codex app-server / code-mode-host** children | `src/cli/dispatch.ts:199` -> `afterCatalogWriteHandleAppServers` (`src/codex/app-server-processes.ts:731`) -> `restartCodexAppServers` (`:662`) |

The load-bearing finding: **no management endpoint reaches
`restartCodexAppServers`.** The dashboard can restart the proxy and cannot touch a
stale app-server. A GUI button therefore needs a new backend route; it cannot be a
relabelled call to `/api/system/restart`.

### 2.2 Staleness classifier (already shipped)

`collectCodexAppServerCatalogState` (`src/codex/app-server-processes.ts:581`) returns
`fresh | stale | not_running | unknown` by comparing each app-server start time
against the catalog mtime, with a 5s memo when every io field is defaulted. Its only
consumer today is `GET /api/subagent-models`
(`src/server/management/agent-settings-routes.ts:601`).

Two deliberate conservatisms to preserve:

- Enumeration failure yields `unknown`, never `not_running` (#857) — a failed
  enumeration must not read as "nothing running".
- The comparison is `<=`, because `ps lstart` is second-granularity. The observed
  sujihome case had a 9-second gap and would otherwise have been misread as fresh.

### 2.3 Termination semantics

`restartCodexAppServers` re-resolves each pid immediately before signaling and
requires the same pid+command-line identity, so a recycled pid is never killed
(`:676-682`). It sends `SIGTERM` only, shares one ~2s exit deadline across all
targets, and never escalates to `SIGKILL` (`:706-714`).

The name overpromises: it stops processes and returns
`{ requested, stopped, surviving, failed }`. It never spawns a replacement. Whoever
owns the app-server (the Codex app, an SSH bootstrap) re-launches it on next use.

### 2.4 Platform matrix (verified against source)

| | Enumerate | Start time | Terminate |
|---|---|---|---|
| macOS | `/bin/ps -u <uid> -o pid=,command=` (`:274-279`) | `ps -o pid=,lstart=` batch (`:494-500`) | `process.kill(pid, "SIGTERM")` |
| Linux | `/proc/<pid>/status` uid + `/proc/<pid>/cmdline` (`:244-268`); missing `/proc` throws `procfs_unavailable` | `/proc/<pid>/stat` field 22 + `/proc/stat` btime (`:426-438`) | `process.kill(pid, "SIGTERM")` |
| Windows | trusted System32 PowerShell `Get-CimInstance Win32_Process` + `GetOwner` owner filter (`:330-352`) | `CreationDate` via CIM (`:516-523`) | `process.kill(pid, "SIGTERM")` |

`defaultListSnapshots` (`:375`) routes `win32` and `darwin` explicitly and sends
**every other platform** down the procfs path, so Linux is genuinely supported
rather than incidentally tolerated.

**The Windows gap.** On Windows `process.kill(pid, "SIGTERM")` is not a graceful
signal — it is `TerminateProcess`. The repository already knows this and already has
the correct ladder for the proxy: `src/lib/process-control.ts:150-165` uses
`taskkill /PID <pid> /T /F` on Windows and `SIGTERM`-then-`SIGKILL` elsewhere. That
ladder is **not** applied to app-servers. Consequences:

- No process-tree termination, so an app-server's own children can be orphaned.
- A target that ignores the request is only reported as `surviving`, with prose
  telling the user to stop it by hand.

This matters more on Windows than anywhere else, because Windows has no Ctrl+Q quit
affordance for the Codex app: the user closes the window and the app-server keeps
running in the background holding its catalog snapshot.

### 2.5 Startup vs manual sync (#1046)

| | Classifier | Signals? | Silent when |
|---|---|---|---|
| `ocx sync` (no flag) | none — warns if any matching process is merely running (`:734-741`) | no | no write happened |
| `ocx sync --restart-codex` | none | yes, all matches | no write happened |
| startup / service | `collectCodexAppServerCatalogState` (`:790-800`) | **never** | `fresh`, `not_running`, `unknown` |

The startup path deliberately refuses to signal: killing an app-server on an
unattended boot would interrupt an in-flight turn, and "a human typing
`ocx sync --restart-codex` is consenting to that; a login is not" (`:772-780`).
That consent boundary is the design constraint for this unit — a dashboard click
**is** consent, which is exactly why the action belongs in the GUI.

### 2.6 GUI surfaces

- Sidebar foot: `gui/src/App.tsx:250` (`.sidebar-foot`) holds locale select, theme
  toggle, stop button (`:267`), then `SidebarGithubRow`.
- Mobile stop button: `gui/src/App.tsx:205`.
- Stop handler `handleStop` with `confirm()` + pending state: `gui/src/App.tsx:172`;
  transport `gui/src/stop-proxy.ts:41`.
- Circular satellite pattern `.sidebar-orb` (28x28, pill radius):
  `gui/src/styles.css:336`; row container `.sidebar-github-row` `:333`.
- Icons are inline SVG with no library: `gui/src/icons.tsx:1`; `IconRefresh` `:23`,
  `IconPower` `:35`.
- Existing restart UX to imitate (confirm -> draining -> reconnecting -> error):
  `gui/src/components/MemoryObservabilityCard.tsx:351`.
- Models page head (already `justify-content: space-between`):
  `gui/src/pages/Models.tsx:1716`, style `gui/src/styles.css:436`.
- i18n: `gui/src/i18n/en.ts` is the source of truth and defines `TKey` (`:2055`);
  the other seven locales are `Record<TKey, string>`, so a missing key fails the
  build rather than falling back silently.

## 3. Constraints carried into the phase docs

1. A new endpoint is required; do not overload `/api/system/restart`.
2. Never signal without an explicit user action. The endpoint is the consent
   boundary and must not be invoked by polling or on render.
3. Preserve the pid+identity re-resolution and the `unknown`-on-enumeration-failure
   conservatism; do not "simplify" either.
4. Do not quit or relaunch the Codex desktop app. No such code exists in this
   repository and this unit does not add it.
5. Stay off the Lab core path (`src/router.ts`, `src/server/lifecycle.ts`,
   `src/server/responses/core.ts`).
6. Locale parity is a build gate; all eight locales change together.

## 4. Work-phase map (dependency-ordered)

| Phase | Doc | Consumes |
|---|---|---|
| 1 | `010_phase1_backend_endpoint.md` | existing process-control primitives |
| 2 | `020_phase2_gui_sidebar.md` | phase 1's endpoint + response contract |
| 3 | `030_phase3_models_tab.md` | phase 2's client helper and i18n keys |
| 4 | `040_phase4_platform_hardening.md` | phases 1-3 landed and green |

Ordering is structural, not effort-based: the response shape must exist before a
client can render it, the client helper must exist before a second surface reuses
it, and platform termination behavior is hardened last because it changes the
meaning of a result the earlier phases already display.

