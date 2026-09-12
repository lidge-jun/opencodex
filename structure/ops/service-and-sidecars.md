# Background Service And Sidecars

## Background service command selection

A bare `ocx service` is an idempotent install-or-repair command. Argument validation happens before
any platform status probe. macOS and Linux choose from the registration file's proven presence;
Windows combines the Task Scheduler and WinSW probes into `installed`, `absent`, or `unknown`.
Only proven absence enters registration. A query failure refuses the bare command with status
guidance, because treating `unknown` as absent can rerun elevated `schtasks /create` against an
existing task. Explicit `ocx service install` remains the operator-owned registration request.

> Decision record: [ADR-0028](../decisions/ADR-0028-background-service-command-selection.md)

## Windows startup ownership listing reuse

One proxy startup asks service-home ownership twice before listen: once before cache invalidation and
again immediately before native-main lifecycle preparation. The second targeted Task Scheduler query
is a deliberate race check and remains mandatory. On a localized host, however, the same nonzero
targeted answer can require a full task listing with a 20-second ceiling; running that identical
enumeration twice made a measured 12.3-second fallback cost roughly 25 seconds before listen.

> Decision record: [ADR-0029](../decisions/ADR-0029-windows-startup-ownership-listing-reuse.md)

## Stable service launcher (launchd and systemd)

Launchd and systemd installation resolve the first absolute `ocx` PATH candidate that is both a regular file
and executable, keeps that path lexical so a version-manager shim remains an indirection, and
records the same single resolution in the service definition and service state. Definition
construction (`buildPlist`, `buildUnit`) never performs PATH discovery itself: callers provide either the resolved launcher or an explicit direct Bun/CLI
fallback, keeping diagnostics and tests independent of the host PATH.

Launcher mode omits the package-local Bun provenance pair because an upgrade may delete that
versioned tree. The only runtime path carried through the launcher is a pre-Bun, proof-bound
`OPENCODEX_BUN_PATH` whose durable runtime source is `override`; bundled and process fallbacks are
rediscovered by the current launcher. The API-auth token remains file-backed and is loaded only by
the service shell at start. On macOS, `start` and detailed `status` compare the live launchd job
against `expectedLaunchdCommand`, which follows the recorded `launcherPath` rather than re-walking
PATH, so a launcher-backed job is never misreported as an older plist (#3464).

> Decision record: [ADR-0030](../decisions/ADR-0030-stable-service-launcher-launchd-and-systemd.md)

## Sidecars

Web search and vision sidecars run only when the main request needs that capability and a usable
sidecar authority exists. Vision has two possible backends; web search's config union additionally
admits `xai`, `gemini`, and `exa`. xAI is a live explicit-only backend through stored Grok OAuth;
Gemini and Exa remain inert until their executors ship. Selection differs per sidecar:

| Sidecar | Backend selection | Default model | Activation |
| --- | --- | --- | --- |
| `web-search/` | Explicit configuration only: unset always resolves to the OpenAI forward path. No backend — Anthropic or otherwise — is auto-selected from credential availability (doing so once sent OpenAI model ids to the Anthropic API). Explicit xAI requires usable stored Grok OAuth and may add hosted `x_search`; explicit Gemini/Exa remain fail-closed until their executors land. | `gpt-5.6-luna` (OpenAI), `claude-sonnet-5` (Anthropic), `grok-4.6` (xAI) | Hosted `web_search` requested by a non-passthrough routed model. |
| `vision/` | Explicit configuration wins for both backends. Only an unset backend auto-selects: Anthropic when a usable Anthropic OAuth provider exists, otherwise the OpenAI forward authority. An explicitly selected backend whose authority is unavailable produces no plan rather than falling back. | `claude-sonnet-5` (Anthropic), `gpt-5.6-luna` (OpenAI) | Input contains images for a model listed in `noVisionModels`. |

The asymmetry is in the unset case only: vision may describe an image with whichever model can see
it, while a hosted search tool is tied to a provider-specific tool contract, so search never infers
Anthropic from credentials alone.

On the OpenAI path there is one deterministic `openai` sidecar candidate and its current account mode
owns credential selection; API-key OpenAI is not a ChatGPT forward sidecar candidate.

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

## Voice diagnostic metadata

`src/server/live.ts` owns optional `OCX_LIVE_FRAME_LOG` diagnostics for both sideband directions.
The JSONL schema contains only `ts`, `dir`, `kind`, `bytes`, and `fffd`. It never stores frame
content or transcript excerpts, and logging failures do not affect transparent frame delivery.
Binary detection decodes only the supplied buffer view; malformed UTF-8 can itself produce U+FFFD,
so the flag does not identify the peer responsible for corruption. Existing diagnostic files are
not rewritten. Audio devices, WebRTC media negotiation, captions and spoken handoff delivery remain
client responsibilities.

Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../gui-and-management-api.md#combo-editor-routing-quota).

Claude replay carries [Go conversation affinity](../data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.
