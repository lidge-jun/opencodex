# 002 — Why `ocx start` serves where `ocx service` cannot

The user's decisive observation: on the same machine, at the same moment,
`ocx service` leaves 10100 silent and `ocx start` serves it. Any root cause that
does not explain *that* asymmetry is the wrong root cause. There are exactly
three structural differences between the two paths.

## A1 — who owns the socket, and who can lie about it

> **R2 correction.** R1 filled this section with a runtime-resolution story
> (frozen path vs. self-healing `resolveBun()`). That story is real but not
> load-bearing: `bundledBunPath()` (`src/lib/bun-runtime.ts:35-46`) validates
> before anything is baked, so the placeholder never reaches the plist. The actual
> asymmetry is one layer up. See `003_audit_round1_correction.md`.

| | `ocx start` | launchd service |
|---|---|---|
| Who binds the socket | the calling process itself | a launchd-spawned child |
| Success signal | the socket is bound, or the command failed in front of you | `launchctl load -w` exit status |
| Can that signal lie | no — there is nothing between intent and bind | **yes** — `load` prints `Load failed` and exits **0** |
| Liveness signal | the process is your foreground job | `launchctl list \| grep` — membership, not service |
| Stale definition | impossible; argv is this invocation | a job bootstrapped from a *previous* plist stays listed |

Measured (macOS 27.0):

```
$ launchctl load -w ~/Library/LaunchAgents/com.opencodex.proxy.plist
Load failed: 5: Input/output error
$ echo $?
0
```

`startLaunchd()` (`src/service.ts:1294`) is `sh("launchctl load -w ...")`, and
`sh()` (`:355`) is `execSync`, which throws only on non-zero. So the service path
has a success signal that can be false, and a liveness signal that answers a
different question — while `ocx start` has neither, because it has no supervisor
to ask.

`buildPlist()` (`src/service.ts:270`) emits

```
/bin/sh -lc "if [ -f '<token>' ]; then ...; fi; exec '<bun>' '<cli>' start --port 10100"
```

which is fine — the command is correct. The failure is that launchd may still be
running the *previous* one, and nothing in the codebase compares the two. WP1's
`launchdJobMatchesPlist()` exists for exactly that comparison.

## A2 — port policy: hard-pin-or-die vs. hop

`chooseListenPort()` (`src/cli/index.ts:123`) branches on `hardPin`:

```
const hardPin = requestedPort !== undefined && requestedPort > 0;
...
preferRetryMs: hardPin ? 5_000 : 750,
allowEphemeralFallback: !hardPin,
```

The service always passes `--port 10100` (`buildServiceShellCommand`,
`src/service.ts:331`), so it is always hard-pinned: 60s reclaim
(2.9.0 raised it from 30s), then 5s prefer-retry, then
`PortUnavailableError` → `process.exit(1)`. A bare `ocx start` has
`requestedPort === undefined`, so it may hop to an ephemeral port and report
healthy on a *different* port.

Consequence for diagnosis: "`ocx start` works" can mean either "10100 is genuinely
free and serving" or "start hopped elsewhere and the user's browser happened to
follow the injected base_url". `cat ~/.opencodex/runtime-port.json` is the
discriminator. This is a real second-order asymmetry and belongs in the status
surface (WP4), but it cannot by itself produce a registered-and-silent service:
a hard-pin failure exits with a message, it does not crash-loop invisibly.

## A3 — output visibility

`ocx start` writes to the terminal. The service writes to
`~/.opencodex/service.log` (`StandardOutPath`/`StandardErrorPath`,
`src/service.ts:300`), and the GUI update worker runs with stdio ignored
(`src/update/job.ts:408`). So every diagnostic that would have explained this in
one line went somewhere the user was never told to look.

`serviceDiagnosticsSummary()` (`src/service.ts:1560`) does append
`logs: <path>` to status output — but only when the user runs
`ocx service status`, and the summary it appends is derived from the same
`existsSync()`-blind diagnostic described in `001`.

## Fix implications

| Asymmetry | Phase | Fix shape |
|---|---|---|
| A1 (false success) | WP1 | Treat `Load failed` on stderr as failure despite exit 0; verify with `launchctl print` |
| A1 (registration ≠ service) | WP2 | Confirm a listener on the baked port before printing success |
| A1 (worker) | WP3 | Update worker must confirm serving, not `viable`, before returning |
| A2 (port policy) | WP4 | Status must state the actual listen port and distinguish "hopped" from "pinned and dead" |
| A3 (visibility) | WP4 | Status must name the log path and the repair, including `launchctl bootout` when the plist is stale |

Freezing the paths is a deliberate choice — a later `nvm use` must not silently
repoint a background daemon — and it is not the defect. The defect is that the
two signals launchd hands back (`load` exit status, `list` membership) are both
read as stronger claims than they are, at every layer that consumes them.
