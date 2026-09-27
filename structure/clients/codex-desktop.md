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
PAC from the main package process. Helpers cannot override it and conflicting main
processes refuse before termination. No other process arguments are carried forward.
Captured command lines stay internal, outside restart results and diagnostic logs.

`src/codex/desktop-compatibility/windows-package-command.ts` validates the canonical
loopback URL shape, rechecks the discovered package manifest, activates with
`IApplicationActivationManager`, and verifies the package identity and actual PAC
argument. Normal launches keep the existing AppsFolder route. A standalone compatibility
launch refuses an already running app; it never quits an app or installs a watcher.
`tests/clients/desktop-compatibility-launch.test.ts` covers restart integration and the
real Windows parser/COM service without launching the user's app.

## Certificate persistence

`src/codex/desktop-compatibility/certificate-store.ts` is a separately callable store
for a 30-day authority constrained to `chatgpt.com`, with IP exclusions. An explicit
feature-owned directory and lifecycle lease protect one atomic envelope. Its public
certificate is bound to a CurrentUser-DPAPI-protected private payload.

Reopening reuses the same key and fingerprint. Corrupt, foreign-user and expired state
refuses instead of silently replacing a trusted identity. Renewal is reported within
the last seven days. The store does not register certificates, start listeners, enable
compatibility settings or change the running app. A deliberate renewal validates the
replacement envelope before atomic publication and compares the existing identity again.
Failure before publication preserves the original removable identity; staging is cleaned.

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
Windows package version is declared in the module. Unknown builds and configured outbound
proxies refuse activation; no automatic direct-egress fallback bypasses a selected proxy.
Proxy-aware WebSocket egress remains an integration item with the shared transport work.

`relay-listener.ts` forwards HTTP with the existing upstream-header filter, cookies and
streaming bodies, and pipes upgraded TLS sockets without decoding their frames. The
upstream is fixed to chatgpt.com; request Host cannot select another destination. CONNECT
allows only chatgpt.com:443. PAC has a certificate-relative deadline and `DIRECT` fallback.
The package launcher uses only the runtime-owned PAC and never kills an existing app.

`usage-controller.ts`, `usage-activation.ts` and `usage-policy.ts` implement a maximum
three-minute, explicitly confirmed account-UI trial after a fresh supported exhaustion
snapshot. They cannot assert selected-provider isolation. Two usage gate booleans may
change; quota windows, credits, spending limits and other responses remain original.
Fresh identity checks, generation changes, unknown schemas and elapsed deadlines refuse
correction. `usage-sse-controller.ts` preserves event metadata and original sequence IDs;
`usage-refresh.ts` closes only usage streams bound by validated original account records.
`usage-controlled-fetch.ts` removes stale validators from changed JSON and controlled SSE.
Response production is reported separately from app-cache or UI confirmation.

`runtime-ownership.ts` serializes certificate mutations against active/starting runtimes.
The existing sibling guard blocks all runtime mutations in sibling instances. Core shutdown
registration occurs only after successful startup. Cleanup stops owned listeners and streams;
a failed cleanup retains ownership and reports `cleanup-required`, never a false `off` state.

`src/server/management/desktop-compatibility-runtime-routes.ts` provides GET status and
local GUI-session POST start/stop/observe/apply/launch, with explicit confirmation and
separate account-wide consent for apply. No setting, login, quota, automatic startup or
dashboard panel is changed by this API. GUI and persisted startup integration are pending.
The status CLI verb remains deferred to this integration owner.
