# Kiro Provider

## Kiro client parallel-tool hint

Kiro's wire remains serialized even when an OpenAI Responses client sends
`parallel_tool_calls: true`. That request field is permissive: it allows parallel calls but does not
require the routed transport to expose a matching flag. The Kiro catalog therefore continues to
advertise `supports_parallel_tool_calls: false`, and the adapter emits no parallel-control field,
while accepting the client hint and translating the ordinary tool catalog normally.

> Decision record: [ADR-0060](../decisions/ADR-0060-kiro-client-parallel-tool-hint.md)

## Kiro Responses text controls

Kiro refuses structured output and tolerates every other Responses `text` member. `text.format`
of type `json_schema` or `json_object` is a contract the CodeWhisperer wire cannot honour, so the
adapter rejects it rather than returning prose to a caller expecting JSON. `text.verbosity` and
`text.format: {"type":"text"}` are preferences, not contracts; they are accepted and dropped,
because `buildKiroPayload` composes `conversationState` from parsed fields and never forwards the
raw body.

> Decision record: [ADR-0061](../decisions/ADR-0061-kiro-responses-text-controls.md)

## Kiro reasoning round-trip (`redactedContent`)

Kiro never returns plaintext reasoning for its **GPT-5.6 family** (`gpt-5.6-sol`, `-terra`,
`-luna`): `reasoningContentEvent` carries a KMS-encrypted `redactedContent` blob, never `text`.
Their `additionalModelRequestFieldsSchema` (`ListAvailableModels`) accepts only `reasoning.effort`
with `additionalProperties: false` — there is no display/summary opt-in, so this is the only
reasoning these models can return. Kiro's own CLI replays the blob on the matching
`assistantResponseMessage.reasoningContent` to preserve model reasoning across turns; dropping it
makes every turn restart without the previous turn's reasoning. Verified on kiro-cli 2.14.1 and
2.16.0, all three models.

The Claude 4.6+/5 entries advertise a different, richer contract (`thinking.type` adaptive/disabled,
`thinking.display` summarized/omitted, `output_config.effort`, `max_tokens`) and are not covered by
that measurement; older Claude, deepseek, minimax, glm, and qwen entries advertise no additional
fields at all. The handling below keys off the wire field, not the model id, so any model that
sends `redactedContent` round-trips.

- The blob rides the existing `ocxr1:` envelope as `krc` (`src/responses/reasoning-envelope.ts`) on
  an envelope-only reasoning item — `summary: []`, no text deltas — so it stays invisible in the
  Codex app while round-tripping, exactly like the hidden-thinking path.
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
`tokenUsage` on any event, which is why Kiro usage stays estimated; `meteringEvent` is currently
ignored because a credit is not a token count.
