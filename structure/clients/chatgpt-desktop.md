# ChatGPT Desktop integrations

The experimental macOS integration is owned by `src/chatgpt/` and exposed through
`src/cli/chatgpt-command.ts`. It is default off; an explicit launch requires
`chatgptDesktop.appServerShim === true` or `chatgptDesktop.unblockSend === true`, and only the
shim launcher requires `appServerShim`. The strict config leaf accepts optional boolean `appServerShim`, `unblockSend` and `pacFallback`
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
without printing its environment. Discovery exceptions and failed process inspection
are unknown rather than evidence of an absent app. Launch preflights process inspection
before writing the launcher; both operations refuse to open when exit cannot be confirmed.
Restore keeps the launcher on those failures. A later probe may fail after launch has
atomically updated it; this is not a transaction spanning the launcher and app restart.
Other platforms reject the public operations.

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
`src/chatgpt/desktop-unblock/ca-trust.ts` reports conservative user-domain SSL trust
configuration for the current, valid self-signed CA and its exact login-keychain fingerprint.
Explicit deny, scoped/non-SSL settings and ambiguous exports do not establish trust. This
status does not attest the running app's effective leaf acceptance or native transport.

`src/server/index/chatgpt-unblock-lifecycle.ts` owns the pending startup promise
and awaited stop. Each lifecycle is single-shot: the first start owns the promise and configuration,
subsequent starts do nothing, and all stops share one shutdown, including a stop during startup.
Stopping before startup permanently closes the instance. `src/server/index/optional-listeners.ts` starts it without
suspending startServer; startup failures warn and keep other services available.
Shutdown warns when the app still carries the resolver rule for the closed port, or opencodex's PAC
in PAC-fallback mode.
The listener rejects identity, HTTP and WebSocket admission until startup has finished,
including PAC publication, and rejects new requests before shutdown begins. Entry shutdown
terminates owned outgoing sockets, including connections that complete after stop.
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
framing; lines over 8 Mi UTF-16 code units stream unchanged without further buffering or JSON
rewriting until their newline, after which normal rewriting resumes. A local identity endpoint reports preserved block names/reasons and
timestamps; request bodies and credentials are not logged.

`src/chatgpt/desktop-unblock/ws-relay.ts`, `ws-frame.ts` and `ws-upstream.ts`
relay upgrades and voice/dictation messages without rewriting. Upstream TLS
verification remains enabled. Both HTTP and WebSocket upstreams use the same runtime-owned
system PAC snapshot or captured static system proxy chain. Only when neither is configured do
routes retain opencodex's existing outbound proxy selection. `pac-policy.ts` validates the whole
route result before dialing: only explicit `DIRECT`, `PROXY`, `HTTPS` and `SOCKS5` are supported;
empty, malformed, unsupported or oversized results never fall back to environment proxies or DIRECT.
`upstream-fetch.ts` uses the exact TLS socket selected by `ws-upstream.ts`, with one request per
socket and streaming/backpressure. Ordered failover is allowed only before TCP connection succeeds.
CONNECT/SOCKS rejection, TLS/hostname failure or an HTTP/WebSocket error never retries a route or
replays a POST. Both proxy and origin certificates remain verified. Runtime stop aborts active
policy HTTP uploads/responses and late connections as well as WebSocket relays. The shared method/auth/CONNECT framing
owner is `src/lib/socks5-handshake.ts`, also used by `src/lib/socks5-fetch.ts`.
Each transport still owns its socket, timeout, buffering and post-CONNECT work.
HTTP CONNECT sends Basic proxy authorization when either URL credential is present; invalid percent
encoding fails before CONNECT is written and closes the proxy socket. SOCKS username-only credentials
retain the shared empty-password compatibility behavior.

`src/chatgpt/desktop-unblock/launch-watcher.ts` owns resolver/system-proxy and PAC launch
arguments and the optional launchd script. The watcher has no shim mode. Its launchd agent wakes on the app's `SingletonLock` and on the
`chatgpt-unblock.ready` marker that `startChatgptUnblock` rewrites once the listener is up, so an
app that opened before opencodex is still routed. Plist freshness compares both watched paths against
the installed generation; a legacy lock-only plist is stale. Installation records the discovered absolute
bundle path. Before quit/open, `src/chatgpt/desktop-unblock/bundle-preflight.ts` rechecks that path using
the shared ownership, ancestor and strict OpenAI-signature policy plus the `com.openai.codex` identifier.
The generated script re-enters the current source/compiled CLI through a hidden preflight command;
a missing runtime or failed validation leaves the app untouched. Process matching, AppleScript quit,
and open all use the recorded bundle path, including paths containing spaces or quotes.
Each run authenticates the listener against the published local CA and `chatgpt.com` hostname before
checking its service identity; missing/invalid CA material fails closed without generating or trusting a CA.
The direct probe pins loopback and bypasses environment proxies. Each run leaves native
launches alone while the intercept is down, and serializes corrective restarts; an explicit launch
that meets another run's lock fails with a message instead of reporting success. In watch mode it
restarts only an app no more than five minutes old (`ps -o etime=`); a missing or unparseable age
counts as fresh, and explicit launch is not age-limited. A failed `open` exits non-zero rather
than printing success.
Explicit CLI launch can supply the existing shim's launcher environment along
with intercept arguments. A loaded watcher must be uninstalled before CLI
restore; this guard queries launchd directly without reading installed watcher files or rendering a
script. The CLI preserves shim-only launch without a running proxy and reports
intercept port, trust, listener identity, watcher freshness and app switches.

PAC fallback (`chatgptDesktop.pacFallback`, effective only when `unblockSend` is enabled) replaces the resolver rule so
the app keeps a route while opencodex is down. `src/chatgpt/desktop-unblock/entry-proxy.ts` binds a
CONNECT entry normally on the listener port + 1 (65534 when the listener port is 65535)
that splices `chatgpt.com:443` onto the TLS listener;
`pac.ts` reads the scutil proxy chain and any system PAC. Downloads have a 3-second total deadline;
file reads use one regular-file descriptor and consume at most 4 MiB + 1 byte to detect oversize,
including growth during reading. Read failures close the request or descriptor. `runtime.ts` rewrites
`chatgpt-unblock.pac` at every start, before the readiness marker, embedding the system PAC only
while the base64 `data:` switch stays within 512 KiB. An unreadable system proxy configuration,
unreadable/oversized system PAC, entry bind or PAC write failure releases both listeners and fails
this optional integration's startup. An explicit system proxy chain receives no synthetic DIRECT:
proxy exhaustion fails the request; only a no-proxy/TUN configuration uses normal DIRECT.
Automatic proxy discovery cannot be captured and also fails either launch mode's startup.

`pac-worker.ts` executes arbitrary PAC only in a QuickJS WASM guest inside a runtime-owned worker;
no host JavaScript evaluator, Node globals, persistent service or guessed VPN endpoint is exposed.
The pinned evaluator and syntax-parser dependencies are packaged with the source distribution;
`scripts/build-standalone.ts` embeds the worker source and the main bundle embeds the WASM asset.
The supported subset includes classic domain, `*`/`?` glob and weekday helpers, plus synchronous
IPv4 DNS helpers using the system resolver. HTTPS/WSS PAC URLs omit credentials, path, query and
fragment; their original scheme is retained. This is intentionally not full browser PAC parity:
`myIpAddress`, date/time ranges, IPv6 extension helpers, extended glob syntax, dynamic code,
asynchronous code and exception recovery (`catch`/`finally`) are unsupported. Syntax validation
ignores keywords in comments and strings. Exception recovery is rejected because the evaluator's
allocation errors are catchable and provide no reliable allocator-failure notification.
DNS errors, including ambiguous negative responses, fail closed rather than guessing an answer.
DNS uses at most one outstanding native lookup; cancellation ignores its late result, but cannot
cancel an operating-system `getaddrinfo` call already in progress.
Each worker has a 32 MiB guest heap, 100 ms execution budget, 2-second total request deadline,
5-second startup deadline, 750 ms per DNS wait, 16 DNS calls, 512 helper calls, and 32 queued requests.
Syntax parsing is also capped at 100,000 tokens.
Source/input/result/route limits are 4 MiB, 16 KiB, 8 KiB and 32 routes. Unsupported semantics,
execution or route errors, aborts and exceeded limits permanently close the policy; restart the
optional integration to retry. No caller-supplied route or error details are logged.

This runtime-owned policy covers only traffic the active listener actually receives. Embedded system
PACs retain non-mandatory Chromium semantics, including direct fallback on invalid results or
execution failure; that mode does not establish a fail-closed policy. The script launches with the inline PAC switch alone, requires the entry
to complete a real CONNECT and authenticated TLS identity exchange. A mere TCP connection, empty
response, foreign authority, wrong hostname or curl failure is not readiness. Both curl probes disable
curlrc overrides, and the CONNECT probe forces its explicit loopback proxy despite NO_PROXY. After deciding a launch is needed, it prepares
all launch arguments before quitting the app, rejecting missing, unreadable, non-file or empty PAC
input and failed encoding. The same prepared PAC snapshot is passed to open; a failed preflight
leaves the running app untouched. `native` mode requires no PAC file and undoes any PAC switch,
inline or the older `file://` form. Resolver-rule launches also reject unreadable/invalid system
proxy configuration before quitting the app and never append `direct://` to an explicit proxy.
Native restore does not depend on reading the proxy configuration.

Intercept regression files use the existing `tests/clients/` domain alongside
the shim tests; shared handshake coverage is `tests/lib/socks5-handshake.test.ts`.
Both explicit layout maps register every added test basename. Focused policy tests exercise
unsupported/invalid rules, execution and DNS budgets, lifecycle cleanup, HTTP/WebSocket route parity,
single-socket POST behavior, strict TLS and compiled worker/WASM operation without source files. No duplicate app-server shim is part
of this integration; the PAC generator and entry proxy run only with `pacFallback`.
Loopback tests cover active CONNECT/WebSocket shutdown and real child-process SIGKILL, stale
readiness rejection, same-port restart and PAC regeneration. They do not attest a macOS app's
cached-PAC fallback or certificate acceptance.
