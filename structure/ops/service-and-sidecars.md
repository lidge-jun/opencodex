# Background Service And Sidecars

Native result continuations and function-result injection follow [the mode-specific result and control contract](../transports/streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.

Native steering follows [the shared WebSocket contract](../transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

Service endpoints are unchanged by the Responses
[core module ownership](../transports/responses.md#core-module-ownership). This surface retains its existing behavior.

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged.

Service startup and restore use the [catalog retirement policy](../catalog.md#shared-catalog);
retirement does not itself change service registration or user-selected model configuration.

Shared parsing and streaming follow the [request-copy](../transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](../transports/byte-accounting.md#stream-buffer-accounting) contracts. Response-attached WebSocket telemetry follows the [stage record identity contract](../transports/responses-wire-shapes.md#passthrough-sse-stream-shapes-314).

## Background service command selection

A bare `ocx service` is an idempotent install-or-repair command. Argument validation happens before
any platform status probe. macOS and Linux choose from the registration file's proven presence;
Windows combines the Task Scheduler and WinSW probes into `installed`, `absent`, or `unknown`.
Only proven absence enters registration. A query failure refuses the bare command with status
guidance, because treating `unknown` as absent can rerun elevated `schtasks /create` against an
existing task. Explicit `ocx service install` remains the operator-owned registration request.

> Decision record: [ADR-0028](../decisions/ADR-0028-background-service-command-selection.md)

## Windows npm tray update badge

The npm Windows tray owns six installed ICOs: online, warning, and offline base safety glyphs plus one blue-dot variant of each. Its hidden `ocx __update-badge` child reads the package cache without refreshing or writing it. The tray samples no more often than every 60 seconds, caps stdout and stderr at 16 KiB each, requests termination after 12 seconds or a pipe overflow, and reaps the child on later Windows Forms ticks before allowing another launch. A successful badge observation expires after 180 seconds; failed reads do not extend it. The **Update available** item opens the dashboard and never installs a package. Shutdown requests child termination, waits at most 500 ms, and disposes the probe before tray UI disposal.

## Windows startup ownership listing reuse

One proxy startup asks service-home ownership twice before listen: once before cache invalidation and
again immediately before native-main lifecycle preparation. The second targeted Task Scheduler query
is a deliberate race check and remains mandatory. On a localized host, however, the same nonzero
targeted answer can require a full task listing with a 20-second ceiling; running that identical
enumeration twice made a measured 12.3-second fallback cost roughly 25 seconds before listen.

> Decision record: [ADR-0029](../decisions/ADR-0029-windows-startup-ownership-listing-reuse.md)

## Service-manager probe

`src/service-manager-probe.ts` (`inspectServiceManagerInstallation`) reports what the platform
service manager has installed for opencodex, read-only and fail-closed. It reads the service
definition itself and parses the `CODEX_HOME` and `OPENCODEX_HOME` values embedded in it, because
installation writes the definition before the state file: an interrupted reinstall can leave the
two naming different homes, and on macOS a logged-out user can have the plist on disk with no GUI
domain to query. The probe returns what it saw and does not decide ownership; callers such as
`src/integrations/native/ownership-preflight.ts` compare the homes. Every command it runs is
read-only and time-bounded, so it is safe while the proxy runs under that same manager.

## Stable service launcher (launchd and systemd)

Systemd installation resolves the first absolute `ocx` PATH candidate that is both a regular file
and executable, keeps that path lexical so a version-manager shim remains an indirection, and
records the same single resolution in the service definition and service state. Definition
construction (`buildUnit`) never performs PATH discovery itself: callers provide either the resolved launcher or an explicit direct Bun/CLI
fallback, keeping diagnostics and tests independent of the host PATH. Launchd always uses the
package-local Bun and CLI pair selected by the trusted install or repair invocation; it never hands
credential-bearing service state to a mutable PATH launcher, and a `launcherPath` recorded by an
older install is reported stale so `ocx service repair` re-bakes the trusted package paths.

Launcher mode omits the package-local Bun provenance pair because an upgrade may delete that
versioned tree. The only runtime path carried through the launcher is a pre-Bun, proof-bound
`OPENCODEX_BUN_PATH` whose durable runtime source is `override`; bundled and process fallbacks are
rediscovered by the current launcher. The API-auth token remains file-backed and is loaded only by
the service shell at start. On macOS, `start` and detailed `status` compare the live launchd job
against `expectedLaunchdCommand`, which still follows a `launcherPath` recorded by a pre-pinning
install rather than re-walking PATH, so such a job is never misreported as an older plist (#3464).

> Decision record: [ADR-0030](../decisions/ADR-0030-stable-service-launcher-launchd-and-systemd.md)
> Decision record: [ADR-0100](../decisions/ADR-0100-stable-service-launcher-launchd-and-systemd.md)

## Sidecars

Web search and vision sidecars run only when the main request needs that capability and a usable
sidecar authority exists. Vision has two possible backends; web search's config union additionally
admits `xai`, `gemini`, and `exa`. xAI is a live explicit-only backend through stored Grok OAuth;
Gemini and Exa remain inert until their executors ship. Selection differs per sidecar:

| Sidecar | Backend selection | Default model | Activation |
| --- | --- | --- | --- |
| `web-search/` | Explicit configuration only: unset always resolves to the OpenAI forward path. No backend — Anthropic or otherwise — is auto-selected from credential availability (doing so once sent OpenAI model ids to the Anthropic API). Explicit xAI requires usable stored Grok OAuth and may add hosted `x_search`; explicit Gemini/Exa remain fail-closed until their executors land. | `gpt-5.6-luna` (OpenAI), `claude-sonnet-5` (Anthropic), `grok-4.6` (xAI) | Hosted `web_search` requested by a non-passthrough routed model. |
| `vision/` | Explicit configuration wins for both backends. Only an unset backend auto-selects: Anthropic when a usable Anthropic OAuth provider exists, otherwise the OpenAI forward authority. An explicitly selected backend whose authority is unavailable produces no plan rather than falling back. | `claude-sonnet-5` (Anthropic), `gpt-5.6-luna` (OpenAI) | Request carries images and the routed target is not positively proven image-capable (`requiresVisionPreprocessing`). |

The asymmetry is in the unset case only: vision may describe an image with whichever model can see
it, while a hosted search tool is tied to a provider-specific tool contract, so search never infers
Anthropic from credentials alone.

On the OpenAI path there is one deterministic `openai` sidecar candidate and its current account mode
owns credential selection; API-key OpenAI is not a ChatGPT forward sidecar candidate.

`src/sidecar/` holds what both sidecars share. `src/sidecar/auth.ts` decides whether ChatGPT or
Anthropic auth is present for sidecar purposes, from config and stored account state and never from
request headers; per-request usability stays with the executors. `src/sidecar/candidates.ts` builds
the candidate set both sidecars start from: a model may be offered as a sidecar backend only when
the management model picker would show it, except the fixed slot model of a logged-in side. Vision
then removes provably text-only models, and web search keeps only models whose probed backend has an
executor (`src/web-search/backends.ts`).

Sidecar failures must degrade to text markers or skipped capability, not abort the main request.

### Grok snapshot module ownership

The client-specific tracker lives in `grok-responses-snapshot-repair.ts`; the
provider-opt-in tracker remains in `responses-snapshot-repair.ts`. Their unchanged
object guard, JSON block encoder and retained-item shape live in the dependency-
free `responses-snapshot-codec.ts`. Core imports each tracker directly. No existing
snapshot export moves, and neither tracker imports the core dispatcher. The Grok
marker selects compatibility behavior and conveys no authenticated client identity.

Manual and automatic OAuth/API-key selection commit through their shared selection owners before
dispatch. Selection revisions fence stale retries and reselection; request identity includes the
actual committed account/key. Generic proactive selection is opt-in and preserves a healthy active
account, while reactive429 recovery remains enabled even with the pool off. Post-commit selection
events immediately invalidate dashboard roster state; see`structure/gui-and-management-api.md`.

### Incomplete quota terminals

A native forward response that ends with quota or rate-limit evidence in an
`incomplete` terminal records account quota failure and spawn-fallback health.
Structured `incomplete_details.reason` and error codes are accepted without a
message; ordinary output-limit, filtering, steering and stall incompletes do not
cool an account. Cyber-policy classification retains precedence. The terminal is
not replayed after output, and fixed-account request selection remains fixed.

Remote compact requests release the server request-idle timeout only after a complete
JSON object with a valid model has been read. Partial or invalid uploads retain
the listener guard; admitted compaction then uses the upstream operation's own
deadlines and client cancellation.

Buffered routed compaction treats nonempty text and reasoning deltas as progress
without exposing partial summary text. Comments, empty deltas and gateway
keepalives do not reset the adapter-event stall watchdog. The default stall
timeout stays 300 seconds; encrypted compaction content is preserved unchanged.

Native compact response buffering also enforces a body-byte inactivity deadline
using `stallTimeoutSec` (300 seconds by default). Nonempty chunks reset that
deadline; a stalled body returns HTTP 504, client cancellation retains HTTP 499,
and cleanup does not wait for a stuck upstream cancellation promise. The 32 MiB
response ceiling and the original body bytes are preserved.

A canonical upstream WebSocket refused-create error can become an HTTP 4xx only
before the response is committed and after stream correlation checks. Permitted
quota headers are bounded and rebuilt without upstream framing headers; the JSON
response is not cacheable. Post-commit and 5xx errors keep the no-resend path.

When encrypted agent-task recovery refuses a routed task, its existing 400 error
can include a bounded `recovery_reason`: `unsupported_envelope`,
`admission_denied`, `recovery_unavailable`, `caller_cancelled`, `input_changed`,
`recovery_http_rejected`, `recovery_timeout`, `recovery_aborted`,
`recovery_transport_error`, or `recovery_invalid_output`.
HTTP rejection requires an observed non-success response. Invalid output includes
invalid UTF-8, oversized bodies, malformed or incomplete recovery streams, and
invalid or conflicting assignments. A caller's cancellation takes precedence over
an owned deadline, which takes precedence over decode/transport failures.
`recovery_aborted` describes a shared recovery cancelled independently of that caller.
Shared-flight waiters receive the same underlying failure unless individually cancelled;
only successful plaintext is cached. Diagnostics contain no upstream error or payload text.
The field is omitted when no classified recovery result exists, and existing combo
branches that return the original target failure keep that response.
`recovery_unavailable` includes cache/singleflight capacity and does not prove an
upstream request was attempted. No retry or broader envelope acceptance is enabled.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## Voice diagnostic metadata

`src/server/live.ts` owns optional `OCX_LIVE_FRAME_LOG` diagnostics for both sideband directions.
The JSONL schema contains only `ts`, `dir`, `kind`, `bytes`, and `fffd`. It never stores frame
content or transcript excerpts, and logging failures do not affect transparent frame delivery.
Binary detection decodes only the supplied buffer view; malformed UTF-8 can itself produce U+FFFD,
so the flag does not identify the peer responsible for corruption. Existing diagnostic files are
not rewritten. Audio devices, WebRTC media negotiation, captions and spoken handoff delivery remain
client responsibilities.

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](../dashboard-and-usage.md#usage-accounting); readable totals are not represented as a complete ledger. Upstream API-key usage follows the [physical-attempt account attribution contract](../dashboard-and-usage.md#upstream-key-account-attribution), independently of subscription quota observations.

Connected CLI usage follows the [client-scoped hub usage contract](../dashboard-and-usage.md#usage-accounting); local management and account data remain separate.

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](../remote-workspace.md) owns that integration.

Auxiliary listener startup failures report their own effective address and do not trigger public-port retries; the synchronous rollback contract is described in [Runtime](../runtime.md#lifecycle).
Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../dashboard-and-usage.md#combo-editor-routing-quota).

Codex pool settings and their consumers follow the [reset-first ordering contract](../providers/openai-accounts.md#reset-first-account-ordering), including independent-quota fallback and preserved affinity.

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](../transports/responses.md).

Provider summary defaults are evaluated per routed Responses request without changing service lifecycle or sidecar activation. See [runtime](../runtime.md).

Claude replay carries [Go conversation affinity](../data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Pool quota producers and account commands follow the [bounded raw-observation contract](../providers/openai-accounts.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

Account quota surfaces use [safe probe diagnostics](../transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](../transports/responses.md) documents this boundary, and native Chat removes effort only for an explicit empty declaration or no-reasoning model.

Live sideband admission and its bounded upstream handshake follow the [runtime contract](../runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](../transports/byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](../transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](../transports/streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](../gui-and-management-api.md#fast-selector-rows-setting).

The service loads the optional `compactionRouting` block from persisted configuration.
[Responses ingress](../transports/responses-failover.md#compaction-routing-overrides) applies it to individual compaction
requests whose trigger the block names.

Standalone binaries use `src/lib/standalone.ts` to detect the Bun `$bunfs` runtime and
`src/service/state.ts` to compose durable service commands as `<execPath> start`, without a
source-tree CLI path. The copied `gui/dist` directory is located by `src/server/gui-static.ts`;
`OPENCODEX_GUI_DIST` remains an explicit override.

## Bun updater ownership transaction

`src/update/ownership-transaction.ts` holds one mutation lease across the Bun updater's awaited
stop, package replacement and recovery work. The parent never puts its token in the global
environment. Fixed stop/service/direct-recovery children can join it; package-manager and
ancillary children receive environments without the capability. Refusals return through the
lease boundary before exiting, and thrown failures release it after owner-aware recovery.
Replacement and recovery inspect both the captured endpoint and the freshly read runtime record.
Malformed or unreadable records remain unknown. Recovery requires the same complete owner
identity and proven-dead liveness; unknown or transferred ownership never starts another proxy.
Direct recovery retains the lease until readiness or its bounded deadline. The normal successful
manual-runtime update still prints the existing restart hint.

The npm launcher in `bin/ocx.mjs` makes one exception after a failed update: a service recovery
releases the lease before the service refresh, as a successful update does. The service manager
starts the proxy outside the updater's process tree, so that proxy has to take the lease itself;
held through the repair's health wait, the lease kept it from starting, and recovery fell through
to a second, directly started proxy (#5760). The recovery decision is made again after the release.

The npm transaction creates each staging directory exclusively and may clean that fresh path
while the creating process still owns it. On POSIX it also creates the stage's `lib` directory,
because npm's strict script policy plans the global tree before it creates the prefix layout
(#5760). A later update only reports staging leftovers. It does not recursively delete them
from a marker: the marker is not an authorization secret, and a neighbouring writer could
replace a previously checked pathname with a link before traversal.

The probe ceilings are module-load constants in `src/server/proxy-liveness.ts`: 750 ms for the
shared default and 1500 ms (three attempts) for `SERVICE_STOP_LIVENESS` and
`START_OWNERSHIP_LIVENESS`. `OCX_PROBE_TIMEOUT_MS` (whole milliseconds, 1 to 30000) only raises
them for hosts whose loopback connects are slowed by a security layer; each ceiling keeps its floor,
so an override can never shorten the budgets that prevent a duplicate proxy, and a value above the
30 s ceiling is ignored so the single-shot stop deadline (`timeoutMs * attempts + 250` in
`src/service/orchestration.ts`) stays bounded. `tests/server/probe-timeout-env.test.ts` reads the
constants in child processes.

`src/update/install-detection.mjs` examines both lexical and resolved package paths. An enclosing mise installation owns its nested npm/aube package only when the adjacent `.mise.backend.toml` identifies the containing tool alias and the canonical `npm:@bitkyc08/opencodex` backend. That verified outer owner takes precedence over the inner npm layout. Two verified owners whose tool roots differ only by a symlinked ancestor (macOS `/var` -> `/private/var`) are compared by canonical directory and count as one install. An unreadable or contradictory ownership boundary on either path takes precedence over a verified owner on the other path, refusing mutation without inventing a tool name or recovery command. One boundary is not OpenCodex's at all: on Windows, npm -g under a mise-managed Node puts the package directly in `<mise>/installs/node/<version>/node_modules`, whose adjacent record is Node's own (`short = "node"`, `full = "core:node"`). That exact record with the package directly in the runtime's global `node_modules` is an npm install and falls through to npm detection; any other backend, alias or deeper layout stays fail-closed (`tests/update/update-mise-node-runtime.test.ts`). `ocx update`, dashboard update checks, and update workers expose `installer: "mise"`; checks remain read-only, while mutation is refused with `mise upgrade <verified-alias>` before any proxy stop, package write, or worker creation. The package-tree integrity guard remains active for mise packages.

## Package cache refresh

src/update/refresh-scheduler.ts owns the package cache timer and per-channel singleflight for the running proxy. Eligible npm, pnpm and Bun installs refresh missing or 20-hour-stale `version.json` after bind, check staleness hourly and retry failures with bounded backoff. Each server start owns one scheduler reference; the last matching stop disarms the timer. A stopped automatic lookup cannot write a late result, but an explicit check joining that lookup marks explicit interest and writes its successful result even if the last listener stops before it resolves. Source/mise installs and `OCX_DISABLE_UPDATE_CHECK=1` do not start automatic lookup; explicit requests remain available.

src/update/async-check.ts uses the existing owner-bound registry target with a bounded asynchronous child; pnpm owner discovery runs in src/update/pnpm-owner-worker.ts off the request loop. `src/update/notify.ts` writes successful results atomically and preserves a dismissal only for the same channel and version. The interactive pre-bind prompt reads the cache and does not launch a second detached refresh. `src/update/badge.ts` only reads the cache and reports unknown at 40 hours.

The desktop badge snapshot in src/update/desktop-badge.ts is process-local display state keyed by a Tauri session id. A 60-second shell heartbeat renews receipt time; entries expire after 180 seconds and the store retains at most 32 sessions. It is separate from the package version cache and from the updater job/ownership transaction. A proxy restart reports unknown until a bound desktop shell republishes; no update installation can be authorized by this snapshot.
