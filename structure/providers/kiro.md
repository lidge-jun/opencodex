# Kiro Provider

Native steering follows [the shared WebSocket contract](../transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged.

The shared hosted-tool policy has no Codex Spark-specific branch. Kiro continues to use its
provider capabilities below; see [Responses compatibility](../transports/responses.md#responses-httpsse).

## Kiro CLI executable resolution

Forced and add-account login spawn the local CLI, so `resolveKiroCliExecutable` in
`src/oauth/kiro-credentials.ts` decides which file runs with credential-flow arguments. The
canonical `kiro-cli` name is tried on `PATH` and then in the platform install locations. Only
after every canonical candidate misses, and only on Windows, does the short `kiro.exe` name count,
and only inside the two dedicated `Kiro-Cli` folders (`%LOCALAPPDATA%` and `Program Files`) when
their base is a fully qualified drive path. A short name is never resolved from `PATH` or from the
shared POSIX bin directories (`~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`), where an
unrelated `kiro` such as the Kiro IDE launcher can live. Coverage:
`tests/providers/kiro/kiro-windows-cli-executable-path.test.ts`.

## Forced-login credential rollback

A forced login uses a receipt-bearing auth-store write naming its exact account, credential
generation, selection revision, and prior slot. If later provider publication fails, rollback is
one serialized compare-and-swap mutation: it removes or restores only that still-owned generation.
A concurrent account addition, selection, or credential refresh wins and is never inferred from a
before/after account-ID set.

> Decision record: [ADR-0109](../decisions/ADR-0109-kiro-login-rollback-ownership.md)

Kiro usage probing uses the same request-profile resolver as generation. A non-OIDC
account without a formable ARN is not probed. Persisted quota and exhaustion evidence
are bound independently by observation time, reset, and login identity, never by token
or raw account label; removal, identity change, expiry, or malformed disk degrades routing
evidence to unknown. Initial routing reads it through `kiroAccountEvidence`.

## Kiro client parallel-tool hint

Kiro's wire remains serialized even when an OpenAI Responses client sends
`parallel_tool_calls: true`. That request field is permissive: it allows parallel calls but does not
require the routed transport to expose a matching flag. The Kiro catalog therefore continues to
advertise `supports_parallel_tool_calls: false`, and the adapter emits no parallel-control field,
while accepting the client hint and translating the ordinary tool catalog normally.

> Decision record: [ADR-0060](../decisions/ADR-0060-kiro-client-parallel-tool-hint.md)

Kiro's own `kiroToolName` rewrite in `src/adapters/kiro-wire.ts` is CodeWhisperer-only and
reserves the private completion tool. Meta Muse 64-character MCP aliases live in
`src/responses/muse-tool-name-alias.ts` and must not import that Kiro helper.

## Kiro Responses text controls

Kiro shares the Responses freeform restoration boundary in
`src/responses/apply-patch-envelope.ts`: contractual `input` wrappers are unwrapped, while alternate
field and outer-fence recovery is limited to unambiguous bare or `default.`-prefixed `exec` and `apply_patch` bodies.

Kiro refuses structured output and tolerates every other Responses `text` member. `text.format`
of type `json_schema` or `json_object` is a contract the CodeWhisperer wire cannot honour, so the
adapter rejects it rather than returning prose to a caller expecting JSON. `text.verbosity` and
`text.format: {"type":"text"}` are preferences, not contracts; they are accepted and dropped,
because `buildKiroPayload` composes `conversationState` from parsed fields and never forwards the
raw body.

> Decision record: [ADR-0061](../decisions/ADR-0061-kiro-responses-text-controls.md)

## Bounded fallback HTTP errors

`src/adapters/kiro-retry.ts` uses the configured executor for every generation send and may try the existing `q.{region}.amazonaws.com` host once after a canonical-host HTTP 502/503/504 before output, subject to the same send budget. Reset, 429, alternate, and completion-fallback sends wait for a pacing slot; only the first send is pre-paid. Kiro web-search turns are paced as well. A Kiro-local wrapper maps its header deadline to HTTP 504 without changing shared or Google fetch behavior; caller cancellation remains an abort. Final HTTP 5xx text is fixed for clients, and opt-in provider diagnostics carry only closed-set status and classification codes.

When a first Kiro stream needs a completion fallback, the fallback response's non-success
body is read through the shared display-safe bounded reader with the attempt's abort signal.
The adapter emits an error with the upstream status and does not emit a successful completion.
A body that exceeds the reader's limit is cancelled and cannot contribute unbounded text to
the error message. Coverage: `tests/providers/kiro/kiro-fallback-error-body.test.ts`.

## Kiro reasoning round-trip (`signature`)

Kiro never returns plaintext reasoning for its **GPT-5.6 family** (`gpt-5.6-sol`, `-terra`,
`-luna`): `reasoningContentEvent` carries a KMS-encrypted blob rather than readable reasoning. It
arrives on `signature`, holding the `.KTR~~…` value verbatim, which is what every capture of those
models sent. The event's `text` field is not absent — every captured GPT-5.6 frame left a literal
`"..."` placeholder there, which the adapter forwards as a `reasoning_raw_delta` — but it never
carries model reasoning, so `signature` is the only field worth replaying
(`tests/providers/kiro/kiro-reasoning-roundtrip.test.ts`).
Their `additionalModelRequestFieldsSchema` (`ListAvailableModels`) accepts only
`reasoning.effort` with `additionalProperties: false` — there is no display/summary opt-in, so this
is the only reasoning these models can return, and all three select that native field
(`KIRO_NATIVE_EFFORT_FIELDS` in `src/adapters/kiro/reasoning.ts`). Kiro's own CLI replays the blob
on the matching `assistantResponseMessage.reasoningContent` to preserve model reasoning across
turns; dropping it makes every turn restart without the previous turn's reasoning. Verified on
kiro-cli 2.14.1 and 2.16.0, all three models.

Native effort admission is narrower than model eligibility: luna and terra send only
`low`, `medium`, `high`, and `max` on the native field. Their `xhigh` requests retain the
previous emulated thinking tags because that native rung is unverified. A future shared
effort rung does not expand this allowlist. Sol and Opus keep their existing native ladder.

The two members of `reasoningContent` are not interchangeable. The wire validates the shape of the
member rather than its content, and the signature is not base64 — its alphabet contains `.` and
`~` — so a blob replayed as `redactedContent` is rejected with `REQUEST_BODY_INVALID`
("Improperly formed request"). `signature` therefore takes the verbatim value and
`redactedContent` remains the home for the base64 shape another model may send. Which field a blob
arrived on is carried by the blob itself, one opaque string with a `signature:` tag, rather than by
a second value that could drift from it; provider data cannot forge the tag, because base64 has no
colon.

The Claude 4.6+/5 entries advertise a different, richer contract (`thinking.type` adaptive/disabled,
`thinking.display` summarized/omitted, `output_config.effort`, `max_tokens`) and are not covered by
that measurement; older Claude, deepseek, minimax, glm, and qwen entries advertise no additional
fields at all. The handling below keys off the wire field, not the model id, so any model that
sends either member round-trips.

- The tagged blob rides the existing `ocxr1:` envelope as `krc`
  (`src/responses/reasoning-envelope.ts`) on an envelope-only reasoning item — `summary: []`, no
  text deltas — so it stays invisible in the Codex app while round-tripping, exactly like the
  hidden-thinking path.
- **Pairing is backwards.** Kiro emits `reasoningContentEvent` at the END of an assistant turn,
  after content AND tool calls. A `krc`-only item therefore belongs to the turn that already
  closed, so the parser attaches it to the PRECEDING assistant message rather than folding it into
  the following turn like ordinary reasoning (`src/responses/parser.ts`). With no assistant turn to
  own it, the blob is dropped rather than mis-paired.
- The blob lives on `OcxAssistantMessage.kiroRedactedReasoning`, not on a thinking content part, so
  no other adapter replays provider-private state if the conversation switches providers.

Kiro reports context pressure in its own `contextUsageEvent`, which is the authoritative source. On
every capture taken (2.14.1 and 2.16.0) `metadataEvent` carried only `stopReason` — which is why
reading the percentage from `metadataEvent` alone never saw a value — but the parser still accepts a
finite `contextUsagePercentage` (and a `tokenUsage` block) there as a fallback, so a value parsed
from `metadataEvent` is legitimate rather than impossible. Both feed the same field, and any
positive value overwrites an earlier one.

Spend arrives in `meteringEvent` as **credits, not tokens**. No captured response carried
`tokenUsage` on any event, which is why Kiro token usage stays estimated. The parser preserves
`meteringEvent` unit/usage (`amount` is an alias) and optional `unitPlural`; credit readings populate
`OcxUsage.providerCredits` independently of token metadata. The latest reading within a response
is a snapshot; separate completion-fallback responses add their credits. Missing metering stays
absent and measured zero stays zero. `initial-response` carries `conversationId` through the same
validated provider-state path as `messageMetadataEvent`. Unknown event types produce opt-in
`debugProviderDiagnostic` entries containing only the event-type length, never the raw header or payload.
Coverage: `tests/providers/kiro/kiro-metering-events.test.ts`,
`tests/providers/kiro/kiro-metering-usage.test.ts`, and
`tests/server/server-kiro-completion-e2e.test.ts`.

## Remote image references

Kiro's wire inlines base64 bytes only, so a remote `https` image reference cannot be
sent. It used to be dropped with neither bytes nor any marker, so the payload and the
evidence that an attachment existed both disappeared.

`countKiroUninlinableImages` reports how many parts `parseDataUrlImage` could not
inline, and the payload builder appends a bounded marker to that turn's text. The
marker is appended before `rawGroupText` is computed, because adjacency grouping
rebuilds a turn's content from its collected texts and would otherwise discard it.

No fetch is introduced: resolving the reference server-side would add an outbound
request on a request path. The marker carries a count and no URL, because a remote
image URL can carry a signed token.

Translated audio/file admission follows the [final-adapter input contract](../adapters/registry.md#untranslated-input-media); native raw passthrough remains separate.
