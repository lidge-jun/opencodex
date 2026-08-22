# CL-00 compatibility incident corpus

These are abstract regression specifications distilled from shipped tests,
public issues, and devlog records. Provider names identify historical evidence,
not special cases to encode in the scenario model.

Each future fixture must reproduce the observable wire condition with a mock
upstream. CL-00 does not reopen or fix the production incidents.

`Future mapping` identifies the suite/scenario family that should own the
regression. It does not claim protocol V1 already covers the incident. Only a
literal vector in `022_protocol_v1_cases.json` gates a V1 verdict.
Unrepresented incidents below are reviewed inputs to a later scenario/suite
version amendment; prose and source-test references cannot be inferred into
V1.

## IC-001 - legal SSE field spacing

- Incident class: valid SSE framing rejected.
- Historical source:
  [#1170](https://github.com/lidge-jun/opencodex/issues/1170),
  `devlog/_fin/260807_untouched_bug_stack/010_sse_unspaced_data_fields.md`,
  `tests/sse-unspaced-data-fields.test.ts`.
- Observable failure: a parser accepts `data: {...}` but rejects legal
  `data:{...}`/`event:name`, trims payload whitespace, or treats a bare
  `data:` as malformed.
- Expected behavior: accept both legal forms, strip at most one optional space,
  preserve payload whitespace, and handle empty field values consistently on
  Responses, Chat, Anthropic and sidecar paths.
- Future mapping: `responses-core.protocol.sse-framing`,
  `chat-core.protocol.stream-terminal`,
  `anthropic-core.protocol.content-sequence`.
- Classification: `protocol_failure` -> `DEGRADED`.
- Deterministic fixture: yes; paired frames differing only in legal spacing.

## IC-002 - null and empty SSE data frames

- Incident class: ignorable frame mishandled as payload or terminal error.
- Historical source:
  `devlog/_fin/260808_bug_campaign/020_wp2_sse_frame_contract.md`,
  `tests/sse-null-data-frame.test.ts`.
- Observable failure: `data: null`, a bare `data:` field, or a comment frame
  crashes decoding, creates a synthetic event, or hides a later valid event.
- Expected behavior: apply each surface's explicit ignorable-frame contract;
  continue parsing without fabricating output, while malformed non-null JSON
  still fails closed.
- Future mapping: `responses-core.protocol.sse-framing`,
  `chat-core.protocol.stream-terminal`,
  `anthropic-core.protocol.content-sequence`.
- Classification: `protocol_failure` -> `DEGRADED`.
- Deterministic fixture: yes; null/empty/comment/malformed controls.

## IC-003 - missing or incorrect terminal stream signal

- Incident class: clean EOF, `[DONE]`, completion event, and terminal state
  confused.
- Historical source: `tests/openai-chat-eof.test.ts`,
  `tests/sse-failed-tail.test.ts`, `tests/claude-outbound.test.ts`,
  `tests/responses-stream-tool-events.test.ts`,
  [#658](https://github.com/lidge-jun/opencodex/issues/658),
  [#735](https://github.com/lidge-jun/opencodex/issues/735).
- Observable failure: a stream ends without the protocol-required terminal,
  emits more than one terminal, accepts `[DONE]` as a Responses completion
  without a terminal event, or maps failed/incomplete to successful end-turn.
- Expected behavior: exactly one surface-correct terminal. Responses remains
  strict. A fingerprinted Chat/Anthropic EOF-tolerance contract may complete
  only after visible output or a fully assembled tool call and only when no
  incomplete call remains; every other deterministic EOF fails closed and
  preserves the typed failed/incomplete reason.
- Future mapping: `responses-core.protocol.terminal-state`,
  `chat-core.protocol.stream-terminal`,
  `anthropic-core.protocol.terminal-errors`,
  `codex-core.protocol.streaming-turn`.
- Classification: deterministic close is `protocol_failure` -> `DEGRADED`.
- Deterministic fixture: yes; completed, failed, incomplete, duplicate and
  missing-terminal tails.

## IC-004 - body stall versus protocol truncation

- Incident class: environmental/provider timeout misreported as incompatibility.
- Historical source:
  [#875](https://github.com/lidge-jun/opencodex/issues/875),
  [#1065](https://github.com/lidge-jun/opencodex/issues/1065),
  `devlog/_fin/260805_bug_stack_campaign/050_issue875_deepseek_flash_stall.md`,
  `devlog/_fin/260806_overnight_triage_round2/020_bounded_body_first_byte.md`.
- Observable failure: no first byte or no later body byte arrives before the
  deadline; the system labels the model's protocol unsupported, or waits
  without a bound.
- Expected behavior: connect, first-byte, inactivity and total deadlines remain
  distinguishable. A silent live stall is a blocker, not proof of malformed
  protocol. A mock that deliberately closes without terminal data remains
  IC-003.
- Future mapping: supplemental timeout controls for
  `responses-core.protocol.terminal-state` and every future live suite.
- Classification: `timeout` -> `BLOCKED`; `provider_transient` when an
  authoritative transient response exists.
- Deterministic fixture: yes for timeout attribution; no deterministic fixture
  can convert an arbitrary live stall into incompatibility evidence.

## IC-005 - sparse lifecycle snapshots

- Incident class: incomplete Responses lifecycle snapshots forwarded as valid.
- Historical source:
  [#893](https://github.com/lidge-jun/opencodex/issues/893),
  `devlog/_fin/260805_bug_stack_campaign/040_issue893_sparse_snapshot_repair.md`,
  `tests/responses-snapshot-repair.test.ts`,
  `tests/responses-snapshot-repair-server.test.ts`.
- Observable failure: added/done snapshots omit required ID, type, role, status,
  output index or closing item, producing a client-invalid lifecycle.
- Expected behavior: preserve a complete canonical lifecycle or apply an
  explicitly configured, assertion-visible repair; never claim a sparse stream
  is valid without proving the repaired output.
- Future mapping: `responses-core.protocol.item-lifecycle`,
  `codex-core.protocol.streaming-turn`.
- Classification: `protocol_failure` -> `DEGRADED`.
- Deterministic fixture: yes; sparse permutations plus no-repair control.

## IC-006 - invalid, reused, or missing item IDs

- Incident class: client-facing Responses item identity violates its grammar or
  event correlation.
- Historical source:
  [#938](https://github.com/lidge-jun/opencodex/issues/938),
  `devlog/_fin/260805_bug_stack_campaign/060_issue938_uuid_item_ids.md`,
  `tests/responses-item-id-repair.test.ts`,
  `tests/deepseek-responses-item-id-repair.test.ts`.
- Observable failure: UUID/placeholder/missing IDs reach a client contract that
  requires typed IDs, or added/done events use inconsistent IDs.
- Expected behavior: valid stable IDs on the client surface; any configured
  repair is deterministic, type-scoped, and never rewrites function call IDs
  or breaks `call_id` correlation.
- Future mapping: `responses-core.protocol.item-lifecycle`,
  `codex-core.protocol.streaming-turn`.
- Classification: `protocol_failure` -> `DEGRADED`.
- Deterministic fixture: yes; valid, invalid, reused, missing-terminal and
  correlation controls.

## IC-007 - function schema root normalization

- Incident class: valid tool rejected because its schema root is missing or
  non-object.
- Historical source:
  [PR #745](https://github.com/lidge-jun/opencodex/pull/745),
  `tests/responses-parser.test.ts`.
- Observable failure: tool definition reaches an object-schema-only upstream
  with absent/invalid root shape, or normalization corrupts an already valid
  schema.
- Expected behavior: produce the required object root without changing valid
  properties/required/additionalProperties semantics.
- Future mapping: `tools-core.protocol.function-round-trip`,
  `mcp-core.protocol.schema-and-bounds`.
- Classification: `protocol_failure` -> `DEGRADED`.
- Deterministic fixture: yes; absent, malformed and valid schema controls.

## IC-008 - custom/freeform tool envelope mismatch

- Incident class: function-only route or token preset rejects a valid
  custom/freeform tool.
- Historical source:
  `devlog/_fin/260807_untouched_bug_stack/070_mimo_token_plan_preset.md`,
  `tests/responses-parser.test.ts` (exact `apply_patch` envelope),
  `tests/responses-tool-groups.test.ts`.
- Observable failure: a custom tool is serialized as a function, its freeform
  input/output is JSON-wrapped or dropped, or the route rejects the tool without
  an honest unsupported result.
- Expected behavior: preserve the exact custom tool declaration, call and
  output grammar, or deterministically classify the exact route unsupported for
  custom tools.
- Future mapping: `tools-core.protocol.custom-freeform-round-trip`,
  `codex-core.protocol.apply-patch-turn`.
- Classification: malformed translation is `protocol_failure` -> `DEGRADED`;
  a proven route contract is `capability_failure` -> `UNSUPPORTED`.
- Deterministic fixture: yes for translation; a future live negative control
  proves route support.

## IC-009 - dangling tool calls and result correlation

- Incident class: tool call/result pair becomes orphaned or misassociated.
- Historical source:
  `devlog/_fin/260718_dangling_toolcall_hardening/010_record.md`,
  `tests/openai-chat-dangling-toolcalls.test.ts`,
  `tests/issue-702-expired-replay-state.test.ts`,
  [#334](https://github.com/lidge-jun/opencodex/issues/334),
  [#620](https://github.com/lidge-jun/opencodex/issues/620).
- Observable failure: an assistant tool call is forwarded without a matching
  result, a result is attached to the wrong ID, or expired continuation state
  resurrects an unrelated call.
- Expected behavior: preserve exact call/result identity and order; repair only
  the narrowly declared orphan case; otherwise fail closed without fabricating
  a successful tool result.
- Future mapping: `tools-core.protocol.function-round-trip`,
  `codex-core.protocol.tool-continuation`,
  `codex-core.protocol.previous-response-replay`.
- Classification: `protocol_failure` -> `DEGRADED`.
- Deterministic fixture: yes; missing, duplicate, out-of-order, expired and
  mismatched IDs.

## IC-010 - parallel tool fragment assembly

- Incident class: interleaved calls merged, lost, reordered, or correlated to
  the wrong result.
- Historical source:
  `devlog/_fin/260709_parallel_tool_calls/000_plan.md`,
  `tests/openai-chat-parallel-stream.test.ts`,
  `tests/parallel-tool-calls-optin.test.ts`,
  [#361](https://github.com/lidge-jun/opencodex/issues/361).
- Observable failure: fragmented deltas from two calls produce one argument
  buffer, unstable ordering, duplicate completion, or incorrect result IDs.
- Expected behavior: assemble each indexed call independently, never duplicate
  argument fragments, preserve stable order/identity, and advertise parallel
  capability only when the effective adapter contract supports it. Provider
  interleaving does not require overlapping canonical adapter events; atomic
  sequential emission is a valid compatibility-preserving bridge contract.
- Future mapping: `tools-core.protocol.parallel-correlation`.
- Classification: `protocol_failure` -> `DEGRADED`; explicit no-parallel
  contract -> `UNSUPPORTED` for that capability only.
- Deterministic fixture: yes; interleaved, fragmented, out-of-order and
  single-call controls.

## IC-011 - wrong upstream wire for a model

- Incident class: Responses-capable and Chat-only models behind one gateway use
  the provider-wide wire indiscriminately.
- Historical source: `src/types.ts` and `src/providers/registry.ts` model-wire
  contract for [#404](https://github.com/lidge-jun/opencodex/issues/404),
  `tests/adapter-resolve.test.ts`, `tests/deepseek-inbound-wire.test.ts`,
  `tests/chat-completions-endpoint.test.ts`.
- Observable failure: an exact model is sent to the wrong endpoint/request
  shape, producing rejection or silent semantic loss.
- Expected behavior: resolve the effective model-specific adapter before
  subject identity and send the declared wire shape. Evidence for one wire is
  never reused for the other.
- Future mapping: `responses-core.protocol.request-shape`,
  `chat-core.protocol.request-mapping`; future live route variants.
- Classification: deterministic resolver/translation error is
  `protocol_failure` -> `DEGRADED`; a correctly selected but unsupported route
  is `capability_failure` -> `UNSUPPORTED`.
- Deterministic fixture: yes; mixed gateway with endpoint-specific fixtures.

## IC-012 - reasoning replay form mismatch

- Incident class: plaintext reasoning, signature, redacted block, or thought
  signature is dropped or replayed in the wrong form.
- Historical source: `tests/deepseek-reasoning-replay.test.ts`,
  `tests/deepseek-reasoning-replay-gaps.test.ts`,
  `tests/google-antigravity-replay.test.ts`,
  `tests/anthropic-thinking-signature.test.ts`,
  `tests/kiro-reasoning-roundtrip.test.ts`.
- Observable failure: a second turn is rejected, reasoning text leaks into
  visible output, required signature data is lost, or incompatible replay data
  is forwarded.
- Expected behavior: use the exact selected adapter's replay contract, preserve
  opaque data only on its compatible route, and omit/normalize it safely
  elsewhere.
- Future mapping: `reasoning-core.protocol.replay`,
  `reasoning-core.protocol.summary-stream`.
- Classification: `protocol_failure` -> `DEGRADED`.
- Deterministic fixture: yes; two-turn fixtures for each abstract replay form.

## IC-013 - provider-private content crosses a route boundary

- Incident class: encrypted/task/reasoning content from one provider is sent to
  an incompatible provider or exposed as ordinary text.
- Historical source:
  [#92](https://github.com/lidge-jun/opencodex/issues/92),
  `devlog/_fin/260706_previous-response-id-400/000_plan.md`,
  `tests/responses-parser.test.ts` encrypted-content case,
  `tests/bridge-raw-reasoning-hidden.test.ts`,
  `tests/v2-agent-message-failfast.test.ts`.
- Observable failure: opaque encrypted content is forwarded where it cannot be
  decrypted, causes a 400, or becomes user-visible/private evidence.
- Expected behavior: provider-private envelopes remain origin-scoped; cross
  route replay fails closed or uses a bounded opaque marker expressly allowed
  by the protocol, never raw private data.
- Future mapping: `reasoning-core.protocol.private-content-isolation`,
  `codex-core.protocol.previous-response-replay`; a later encrypted-task
  capability scenario when its upstream contract is implementable.
- Classification: unsafe translation is `protocol_failure` -> `DEGRADED`; a
  route proven unable to consume the encrypted task capability is
  `UNSUPPORTED`; the current explicit fail-fast is safe `UNSUPPORTED` evidence
  only when the scenario's exact route and encrypted-task preconditions match.
  Raw disclosure is also a security Critical independent of compatibility
  verdict.
- Deterministic fixture: yes for local origin isolation and fail-fast
  mitigation; partial for true cross-provider encrypted task execution.

## IC-014 - image modality or tool-result image mismatch

- Incident class: structured image content is dropped, stringified, sent to a
  text-only route, or advertised inaccurately.
- Historical source:
  [#888](https://github.com/lidge-jun/opencodex/issues/888),
  `tests/openai-chat-tool-result-images.test.ts`,
  `tests/responses-parser.test.ts`, `tests/vision-anthropic.test.ts`,
  `tests/vision-fail-closed.test.ts`, `tests/request-evidence.test.ts`.
- Observable failure: image order/detail/MIME is lost, a tool-result image
  becomes raw JSON/text, or capability gating disagrees with the effective
  native/sidecar path.
- Expected behavior: preserve structured image parts and honestly choose
  native, declared sidecar, or unsupported behavior without silent loss.
- Future mapping: `vision-core.protocol.input-image`,
  `vision-core.protocol.tool-result-image`,
  `vision-core.protocol.modality-gate`.
- Classification: `protocol_failure` -> `DEGRADED`; proven no-image route ->
  `UNSUPPORTED`; sidecar/network unavailability -> `BLOCKED`.
- Deterministic fixture: yes; synthetic data image and text-only controls.

## IC-015 - malformed continuation and previous-response state

- Incident class: stateful continuation is forwarded to a stateless/incompatible
  route or local replay is incomplete.
- Historical source:
  [#702](https://github.com/lidge-jun/opencodex/issues/702),
  `devlog/_fin/260706_previous-response-id-400/000_plan.md`,
  `tests/responses-state.test.ts`,
  `tests/issue-702-expired-replay-state.test.ts`,
  `tests/grok-orphan-adoption.test.ts`.
- Observable failure: upstream 400, duplicate history, missing prior tool call,
  orphaned result, or continuation state reused after expiry/route change.
- Expected behavior: use valid provider-private continuation only on its exact
  compatible subject; otherwise perform bounded ordered local expansion or fail
  closed.
- Future mapping: `codex-core.protocol.previous-response-replay`,
  `codex-core.protocol.tool-continuation`.
- Classification: `protocol_failure` -> `DEGRADED`.
- Deterministic fixture: yes; stateful, stateless, expired and route-change
  matrices.

## IC-016 - Anthropic terminal/error taxonomy corruption

- Incident class: failed/incomplete/upstream-overload response appears as
  successful `end_turn` or wrong Anthropic error type.
- Historical source: `tests/claude-outbound.test.ts`,
  `tests/anthropic-eof-tolerance.test.ts`,
  `tests/anthropic-compatible-stream.test.ts`.
- Observable failure: missing `message_stop` is accepted outside a declared
  tolerance, transient 502 becomes a normal message, or content-filter/max-token
  stop reason is mapped incorrectly.
- Expected behavior: preserve exact content-block and message terminal
  sequence; map failure classes and stop reasons deterministically; apply any
  EOF tolerance only to its exact fingerprinted route.
- Future mapping: `anthropic-core.protocol.terminal-errors`,
  `anthropic-core.protocol.content-sequence`.
- Classification: `protocol_failure` -> `DEGRADED`; live transient ->
  `provider_transient` -> `BLOCKED`.
- Deterministic fixture: yes; strict/tolerant, failed, incomplete and transient
  controls.

## IC-017 - MCP namespace, bound, and result atomicity

- Incident class: namespace collision, oversized schema/result partial commit,
  or result type loss.
- Historical source: `tests/cursor-mcp-manager.test.ts`,
  `tests/cursor-mcp-stdio.test.ts`.
- Observable failure: flattened names cannot map back, one-byte-over input
  leaves a partial catalogue, image/error result changes type, or unknown tool
  becomes an untyped exception.
- Expected behavior: collision-safe namespace mapping, exact atomic bounds, and
  typed result/error/resource behavior through a Lab-owned stub.
- Future mapping: all `mcp-core.protocol.*` scenarios.
- Classification: `protocol_failure` -> `DEGRADED`; declared no-MCP route ->
  `UNSUPPORTED`.
- Deterministic fixture: yes; in-memory/loopback stub only.

## IC-018 - DNS/connect failure poisons account or capability evidence

- Incident class: pre-connection transport failure attributed to credentials,
  account, model, or capability.
- Historical source:
  [#914](https://github.com/lidge-jun/opencodex/issues/914),
  `devlog/_fin/260805_bug_stack_campaign/030_issue914_dns_transport_attribution.md`,
  `devlog/_fin/260803_transport_attribution/000_plan.md`,
  `tests/upstream-connect-error.test.ts`.
- Observable failure: DNS/connect/TLS setup rotates account state, marks a
  route capability degraded, or becomes authentication evidence.
- Expected behavior: classify pre-response transport evidence as environment/
  network, leave compatibility and credential capability unchanged, and permit
  retry after environment repair.
- Future mapping: blocker controls shared by every future live suite.
- Classification: `network_failure` -> `BLOCKED`.
- Deterministic fixture: yes for attribution using an injected connect failure;
  it never contributes a compatibility failure.

## IC-019 - malformed error or empty success envelope

- Incident class: upstream error/empty payload accepted as a successful model
  response.
- Historical source: `tests/openai-chat-hardening.test.ts`,
  `tests/error-fidelity.test.ts`, `tests/upstream-http-error.test.ts`.
- Observable failure: falsey error payload, empty choices, null choice, missing
  message, or malformed SSE data is emitted as success or hidden by a terminal.
- Expected behavior: fail closed with a typed normalized error while preserving
  any safe usage/status evidence.
- Future mapping: `chat-core.protocol.nonstream-envelope`,
  `chat-core.protocol.stream-terminal`.
- Classification: `protocol_failure` -> `DEGRADED` for deterministic malformed
  protocol; recognized live transient remains `provider_transient`.
- Deterministic fixture: yes.

## IC-020 - structured-output wire mismatch

- Incident class: Responses `text.format` is lost, malformed, or sent to an
  upstream in the wrong shape.
- Historical source: `tests/responses-parser.test.ts`,
  `tests/openai-chat-hardening.test.ts`,
  `tests/deepseek-inbound-wire.test.ts`.
- Observable failure: JSON schema/object request widens to plain text, schema
  nesting changes, or a strict unsupported route receives an invalid parameter.
- Expected behavior: preserve the known equivalent wire form, or return a
  deterministic unsupported result without pretending structured output was
  honored.
- Future mapping: `codex-core.protocol.structured-output`,
  `responses-core.protocol.request-shape`,
  `chat-core.protocol.request-mapping`.
- Classification: translation error is `protocol_failure` -> `DEGRADED`;
  proven route limitation is `capability_failure` -> `UNSUPPORTED`.
- Deterministic fixture: yes for wire translation; future live negative control
  for route support.

## IC-021 - data-only Responses SSE

- Incident class: valid Responses events rejected because the producer omits
  the redundant `event:` field.
- Historical source:
  [#700](https://github.com/lidge-jun/opencodex/issues/700),
  `tests/claude-outbound.test.ts`.
- Observable failure: a payload with a valid typed Responses JSON record in
  `data:` is ignored or treated as a truncated stream when no `event:` line is
  present.
- Expected behavior: infer the event name from the payload's canonical `type`
  when the surface permits data-only events, permit explicit and inferred
  frames to interleave, and keep untyped data-only records ignored/fail-closed
  according to the scenario.
- Future mapping: `responses-core.protocol.sse-framing`,
  `anthropic-core.protocol.content-sequence`.
- Classification: `protocol_failure` -> `DEGRADED`.
- Deterministic fixture: yes; explicit-only, data-only, mixed and untyped
  controls.

## Corpus maintenance rule

New incidents enter this corpus only when they add a reusable wire condition,
assertion, or attribution boundary. A provider-specific workaround is not a
scenario. The abstraction must state:

```text
incident class
historical source/reference
observable failure
expected correct behavior
future scenario/suite mapping
expected failure classification
deterministic fixture feasibility
```

When a future fix changes the expected contract, bump the mapped scenario
version and preserve this historical record.
