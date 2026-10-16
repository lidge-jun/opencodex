# Coexistence with an existing npm installation

External review of the desktop shell against an existing npm install, recorded here as claims plus
what this tree actually says. Findings are labelled **confirmed** when read directly out of the
source at `a499746395`, and **unverified** when the reasoning is sound but the behaviour was not
reproduced.

## What happens today when an npm user launches the app

| existing state | what the code does | consequence |
| --- | --- | --- |
| npm server already running | joins it, does not start the bundled one | the app ships a newer engine and dashboard than the one in use |
| npm server stopped, custom port | no runtime-port record, so 10100 is chosen | starts on a port the user did not configure |
| npm service autostarts at login | the app also enables its own Start at Login | two owners race at next login |
| terminal-only `OPENCODEX_HOME` | the app's environment lacks it, so a different home is read | looks like accounts disappeared |
| app started the server, then Quit | `kill()` on the child | in-flight requests and config restoration are cut off |
| server fails to start | the window and tray are created after `ensure_proxy` returns | nothing on screen explains the failure |

## Confirmed in this tree

- **Version split is invisible.** `sidecar.rs` accepts any successful `/healthz` and `lib.rs` then
  navigates to that server's `/#/usage`. Nothing compares the app's version, the engine's version
  or the dashboard's build. A user on 2.60.0 who installs a newer app keeps using 2.60.0 and has no
  way to see it.
- **Port and home are guessed separately from core.** `discovery.rs` reads only
  `runtime-port.json` and falls back to `DEFAULT_PORT = 10100`; `sidecar.rs` then passes
  `--port 10100` explicitly rather than letting the CLI resolve `config.port`. `config_directory`
  expands `~` itself instead of using the CLI's resolution.
- **Quit bypasses graceful stop.** `AppState::shutdown_child` calls `CommandChild.kill()`; there is
  no `RunEvent::ExitRequested` handler, so Cmd+Q reaches it directly.
- **Ownership is a startup boolean.** `spawned_by_us` is set from whether a child was spawned, not
  from whether the process now answering the port is that child. A slow-starting npm service that
  wins the port after the spawn attempt would be recorded as app-owned.
- **Start at Login is enabled unconditionally on first run.** `first_run.rs` does not look for an
  existing service, and it is not gated to macOS.
- **The updater does not coordinate a stop.** `updater.rs` installs and restarts with no drain of
  an owned server first.

## Confirmed, and already solved one layer down

`src/server/proxy-liveness.ts` resolves liveness from the pid record and the runtime-port record,
requires the `/healthz` body to identify as opencodex, and returns the reported `version` and
`role`. It also carries deliberately tuned probe budgets — `START_OWNERSHIP_LIVENESS` exists
because a single unanswered 750ms probe was enough to start a duplicate proxy on Windows. The Rust
shell reimplemented the weaker form of this question and inherited the bug the comment describes.

`src/service/state.ts` `stableLauncherEntry()` prefers the **recorded** `launcherPath` over a
fresh `PATH` walk, for a documented reason. The consequence for this unit is direct: a repair
driven from the app keeps pointing the service at the npm launcher.

## Unverified

- Whether the local management client can be diverted by system proxy settings. `ProxyClient` sets
  a timeout and a user agent and does not disable reqwest's system-proxy default. No token exposure
  was observed; the concern is that a management token rides a client that has not been forced
  direct.
- Whether the 20 × 150ms start wait plus per-request timeouts produces a user-visible hang. The
  arithmetic is real — `proxy.rs` sets a 4s timeout and `sidecar.rs` loops 20 times — but no
  measurement was taken.
- Whether incremental local builds actually ship a stale engine. `prepare-sidecar.ts` reuses an
  existing `dist/standalone/<target>/ocx` without checking that it came from the current source,
  so a new app with an old engine is possible; it was not reproduced.

## Recommended ordering from the review

1. An identity-checked connection contract: pid, version, role and config home, custom port kept,
   no connection to a foreign listener.
2. A visible startup and recovery surface: the app opens even when the server does not.
3. Coordinated stop for quit, stop and update: drain only what the app owns, never an external one.
4. Bundle consistency: app, engine and dashboard from one source, or an explicit build refusal.
5. Service coexistence, takeover and removal: one owner after login, and uninstall never touches an
   existing npm install.

