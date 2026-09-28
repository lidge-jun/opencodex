# Codex Desktop compatibility

## Explicit restart

`ocx system codex-restart` requests a full Codex app and app-server restart through
the management endpoint. `src/cli/capabilities.ts` and `src/cli/system-command.ts`
warn that unsaved drafts, picker selections and pending approvals may be lost.
The unconfirmed path sends no restart request; JSON output preserves refused outcomes.

Under the test preload's `OCX_TEST_HOME_GUARD=1`,
`src/codex/desktop-app-restart.ts` skips real restart without an injected executor.
`src/cli/restart-scope.ts` reports that skip. `NODE_ENV=test` alone does not control
this boundary. `tests/clients/desktop-app-restart.test.ts` covers the contract.

## Windows launch context

`src/codex/desktop-app/windows.ts` captures an already active loopback compatibility
PAC from the main package process only when its exact URL is registered by the current
process-local serving runtime. The runtime publishes a fresh generation after its listeners
bind and revokes it before cleanup. Disk state and URL shape cannot establish this ownership;
stopped, expired, foreign or unregistered runtimes refuse capture before termination.
The adapter rechecks the captured generation immediately before package activation, so even
a replacement runtime serving identical ports cannot inherit the old restart approval.
Helpers cannot override it and conflicting main
processes refuse before termination. No other process arguments are carried forward.
Captured command lines stay internal, outside restart results and diagnostic logs.
Capture failures return `relaunch_context_failed` and release the restart lock before any process is signalled; the CLI reports that the app was not stopped.
An explicitly empty or whitespace-only root command line remains unknown after CIM parsing and refuses context capture; an unreadable helper cannot erase a known root PAC.

`src/codex/desktop-compatibility/windows-package-command.ts` validates the canonical
loopback URL shape, rechecks the discovered package manifest, activates with
`IApplicationActivationManager`, and verifies the package identity and actual PAC
argument. Normal launches keep the existing AppsFolder route. A standalone compatibility
launch refuses an already running app; it never quits an app or installs a watcher.
Activation reads the final non-empty JSON line after trimming a BOM or preceding warnings. Invalid output and executor failures remain unverified, without automatic relaunch retries.
`tests/clients/desktop-compatibility-launch.test.ts` covers restart integration and the
real Windows parser/COM service without launching the user's app.

## Certificate persistence

`src/codex/desktop-compatibility/certificate-store.ts` is a separately callable store
for a 30-day authority constrained to `chatgpt.com`, with IP exclusions and a TLS-server-only EKU. An explicit
feature-owned directory and lifecycle lease protect one atomic envelope. Its public
certificate is bound to a CurrentUser-DPAPI-protected private payload.

Reopening reuses the same key and fingerprint. Corrupt, foreign-user and expired state
refuses instead of silently replacing a trusted identity. Renewal is reported within
the last seven days. The store does not register certificates, start listeners, enable
compatibility settings or change the running app. A deliberate renewal validates the
replacement envelope before atomic publication and compares the existing identity again.
Failure before publication preserves the original removable identity; staging is cleaned.
An older authority without the server-only EKU reports `renewal-required`: serving and trust
registration refuse it, while exact trust removal and deliberate renewal remain available.

`src/codex/desktop-compatibility/windows-key-protection.ts` uses trusted PowerShell
and bounded stdin/stdout, never command-line secrets or plaintext fallback. CurrentUser
protects against other OS identities, not another process using the same credentials.
`tests/clients/desktop-compatibility-authority.test.ts` covers persistence, refusal,
and a real Windows DPAPI round trip with synthetic data.

## Certificate setup API

`src/server/management/desktop-compatibility-routes.ts` exposes the authenticated
`/api/codex/desktop-compatibility/certificate` setup endpoint. GET is read-only public metadata and OS-trust inspection;
it does not decrypt a key, create a file, acquire a lease or register trust. POST
requires a GUI-session principal on trusted loopback ingress and explicit confirmation.
Trust mutations also require the exact SHA-256 fingerprint. Raw admin tokens cannot
substitute browser provenance; this does not protect against arbitrary same-user code.

`src/codex/desktop-compatibility/certificate-service.ts` serializes setup and refuses
busy operations. Only prepare may generate a key. Trust/removal load existing validated
state, recheck its fingerprint, and never repair missing state by creating a new root.
Removal refuses while the app is running or its process state cannot be established.
An expired key is loadable only for removal, not for renewed trust.
Explicit renewal first proves the app absent and verifies old trust removal, then replaces
the encrypted envelope. Unknown or refused removal never loses the old key. The new root
remains untrusted until a separate fingerprint-bound confirmation; renewal never creates
an automatic trust prompt or accumulates old trusted roots.

`src/codex/desktop-compatibility/windows-certificate-trust.ts` uses the CurrentUser Root
store and exact certificate bytes. Mutations require the matching private key from the
protected store, not status metadata. Idempotent actions skip repeated OS changes;
uncertain command completion is resolved by an independent readback. Unknown readback
remains unknown. Public responses contain no PEM, private-key objects or subprocess output.

Sibling instances refuse certificate mutations because OS trust is shared user state.
The registry declares the certificate-status CLI verb as deferred to the desktop
compatibility integration owner; it currently has an authenticated HTTP contract only.

## Optional compatibility runtime

`src/codex/desktop-compatibility/runtime.ts` owns an explicit, default-off runtime.
Construction and status do not start listeners, load credentials or enroll trust. Start
loads an existing DPAPI key, verifies CurrentUser trust and a fresh native file-login
identity, then creates only loopback TLS/CONNECT/PAC listeners. The currently assessed
Windows package version is declared in the module. Unknown builds refuse activation.
The assessed family/publisher, full package basename and App entry must also agree;
matching the version prefix alone does not qualify a foreign package identity.
HTTP, identity verification and upgraded sockets use the explicit desktop egress policy
described in the [transport inventory](../transports/inventory.md#native-desktop-proxy-egress).
Invalid proxy routes refuse rather than falling back to direct egress.
Native routing verification binds both the actual listener address family and port; the companion
is IPv4-only. Ambiguous localhost aliases cannot qualify, and listener identity changes revoke observation.

`relay-listener.ts` forwards HTTP with the existing upstream-header filter, cookies and
streaming bodies, and pipes upgraded TLS sockets without decoding their frames. The
upstream is fixed to chatgpt.com; request Host cannot select another destination. CONNECT
allows only chatgpt.com:443. PAC has a certificate-relative deadline and `DIRECT` fallback.
HTTP and upgraded requests accept the case-insensitive DNS spelling of that exact Host,
with optional port443, while other hosts, ports and non-origin request targets remain refused.
The package launcher uses only the runtime-owned PAC and never kills an existing app.

`connection-store.ts` preserves the PAC nonce and two public loopback ports in a bounded,
strictly validated `connection.json` beside the protected authority. No account, credential,
key or expiry is stored there. First publication is create-only under a lifecycle lease;
another identity cannot be overwritten. Startup binds the recorded ports and revalidates
publication before exposing a launch URL. A conflict or malformed file fails without new
port allocation. Existing cached PACs can reconnect after a service restart using the same
authority and endpoints; correction always restarts in Observe. Certificate renewal still
requires a closed app, so its next launch fetches the new certificate-relative PAC deadline.
If both publication and temporary-file cleanup fail, the cleanup-required error retains both causes; cleanup never throws from a `finally` block or reports the residue as removed.

`usage-controller.ts`, `usage-activation.ts` and `usage-policy.ts` implement a maximum
three-minute, explicitly confirmed account-UI trial after a fresh supported exhaustion
snapshot. They cannot assert selected-provider isolation. Two usage gate booleans may
change; quota windows, credits, spending limits and other responses remain original.
An original available or protected usage record disarms Apply and advances its generation.
Later exhaustion does not resume that trial; it requires another explicit activation.
Pending response checks from the previous generation cannot emit a correction after recovery.
Native identity verification also binds an opaque reader-local credential generation from a stable file-stat/content snapshot. Replacement, token rotation and A-to-B-to-A restoration invalidate pending identity checks and response correction; they require a fresh observation runtime. Neither credential hashes nor tokens appear in public status. `tests/clients/desktop-compatibility-native-identity.test.ts` exercises delayed verification and build-check races with synthetic auth files.
Fresh identity checks, generation changes, unknown schemas and elapsed deadlines refuse
correction. `usage-sse-controller.ts` preserves event metadata and original sequence IDs;
`usage-refresh.ts` closes only usage streams bound by validated original account records.
`usage-controlled-fetch.ts` removes stale validators from changed JSON and controlled SSE.
Response production is reported separately from app-cache or UI confirmation.
Observation counters distinguish validated JSON/SSE snapshots from merely registered streams;
only identity-bound, untainted active streams count as `validatedActiveStreams`. Counts and the
last snapshot time describe this relay's lifetime, including responses sent by diagnostic clients.
They never establish a source PID, authoritative gate coverage or composer recovery. Both
`sourceProcessVerified` and `composerRecoveryVerified` remain false. Invalid/foreign snapshots do
not advance these counters. Conversation initialization and other non-WHAM endpoints retain
their original response bytes, including `blocked_features` and `limits_progress`.

`routing-binding.ts` records the server's actual bound data/companion ports. Shutdown
unregisters only its matching owner. `routing-preflight.ts` verifies bounded native root
TOML and any selected root profile against those ports, rejecting foreign providers,
remote destinations, authless mode, unknown profiles and process-level app overrides.
The verifier binds parsed root TOML values, actual listener ports and the configured provider/model/fallback
routing inputs to its first valid observation. A change or failed check invalidates that runtime
even if the old settings return; stop/start creates a fresh observation context. Unrelated
OpenCodex preferences, TOML formatting, object-key order and the native root `mcp_servers`
table do not invalidate the routing snapshot. Desktop refreshes that tool-transport table
after launch; all other native fields, including unknown ones and selected profiles, remain bound.
It does not claim knowledge of project-local overrides or a conversation's selected model.
Each record that would be corrected checks routing and the assessed installed build asynchronously,
then rechecks account identity and trial generation before emitting it. `installed-build.ts` shares
the Windows adapter's discovery parser, coalesces concurrent probes without caching a positive
result across requests, and aborts/reaps its bounded child before shutdown completes. Observe and
unchanged responses do not query Windows. Background refresh runs once a minute in Observe,
every ten seconds during Apply, and stops probing after the safety deadline. Failed checks
disarm Apply. Native update/routing failures are
public diagnostic codes; originals continue to relay and no app/config repair is automatic.

`runtime-ownership.ts` serializes certificate mutations against active/starting runtimes.
The existing sibling guard blocks all runtime mutations in sibling instances. Core shutdown
registration occurs only after successful startup. Cleanup stops owned listeners and streams;
a failed cleanup retains ownership and reports `cleanup-required`, never a false `off` state.

`src/server/management/desktop-compatibility-runtime-routes.ts` provides GET status and
local GUI-session POST start/stop/observe/apply/launch, with explicit confirmation and
separate account-wide consent for apply. No setting, login, quota, automatic startup or
dashboard preference is changed by this API. The separate startup preference below never saves Apply.
The status CLI verb remains deferred to this integration owner.

## Dashboard controls

`gui/src/pages/codex-desktop-compatibility.tsx` is a lazy Codex Set tab at
`#codex-set/desktop`. It uses the machine API base, never the shared hub base. Managed
OpenCodex client mode does not offer these controls because its local listener deliberately
does not admit durable machine mutations through a dashboard bootstrap session.

`gui/src/desktop-compatibility-api.ts` projects public status and issues one POST per action.
Fingerprint-bound trust/renew/removal and the account-wide trial require separate acknowledgement.
Observe/start/stop/launch follow explicit button actions. No action is replayed after an uncertain
response; a fresh status read is required. Changing the API target remounts the panel and discards
pending consent. `useClientResource` owns bounded, visibility-aware reads and invalidates earlier
reads when a mutation result is published. Certificate status is not repeatedly polled; runtime
status polls only while the tab is active. Consent copy exists in all ten locale catalogs.
Trial consent and pending withdrawal distinguish stopped response correction from unconfirmed native cache refresh; the panel never reports cache rollback as confirmed.
The panel offers renewal only for prepared, trusted or expired identities. Unknown trust permits fingerprint-verified removal but not renewal; invalid keys expose neither action.
Running-state help distinguishes a listening service from a connected native app: ordinary app launches or updates can omit the managed PAC argument. It points to explicit package launch after the user closes Codex and states that a certificate reinstall cannot authorize an unassessed build.

## Proxy startup preference

`desktopCompatibility.startOnProxyStart` is opt-in and defaults absent/off. The strict schema
rejects candidate writes containing unknown options, while invalid hand edits disable startup.
`src/server/index/desktop-compatibility-startup.ts` gates optional imports on this intent,
Windows, non-test execution and non-sibling/non-client ownership. It keeps `startServer`
synchronous and does not await before the Lab activation boundary. Unsupported prerequisites
warn without stopping the model proxy or installing trust.
When the CLI supplies its readiness gate, observation waits for post-startup native configuration
sync before loading its runtime. A failed sync or a two-minute pending limit leaves observation
off with a generic diagnostic; shutdown cancels this optional wait without delaying proxy exit.

`service.ts` shares one runtime between startup and management. Server shutdown retains
the asynchronous teardown, waits for in-flight startup, and prevents a late start after stop.
The saved preference does not launch Codex, enroll or renew certificates, or resume a trial.
The dashboard's startup toggle changes only this next-process preference. Its settings API
requires local GUI provenance, explicit boolean intent and a revision of the displayed field.
`startup-settings.ts` uses the existing config mutation lock/rebase writer, then reads back
the real file. Unrelated concurrent fields survive. `adoptPersistedDesktopCompatibility`
updates only this field and its live comparison baseline, so a later unrelated save cannot
undo the committed preference or overwrite newer disk edits. Publication-side errors remain
errors, with verified disk state adopted rather than speculative rollback or request replay.
Invalid/missing configuration cannot be recreated by toggling this setting.
