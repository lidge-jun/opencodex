# 002 — The startup path writes the catalog and says nothing

opencodex already knows that a long-lived app-server goes stale after a catalog
write. #476 built the detection, #857 built the staleness classifier. Both are
wired into the **CLI sync** path and neither is wired into the **startup** path.

## The two call sites

| | `ocx sync` / `ocx sync-cache` | proxy startup (`ocx start`, service) |
|---|---|---|
| Rewrites the catalog | yes (`syncModelsToCodex`) | yes (`syncModelsToCodex`, `src/cli/index.ts:319`) |
| Invalidates `models_cache.json` | yes | yes (`src/server/index.ts:313`) |
| Lists running app-servers | yes | **no** |
| Warns the user | yes — `formatStaleCodexAppServerWarning` | **no** |
| Can terminate them | yes — `--restart-codex` | **no** |

The handler is `afterCatalogWriteHandleAppServers()`
(`src/codex/app-server-processes.ts:726`). Its only two call sites are
`src/cli/index.ts:840` (`sync`) and `:855` (`sync-cache`). Nothing in
`src/server/` references it.

The guard in the CLI path is explicitly conditional on a write having happened:

```ts
// src/cli/index.ts, case "sync"
if (synced.catalogWritten || synced.cacheSynced) {
  const { afterCatalogWriteHandleAppServers } = await import("../codex/app-server-processes");
  afterCatalogWriteHandleAppServers({ restart: restartCodex, log: console });
}
```

The startup path performs the same two writes and skips the block entirely. So
`ocx service repair` — the command a user runs precisely *because* something
looked wrong — rewrites the catalog, leaves a stale app-server holding the old
list, and prints a success line.

## The signal already exists

`collectCodexAppServerCatalogState()` (`src/codex/app-server-processes.ts`)
computes exactly the comparison `001` made by hand:

> - `not_running`: no app-server process → nothing can disagree.
> - `unknown`: catalog unreadable, or any server's start time is unreadable.
> - `stale`: at least one server predates the catalog mtime.

Run against the broken host's numbers (app-server 15:37:42, catalog 15:42:09) it
returns `stale`. The information needed to warn the user was available and was
never consulted, because the startup path does not call it.

## Why "warn", not "restart", on this path

The CLI path can offer `--restart-codex` because a human typed the command and
accepted the documented consequence ("active turns may be interrupted").

A proxy start is different. It happens on login, on `service repair`, and on
update — none of which are moments where silently SIGTERM-ing the editor's
app-server is defensible. On a remote host it would kill the app-server serving
somebody's in-flight SSH turn.

So the proportionate fix is: on startup, after a catalog or cache write, consult
`collectCodexAppServerCatalogState()` and emit the existing warning when the
result is `stale`. Leave termination opt-in. The user then learns the one fact
currently missing — that the picker is stale and why — instead of comparing JSON
files by hand.

A second, smaller surface worth considering: the same `stale` state could be
reported by `ocx status`, which today prints `Catalog clamp: inactive` and
nothing about app-server staleness. On the broken host `ocx status` was fully
green while the picker was wrong.

## Scope note

This is deliberately *not* filed as an SSH bug. SSH is where it surfaces (`001`,
"why an SSH workspace is the exposed surface"), because the remote app-server is
detached and outlives everything. The defect itself is surface-independent: any
long-lived app-server that predates a proxy restart shows a stale picker.

Related: #476 (detection built), #857 (staleness classifier), #851 (SSH
workspaces, closed for template reasons rather than resolved), #241 (Desktop
picker omits routed models even with a correct catalog — a different, upstream
failure that should not be conflated with this one).

Filed as #1046.
