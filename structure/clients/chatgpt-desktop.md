# ChatGPT Desktop integrations

## Integrated cloud network

`src/chatgpt/cloud-network/` owns the opt-in `chatgptDesktop.cloudNetwork`
integration. `src/config/schema/chatgpt-desktop.ts` validates this independent boolean;
`src/types/config.ts` carries it independently of the app-server shim flag.
The public `src/cli/chatgpt-network-command.ts` supplies status/install/enable/disable/
recover/uninstall. This is the only cloud-network implementation and public entry.

`src/server/index/chatgpt-cloud-network-lifecycle.ts` joins the existing
`src/server/index/optional-listeners.ts` startup and awaited shutdown. Startup remains
synchronous at the composition root. Disabled installations do not import the transport
or contact the helper. Enabled startup runs asynchronously, only on macOS outside the
client role; a failure records unavailable state without failing the model proxy.
Stop joins pending activation and removes the mapping before releasing owned sockets.
After a failed release, lost helper or startup reply requiring recovery, disable/shutdown
retries helper recovery before reporting disabled/stopped, even when startup returned no
runtime handle. The helper's recovery-required state survives independently of its reason
code until recovery or acquisition succeeds; persisting the off flag alone never clears it.

`runtime.ts` selects the existing outbound environment with `effectiveProxyFor`,
after server startup's `applyProxyEnv`. It refuses matching NO_PROXY, missing proxy
and obvious local-443 loops. `entry.ts` binds IPv4/IPv6 loopback 443 and preflights
the fixed cloud target through HTTP(S) CONNECT or SOCKS5 before acquiring a mapping.
It reuses `dialTunnel` in `src/lib/opaque-proxy-tunnel.ts`, whose handshake returns
a paused raw socket. Entry shutdown aborts in-flight tunnel establishment as well as
closing established sockets, so pending CONNECT/SOCKS handshakes cannot outlive teardown.
All client TLS remains opaque; no CA, payload logging,
account reads or direct fallback is added. The relay resumes the socket only after
attaching the client pipes; existing WebSocket transports remain unchanged.

`src/server/management/chatgpt-network-routes.ts` is lazy-loaded by namespace.
GET status and POST enable/disable/recover require trusted local ingress and a GUI
session or admin-token principal. Data-plane keys and remote ingress cannot mutate
it. Enable/disable share the existing config transaction before runtime reconciliation;
failed persistence does not start a listener. Failed activation retains configured
intent and reports a non-success result, distinct from active state.
The endpoint cannot install, elevate, choose a hosts path or supply an upstream proxy.
`ocx chatgpt status` includes cloud state; cloud-only launch checks active state;
restore recovers cloud routing before relaunching the trusted desktop, including when
the config flag is already off but the recovery helper remains installed.

`helper.ts` owns the mapping while one authorized Unix-socket connection remains.
`helper-client.ts` sends only fixed protocol actions, never a path, command or secret.
Disconnect releases the mapping; an active owner excludes another runtime/recover.
Helper status derives from the live owner and any recovery error, not a second state machine.
Acquisition delegates stale recovery to the same mapping implementation used at startup.
`hosts.ts` records a durable journal before atomic replacement, preserves file mode/
ownership and unrelated lines, and retains the journal until resolver invalidation
succeeds. Conflicting or edited owned records require inspection instead of deletion.
`helper-system.ts` fixes production paths, requires root on macOS, holds an OS-released
SQLite lock and recovers before accepting clients. No public path/environment override
redirects its privileged operations; tests inject temporary paths into the lower layers.

`install.ts` requires explicit sudo authorization and separates installation from
activation. launchd owns the small recovery helper, not a second traffic proxy.
Its fixed job requests KeepAlive and RunAtLoad; recovery is after service restart,
not instantaneous after SIGKILL or power loss. Source/npm installation bundles
`helper-system.ts` and copies Bun; standalone installation copies the CLI and enters
the hidden helper command. Installed code and its parents must be root-owned and
not group/other-writable. The socket grants only the installing uid access.
The helper reads no user config or proxy credentials. Updating/removing it requires
idle routing and explicit authorization, never an ordinary proxy update side effect.
Uninstall restores first and removes fixed owned files; unknown leftovers are retained.

The entire network namespace, including its internal privileged entry, bypasses
unrelated shim auto-repair in `src/cli/codex-shim-autorestore.ts`.
`tests/clients/desktop-cloud-management.test.ts` drives the real server and public
CLI against temporary resources; runtime/recovery/install regressions are in sibling
desktop-cloud tests. Source/npm bundling and compiled command reachability are separate
from real launchd, port-443, DNS-cache and authenticated desktop acceptance.
Status always leaves applicationHandshake unverified.

## Isolated validation of the integrated implementation

`tests/helpers/cloud-network-fixture.ts` supplies temporary hosts/journal/socket paths;
`tests/helpers/cloud-network-process.ts` runs the real helper and server lifecycle in
separate test processes. No parallel sandbox mapping or worker implementation ships.
`tests/clients/desktop-cloud-entry.test.ts` drives the integrated runtime on ephemeral
ports to verify IPv4/IPv6 TLS hostname validation and byte forwarding without OS trust changes.
`tests/clients/desktop-cloud-recovery.test.ts` verifies process-loss and journal recovery.
The native system-extension candidate and old public sandbox command are not in the source tree.

## App-server shim

The experimental macOS integration is owned by `src/chatgpt/` and exposed through
`src/cli/chatgpt-command.ts`. It is default off; an explicit launch requires
`chatgptDesktop.appServerShim === true` or `chatgptDesktop.cloudNetwork === true`, and only the
shim launcher requires `appServerShim`. The strict config leaf accepts optional boolean `appServerShim` and `cloudNetwork`
flags; malformed reads disable the leaf, while live
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
This is a stdout-projection boundary, not a guarantee that every Desktop composer
uses that transport. The post-closure reports in
[#6196](https://github.com/lidge-jun/opencodex/issues/6196) describe an attached shim
with no eligible rate-limit RPC messages and a still-locked composer on specific
macOS builds. A launcher override or synthetic rewrite test does not establish
original-app acceptance. The separate renderer usage transport is outside this
module's scope; the reported remaining lock stays open without reviving the
closed local-CA intercept design.
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
Other platforms reject all three operations.

The launcher and its executable paths are local code-execution inputs. This
shim installs no network listener, CA, PAC or background watcher, and
starts no proxy timer. Explicit launches are its only activation point.

Tests cover rewriting, byte framing, passthrough degradation, source/compiled
launcher text, stub launcher execution, hidden preflight, and strict config writes
in tests/clients/desktop-*.test.ts. Pipe-crash behavior is mock evidence only;
no bundled-app respawn guarantee is asserted.
