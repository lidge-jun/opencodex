# Runtime

## Resolved static model policy

`src/router.ts` attaches one frozen `ResolvedModelPolicy` to every `RouteResult`. Policy/combo
route spreads retain that object. Every initial, fallback, and recovery route is recaptured for the
request's original inbound protocol before route-dependent normalization, and all adapter rebuilds
consume its recorded adapter. A translated Chat or Anthropic replay therefore cannot inherit a
Responses-only default. Credential, account, quota, health, cooldown, and observed transport
evidence remain late and cannot widen a captured static limit.

Virtual models are the sole model-identity transition: the ordinary and compact paths preserve the
selected public id in diagnostics, rewrite `route.modelId` to the upstream wire id, and atomically
replace `route.staticPolicy` before adapter or capability decisions continue. Model aliases are
resolved before the route result is built, so their policy is already keyed by the native wire id.
Live selector hints obey the [credential-scoped cache contract](catalog.md): a selection change
cannot reuse the previous credential's roster to choose an alias target. Passive OAuth observation
neither refreshes credentials nor repairs their storage.

Routed Meta Muse requests use the registry-owned [Muse effort and header contract](providers-and-adapters.md); `max` reaches the provider through the existing reasoning mapper.

Native result continuations and function-result injection follow [the mode-specific result and control contract](transports/streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.

Native steering follows [the shared WebSocket contract](transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

Responses admission and finalization are composed through the
[core module ownership](transports/responses.md#core-module-ownership). This surface retains its existing behavior.

Catalog HTTP acquisition follows the [proxy-routing contract](catalog.md#remote-catalog-http-proxy-routing).

OAuth refresh coordination follows the [refresh-lock identity contract](catalog.md#accounts-namespaces-and-pool-rotation): a fresh unreadable lock remains held, and release requires matching descriptor identity. A failed path-identity probe preserves the refresh callback outcome. Cooperating lock metadata changes serialize through the existing SQLite mutation transaction; release keeps the descriptor open through identity comparison and any unlink, then closes it. Failed metadata writes remove only a matching owned path after successful coordination; unknown identity, failed probes or unavailable coordination retain the path for stale recovery. Async refresh work holds no metadata transaction.

The configuration-only [plaintext V2 contract](subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged. Cursor's localized native-shell names follow the [routing-commentary guard contract](providers/cursor.md#cursor-native-exec).

Chat request serialization owns
[chronological instruction ordering](providers/chat-compat.md#chronological-in-conversation-instructions)
and the developer wire role; it requires no runtime lifecycle change, and its one
configuration option is a per-provider role opt-out.

Shared parsing and streaming follow the [request-copy](transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](transports/byte-accounting.md#stream-buffer-accounting) contracts. Response-attached WebSocket telemetry follows the [stage record identity contract](transports/responses.md#passthrough-sse-stream-shapes-314).

## Anthropic streaming usage snapshots

`src/claude/outbound.ts` starts Anthropic semantic framing lazily. When `response.created` or
`response.in_progress` reports numeric input usage before the first content event, `message_start`
uses that confirmed value through the normal Anthropic cache-token transform. Without an early
measurement it emits the required zero snapshot without estimating or delaying content. The terminal
`message_delta.usage` remains cumulative and is always derived from the terminal response usage;
this wire projection does not change the usage ledger.

## CLI readiness diagnostics

Catalog-derived reasoning-level diagnostics are escaped only at the human-output boundary, which `src/cli/runtime-api.ts` owns alongside the human/JSON print split. Every CLI path that prints a hub-supplied catalog value renders it there: the first-time refusal in `src/cli/connect.ts` and the connected `ocx sync` refusal in `src/cli/dispatch.ts`. C0/C1 controls, DEL, and Unicode line/paragraph separators print as visible hexadecimal escapes; structured status retains the exact reason, and a rendered failure keeps the domain error as its `cause`. The ready/unverified/incompatible classification and exit policy are unchanged.

## CLI resolve and stop contracts for embedding shells

`ocx resolve` (`src/cli/resolve.ts`) is the machine surface a desktop shell asks instead of resolving the config home, the port, and liveness itself: the home comes from `src/config/paths.ts`, the effective port is the live listener's when the identity-checked `findLiveProxy` answers and the configured `config.port ?? 10100` otherwise, and the liveness verdict is that same module's output (pid, runtime-versus-config provenance, version, role). Config reads go through `readConfigDiagnostics`, not `loadConfig`: a missing file is defaults, but an invalid file exits 1 instead of being repaired to defaults, because a defaulted port is a guess the caller must refuse. Liveness is three-valued: when `findLiveProxy` returns null, resolve re-asks the endpoints with the updater's tri-state probe (`endpointsToProve` + `everyEndpointProvenDown` + `probeProxyLiveness`), and only a unanimous definitive "dead" becomes `absent-proven`; unknown exits 1 and never authorises a start. Discovery borrows `START_OWNERSHIP_LIVENESS`, the start path's ownership budget — the verdict feeds the shell's launch decision, so the cost of a false "nobody listening" is the duplicate proxy (#5004). The verb is in `skipsCodexShimAutoRestore`, so a read-only lookup never triggers a shim repair. Arguments are pre-parsed in `src/cli/root.ts` and exit 64 before any preflight side effect, the same ordering `ocx ready` obeys.

`ocx stop --json` is a reporting layer over the unchanged stop path. `src/cli/index.ts` threads a `StopRunRecord` through the existing receipt, drain, respawn-verification and restore flow, and `src/cli/stop-report.ts` maps the recorded facts plus the signals that already pick the exit code into one versioned document (`schema: "ocx-stop/1"`). With `--json` the human lines print on stderr and stdout carries only that document; exit codes 0/1/79/80 cross the process boundary unchanged.

## Native main reauth JSON output

`src/cli/account-main.ts` emits one JSON object to stdout when `ocx account main reauth --device --no-wait --json` succeeds. The human-readable `follow up:` line is emitted only without `--json`; `flowId` remains available for status polling. `tests/cli/cli-native-profile.test.ts` parses the complete captured stdout and preserves coverage of the human follow-up.

## CLI Codex restart scope

`ocx system codex-restart` requests a full Codex desktop-app restart and app-server restarts through the management endpoint. `src/cli/capabilities.ts` names that scope in its summary and `--yes` description; `src/cli/system-command.ts` explains the desktop interruption when confirmation is missing and sends no restart request. Human output says the restart was requested, while `--json` preserves the complete server result, including skipped or refused desktop outcomes.

After a CLI catalog/cache write, advisory restart guidance compares each running Codex app-server's
start time with the written catalog mtime. It reports only processes proven stale; a fresh or
unreadable observation does not claim that another restart is required. Explicit
`--restart-codex` and `--restart-app-server-only` retain their operator-consent semantics and act on
verified matching processes regardless of the advisory freshness result.

> Decision record: [ADR-0097](decisions/ADR-0097-post-write-app-server-freshness.md)

## Hub management dashboard address

When hub management ingress is enabled, `src/cli/dispatch.ts` opens the dashboard on the literal IPv4 loopback address and configured ingress port, matching the listener in `src/server/index.ts`. Other dashboard address selection is unchanged.

## Codex desktop process membership

`src/codex/desktop-app/windows.ts` discovers the installed package and limits process ownership to the current Windows user.
Its PowerShell prefilter normalizes both the install root and candidate executable from `/` to `\` before a case-insensitive prefix comparison.
The adapter then folds both slash forms onto the host separator before calling `isUnderRoot()` in `src/codex/desktop-app/types.ts`.
That shared lexical boundary check rejects sibling prefixes such as `OpenAI.Codex-evil`; Windows path folding stays in the Windows adapter, so a POSIX backslash remains a filename character.
The prefilter is only an optimization, not final process-membership authority.
`tests/clients/desktop-app-restart.test.ts` covers both mixed-slash directions through the adapter and runs the real PowerShell filter against synthetic CIM rows on Windows.
`tests/clients/desktop-app-restart-posix.test.ts` keeps the POSIX separator contract covered; uid-dependent macOS/Linux cases skip on Windows.

## Explicit Codex CLI installation observation

`src/cli/codex-cli-update.ts` dispatches the opt-in Windows x64 `attest` operation to
`src/codex/cli-installation-identity.ts`. With no options, `src/codex/cli-installation-targets.ts`
derives the four inputs from the proof-bound launcher snapshot: the configured candidate or
the first codex on the captured PATH, an OpenCodex wrapper resolving to its renamed npm
backing, the npm prefix layout, and the Node/npm toolchain beside the resolved node.exe.
Configured values containing a path separator must be drive-absolute; otherwise derivation
refuses with `candidate_unavailable` instead of substituting a different PATH candidate. Bare
command names and the unset default continue to resolve only through the captured PATH.
Discovery only proposes paths and never reads ambient state. Four explicit absolute paths
remain accepted as an all-or-none override. Only the
standard npm command shim or direct Codex package entry is accepted. The native reader in
`src/codex/windows-installation-files.ts` holds ancestor/file handles for bounded reads and
rejects reparse points, conflicting writers and unsupported paths/platforms. Its path-free
report binds file identities and bytes to this observation, not a durable update permission.
`installationIdentityObserved` can be true; `selectionAttested`, `managed` and `applyAllowed`
remain false. Supplied Node identity does not prove launcher selection, effective npm config,
past installer identity or tool authenticity. No package-registry request, installation,
config write or process control occurs. Existing Windows `check` retains zero candidate/config
filesystem I/O. A reported refusal can exit 0; consumers inspect `status`.

The local account CLI and pool credential resolver share the
[Orca source-owned import contract](codex-home.md#orca-source-owned-account-import): importing
does not perform OAuth, and runtime credential resolution rereads the owned source.

## Entrypoints

| Path | Responsibility |
| --- | --- |
| `bin/ocx.mjs` | Published npm `bin` entry (Node shim). Resolves the bundled or explicit Bun binary before project dotenv can load, stamps its runtime provenance plus a proof-bound Anthropic parent-env snapshot, lazy-runs `bun/install.js` if only the placeholder stub is present, then execs `src/cli/index.ts` under Bun. Lets `npm install -g` work without a separately-installed Bun. The exact `system codex-cli-update` inspection namespace skips both boot repair and lazy Bun installation; missing runtime support fails closed instead of mutating state. |
| `src/lib/bun-runtime.ts` | Bundled-Bun resolution: `isRealBunBinary()` (size gate vs the ~450-byte placeholder stub), `bundledBunPath()`, and `durableBunPath()` (path baked into service/shim artifacts). Durable selection accepts only the source/path pair already stamped for the running executable; it never re-reads a project-dotenv `OPENCODEX_BUN_PATH`. |
| `src/lib/plain-data.ts` | Detached copies for a consumer that must not observe later edits. Descriptor-based reads, including array elements, so an accessor is refused rather than invoked; refuses cycles, functions, class instances and anything else JSON could not have produced, and returns a copy-or-refusal union rather than degrading silently. Symbol-keyed process bookkeeping is skipped. |
| `src/cli/index.ts` | `ocx` / `opencodex` CLI. Lifecycle: init, start, stop, restart, status, sync, restore/eject, gui, service, update. `restart` refuses an in-place restart requested by a CLI whose version differs from the attested `/healthz` version, because the replacement respawns from the live installation; placeholder versions (unknown/0.0.0) stay incomparable and keep the restart path. Configuration: provider, account, models, combo/route, access, integrations, v2. Client launchers: Claude, OpenCode, MiniMax Code, and MiniMax CLI text. The MMX launcher owns a child-lifetime loopback path bridge from the client's hard-coded `/anthropic/v1/messages` path to the canonical `/v1/messages` data plane; the server does not expose an extra auth surface. Diagnostics: doctor, debug, observe, health. Windows adds tray. The full command surface is `src/cli/help.ts`; this table names the groups, not every verb. After help/version early exits, ordinary commands run the bounded best-effort Codex-shim auto-restore policy before dispatch. `system codex-cli-update` is the deliberate read-only exception and suppresses auto-restore for its whole namespace, including malformed invocations. Keeps the `#!/usr/bin/env bun` shebang for from-source dev (`bun run src/cli/index.ts`). |
| `src/server/index.ts` | Bun server entrypoint: `startServer`, `/v1/responses` HTTP + WebSocket routing (compact handled before generic Responses), exact `POST /v1/images/generations` and `POST /v1/images/edits` routing, `/v1/models`, the Anthropic-shaped `/v1/messages` and OpenAI-shaped `/v1/chat/completions` compatibility surfaces, the Live/Realtime surface, the hosted-search relay, artifact serving, `/healthz`, the `/api/*` auth gate, the `/v1/*` JSON 404 guard, GUI fallback, the opt-in loopback-only hub-management listener, and facade re-exports for split server modules. The route table itself is built by `src/server/index/serve-options.ts`; this entry file owns the listener and the startup transaction. |
| `src/server/images.ts` | Standalone Images data plane: default OpenAI or explicit custom-provider selection, Codex account affinity, bounded opaque request relay, single-attempt upstream fetch, pool health recording, and safe response/cancellation relay. |
| `src/server/audio-transcriptions.ts` | Standalone multipart transcription; audio-specific key admission, bounded upload/response, stored OpenAI credential resolution and lease-bound cancellation. See [audio contracts](data-planes/inbound-compat.md#standalone-file-transcription). |
| `src/server/audio-live.ts`, `src/server/audio-dictation.ts` | External voice/dictation orchestration using the existing bounded socket relay, server-owned credentials, cancellation and opaque call ownership. See [streaming audio](data-planes/inbound-compat.md#streaming-audio). |
| `src/config.ts` | Persisted `~/.opencodex/config.json` surface: the facade keeps the load/save/initialize entry points and re-exports, while schema lives in `src/config/schema/` (`config-schema.ts`, `leaf-validators.ts`), defaults in `src/config/proxy-env.ts`, and replace-path persistence in `src/config/persist-unlocked.ts`. |
| `src/config/paths.ts` | Resolves `OPENCODEX_HOME`, `config.json`, and owner-only directory hardening. |
| `src/config/atomic-write.ts` | Shared synchronous/asynchronous temp-harden-rename writer and residual-temp failure contract. The temp is ACL-hardened before it holds a byte and again before the rename, both `required: true`; the second call is a memo hit rather than a second icacls sequence because the writer re-asserts descriptor/path identity after the content write and re-attributes the harden through `reattributeHardenedSecretPath`. Windows takes no `chmod` on that path — it sets the read-only attribute, not the DACL, and its ChangeTime bump is what used to retire the memo. |
| `src/config/process-state.ts` | Owns `ocx.pid`, `runtime-port.json`, cheap liveness, full command-line identity verification, and snapshot-guarded cleanup. |
| `src/config/admitted-identity.ts` | Which configuration a derived artifact was built from. Detaches the resident configuration as plain data so one pass cannot gather under one state and project under another, and records the complete structure beside the configuration file's bytes. Refuses an accessor, a cycle, a value JSON could not produce, an unreadable file and a file the loader would have had to salvage; a callable `providers[name].fetch` is the one non-data field, held and compared by reference, while a written one is ordinary data on both sides, as the outbound transport also reads it. It does NOT require the resident configuration to equal the file: the proxy routes by what it holds, and live reconciliation retains live changes and the active listener binding on purpose. Evidence stays in a module WeakMap, never on the config and never in a response. |
| `src/server/ports.ts` | Owns bind availability and ephemeral-port selection. Temporary probes dispose accepted peers and wait for listener close before reporting success. |
| `src/cli/status.ts` / `src/cli/status-probes.ts` | Status snapshot assembly and the shared read-only health/stale-process probes used by status and doctor. Probe evidence keeps recorded-port choice, before/after snapshots and per-call timer cleanup together. |
| `src/cli/doctor.ts` | Read-only environment diagnostics. Sections print through `console.log`; each is a `collect*` helper above `runDoctor` so it is testable without the command. Only a `FAIL`-level condition records a doctor failure — a degraded-but-working install must not break a green pipeline. `collectDefaultModelExposure` compares Codex's root `model` pin against the exposed set, which it READS rather than recomputes: the running proxy's `/v1/models` through the byte-capped direct-local transport when one answers, otherwise the on-disk catalog's `visibility: "list"` slugs. It reports exposed, not exposed, or undeterminable, and never the second when it could not read either surface. |
| `src/router.ts` | Provider/model selection before adapter dispatch. Policy execution and ordinary management dry-run share effective-provider capability evidence; unresolved, missing, and disabled providers are excluded before scoring. |
| `src/providers/api-key-selection-capture.ts` | Pure request-owned snapshot of the configured key entry, reference, and revision. The router and stateful selection module share this leaf with type-only dependencies; `api-key-selection.ts` retains the compatibility export and owns persisted selection changes and route resolution. |
| `src/types.ts` | Shared config, parsed request, adapter, and event types. |
| `src/reasoning-effort.ts` | Codex reasoning-level definitions (`low`/`medium`/`high`/`xhigh`), per-model effort mapping, and catalog effort sanitization. |
| `src/codex/shim.ts` | Codex autostart shim: replaces the `codex` binary with a wrapper that auto-starts the proxy on demand. It skips startup for management subcommands even when value-taking global flags precede the subcommand, and transactionally restores complete, stable external launcher replacements without a watcher or PATH rediscovery. |
| `src/service.ts` | OS service manager (macOS launchd, Linux systemd, Windows schtasks): always-on proxy with crash restart. Facade over the `src/service/` leaves — `src/service/launchd.ts`, `src/service/systemd.ts`, `src/service/windows-ops.ts`, `src/service/windows-scheduler.ts`, `src/service/windows-taskxml.ts`, `src/service/state.ts`, `src/service/guards.ts`, `src/service/health.ts`, `src/service/repair.ts`, `src/service/orchestration.ts`, `src/service/diagnostics.ts`, `src/service/cli.ts`. |

`src/cli/provider.ts` accepts the Google-only `--google-tool-schema-policy` creation flag and rejects
an unknown value or non-Google effective adapter before persistence. The persisted field and default
are owned by the [config contract](config.md#config-surface).

The `src/` root stays thin: process entry (`src/cli.ts`, `src/index.ts`), shared config/types,
router, bridge, service manager, reasoning-effort definitions, and the stall-timeout budget live
there. Feature code is grouped by responsibility:

| Group | Directories |
| --- | --- |
| Data plane | `src/adapters/`, `src/responses/`, `src/chat/`, `src/claude/`, `src/grok/`, `src/images/`, `src/vision/`, `src/web-search/` |
| Codex integration | `src/codex/`, `src/combos/`, `src/providers/`, `src/oauth/` |
| Surfaces | `src/server/`, `src/cli/`, `src/tray/`, `src/github/` |
| Evidence and contracts | `src/compatibility/`, `src/lab/` |
| Support | `src/lib/`, `src/storage/`, `src/usage/`, `src/update/`, `src/generated/` |

`src/generated/` is build output committed for the runtime; it is not edited by hand.

`src/server/` is split by responsibility: `index.ts` owns the listener and the startup transaction
while `index/serve-options.ts` owns route ordering; `responses.ts` and `responses/core.ts` compose
Responses handling from the owners inventoried in [Responses transport](transports/responses.md),
and `responses/compact.ts` owns compaction; `images.ts` owns the standalone Images relay;
`responses/codex-auth-error.ts` owns the shared Responses/compact Codex auth-context HTTP mapping.
Model entitlement denial is a 400 request error and temporary exhaustion of every model-capable
account is a retryable 429; neither is reported as an invalid API key. Images, Live, and Search
reuse that model-availability mapping while retaining their existing credential handling. Account
selection, credential materialization, logging, and transport stay in their existing handlers;
`management-api.ts` owns `/api/*`;
`lifecycle.ts`, `request-log.ts`, `relay.ts` (incl. the shared `createSseInspector` SSE inspection
factory), `relay-eager.ts` (#314 gated eager bounded passthrough relay), `memory-watchdog.ts`
(warn-only RSS sampler), `management/system-routes.ts` (`/api/system/*`), and `auth-cors.ts` own
server infrastructure (`src/lib/bun-stream-caps.ts` owns the Bun stream-capability gate); and
static GUI, WebSocket bridge, port/liveness, decompression, and adapter-resolution helpers live in
their own files.

## Lifecycle

Startup catalog sync and native restore apply the [retired-native policy](catalog.md#shared-catalog).
Codex quota processing has shared and Reserve scopes; retired model evidence is suppressed as
described in [OpenAI quota ownership](providers/openai-tiers.md#public-provider-contract).

`ocx start` refuses a duplicate PID, starts the proxy, writes `~/.opencodex/ocx.pid` and
`runtime-port.json` through `src/config/process-state.ts`, syncs Codex config/catalog, then serves
until shutdown. Normal shutdown restores native Codex. Service mode sets
`OCX_SERVICE=1`, so managed restarts do not repeatedly restore/reinject; explicit service stop and
uninstall still restore.

A busy preferred port is never resolved by starting somewhere else. Both questions a start asks
about an existing proxy — the pre-bind owner check and the port-is-busy check in `src/cli/index.ts`
— are identity probes with a retry budget, because a start that answers "nobody is there" on one
lost probe deletes this home's pid record and then binds a second listener that takes over the
records and re-points Codex at itself. `probePortOwner` in `src/server/proxy-liveness.ts` asks the
busy port directly, on both loopback families, independent of the pid and runtime records; the
outcome is the pure decision `decideBusyPreferredPort` in `src/cli/dispatch.ts`. An opencodex
holder is refused with the same message the owner check prints (exit 0 instead under
`OCX_SERVICE=1`, so the wrapper loop terminates), and a holder that does not identify as opencodex
is reported as such rather than called foreign, because an identity probe cannot distinguish a
foreign server from an unreachable one. An explicit `--port` still never hops — it waits for the
pin through `src/server/port-reclaim.ts` — and a configured `port: 0` still means "ask the OS".

Every `startServer` invocation acquires the `src/lib/spend-ledger-owner.ts` SQLite writer lease
for its resolved OpenCodex state directory before loading configuration or binding a listener.
References share one lease only inside one process and one directory; a different directory in
that process is refused while the lease is held, because the shared ledger is process-wide. The
refusal is about two directories owned at once, not forever: releasing the final reference
discards the singleton with its binding, so the same process may then own a different directory
and build a ledger by replaying that directory's own journal. A second process on the same
directory is refused even for observe-only spend configuration, while a separate directory is
independent. Ordinary stop releases the final reference after listener teardown, and every thrown
startup path releases its reference. SQLite and the OS release a crashed owner; no PID, timestamp,
TTL or lock-file deletion participates in recovery.

An explicit Codex integration OFF skips startup cache invalidation before the user-scoped catalog
serialization lock is resolved. Explicit `sync` and `sync-cache` retain their catalog-only override.

`startServer` composes up to three sockets in one synchronous startup transaction: the public data
listener, the optional unauthenticated data-loopback listener, and the optional hub-management
listener.

The data-loopback socket serves a fixed data-plane allowlist: Responses and its compact sibling,
the native search relay, the standalone Images POSTs, keyed file/stream transcription, `GET /v1/models`, the realtime voice shapes,
and the Anthropic and OpenAI chat wires the host's own local clients speak — `POST /v1/messages`,
`POST /v1/messages/count_tokens`, and `POST /v1/chat/completions`. It never serves `/api/*`,
`/healthz`, `/readyz`, or GUI routes, so local management discovery has to use an authenticated
surface with a management credential.

The hub-management socket is enabled only by `runtimeRole: "hub"` plus
`hub.managementIngress.enabled`, always binds `127.0.0.1`, and default-denies everything except
GUI, session bootstrap/exchange, and `/api/*`.

### Claude intercept pair

At the end of the startup transaction, `startServer` also starts the optional Claude intercept pair
through `src/server/index/claude-intercept-lifecycle.ts` (fire-and-forget start, `ownsListener` for
the ingress decision, `stop` joined into the listener shutdown) from `src/claude/intercept/runtime.ts`: a loopback HTTP CONNECT proxy (`src/claude/intercept/connect-proxy.ts`)
and a loopback TLS listener (`src/claude/intercept/listener.ts`) that presents a leaf for
`api.anthropic.com` signed by a per-install authority (`src/claude/intercept/local-ca.ts`, persisted
under `<OPENCODEX_HOME>/claude-intercept/` with a 0600 key; never installed into an OS trust store). CA reads and pair publication share a directory-bound SQLite lease; persisted certificates must match their private key and verify as a self-signed CA. Startup retries only lease contention with bounded asynchronous backoff before binding either listener.
Claude Code reaches the pair through `HTTPS_PROXY` plus `NODE_EXTRA_CA_CERTS` in its settings env
(`src/claude/intercept/settings.ts`), so no `ANTHROPIC_BASE_URL` rewrite is involved and the client
still believes it talks to Anthropic. The proxy splices `CONNECT api.anthropic.com:443` onto the TLS
listener, relays every other CONNECT target blind, and refuses plain proxied HTTP and loopback targets.
The TLS listener rewrites `POST /v1/messages` and `POST /v1/messages/count_tokens` onto a loopback
origin and dispatches them to the same route table under the `claude-intercept` ingress, which takes
the loopback request policy; every other path on the intercepted host is relayed verbatim to the
configured Anthropic upstream. The pair is on by default on a hub (`claudeCode.intercept.enabled`),
its proxy port defaults to the public port + 100 (`claudeCode.intercept.port`), and a bind failure
degrades to a startup warning rather than a startup failure; stop joins both sockets. A server asked
for an ephemeral public port (`startServer(0)`, the shape every in-process test fixture uses) has no
stable port to derive from, so the pair stays off unless `claudeCode.intercept.port` is explicit.

Auxiliary listener bind failures carry the listener key and effective address through `AuxiliaryListenerBindError` in `src/server/ports.ts`. `src/cli/index.ts` reports them without retrying the public port. Startup still rolls back every earlier socket synchronously.

A failed optional bind initiates rollback of every earlier socket; normal stop joins all bound
sockets before lifecycle release. The existing launchd/systemd installer remains the service owner
and continues loading the data token from `service-api-token`; hub mode adds no service-manager
fork and no token-bearing unit/plist field.

> Decision record: [ADR-0002](decisions/ADR-0002-lifecycle.md)

The process-state boundary deliberately exposes two PID checks. `readAlivePid()` is the cheap
non-destructive probe used by liveness polling. `readPid()` and `verifyPidIdentity()` include the
fixed-path command-line check required before stop, kill, port reclaim, or stale-state deletion.
Callers must not replace the latter with the former merely to avoid the Windows WMIC/PowerShell
probe. Expected-PID and snapshot removal helpers are the TOCTOU boundary when a replacement proxy
can write new state during a probe.

Ownership of a pending-teardown receipt is decided by that same identity rule. The receipt records
the PID that accepted the obligation, and `handleStop` treats an owner as still running only when
the live PID is verifiably an opencodex process (`isProcessAlive` composed with
`isLikelyOcxProcess`). Bare liveness is not sufficient and is a regression here: the OS reuses PID
numbers, so once the owner exits an unrelated process can inherit its number, and a cheap probe
then reports the stop as still in flight for as long as that process lives. The receipt is filtered
out of the recovery loop and is never recovered, quarantined, or even mentioned, while both updater
gates keep seeing an outstanding obligation — a permanent fail-closed `teardown-outstanding` abort
with no proxy running and a dead owner (#4897). `isLikelyOcxProcess` asks the broader question than
`verifyPidIdentity`, without the `start` verb, because a receipt owner is an `ocx stop` or the
`ocx update` worker that drove it rather than the proxy. Recognizing a receipt as abandoned only
admits it to recovery; a valid receipt must still prove its recorded endpoint is down before
anything is restored, and the package launcher still decides nothing itself.

Port reclamation must honor a rejected OCX verifier result even for a PID captured before stop or
update. A rejected live holder prevents both termination and TCP-row deletion for that scan; later
scans may proceed if verification succeeds or the holder exits. The allowlist narrows termination
eligibility and supplies no identity evidence by itself. This contract uses the existing verifier;
it does not add process-instance proof or change the classification cache.

Pinned post-update retries in `src/update/job.ts` retire a child after an observed exit, signal, spawn error, or close event.
Both retry and final-timeout cleanup check the retained child object; a late exit from an older
child cannot clear its replacement. Retirement removes only its own event listeners and preserves
separate logging. A healthy child remains running. This does not provide an
atomic OS guarantee against unobserved PID reuse.

> Decision record: [ADR-0003](decisions/ADR-0003-lifecycle.md)

An installed Codex shim is checked on ordinary CLI startup with a regular-file/1 MiB state bound plus
bounded metadata and prefix reads. A complete replacement must produce identical fingerprints and
prefixes across a 100 ms observation interval; changing launchers are silently deferred, while mixed
sibling sets warn and defer as a unit. Guarded repair holds a self-identifying atomic-mkdir
interprocess lock across its final revalidation, rename, shim write, and state commit. Its owner record
uses the unique token as the filename, so stale-owner deletion cannot name a successor's record. An
aged lock is reclaimed only when its owner PID is no longer alive and the same token, lock-directory
identity, and owner fingerprint are still present immediately before deletion. Repair preflights every
tracked sibling before mutation and rolls back earlier siblings in reverse order on a later race.
Failures warn without changing the requested command's exit behavior. The probe uses read-only config
diagnostics only for a confirmed candidate and never reads adjacent auth state.

Unix install-probe cleanup refusals retain their fail-closed behavior and report a bounded
diagnostic suffix: a fixed probe phase, allowlisted native error/signal, and bounded exit status.
Metadata contents, launcher paths and raw child errors never enter that suffix. Diagnostic
classification does not grant process ownership or change rollback/termination policy.

Codex CLI update inspection is split from mutation. `system codex-cli-update check` makes no
package-registry request and reads bounded provenance evidence for the configured launcher candidate, npm ownership layout,
package metadata, and shim binding. The proof-bound launcher snapshot does not attest successful Codex execution;
environment and persisted candidates remain report-only and cannot produce a managed classification in this one-shot command.
On Windows this first slice performs no candidate/configuration filesystem I/O: it preserves only proof-captured
absolute environment candidates for lexical app-bundle/version-manager reporting and otherwise fails closed. That
fail-closed result records which observation was missing: a run with no proof-captured environment candidate reports
`windows_inspection_deferred`, because persisted selection is never consulted there and the command cannot claim that
no Codex CLI exists; a captured candidate whose path is not lexically eligible reports `candidate_path_unavailable`.
POSIX keeps `candidate_unavailable` for an unobserved candidate.
This check does not attest or admit a selected runtime. The command exposes no private mutation authority and does not query
a registry, execute Codex/npm, install, repair, stop, restart, or change configuration/cache state.

The bridge enforces a heartbeat stall deadline. It defaults to 300 seconds sampled on a 2 s tick
(`src/stall-timeout.ts`) and is configurable, so treat the number as a default rather than an
invariant; sidecars keep their own clocks. On expiry the stream is closed and the upstream request
cancelled. If the adapter generator ends without an explicit done/error event, the response is marked
`incomplete` rather than `completed` so Codex can distinguish a clean finish from a truncated stream.
On `error` / incomplete / stall / EOF — and when assembled non-freeform tool arguments fail to parse —
an open tool call is cancelled as `status: "incomplete"` without `function_call_arguments.done`, so
the client never sees a completed call ahead of `response.failed` / `response.incomplete`.
At the freeform boundary, `src/responses/apply-patch-envelope.ts` unwraps the contractual `input`
field for every tool. Only bare `exec` and `apply_patch` calls may recover one recognized alternate
body field or remove one complete outer Markdown fence; ambiguous alternate fields and every other
freeform grammar pass through unchanged.

The server exposes `POST /api/stop` which restores native Codex config, stops any installed service
(to prevent respawn), and exits the process. The GUI sidebar stop button calls this endpoint.

> Decision record: [ADR-0004](decisions/ADR-0004-lifecycle.md)

## Remote Hub hardening ownership

`src/cli/connect.ts` resolves only through the first valid local Codex runtime for catalog
readiness, then reads that runtime's effort ladder without persisting its selection. Rejected
preferred candidates still fall back in priority order. General `ocx status` retains full runtime
discovery and passes its resolved command into readiness, avoiding a second version probe without adding cache state.

`ocx config show` stays outside that lifecycle path. `src/cli/config-command.ts` reads the validated
config snapshot and the bounded service-token observation needed for its `_remoteHub` annotation;
it does not import the connect command, inspect catalog readiness, acquire lifecycle locks, or run
config/secret ACL hardening.

`src/remote/protocol.ts` owns pure interval/feature negotiation. `src/remote/hub-state.ts` owns the `GET|HEAD /v1/hub-state` contract, its caps, and the parser both sides share. `src/client/hub-client.ts` owns bounded, schema-validated remote catalog consumption, hub-state reads, and key-id probes; `src/client/hub-state.ts` owns the resolution and the owner-stamped 0600 cache, and a failed read reports "unavailable" rather than degrading to the client's own local provider and login state. `src/client/hub-relay.ts` is a fixed-authority management relay with URL, header, body, redirect, and stream bounds. The public data listener remains the direct client→hub path; the loopback management ingress never serves data-plane routes.

### Remote Hub status credential binding

`src/cli/status.ts` rereads the persisted client connection and `service-api-token` state before
requesting hub state. It passes a usable token only when the current connection matches the
status snapshot's `serverUrl`, `apiKeyId`, and `connectedAt`, and the token fingerprint matches
the current connection's `tokenFingerprint`. Otherwise it skips the live request and uses the
snapshot owner's matching cached hub state, or reports `unavailable`.
A withheld token carries its own cause into the reported `reason` through
`resolveHubState`'s `withheldTokenReason`, so a changed connection, a missing token file, and a
fingerprint mismatch are named separately rather than all reported as a missing data key.

Codex display-cache expiry, retained blocking main-policy evidence, and reset history follow the
[quota cache contract](providers/openai-tiers.md#quota-cache-and-short-window-history).

Usage consumers preserve positive incomplete-history metadata as specified in
[usage accounting](gui-and-management-api.md#usage-accounting); readable totals are not represented
as a complete ledger. The same contract owns `src/usage/log.ts` append-path permission rechecks and
their bounded cache.

Connected `ocx usage` reads `/v1/usage` through `src/client/hub-client.ts`, using its enrolled data key and checking connection/token ownership before and after the read. It reports hub/client scope and never substitutes local totals on failure. Standalone commands retain their management endpoint.

The client usage read requires HTTPS or loopback HTTP before adding the enrolled credential, and sets request `cache: "no-store"`; the hub response also forbids caching.

The shared atomic replacement publisher also identifies explicit Remote Workspace file writes as `remote-workspace`; its isolated owner and support limits are documented in [Remote Workspace](remote-workspace.md).

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](remote-workspace.md) owns that integration.

Chat helper admission in `src/server/responses/request-sidecar-auth.ts` follows the
[deferred stored-main contract](providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

Automatic Codex pool selection and account status share the [plan exclusion contract](providers/openai-tiers.md#automatic-pool-plan-exclusions).

### Empty forced search answers

`src/web-search/loop.ts` makes at most one extra answer attempt after a clean forced-answer terminal with no visible output or tool call. The recovery has no tools and reuses gathered search results. Malformed calls fail before refusal/truncation passthrough, and well-formed recognized refusal/truncation terminals pass through unchanged, including empty or partial answers. The extra generation may incur provider usage.
## Scoped provider quota for Combo selection

`src/providers/quota/report-cache.ts` publishes routing evidence only when a producer explicitly supplies its
inference-wide projection. A matching credential alone does not grant veto authority. Display-only
account, model-group, search and legacy MCP windows remain visible but cannot exclude a provider.
The private WeakMap binds provider name, adapter, destination and captured credential; neither
credential nor binding enters report JSON.

`src/providers/quota-routing-cache.ts` rechecks the live single key, effective authentication,
static credential headers and key-pool size. Unknown, invalid, future or 30-minute-old evidence
cannot rank or veto a provider. `src/combos/resolve.ts` uses that same scoped getter for selection,
reset-window ordering and catalog inactivity. Changing a key, destination or adapter invalidates
the old binding; restoring the same configuration may reuse still-fresh evidence. Account admission,
cooldowns and response-driven retry remain authoritative.

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](gui-and-management-api.md#combo-editor-routing-quota).

Canonical Spark Lite metadata follows the final serialized model and surviving nonempty Lite tool catalog; see [Responses transport](transports/responses.md).

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](transports/responses.md).

Responses route normalization resolves provider summary defaults from the original wire preference on every final route. See [reasoning presentation](providers/chat-compat.md) and [CCA summary provenance](providers/google.md).

## Live sideband handshake

`src/server/index/serve-options.ts` establishes the authorized upstream live sideband before accepting the client WebSocket upgrade, and `src/server/index/live-sideband.ts` implements the bounded upstream dial. `openLiveSidebandUpstream` bounds the handshake to ten seconds and retains at most 32 frames and 1 MiB of preamble within the frame limit. `src/server/ws-bridge.ts` defines the runtime handoff carrying captured frames or terminal state. Failed handshakes return 502/504 and client cancellation returns 499; exact upstream 404/410 status is unavailable from Bun's client WebSocket. Admission ownership lasts until upstream close/CLOSED, including failed upgrades and failed attachment. The ordinary Responses WebSocket exchange remains separate.

The relay is transparent in both directions, and that includes the close: a downstream client's close code and reason are carried to the upstream through `clientCloseForUpstream`, which only substitutes 1000 for a code no endpoint may send and truncates the reason to the 123-byte control-frame limit. This matters to the caller, because a Frameless v3 client reads upstream 1000 as the session completing and any other code as a transport loss to reconnect.

`OCX_LIVE_FRAME_LOG` records both frame metadata and sideband lifecycle stages (`upstream-open`, `upstream-failed`, `relay-attached`, `relay-closed`) in one JSONL, content-free in both shapes. The lifecycle half is what separates a join that never reached this proxy from one whose upstream handshake was refused and from a live relay that carried nothing; frame records alone leave all three as an empty file. `tests/server/server-live-realtime-fixtures.test.ts` drives each sideband stage against de-identified Frameless v3 fixtures in `tests/fixtures/realtime-voice-sideband/` so a failure names the stage.

Paginated and migration-capable history follows the [authoritative writer contract](codex-home.md#paginated-history-writer-boundary); this document adds no independent writer guarantee.

Codex pool settings and their consumers follow the [reset-first ordering contract](providers/openai-tiers.md#reset-first-account-ordering), including independent-quota fallback, preserved affinity, strategy-specific threshold summaries, and shared short-observation freshness for switch warnings.

Claude replay carries [Go conversation affinity](data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.

Private pool credential metadata follows the [quota-history publication identity contract](providers/openai-tiers.md#quota-history-publication-identity); credential-only and account DTO projections omit it.

Cline CLI joins the existing export/client integration registries. Explicit CLI sync and POST /api/sync refresh its owned pair; unattended catalog refresh excludes it. See [Cline paired files](clients/integrations.md#cline-paired-files).
Its paired-file writer uses the config atomic-write primitive that replaces the named entry without
following a final symlink, so an exchange during a mutation cannot redirect the write.

`claudeCode.stabilizePromptCache` is a default-off operator setting for
[translated instruction stabilization](data-planes/inbound-compat.md#opt-in-claude-instruction-stabilization).
Config JSON preserves the boolean; only literal true activates the role-changing transform.
The lightweight top-level CLI help counts Cline CLI among the fifteen registered export clients; registry parity remains covered by the client help and integration tests.

Devin CLI credential path composition in `src/oauth/devin/cli-import.ts` follows the selected platform: Windows uses Win32 APPDATA paths, other platforms use POSIX XDG-data paths. The explicit absolute override remains verbatim; credential parsing and login behavior are unchanged. The `src/providers/devin-provider-merge-migration.ts` startup migration treats the legacy provider row and its OAuth slot as one account-bound unit: an occupied destination or a refused config projection leaves both unchanged, and both backups complete before either file changes. The adapter takes a tenant host only from the stored account that owns the exact key being transmitted, in the literal slot or, during a detached rekey window, the alias slot, so separately configured or forwarded credentials and non-owning accounts cannot lend another account's destination.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.
Pool quota producers and account commands follow the [bounded raw-observation contract](providers/openai-tiers.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

The account history response can include a [low-confidence effective capacity estimate](providers/openai-tiers.md#observed-effective-token-capacity); usage normalization retains local-answer provenance so local responses cannot supply samples.

Account quota surfaces use [safe probe diagnostics](transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Translated Chat request construction uses the [inline-image budget](transports/streaming-health.md#translated-chat-inline-image-budget); the shared normalizer counts retained bytes even when a wire-specific drop callback keeps the image attached, rejects inputs above the safe decoded-pixel ceiling, caps native decode work process-wide, and stops queued work when the request is cancelled.

OpenCode catalog discovery in `src/cli/opencode.ts` derives a catalog-only bearer from the local admin credential and uses a validated numeric-loopback management origin. `src/server/management-auth.ts` accepts that derived bearer only for the exact `GET /api/models` read, so a spoofed listener cannot capture reusable administrator authority; that read can still finalize a pending initial model selection, so the bearer is catalog-scoped rather than strictly read-only. The launcher dials through `src/server/direct-local-http.ts`, rejects redirects and preserves the request/body deadline. Hub ingress selection stays separate from exported inference settings.

The [explicit model-capability contract](config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture. Vision dispatch consumes those declarations together with registry/vendor metadata before any image-bearing upstream send.

## Capability-aware image admission

The `anthropic` OAuth and `anthropic-apikey` presets in `src/providers/registry/entries-core.ts`
declare `modelInputModalities: ["text", "image"]` per model for the nine Claude seeds in
`src/providers/registry/model-seeds.ts`. Existing enrichment fills missing entries while preserving
explicit operator overrides; unknown models receive no new declaration. Client eligibility filters
and Anthropic image wire handling remain unchanged.

`src/vision/plan.ts` prevents raw image bytes from reaching any target whose effective capability is positively known to exclude image input. Evidence is consulted highest-first: `modelCapabilities`, an explicit custom row for the same routed identity, `noVisionModels`, an explicit per-model modality list without `image`, then backend-specific/registry/vendor metadata. A proven text-only target is preprocessed through the configured Vision Sidecar; a positively image-capable target receives the image directly. Genuinely unknown custom models retain the existing compatibility path rather than being guessed text-only.

Canonical ChatGPT Codex forwarding uses the generated `openai-codex` capability bundle rather than the public `openai` bundle. This matters when the two backends differ: for example, the vendored metadata records `gpt-5.3-codex-spark` as text-only on `openai-codex` while the public OpenAI row lists image input. The native Chat fast path and web-search image verbalization consume the same effective-capability decision.

An explicitly configured routed `visionSidecar.model` is dispatchable unless capability evidence positively proves it cannot accept images; an unknown custom sidecar is not guessed blind. If a proven text-only main target has no usable sidecar plan, image parts are stripped before the upstream request rather than forwarded raw. `modelInputModalities` is symmetric evidence: `["text","image"]` proves image support while `["text"]` triggers preprocessing. Runtime provider hooks such as injected `fetch` functions are preserved without mutation during capability enrichment.

Regression coverage: `tests/vision/vision-cache.test.ts`, `tests/vision/vision-eligibility.test.ts`, `tests/vision/vision-routed.test.ts`, and `tests/adapters/openai/openai-chat-native-policy.test.ts`.

Provider-scoped approval reviewer settings are projected by the [catalog owner](catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

Renamed fixed-key providers receive [missing reasoning metadata](catalog.md#renamed-destination-reasoning-metadata) during derivation; explicit per-model entries and provider defaults retain precedence.

Translated audio/file admission follows the [final-adapter input contract](adapters/registry.md#untranslated-input-media); native raw passthrough remains separate.
## Request-local target compatibility

Google's final adapter compiler may emit an opt-in, content-free
[tool-schema loss diagnostic](providers/google.md#google-tool-schema-loss-reporting). It observes
adapter-local narrowing only and changes neither provider routing nor the serialized request body.

`src/adapters/openai-responses.ts` omits only top-level `user` at the canonical ChatGPT Codex forward destination. Claude translation retains its original identity and prompt-cache key; public API and noncanonical gateways retain their `user` field. Input roles, tool-schema properties, safety identifiers and original replay bodies are not changed.

`src/combos/failover.ts` treats four intact HTTP 400 invalid-request envelopes as request-local incompatibilities: exactly `Unsupported parameter: user`; `unsupported_value` naming `reasoning.effort` or `reasoning_effort` with an explicit unsupported-value message; `param: input` with a bounded model-scoped `does not support image inputs` message; and the exact null-code `gpt-6-astra` function-tool routing mismatch that tells an existing Responses request to use `/v1/responses`, allowing only the bare model name or its strict `YYYY-MM-DD` deployment suffix. A null provider code is accepted only for the two observed envelopes that require it. Only the exact proxy wrapper is unwrapped, within three envelopes and 16,384 characters; conflicting codes, malformed/truncated envelopes and reflected JSON do not gain hop permission.

A `response_format` capability refusal is a fifth envelope, kept separate because it needs one code and one frame the four above do not admit. The refusal must name `response_format` AND state that it is unavailable or unsupported; a message that merely names the field, such as an invalid-schema complaint, stays terminal, because replaying a malformed request at every later target is the outcome this distinction exists to avoid. `param` may be absent or explicitly null and a param naming another field fails closed. Its code set is the shared generic one plus `invalid_parameter_error`, held separately so the `user` and image branches are not widened by it. It also unwraps a single `data:` SSE frame on a one-line body — the reported gateway answers on the stream, so the error object is never extracted and the structured code arrives undefined — while a multi-event body is left alone. The next target receives the same request with `response_format` intact: no field is dropped and the output contract the caller asked for is unchanged. Traversal stays finite because combo excludes each attempted target. This verdict records no cooldown, and cancellation, origin/cyber-policy rejection and the non-replayable post-send codes are all tested before it (#4903).

The combo may advance to its next eligible unattempted target before output commitment. It records no target/provider cooldown for these request-local mismatches and does not silently drop reasoning controls or raise `none` to a supported rung. Cancellation, origin/cyber-policy rejection, non-replayable post-send errors and the existing streaming commit boundary stay authoritative. Apart from the definite context overflow below, other invalid requests remain terminal.

A definite context-window overflow is the fourth request-local verdict. A heterogeneous combo mixes windows, so "this turn does not fit THIS model" is not "this turn is impossible", and stopping at the first undersized target burned the ladder on turns a later target could hold. Evidence must come from the innermost provider message: `classifyError` remaps any occurrence of `context window`, `context length`, `maximum context` or `too many tokens` anywhere in the blob, and inheriting that looseness would let a `context_length_exceeded` token sitting in a `code` field beside `Unsupported parameter: user` authorize a replay. `src/combos/failover.ts` therefore unwraps only the exact proxy wrapper, within four envelopes and 16,384 characters, and reads the leaf message. A JSON-shaped body that does not parse fails closed, because `normalizeUpstreamErrorText` caps `classificationText` at 500 characters and a long envelope arrives here as a prefix. The verdict is admitted only for statuses that speak about the request — 400, 413, 422 and 5xx — so a 401/403 body that merely quotes context prose keeps its provider-wide cooldown instead of being rescored as request-shaped. Structured `origin_rejected`, cyber policy and the non-replayable post-send codes are all tested before it.

This is also why the classifier cannot duplicate visible output. A streaming child reaches combo classification only through `preflightComboStreamResponse`, which commits the child on any text, tool call or unknown event and synthesizes a failure envelope only for a zero-output terminal, so a turn whose text or tool call the client already saw is never reclassified as a hop.

Regression coverage: `tests/responses/responses-forward-prompt-envelope.test.ts`, `tests/routing/router-combo-failover-classification.test.ts`, `tests/routing/routing-policy-fallback.test.ts`, `tests/helpers/combo-context-overflow-cases.ts`, and `tests/server/server-combo-failover-e2e.test.ts`.

## Combo default effort precedence

`src/combos/request.ts` keeps `reasoningEffortMode` and `defaultEffortMode` independent.
The existing fifth argument remains the strict/adaptive capability-normalization policy;
the optional sixth argument enables fallback/force precedence. Force requires a valid
non-null default, overrides only valid caller effort on a known supported ladder, and
retains the existing unsupported-control stripping. It does not add a caller opt-in or
change target selection. `src/server/responses/core-combo.ts` applies the policy per child
and preserves the original requested effort separately from effective wire telemetry.
`src/server/chat-completions.ts` routes combos through that same child pipeline while
retaining the current config-aware native-Chat eligibility check for non-combo routes.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](transports/byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

## Upstream key usage identity

`src/codex/account-label.ts` owns the provider/selection digest and `src/providers/label.ts`
stamps the configured key selected for the physical request. `src/server/request-log.ts`
retains per-key attempt usage, and `src/usage/log.ts` validates and persists labels. The
[account attribution contract](gui-and-management-api.md#upstream-key-account-attribution)
defines identity, unknown records, and aggregation boundaries.

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](transports/streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

Unicode pattern normalization uses [copy-on-write traversal](transports/byte-accounting.md#unicode-pattern-normalization) while preserving the existing schema and wire semantics.

Codex compaction uses a request-local model override for the configured triggers; the
[Responses compaction contract](transports/responses.md#compaction-routing-overrides) owns its trigger and replay boundaries.

## Background-service runtime ownership

`src/service/state.ts` records who owns the running proxy in the shared service install
state, beside the install provenance. The claim carries an `owner` (`cli` or `desktop`), an
opaque `installId` naming the owning installation rather than the user or the machine, and a
`consentGeneration`. An absent claim means the CLI install that registered the service owns
the runtime, which is what every record written before the field existed says.

Every write goes through `swapServiceInstallState`. With a custom home, the default-home
record is the authority every writer can derive and the active-home record is a compatibility
mirror; with one path, that path is authoritative. `src/service/state-lock.ts` holds
token/PID/process-instance locks for every path in canonical order. A live holder is never
evicted because of age, and release deletes only its token-named owner. The authoritative
file is fsynced and atomically renamed through `src/config/atomic-write.ts`; that rename is
the commit point. Mirrors receive the exact committed bytes afterwards. A mirror failure is
diagnostic rather than rollback, and the next writer repairs it. An absent authority imports
one valid legacy mirror once; same-or-newer mirror disagreement and unreadable authority are
`unknown`, never ownership votes. Uninstall removes mirrors before the authority, so a
partial deletion cannot turn a revoked mirror claim back into migration input.

`resolveServiceOwnership` answers `none`, `owned` or `unknown` from that authoritative
generation. `consentGenerationCeiling` survives a release, so granting, releasing and
granting again cannot reuse a number an app-local record may still hold.
`recordServiceOwner` requires the exact `owner`/`installId`/`consentGeneration`/`revision`
subject shown on the consent surface. The comparison runs again inside the same lock and on
every internal retry; a mismatch or unknown subject writes nothing and requires fresh user
approval. `ownershipGrantedTo` remains the narrower relaunch test for an already-owned app.

Permanent takeover also requires `assessServiceTakeoverCompatibility` to approve both the
preserved service launcher and the selected PATH launcher. Every observed manager must be
OpenCodex 2.61.0 or later, and a preserved registration must carry ownership protocol 1.
Missing, old, malformed or unknown manager evidence blocks takeover and leaves registration
and autostart untouched. The supported verdict carries an opaque token over the approved
subject and both manager identities; `recordServiceOwner` re-observes and compares it inside
the lock, so a mutable shim or downgrade cannot inherit earlier consent. An upgrade is a
separate user-authorized action; declining or failing it leaves the app a guest.

The verbs that activate the npm registration refuse on a foreign or unknown owner:
`src/service/repair.ts` stops before it asserts, writes, stops or starts anything, and
`ocx service start` reports the same refusal. `stop` and `uninstall` are not gated, because
they deactivate. `src/update/runtime-ownership.mjs` vetoes both the pre-update stop and the
post-update service refresh for all three update lanes — `src/update/index.ts`,
`bin/ocx.mjs` and the dashboard worker in `src/update/job.ts`. The shared update decision has
three independent authorities: package replacement, runtime stop and service restoration.
Unknown and desktop ownership deny all three because a claim alone does not prove that the live
process is detached from the npm package; CLI ownership permits the ordinary stop-first
flow. Both package updaters use `src/service/install-state-contract.mjs`, backed by the single
`state-record.mjs` parser and authority selector. One mutation lease covers the fresh stop
authorization, the stop child, the current runtime-record re-read and package replacement.
The updater never treats the pre-stop address as proof that this installation is idle;
an unreadable current record is unknown, and a valid address is probed even when its recorded
PID is gone. Lease delegation is passed only to stop and recovery children, never package
manager children. A replacement refusal passes through owner-aware recovery: only the same CLI
owner revives the stopped runtime; foreign ownership stays transferred and unknown ownership
remains a reported recovery requirement. Dashboard restart delegates the lease token to its repair child. Direct
start holds the same lease through bind plus PID and runtime-address publication. If listener
rollback cannot prove the socket closed, the process retains its lease until exit.
The registration is never deleted; `ocx service install` releases the marker only after the
registration succeeds.

Bun updater lease and recovery behavior follows the [update transaction contract](ops/docs-and-release.md#bun-updater-ownership-transaction).

Companion timeline and filtered totals follow the [companion usage contract](companion.md).
