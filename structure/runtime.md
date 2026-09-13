# Runtime

The configuration-only [plaintext V2 contract](subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged.

## CLI readiness diagnostics

Catalog-derived reasoning-level diagnostics from `src/cli/connect.ts` are escaped only at the human-output boundary. C0/C1 controls, DEL, and Unicode line/paragraph separators print as visible hexadecimal escapes; structured status retains the exact reason. The ready/unverified/incompatible classification and exit policy are unchanged.

## Entrypoints

| Path | Responsibility |
| --- | --- |
| `bin/ocx.mjs` | Published npm `bin` entry (Node shim). Resolves the bundled or explicit Bun binary before project dotenv can load, stamps its runtime provenance plus a proof-bound Anthropic parent-env snapshot, lazy-runs `bun/install.js` if only the placeholder stub is present, then execs `src/cli/index.ts` under Bun. Lets `npm install -g` work without a separately-installed Bun. The exact `system codex-cli-update` inspection namespace skips both boot repair and lazy Bun installation; missing runtime support fails closed instead of mutating state. |
| `src/lib/bun-runtime.ts` | Bundled-Bun resolution: `isRealBunBinary()` (size gate vs the ~450-byte placeholder stub), `bundledBunPath()`, and `durableBunPath()` (path baked into service/shim artifacts). Durable selection accepts only the source/path pair already stamped for the running executable; it never re-reads a project-dotenv `OPENCODEX_BUN_PATH`. |
| `src/cli/index.ts` | `ocx` / `opencodex` CLI. Lifecycle: init, start, stop, restart, status, sync, restore/eject, gui, service, update. Configuration: provider, account, models, combo/route, access, integrations, v2. Client launchers: Claude, OpenCode, MiniMax Code, and MiniMax CLI text. The MMX launcher owns a child-lifetime loopback path bridge from the client's hard-coded `/anthropic/v1/messages` path to the canonical `/v1/messages` data plane; the server does not expose an extra auth surface. Diagnostics: doctor, debug, observe, health. Windows adds tray. The full command surface is `src/cli/help.ts`; this table names the groups, not every verb. After help/version early exits, ordinary commands run the bounded best-effort Codex-shim auto-restore policy before dispatch. `system codex-cli-update` is the deliberate read-only exception and suppresses auto-restore for its whole namespace, including malformed invocations. Keeps the `#!/usr/bin/env bun` shebang for from-source dev (`bun run src/cli/index.ts`). |
| `src/server/index.ts` | Bun server entrypoint: `startServer`, `/v1/responses` HTTP + WebSocket routing (compact handled before generic Responses), exact `POST /v1/images/generations` and `POST /v1/images/edits` routing, `/v1/models`, the Anthropic-shaped `/v1/messages` and OpenAI-shaped `/v1/chat/completions` compatibility surfaces, the Live/Realtime surface, the hosted-search relay, artifact serving, `/healthz`, the `/api/*` auth gate, the `/v1/*` JSON 404 guard, GUI fallback, the opt-in loopback-only hub-management listener, and facade re-exports for split server modules. |
| `src/server/images.ts` | Standalone Images data plane: default OpenAI or explicit custom-provider selection, Codex account affinity, bounded opaque request relay, single-attempt upstream fetch, pool health recording, and safe response/cancellation relay. |
| `src/server/audio-transcriptions.ts` | Standalone multipart transcription; audio-specific key admission, bounded upload/response, stored OpenAI credential resolution and lease-bound cancellation. See [audio contracts](data-planes/inbound-compat.md#standalone-file-transcription). |
| `src/server/audio-live.ts`, `src/server/audio-dictation.ts` | External voice/dictation orchestration using the existing bounded socket relay, server-owned credentials, cancellation and opaque call ownership. See [streaming audio](data-planes/inbound-compat.md#streaming-audio). |
| `src/config.ts` | Persisted `~/.opencodex/config.json` schema, defaults, migrations, transactions, and compatibility re-exports for split config modules. |
| `src/config/paths.ts` | Resolves `OPENCODEX_HOME`, `config.json`, and owner-only directory hardening. |
| `src/config/atomic-write.ts` | Shared synchronous/asynchronous temp-harden-rename writer and residual-temp failure contract. |
| `src/config/process-state.ts` | Owns `ocx.pid`, `runtime-port.json`, cheap liveness, full command-line identity verification, and snapshot-guarded cleanup. |
| `src/server/ports.ts` | Owns bind availability and ephemeral-port selection. Temporary probes dispose accepted peers and wait for listener close before reporting success. |
| `src/cli/status.ts` / `src/cli/status-probes.ts` | Status snapshot assembly and the shared read-only health/stale-process probes used by status and doctor. Probe evidence keeps recorded-port choice, before/after snapshots and per-call timer cleanup together. |
| `src/router.ts` | Provider/model selection before adapter dispatch. Policy execution and ordinary management dry-run share effective-provider capability evidence; unresolved, missing, and disabled providers are excluded before scoring. |
| `src/providers/api-key-selection-capture.ts` | Pure request-owned snapshot of the configured key entry, reference, and revision. The router and stateful selection module share this leaf with type-only dependencies; `api-key-selection.ts` retains the compatibility export and owns persisted selection changes and route resolution. |
| `src/types.ts` | Shared config, parsed request, adapter, and event types. |
| `src/reasoning-effort.ts` | Codex reasoning-level definitions (`low`/`medium`/`high`/`xhigh`), per-model effort mapping, and catalog effort sanitization. |
| `src/codex/shim.ts` | Codex autostart shim: replaces the `codex` binary with a wrapper that auto-starts the proxy on demand. It skips startup for management subcommands even when value-taking global flags precede the subcommand, and transactionally restores complete, stable external launcher replacements without a watcher or PATH rediscovery. |
| `src/service.ts` | OS service manager (macOS launchd, Linux systemd, Windows schtasks): always-on proxy with crash restart. |

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

`src/server/` is split by responsibility: `index.ts` owns the listener and route ordering;
`responses.ts` owns Responses handling and compaction; `images.ts` owns the standalone Images relay;
`responses/codex-auth-error.ts` owns the shared Responses/compact Codex auth-context HTTP mapping,
while account selection, credential materialization, logging, and transport stay in their existing handlers;
`management-api.ts` owns `/api/*`;
`lifecycle.ts`, `request-log.ts`, `relay.ts` (incl. the shared `createSseInspector` SSE inspection
factory), `relay-eager.ts` (#314 gated eager bounded passthrough relay), `memory-watchdog.ts`
(warn-only RSS sampler), `management/system-routes.ts` (`/api/system/*`), and `auth-cors.ts` own
server infrastructure (`src/lib/bun-stream-caps.ts` owns the Bun stream-capability gate); and
static GUI, WebSocket bridge, port/liveness, decompression, and adapter-resolution helpers live in
their own files.

## Lifecycle

`ocx start` refuses a duplicate PID, starts the proxy, writes `~/.opencodex/ocx.pid` and
`runtime-port.json` through `src/config/process-state.ts`, syncs Codex config/catalog, then serves
until shutdown. Normal shutdown restores native Codex. Service mode sets
`OCX_SERVICE=1`, so managed restarts do not repeatedly restore/reinject; explicit service stop and
uninstall still restore.

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
absolute environment candidates for lexical app-bundle/version-manager reporting and otherwise fails closed.
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

The server exposes `POST /api/stop` which restores native Codex config, stops any installed service
(to prevent respawn), and exits the process. The GUI sidebar stop button calls this endpoint.

> Decision record: [ADR-0004](decisions/ADR-0004-lifecycle.md)

## Providers and adapters

| Path | Responsibility |
| --- | --- |
| `src/providers/registry.ts` | Canonical provider presets for CLI, dashboard, OAuth, key providers, and metadata. |
| `src/providers/derive.ts` | Enrichment from provider presets into user config. |
| `src/oauth/` | OAuth providers, token storage, refresh, and auth-token resolution. The login callback listener binds a per-provider FIXED loopback port, so consecutive logins reuse the same number; every response it sends ends its connection (`Connection: close`, including non-callback paths such as a stray `/favicon.ico` 404). Stopping the listener does not close an established socket, so without that a pooled client would deliver the next login's callback to the retired flow, which rejects the unknown state as a CSRF mismatch while the live flow waits. |
| `src/combos/request.ts` | Clones each selected combo target request and applies the existing target capability ladder: adaptive unknown targets and explicit empty ladders receive no unsupported reasoning/thinking controls, while known ladders retain per-target resolution. |
| `src/adapters/openai-responses.ts` | Native OpenAI/ChatGPT Responses passthrough. |
| `src/responses/muse-tool-name-alias.ts` | Host-gated Meta Muse 64-char tool-name alias/restore used by the Responses passthrough. |
| `src/adapters/openai-chat.ts` | OpenAI-compatible Chat Completions bridge. Its client delivery shapes in `src/chat/outbound.ts` and `src/server/chat-native-sse.ts` relay the upstream `service_tier` echo on non-stream, folded-stream, and synthesized-SSE bodies, never inventing the key when the upstream omits it. |
| `src/adapters/anthropic.ts` | Anthropic Messages bridge. |
| `src/adapters/google.ts` | Gemini bridge. |
| `src/adapters/azure.ts` | Azure OpenAI bridge. |
| `src/adapters/cursor.ts`, `src/adapters/cursor/` | Cursor protobuf transport: discovery, request builder, event decoding, MCP, thread continuity, native-exec policy. |
| `src/adapters/kiro.ts` and its `src/adapters/kiro-*.ts` helpers | Kiro event/tool/thinking/truncation/retry handling. |
| `src/adapters/mimo-free.ts` | Mimo Free transport (client identity + JWT). |
| `src/adapters/image.ts`, `src/adapters/anthropic-image-guard.ts`, `src/adapters/anthropic-image-normalize.ts` | Image conversion for adapter ingress and Anthropic-specific normalization/limits. |
| `src/adapters/run-turn-queue.ts`, `src/adapters/tool-catalog-nudge.ts`, `src/adapters/identity.ts`, `src/adapters/upstream-http-error.ts` | Shared adapter execution support: turn queueing, tool-catalog nudging, client identity, upstream error normalization. |

Adapter output must stay in internal `AdapterEvent` form until `bridge.ts` converts it back to
Responses SSE or WebSocket frames.

Live model discovery is bounded and registry-driven through `src/providers/model-discovery.ts`.
Custom providers keep the conventional `${baseUrl}/models` request; canonical presets may select a
trusted URL/path/query and declarative eligibility filter without persisting that policy into user
config. A response is rejected before caching when it exceeds 4 MiB, contains more than 2,000 raw
rows, has a malformed OpenAI list envelope, or includes an invalid model id. Tests use fixtures and
must never depend on live provider endpoints. Newly promoted fixed key presets opt into
`preserveCustomDestination`, so an older same-named custom provider keeps its configured adapter,
destination, and key boundary instead of being silently canonicalized onto the new host. Fixed
OAuth presets resolve discovery against the same canonical registry transport as normal routing
before any adapter-specific transport override, so a stale configured `baseUrl` cannot receive an
OAuth bearer token.

Provider-scoped capability hints remain authoritative when discovery returns an id without
capabilities. In particular, `src/providers/registry.ts` assigns OpenCode Go's live
`deepseek-v4.1-flash` route the official 1,048,576-token window instead of the conservative 128k
routed-model fallback.

The BigModel Coding Plan Responses preset uses the separately documented
`https://open.bigmodel.cn/api/v1` transport and a static catalog. Its provider row
disables live discovery: a local Codex `models.json` example does not establish an
authenticated HTTP models endpoint. Its static context and reasoning metadata are
kept in the canonical registry, including an explicit empty selectable effort
ladder for `glm-5-turbo`.

Raycast is a managed client export, not an upstream model provider. Its YAML
contribution owns only the unique `providers/[id=opencodex]` entry, with the
existing manifest and fingerprint checks protecting user-owned provider values.
Ambiguous selector matches and incompatible containers cannot be adopted or
mutated. Catalog refresh uses the existing owned-integration activation check;
an unowned client remains disconnected. OpenCodex omits Raycast API-key fields
and exports only to eligible local targets. Pro detection is an advisory hint,
not an authentication or entitlement decision.

Routed Responses continuations whose local replay state is missing resolve their recovery decision from the selected wire protocol, not the model name; the contract lives in [Responses transport](transports/responses.md).

The shared Responses path follows the [bounded multipart recovery contract](subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## Remote Hub hardening ownership

`src/remote/protocol.ts` owns pure interval/feature negotiation. `src/remote/hub-state.ts` owns the `GET|HEAD /v1/hub-state` contract, its caps, and the parser both sides share. `src/client/hub-client.ts` owns bounded, schema-validated remote catalog consumption, hub-state reads, and key-id probes; `src/client/hub-state.ts` owns the resolution and the owner-stamped 0600 cache, and a failed read reports "unavailable" rather than degrading to the client's own local provider and login state. `src/client/hub-relay.ts` is a fixed-authority management relay with URL, header, body, redirect, and stream bounds. The public data listener remains the direct client→hub path; the loopback management ingress never serves data-plane routes.

Codex display-cache expiry, retained main-policy evidence, and reset history follow the
[quota cache contract](providers/openai-tiers.md#quota-cache-and-short-window-history).

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](gui-and-management-api.md#usage-accounting); readable totals are not represented as a complete ledger.

Connected `ocx usage` reads `/v1/usage` through `src/client/hub-client.ts`, using its enrolled data key and checking connection/token ownership before and after the read. It reports hub/client scope and never substitutes local totals on failure. Standalone commands retain their management endpoint.

The client usage read requires HTTPS or loopback HTTP before adding the enrolled credential, and sets request `cache: "no-store"`; the hub response also forbids caching.

The shared atomic replacement publisher also identifies explicit Remote Workspace file writes as `remote-workspace`; its isolated owner and support limits are documented in [Remote Workspace](remote-workspace.md).

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](remote-workspace.md) owns that integration.

Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

Automatic Codex pool selection and account status share the [plan exclusion contract](providers/openai-tiers.md#automatic-pool-plan-exclusions).

### Empty forced search answers

`src/web-search/loop.ts` makes at most one extra answer attempt after a clean forced-answer terminal with no visible output or tool call. The recovery has no tools and reuses gathered search results. Malformed calls fail before refusal/truncation passthrough, and well-formed recognized refusal/truncation terminals pass through unchanged, including empty or partial answers. The extra generation may incur provider usage.
## Scoped provider quota for Combo selection

`src/providers/quota.ts` publishes routing evidence only when a producer explicitly supplies its
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

`src/server/index.ts` establishes the authorized upstream live sideband before accepting the client WebSocket upgrade. `openLiveSidebandUpstream` bounds the handshake to ten seconds and retains at most 32 frames and 1 MiB of preamble within the frame limit. `src/server/ws-bridge.ts` defines the runtime handoff carrying captured frames or terminal state. Failed handshakes return 502/504 and client cancellation returns 499; exact upstream 404/410 status is unavailable from Bun's client WebSocket. Admission ownership lasts until upstream close/CLOSED, including failed upgrades and failed attachment. The ordinary Responses WebSocket exchange remains separate.

## Paginated history writer boundary

`src/codex/history-provider.ts` refuses external writes to paginated or migration-capable history. `src/codex/inject.ts` checks affected rows and manifest-owned restore targets before and after config/profile/journal changes, including successful journal and fallback restores, and compensates detected migration. Failed config restore stops later catalog/history work and rolls back a coordinated remove transition. See the [history writer contract](codex-home.md#paginated-history-writer-boundary) for guarantees and concurrent-writer limits.

Codex pool settings and their consumers follow the [reset-first ordering contract](providers/openai-tiers.md#reset-first-account-ordering), including independent-quota fallback and preserved affinity.

Claude replay carries [Go conversation affinity](data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.

Private pool credential metadata follows the [quota-history publication identity contract](providers/openai-tiers.md#quota-history-publication-identity); credential-only and account DTO projections omit it.

Cline CLI joins the existing export/client integration registries. Explicit CLI sync and POST /api/sync refresh its owned pair; unattended catalog refresh excludes it. See [Cline paired files](clients/integrations.md#cline-paired-files).

`claudeCode.stabilizePromptCache` is a default-off operator setting for
[translated instruction stabilization](data-planes/inbound-compat.md#opt-in-claude-instruction-stabilization).
Config JSON preserves the boolean; only literal true activates the role-changing transform.
The lightweight top-level CLI help counts Cline CLI among the fifteen registered export clients; registry parity remains covered by the client help and integration tests.

Devin CLI credential path composition in `src/oauth/devin-cli.ts` follows the selected platform: Windows uses Win32 APPDATA paths, other platforms use POSIX XDG-data paths. The explicit absolute override remains verbatim; credential parsing and login behavior are unchanged.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.
Pool quota producers and account commands follow the [bounded raw-observation contract](providers/openai-tiers.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

The account history response can include a [low-confidence effective capacity estimate](providers/openai-tiers.md#observed-effective-token-capacity); usage normalization retains local-answer provenance so local responses cannot supply samples.

Account quota surfaces use [safe probe diagnostics](transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Translated Chat request construction uses the [inline-image budget](transports/streaming-health.md#translated-chat-inline-image-budget); the shared normalizer counts retained bytes even when a wire-specific drop callback keeps the image attached.

OpenCode catalog discovery in `src/cli/opencode.ts` uses the local admin credential and a validated numeric-loopback management origin. It dials through `src/server/direct-local-http.ts`, rejects redirects and preserves the request/body deadline. Hub ingress selection stays separate from exported inference settings.

The [explicit model-capability contract](config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Exact [model input declarations](config.md#explicit-per-model-capability-declarations) now feed text-only eligibility and catalog hints; existing image-description/omission handling consumes them before the main upstream send.

Provider-scoped approval reviewer settings are projected by the [catalog owner](catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

Renamed fixed-key providers receive [missing reasoning metadata](catalog.md#renamed-destination-reasoning-metadata) during derivation; explicit per-model entries and provider defaults retain precedence.
