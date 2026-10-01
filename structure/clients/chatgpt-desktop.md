# ChatGPT Desktop integrations

The experimental macOS integration is owned by `src/chatgpt/` and exposed through
`src/cli/chatgpt-command.ts`. It is default off and requires
`chatgptDesktop.appServerShim === true` for an explicit launch. The strict config leaf accepts optional boolean `appServerShim` and `unblockSend`
flags and an optional integer `port` in 1..65535; malformed reads disable the leaf, while live
writes reject malformed values and unknown fields.

The launcher under the config directory re-enters the current CLI using
`process.execPath` and `selfLaunchArgv()`. Its hidden internal filter command stays
out of the public command registry and generated skill surface. Source installs
include the CLI entry argument; compiled builds use only the executable and
internal command arguments.

The launcher checks macOS, executable presence and a successful filter self-test,
then replaces itself with the bundled app-server using shell exec. Only stdout
passes through the filter. Stdin, stderr, process identity and the real server's
exit status retain the direct app/server relationship.

A failed precondition or a failed self-test runs the original binary with untouched stdout.
A filter that passes the self-test and then dies mid-session closes the pipe.
Expected (not yet validated against the bundled app-server): the server gets SIGPIPE or a write error and Desktop respawns it through the same launcher.
The filter's passthrough mode limits this to an exit/crash case.

The pure gate rewrite changes known plain-quota fields only in eligible JSON-RPC
rate-limit notifications and top-level rate-limit results. Workspace, credit,
unknown reached-type and spend-control restrictions preserve closed gate flags.
Usage percentages, resets and window durations remain accurate. Unrelated messages
and malformed lines remain byte-identical; changed lines are reserialized.
A per-line rewrite exception preserves that line. A failure in the framing/rewrite
machinery preserves buffered bytes and switches the rest of the stream to raw
passthrough. Output-write failures propagate; they are not rewrite failures.

Launch writes a mode-0755 executable, waits for the old ChatGPT instance to quit,
then invokes open with the launcher in CODEX_CLI_PATH. Restore relaunches without
that override and removes the launcher only after open succeeds. Status reports
the experimental flag, launcher presence, and the named bundle process's override
without printing its environment. Other platforms reject the public operations.

The launcher and its executable paths are local code-execution inputs. The shim alone
installs no network listener, CA or background watcher and starts no proxy timer.
Explicit launches are its only activation point.

Tests cover rewriting, byte framing, passthrough degradation, source/compiled
launcher text, stub launcher execution, hidden preflight, and strict config writes
in tests/clients/desktop-*.test.ts. Pipe-crash behavior is mock evidence only;
no bundled-app respawn guarantee is asserted.

## Optional local-CA send-unblock intercept

`src/chatgpt/desktop-unblock/runtime.ts` enables the macOS listener only for
`chatgptDesktop.unblockSend === true` outside the client runtime role. The
independent `appServerShim` flag does not enable it. The TLS listener binds
127.0.0.1 on the explicit desktop port or public port + 200; an overflowing
port is rejected before creating a CA. It reuses the Claude local authority,
issues a leaf for chatgpt.com and never installs OS trust. The operator manually
adds that authority to the login keychain; this permits TLS termination of the
account's credentials and message traffic. Restore leaves the shared CA and
keychain trust in place.

`src/server/index/chatgpt-unblock-lifecycle.ts` owns the pending startup promise
and awaited stop. `src/server/index/optional-listeners.ts` starts it without
suspending startServer; startup failures warn and keep other services available.
Shutdown warns when the app still carries the resolver rule for the closed port.
The three core entry points do not reach the new optional modules. The activation
window rationale in `tests/lab/core-lab-boundary.test.ts` records the synchronous
composition-root boundary.

`src/chatgpt/desktop-unblock/listener.ts` forwards HTTP to the fixed chatgpt.com
upstream without following redirects. Only the conversation and usage surfaces
selected by `rewrite.ts` are rewritten. Conversation send blocks with known quota
reasons and exhausted send progress entries are removed; unknown non-quota blocks
remain. Usage gate rewriting imports the existing app-server shim gate owner
instead of maintaining a duplicate. Display data remains unchanged. JSON bodies
above the bounded rewrite ceiling stream through. SSE lines preserve untouched
framing. A local identity endpoint reports preserved block names/reasons and
timestamps; request bodies and credentials are not logged.

`src/chatgpt/desktop-unblock/ws-relay.ts`, `ws-frame.ts` and `ws-upstream.ts`
relay upgrades and voice/dictation messages without rewriting. Upstream TLS
verification remains enabled; direct, HTTP(S) CONNECT and SOCKS5 routes follow
opencodex's outbound proxy selection. The shared method/auth/CONNECT framing
owner is `src/lib/socks5-handshake.ts`, also used by `src/lib/socks5-fetch.ts`.
Each transport still owns its socket, timeout, buffering and post-CONNECT work.

`src/chatgpt/desktop-unblock/launch-watcher.ts` owns resolver/system-proxy launch
arguments and the optional launchd script. The watcher has no shim mode or PAC
fallback. Its SingletonLock event checks listener identity, leaves native
launches alone while the intercept is down, and serializes corrective restarts.
Explicit CLI launch can supply the existing shim's launcher environment along
with intercept arguments. A loaded watcher must be uninstalled before CLI
restore. The CLI preserves shim-only launch without a running proxy and reports
intercept port, trust, listener identity, watcher freshness and app switches.

Intercept regression files use the existing `tests/clients/` domain alongside
the shim tests; shared handshake coverage is `tests/lib/socks5-handshake.test.ts`.
Both explicit layout maps register every added test basename. No PAC generator,
entry proxy, or duplicate app-server shim is part of this integration.
