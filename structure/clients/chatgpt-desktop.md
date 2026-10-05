# ChatGPT Desktop integrations

The experimental macOS integration is owned by `src/chatgpt/` and exposed through
`src/cli/chatgpt-command.ts`. It is default off; an explicit launch requires
`chatgptDesktop.appServerShim === true` or `chatgptDesktop.unblockSend === true`, and only the
shim launcher requires `appServerShim`. The strict config leaf accepts optional boolean `appServerShim` and `unblockSend`
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

When the platform is not macOS, the runtime is missing, or the filter self-test fails,
the launcher runs the original binary with untouched stdout. A missing bundled binary
exits 127 instead (see below). A filter that passes the self-test and then exits
mid-session closes the server's stdout pipe; the filter's passthrough mode limits this
to an exit/crash case.

The pure gate rewrite changes known plain-quota fields only in eligible JSON-RPC
rate-limit notifications and top-level rate-limit results. Workspace, credit,
unknown reached-type and spend-control restrictions preserve closed gate flags.
Both the rate-limit flags and `ordinaryUsageAllowed` open only where the subtree shows
plain-quota evidence: a cleared plain reached type or a usage window at 100% (`usedPercent` in the
RPC, `used_percent` in the web usage snapshot; every gate field is read in both spellings).
Usage percentages, resets and window durations remain accurate. Unrelated messages
and malformed lines remain byte-identical; changed lines are reserialized.
A per-line rewrite exception preserves that line. A failure in the framing/rewrite
machinery preserves buffered bytes and switches the rest of the stream to raw
passthrough. Output-write failures propagate; they are not rewrite failures.
A partial line is held as a list of chunks and joined once at its newline, so a long
line split across many pipe reads costs linear copying.
A line longer than `MAX_FILTERED_LINE_BYTES` (8 MiB) is never joined or parsed, whether
it arrives across many chunks or whole in one: its bytes stream through raw, and
filtering resumes after its newline.

The app is discovered and confirmed by bundle identifier through
`darwinDesktopAppAdapter.discover` (`src/codex/desktop-app/darwin.ts`). Launch derives
the bundled app-server binary from that root (`resolveChatgptCodexBinary`) and refuses
when none exists or when `untrustedChatgptBundleReason`
(`src/chatgpt/app-server-shim/bundle-trust.ts`) reports the bundle or binary as owned
by another user, group/other-writable, unsigned, or signed by a team other than
OpenAI's. It writes the mode-0755 executable through an exclusive temp file and a
rename (never through a symbolic link), quits the bundle by id, waits for this user's
instance to exit, then opens the same bundle path with the launcher in CODEX_CLI_PATH.
The launcher itself exits 127 with a stderr hint when the recorded binary is gone.
Restore uses the same trust policy for the bundle and its main app executable before
quit or open. Both relaunch paths check ancestor ownership and POSIX replacement permissions
through the filesystem root. Ancestors must be owned by this user or root; group/other write
is accepted only for trusted sticky ancestors or root-owned, non-world-writable containers
whose group matches the local directory service's admin group. An unreadable admin-group lookup
does not grant that exception. These checks do not attest ACL or mount-policy restrictions.
Restore does not require the experimental flag or a bundled
app-server binary. It relaunches without that override and removes the launcher only after open succeeds; when no
`com.openai.codex` bundle is found it removes the launcher, relaunches nothing and
exits 1. Status reports
the experimental flag, launcher presence, and the verified bundle process's override
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
Shutdown warns when the app still carries the resolver rule for the closed port, or opencodex's PAC
in PAC-fallback mode.
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

`src/chatgpt/desktop-unblock/launch-watcher.ts` owns resolver/system-proxy and PAC launch
arguments and the optional launchd script. The watcher has no shim mode. Its launchd agent wakes on the app's `SingletonLock` and on the
`chatgpt-unblock.ready` marker that `startChatgptUnblock` rewrites once the listener is up, so an
app that opened before opencodex is still routed. Each run checks listener identity, leaves native
launches alone while the intercept is down, and serializes corrective restarts; an explicit launch
that meets another run's lock fails with a message instead of reporting success. In watch mode it
restarts only an app no more than five minutes old (`ps -o etime=`); a missing or unparseable age
counts as fresh, and explicit launch is not age-limited. A failed `open` exits non-zero rather
than printing success.
Explicit CLI launch can supply the existing shim's launcher environment along
with intercept arguments. A loaded watcher must be uninstalled before CLI
restore. The CLI preserves shim-only launch without a running proxy and reports
intercept port, trust, listener identity, watcher freshness and app switches.

PAC fallback (`chatgptDesktop.pacFallback`, implying `unblockSend`) replaces the resolver rule so
the app keeps a route while opencodex is down. `src/chatgpt/desktop-unblock/entry-proxy.ts` binds a
CONNECT entry on the listener port + 1 that splices `chatgpt.com:443` onto the TLS listener;
`pac.ts` reads the scutil proxy chain and any system PAC; `runtime.ts` rewrites
`chatgpt-unblock.pac` at every start, before the readiness marker, embedding the system PAC only
while the base64 `data:` switch stays within 512 KiB (`system-pac-unreadable`/`-too-large` fall
back to the proxy chain, then DIRECT, with a startup warning). An entry bind or PAC write failure
releases both listeners. The script launches with the inline PAC switch alone, requires the entry
(curl exit 0 or 56) as well as listener identity, and `native` mode undoes any PAC switch, inline
or the older `file://` form.

Intercept regression files use the existing `tests/clients/` domain alongside
the shim tests; shared handshake coverage is `tests/lib/socks5-handshake.test.ts`.
Both explicit layout maps register every added test basename. No duplicate app-server shim is part
of this integration; the PAC generator and entry proxy run only with `pacFallback`.
