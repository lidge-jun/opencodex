# wp7 — Preserve diagnostic state and test selected data-plane credentials

Depends on wp6. Layer 6. Observation is C3; chosen-key/model/audio consumers are a separate C4-reviewed part of this phase. No server admission changes or upstream production tests.

## Observation contracts

- Add system health --json, fixed GET /api/system/health. Existing health liveness and system status aggregate stay unchanged (src/cli/system-command.ts).
- Add companion timeline with hours/bucket-minutes/metric/aggregation/grouping/model/provider filters matching usage-timeline route, preserving truncated/missingMeasurements. Keep companion show/set/reset (new src/cli/companion-timeline.ts, wire companion.ts).
- Extend non-client usage with --api-key-id; reject it on connected clients before reading/transporting a key. Existing connected /v1/usage remains authenticated self-only; Hub host supports management total/key views. No admin privilege synthesized from a data key (observe.ts).
- Extract src/cli/log-follow.ts: send/validate cursor, retain a bounded snapshot window, surface changed same-ID rows and repeated IDs. Existing row JSONL re-emits amendments for upsert consumers. Add --events only for --follow to emit versioned snapshot/append events containing rows/cursor for exact reset/removal reconstruction; do not silently replace legacy row output. --json stays one-shot. Legacy arrays stay accepted without manufactured cursor.
- Add observe injection --follow --jsonl using its real after cursor and bounded polling; preserve snapshot command. SIGINT stops polls and leaves no running process. No write retry.

## Fixed data-plane task contracts

NEW src/cli/access-data-plane.ts and access-audio.ts; MODIFY access.ts:

| Command | Wire behavior |
| --- | --- |
| access key rename ID-or-NAME NAME --json | Existing unambiguous key resolver; PATCH only {id,name}; preserve scopes and no plaintext output. |
| access test MODEL --protocol responses\|chat\|messages --api-key-stdin --json | Reuse named protocol payloads, read explicit chosen key from bounded 4 KiB stdin; reject internal newline, empty/oversized/invalid UTF-8, TTY wait and input timeout without echo. Fixed /v1/responses, /v1/chat/completions or /v1/messages; dedicated x-opencodex-api-key only, never management-header helper. Existing unkeyed test cannot claim chosen-key verification. |
| access audio transcribe FILE --model ID --api-key-stdin --json | Fixed /v1/audio/transcriptions multipart file/model/JSON response format; bounded file/body/time, cancellation, no retry. Output is the requested transcript/result only. |
| access audio live-check --model ID --api-key-stdin --json | Fixed /v1/live WebSocket with the existing GUI key-subprotocol and session-update contract. Wait for actual session readiness, send session.close and close socket. No microphone, upload, delegation execution, reconnect or full voice-roundtrip claim. |

Standalone/Hub origin is the existing identity-checked local serving origin. Connected clients may use their already-enrolled normalized serverUrl with connection identity rechecked around async key read; never substitute the enrolled key for the explicit key. Preserve HTTPS-or-loopback policy and refusal of redirects/cross-origin auth forwarding. No --base-url, secret argv/env, key cache or management-relay credential exchange.

Shared input/output uses existing bounded readers and error/exit vocabulary. Chosen-key mode must first establish that the selected target enforces data credentials; it refuses unsupported/authless targets without a paid model probe. Wrong keys fail in stable key-enforcing fixtures; cross-request policy stability is not guaranteed. Fixtures must use actual admission/parser contracts, not a mocked 401 that assumes loopback key enforcement, and assert no administrative header/fallback is attached. Do not echo a raw error response that could contain credentials or arbitrary terminal controls. Key creation/rotation-start and pairing remain human-terminal handoffs in the skill.

Update pure capability leaves, generated references, JSONL/event schema docs, skill observation/API recipes and public reference pages. Structure owners: cli-management, dashboard-and-usage, GUI/API authority, audio/live contract as affected. No change to router/data-plane server authentication.

NEW tests/cli/cli-system-health.test.ts, cli-companion-timeline.test.ts, cli-usage-scope.test.ts, cli-log-follow.test.ts, cli-injection-follow.test.ts, cli-access-rename.test.ts, cli-access-data-plane.test.ts, cli-access-audio.test.ts. Reuse existing request-log cursor/GUI parser tests as independent expectations, not as substitutes for CLI behavior. Auth/server audio fixtures stay synthetic.

## Selected-key model-test guard (CP-DATA-01)

This is an observational two-request workflow, not an atomic key-admission certificate. Existing unkeyed testing stays unchanged. No server auth policy or endpoint is changed.

1. Validate grammar, protocol/model and existing target trust/origin. Read a single explicit UTF-8 key through bounded readSecretBytes (4096 bytes, 30-second input deadline), reject TTY waiting/internal newlines/empty input, and clear returned mutable buffers after use. Recheck observable runtime/enrollment identity after asynchronous input; pin one origin and selected protocol path.
2. Send one fresh credentialless POST to that exact model endpoint with literal body bytes `{`, Content-Type: application/json, optional Accept: application/json, credentials:omit and redirect:error. No auth/key/cookie/session/relay/caller headers, content encoding or user-defined body. Control limits: 5 seconds total through body consumption, 4096 response bytes. Cancel/release on every exit; no retry or cached observation.
3. Continue only for HTTP 401 with the exact current native key-required envelope: OpenAI-shaped error has message 'opencodex API key required', type authentication_error and code invalid_api_key; Messages may also use its native top-level type:error with the same message/type, or the OpenAI shape from the existing Hub-link gate. Reject generic/nonmatching 401, unknown/malformed/oversized body, redirect, timeout/cancel/network failure and every other status before sending inference. Response shape never establishes a new trusted origin or cryptographic process identity.
4. Recheck available identity/connection evidence and refuse detected drift. Only then issue one fixed 16-token model request with the supplied dedicated key, bounded to 60 seconds total and 2 MiB response. No management or enrolled-key fallback. A Messages control 401 followed by keyed 403 means failed/disabled test, not success. Audio uses its own explicit-key admission and does not run/reuse this control.
5. Report observations exactly: 'Credentialless request was refused; the model request using the supplied key succeeded.' In selected-key JSON mode, use a versioned probe report with safe control/request observations plus response; unkeyed legacy JSON remains its existing payload. Never say unqualified key verified, key scope certified or billed-to-this-key. No key/fingerprint/raw request metadata is serialized.

On current supported routes the fixed malformed body parses before routing and cannot dispatch model inference; local logging/rate/admission bookkeeping may occur, so this is not advertised as globally side-effect-free. The observation is invocation/protocol/target scoped. Listener restart/rebind, remote backend change or policy change between calls cannot be atomically excluded by a client. Identity checks detect some changes, not all; no reused connection or extra control is presented as a lease. An authless/unrecognized target returns explicit verification unavailable/nonzero without the inference payload.

NEW tests/cli/cli-access-key-guard.test.ts and tests/server/cli-key-probe-admission.test.ts exercise actual resolver+handler route compositions with a provider-call trap for all three protocols: enforcing/no key -> native 401 before handler; authless/literal malformed body -> parse/disabled refusal and zero provider calls; accepted control/wrong key -> 401 and zero provider calls under stable enforcing policy; valid key -> one controlled mock inference; disabled Messages -> control 401 then keyed 403; Hub-link native envelope; nonmatching/spoof-shaped/malformed/oversized errors; redirect; interruption; identity drift. State-change fixtures explicitly demonstrate the cross-request claim limit instead of claiming an atomic guarantee. Record whether the fixture invokes the real serve dispatcher or composes real resolvers/handlers; a hand-written fetch 401 alone is only transport coverage.

## Activation matrix

Same request id with new tokens/status must emit an amendment; reset/deletion event reconstructs GUI state; duplicate/suffix/legacy/malformed cases are distinct and bounded. Empty polls don't flood output. Connected caller-specified key scope is refused before key read. Timeline incomplete evidence isn't zero.

For API consumers verify all three protocol shapes, missing/wrong key on an enforcing target, authless-target refusal before a paid probe, no admin leakage, redirect refusal, non-JSON/malformed/oversized responses, file cap, timeout, interruption, origin changes and session.close. No fake key reaches a real provider. Security reviewer separately assesses data-key authority, secret lifecycle and bounded WebSocket cleanup before publication.

## Shared completion contract

This phase follows 002_terminal_ux.md and 003_verification_strategy.md. Main owns registry/dispatch integration, layout-map registration, generated output and Git branch state; executor write scopes are disjoint and named before B. Existing method/path/body semantics come from the referenced source inventories, not endpoint-name guessing.

Update the phase's capability domain, generated references, relevant public CLI pages and owning structure contracts in the same layer. Every new test file enters scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json. Existing tests are retained; no baseline cap increases or green-on-retry acceptance.

Planned new test paths below become executable verification only after B creates them. The current baseline gates in 003 have actually run. C invokes the exact focused files, typecheck, structure and skill-surface checks, privacy where data is handled, a source-bound cxc receipt and real isolated CLI QA (stdout/stderr/exit/teardown). A successful function mock is transport proof only; relevant existing server tests or isolated real handlers verify accepted state. No live user proxy, credentials or upstream requests.

Before P>A, revalidate this document against the parent layer and record the prior D conclusion. Consult an architect for actual decision changes; independent A review is separate. C must preserve saved-versus-applied/refused outcomes. D records exact checks and ledger evidence before the next cycle. Publishing is main-owned; this request stops at open PRs.
