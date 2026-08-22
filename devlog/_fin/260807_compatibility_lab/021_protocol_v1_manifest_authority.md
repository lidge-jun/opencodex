# CL-00 protocol V1 manifest authority

This document closes the executable semantics for the initial
`protocol_conformance` scenarios. It is normative for CL-01 and does not
implement a runner.

The machine-readable source of truth is
[`022_protocol_v1_cases.json`](./022_protocol_v1_cases.json). It contains 35
provider-independent canonical fixture vectors, literal expected values,
row-specific requirements, exact roles/media types, execution limits, artifact
policy, failure rules, and domain-separated fixture digests. Historical tests
in the [incident corpus](./030_incident_corpus.md) are provenance and coverage
guidance only; they are not executable manifest semantics.

## 1. Exact manifest expansion

For each entry in `cases`, CL-01 constructs `CompatibilityScenarioV1` in this
field order before RFC 8785 canonicalization:

```text
schemaVersion           source.schemaVersion
id                      case.id
version                 manifestDefaults.version
suite                   { id: case.suite,
                          version: manifestDefaults.suiteVersion,
                          evidenceLayer:
                            manifestDefaults.evidenceLayer }
evidenceLayer           manifestDefaults.evidenceLayer
capability              case.capability
verificationRole        case.verificationRole when present,
                        otherwise manifestDefaults.verificationRole
requirements            case.requirements
fixtures                when case.initiatingRequest is present:
                          [fixtureRef(case.initiatingRequest),
                           fixtureRef(case.fixture)]
                        otherwise: [fixtureRef(case.fixture)]
executionLimits         manifestDefaults.executionLimits
assertions              case.assertions
expectedFailure         case.expectedFailure, only when present
failureRules            expandFailureRules(case)
artifactPolicy          manifestDefaults.artifactPolicy
freshness               manifestDefaults.freshness
```

`fixtureRef(x)` is exactly:

```text
{
  id: x.id,
  role: x.role,
  mediaType: x.mediaType,
  digest: x.digest,
  byteLength: UTF8(x.bytesUtf8).byteLength,
  syntheticMarker: "ocx-lab-synthetic-v1",
  provenance: {
    kind: "lab_authored",
    authority: "022_protocol_v1_cases.json",
    sourceCommit: source.sourceCommit
  }
}
```

The marker/provenance fields are mandatory for every protocol V1 fixture
reference and participate in the scenario manifest digest. Registration rejects
any fixture reference whose marker is absent/different, whose provenance kind
is not `lab_authored`, whose authority is not the exact authority file above,
or whose source commit differs from the parsed authority. This is the
machine-checkable synthetic-fixture boundary: a fixture cannot be substituted
from user input, a repository, MCP config, an external URL, or a live response
merely because its bytes share a valid digest.

`expandFailureRules(case)` copies
`failureRuleSets[manifestDefaults.failureRuleSet]`. When
`case.expectedFailure` is absent, that copy is the complete rule list and no
control-specific rule exists. When present, registration validates the closed
control matrix in the evidence contract and inserts this materialized record
immediately before `required-assertion`:

```text
id                      expectedFailureRuleTemplate.id
match                   expectedFailureRuleTemplate.match
classification          case.expectedFailure.expectedClass
secondaryCode           case.expectedFailure.expectedCode
verdictEffect           none when onMatch is pass,
                        unsupported when onMatch is unsupported
retry                   expectedFailureRuleTemplate.retry
expected                expectedFailureRuleTemplate.expected
```

`expected_failure_exact_match` exists only when the observed class and code
equal `expectedClass`/`expectedCode` and every listed assertion ID passed. An
`onMismatch: fail` falls through to `required-assertion`; an
`onMismatch: inconclusive` falls through to `fallback`. No V1 case declares a
`capability_absence_control`, so no V1 expanded manifest contains an
`unsupported` effect.

JSON object field order has no digest effect, but the field set above is
closed. Unknown fields reject registration. Arrays preserve source order.
Empty arrays remain present. No default may be read from runtime code.

The scenario digest is:

```text
sha256(
  UTF8("ocx-lab:scenario-manifest:v1\0") ||
  UTF8(JCS(expanded scenario))
)
```

The exact fixture bytes are UTF-8 encoding of each `bytesUtf8` field; every
published `fixture` and `initiatingRequest` digest is:

```text
sha256(UTF8("ocx-lab:fixture:v1\0") || fixture bytes)
```

Registration recomputes all digests and rejects mismatch. Every `bytesUtf8` is
retained as a content-addressed fixture artifact, not duplicated into the
expanded manifest. An `upstream_response` case without an initiating
`client_request` rejects registration.

## 2. Exact suite manifests

All suite versions are `1.0.0`. Every listed scenario has role `required`
except `vision-core.protocol.modality-gate`, whose role is `negative_control`.
No supplemental protocol V1 scenario exists. Order is the order in the case
authority:

| Suite | Capability | Required member suffixes |
|---|---|---|
| `responses-core` | `protocol.responses.core` | `request-shape`, `sse-framing`, `item-lifecycle`, `terminal-state`, `json-sse-equivalence` |
| `chat-core` | `protocol.chat.core` | `request-mapping`, `nonstream-envelope`, `stream-assembly`, `stream-terminal` |
| `anthropic-core` | `protocol.anthropic.messages.core` | `request-mapping`, `content-sequence`, `tool-round-trip`, `terminal-errors` |
| `tools-core` | `tools.round_trip` | `function-round-trip`, `custom-freeform-round-trip`, `parallel-correlation`, `result-content`, `choice-and-allowed-set` |
| `codex-core` | `client.codex.core` | `streaming-turn`, `apply-patch-turn`, `tool-continuation`, `previous-response-replay`, `structured-output`, `compaction-and-special-items` |
| `vision-core` | `modalities.image.input` | `input-image`, `tool-result-image`, `modality-gate` |
| `reasoning-core` | `reasoning.round_trip` | `effort-mapping`, `summary-stream`, `replay`, `private-content-isolation` |
| `mcp-core` | `tools.mcp.core` | `namespace-mapping`, `schema-and-bounds`, `call-result`, `resource-round-trip` |

For each row, the expanded suite manifest is:

```text
schemaVersion           1
id                      table suite
version                 1.0.0
evidenceLayer           protocol_conformance
capability              table capability
assertionDslVersion     1.0.0
evidenceSchemaVersion   1.0.0
freshness               { maxAgeMs: null }
contradictionRule       newest-required-observation-v1
scenarios               [{
                          id: full case ID,
                          version: 1.0.0,
                          role: expanded scenario verificationRole,
                          manifestDigest: expanded scenario digest
                        }, ...]
verificationRule        all-applicable-required-pass-v1
```

Unknown fields reject registration. The suite digest uses
`ocx-lab:suite-manifest:v1` plus JCS exactly as defined by the evidence
contract. `VERIFIED` requires at least one applicable required member, a
current pass for every applicable required member, and the exact
suite/scenario/fixture digests above.

## 3. Observation selector model

Assertions use absolute RFC 6901 JSON Pointers into this closed normalized
observation:

```text
{
  "client": {
    "request": { "status": 0, "headers": {}, "json": null, "rawBytes": 0 },
    "response": {
      "status": 0,
      "headers": {},
      "json": null,
      "events": [],
      "toolCalls": [],
      "mcpCalls": [],
      "terminal": null,
      "normalizedText": ""
    }
  },
  "upstream": {
    "requests": [
      { "status": 0, "headers": {}, "json": null, "rawBytes": 0 }
    ],
    "responses": []
  },
  "process": { "exitCode": null },
  "verifiers": {}
}
```

Header names are lowercase. JSON pointers use `~0` and `~1` escaping. Array
indexes are decimal with no leading zero except `0`; `-` is forbidden.
Wildcard, filter, recursive descent, script expression, URI, and filesystem
selectors do not exist in V1.

Unless the operator is `json_path_absent`, a missing selector fails with
`selector_missing`. Unless the operator checks presence/absence, a wrong JSON
type fails with `selector_type_mismatch`. Both are required-assertion failures,
not harness failures.

Objects compare by JCS bytes. Arrays are order-sensitive. Strings compare
without trimming or Unicode normalization. Numbers use JCS representation.
`null`, missing, empty string, empty array, and empty object are distinct.

## 4. Fixture roles and execution

Closed V1 fixture roles are:

- `client_request`: inject exact bytes at the named inbound protocol surface;
- `upstream_response`: return exact bytes from the loopback mock;
- `adapter_vector`: decode the fixture JSON and feed its documented fields to
  the selected adapter boundary without network access;
- `synthetic_tool`: decode the fixture JSON into the in-memory inert tool/MCP
  stub and execute only the closed harness action selected below. It never
  executes model arguments.

Closed media types are `application/json`, `text/event-stream`,
`application/vnd.opencodex.adapter-vector+json`, and
`application/vnd.opencodex.mcp-stub+json`.

Each case's exact `requirements` selects the adapter/surface and harness
features. `adapter_vector` keys are scenario-specific closed input fields
defined by the literal vector and scenario assertions; unknown keys reject the
fixture. CL-01 must encode those fields as a discriminated union keyed by the
scenario ID, not a generic callback or dynamic module.

The four protocol V1 MCP cases each carry exactly one additional closed
`requiredHarnessFeatures` action token. These tokens are executable semantics
and participate in the scenario manifest digest:

- `mcp_namespace_round_trip_v1`: decode `namespace`, `name`, `description`, and
  `inputSchema`; register exactly one inert tool; serialize its upstream name
  as `namespace + "__" + name`; then synthesize exactly one completed
  client-visible function call with ID `call_fixture`, that flattened name, and
  arguments `{}`. Run the normal `toolCalls` -> `mcpCalls` projection. No stub
  result, process, filesystem, or network action occurs.
- `mcp_schema_bounds_v1`: decode only `limitBytes`, `exactSchema`, and
  `overSchema`; stage an otherwise-identical single inert tool first with
  `exactSchema` and then in a fresh transaction with `overSchema`. The first
  transaction commits only when its UTF-8 schema bytes equal the limit; the
  second must reject atomically before commit when it is exactly one byte over.
  It emits no tool call and performs no invocation.
- `mcp_call_result_v1`: decode `namespace`, `name`, `arguments`, and `result`;
  register exactly one inert tool; synthesize exactly one completed call with
  ID `call_fixture`; invoke the in-memory stub exactly once with the decoded
  namespace/name/arguments; the stub returns the literal decoded `result`,
  which becomes `/client/response/json`. Duplicate/missing calls or any extra
  invocation fail the required verifier.
- `mcp_resource_round_trip_v1`: decode only `resources` and `read`; install them
  in the in-memory resource stub; perform exactly one list operation followed
  by exactly one read for `read.uri`; expose the literal list as
  `/client/response/json/resources` and the matching literal contents as
  `/client/response/json/contents`. Missing, duplicate, or extra operations
  fail the required assertion.

A protocol V1 MCP case missing its scenario-specific action token, carrying the
wrong token, carrying more than one of these tokens, or providing fixture keys
outside that token's closed schema rejects registration. No generic
`synthetic_tool` callback, implicit model output, or implementation-defined
invocation is permitted.

The MCP cases use only `in_memory_mcp_stub`. No case authorizes stdio, a child
process, user MCP configuration, filesystem access, or a user tool.

## 5. SSE normalization

This section is the Lab harness normalizer for protocol V1 observations. It
does not rewrite production sidecar parsers such as
`src/vision/anthropic-describe.ts`; those remain out of CL-00/CL-01 scope and
may keep closed product-local semantics until a later shared-normalizer phase.

The harness retains exact fixture bytes and normalizes only for assertions:

1. UTF-8 must decode without replacement. A BOM is allowed only at byte zero
   and is removed.
2. CRLF and CR become LF.
3. An empty line terminates a frame. Comment lines beginning `:` are ignored.
4. The first `:` separates field and value. No colon means an empty value.
   Exactly one optional leading U+0020 after `:` is removed; no other
   whitespace is trimmed.
5. Repeated `data` fields join with LF. The last `event` field wins.
6. Sentinel interpretation follows the protocol of the byte stream being
   normalized, not the client-facing `requirements.surfaces` label. For an
   `upstream_response` fixture, the source is the case's single resolved
   `requirements.upstreamProtocols` entry: only `openai-chat` recognizes a
   data value exactly equal to `[DONE]` as a sentinel. `openai-responses` and
   `anthropic-messages` do not. A raw fixture with zero or multiple resolved
   source protocols is invalid. Client-output normalization instead follows
   the emitted client protocol; a Responses bridge's transport `[DONE]`
   padding is not reclassified as an upstream Chat sentinel.
7. When `event` is absent and parsed `data` is an object with string `type`,
   Responses/Anthropic normalization infers that `type`. Explicit event wins.
   Parsed `null`, scalar, array, or empty data is padding and emits no event.
   Syntactically malformed nonempty JSON is terminal.
8. Arrival order is preserved; events are never sorted or deduplicated.

Each normalized event is:

```text
{ "event": string, "data": JSON value, "ordinal": integer }
```

### Semantic call projections

`/client/response/events` always contains the event records above and is never
treated as an array of bare calls. The normalized observation additionally
contains `/client/response/toolCalls` and `/client/response/mcpCalls`.

`toolCalls` is built from completed client-visible semantic output items in
response order. For non-streaming Responses, use `output[]`; for Responses SSE,
use each `response.output_item.done.data.item` and reject a completed response
whose added item lacks exactly one done item. Chat fragments are first
translated by the adapter into those client-visible Responses items; the
projection never reads the upstream Chat deltas directly.

Accepted item shapes and exact projections are:

```text
function_call:
  { id: item.call_id, name: item.name,
    arguments: JSON.parse(item.arguments),
    kind: "function", ordinal: output order }
custom_tool_call:
  { id: item.call_id, name: item.name,
    arguments: item.input,
    kind: "custom", ordinal: output order }
```

Missing/non-string IDs or names, malformed function JSON, duplicate IDs, an
unknown item type, or an added/done mismatch emits no repaired call and causes
the corresponding required assertion to fail. Ordinals are contiguous from
zero; they are not SSE event ordinals.

`mcpCalls` is derived from `toolCalls` whose name starts with `mcp__` and
contains a final `__` separator. Split at the final separator:

```text
{ namespace: bytes before final "__", name: bytes after final "__" }
```

Empty components, more than 64 UTF-8 bytes per component, invalid UTF-8, or a
non-MCP name emits no MCP call. Order matches `toolCalls`.

## 6. Assertion operators

- `http_status_equals`: selected integer equals expected integer.
- `header_present` / `header_absent`: selected lowercase header key exists/does
  not exist.
- `header_value_equals`: selected normalized header string equals expected.
- `json_schema_matches`: selected value validates against embedded JSON Schema
  draft 2020-12. Only local `$defs`/`$ref` are allowed; coercion, defaults,
  custom formats, and network resolution are forbidden.
- `json_path_equals`: selected value equals literal expected under JCS rules.
- `json_path_present` / `json_path_absent`: pointer succeeds/fails; a present
  `null` is present. Expected must be literal `true`.
- `sse_field_equals`: selected normalized field equals expected string.
- `sse_event_sequence`: exact event-name array; no subsequence or extras.
- `sse_event_count`: expected is `{event,count}` and exact count is required.
- `terminal_signal_equals`: expected is `completed`, `failed`, `incomplete`,
  `done`, `message_stop`, `eof_tolerated`, or `none`. Exactly one terminal is
  required unless expected is `none`.
- `id_matches`: expected is a closed grammar:
  - `responses_message`: `msg_` plus 1..128 ASCII alphanumeric/underscore/dash;
  - `responses_reasoning`: `rs_` plus 1..128 of that set;
  - `responses_call`: `call_` plus 1..128 of that set;
  - `nonempty_128`: 1..128 printable non-whitespace ASCII characters.
  Arbitrary regular expressions are forbidden.
- `id_stable_across_events`: expected is an ordered pointer list. Every
  resolved string is byte-equal.
- `id_correlates`: expected is exactly two pointers resolving to byte-equal
  strings.
- `tool_call_equals`: selected normalized call equals
  `{id,name,arguments,kind,ordinal}`. Function arguments are parsed JSON;
  custom/freeform arguments are exact strings.
- `tool_result_correlates`: expected is `{call,result}` pointers. IDs match,
  result follows call, and no intervening call reuses the ID.
- `fixture_request_matches`: method, normalized path, allowlisted headers and
  JSON body equal the literal fixture expectation.
- `normalized_text_equals`: selected string equals expected exactly.
- `byte_limit_observed`: selected nonnegative integer is `<=` expected.
- `process_exit_equals`: selected integer equals expected.
- `verifier_result_equals`: selected value `pass|fail|blocked|inconclusive`
  equals expected.

Unknown operators, selectors, expected shapes, fixture roles, media types, or
requirements reject registration.

## 7. Closed verifier derivations

`/verifiers` is populated only by these pure V1 functions. They may read the
current case's decoded synthetic fixture and normalized observation, but no
clock, random source, network, filesystem, environment, runtime callback, or
model output outside that observation.

- `json_sse_equivalence`: build the JSON projection
  `{text,terminal}` where `text` concatenates, in order, every
  `output[].content[]` `output_text.text`, and `terminal` is top-level
  `status`. Build the SSE projection where `text` concatenates every
  `response.output_text.delta.data.delta`, and `terminal` is the normalized
  terminal. Return `pass` iff the two JCS objects are equal, else `fail`.
- `nonoverlap_order`: read `/client/response/toolCalls` in array order. Return
  their IDs only when every ID occurs once, each record has a complete
  arguments value, and ordinals are contiguous from zero and equal the array
  indexes. Otherwise return an empty array.
- `call_result_order`: over the normalized two-turn input, return `pass` iff a
  `function_call` occurs in turn 1, exactly one `function_call_output` with the
  same `call_id` occurs in turn 2, and no result precedes its call; otherwise
  `fail`.
- `compaction_replayed`: return `true` iff the one
  `context_compaction.encrypted_content` value is accepted into the parser's
  normalized compaction slot and is absent from user-visible output; otherwise
  `false`. The synthetic value is never decrypted or executed.
- `local_shell_correlated`: return `true` iff the `local_shell_call.call_id`
  equals the following `function_call_output.call_id` and neither item invokes
  a process; otherwise `false`.
- `tool_search_error`: for the one failed `tool_search_output`, return its exact
  `error` string; missing, duplicate, or non-failed items return `null`.
- `modality_path`: return `native` when `requestHasImage` is true and
  `modelInputModalities` contains `image`; otherwise return `sidecar` when an
  enabled authorized vision sidecar exists; otherwise return `unsupported`.
- `silent_image_drop`: return `true` only when an image-bearing input is
  omitted from adapter output without either a `native`/`sidecar` path or the
  typed unsupported rejection; otherwise `false`.
- `exact_bound`: UTF-8 encode `exactSchema`; return `pass` iff its byte length
  equals `limitBytes`, JSON parsing succeeds, and the complete staged catalogue
  commits; otherwise `fail`.
- `one_over_rejected`: UTF-8 encode `overSchema`; return `pass` iff its byte
  length equals `limitBytes + 1` and admission rejects it before commit;
  otherwise `fail`.
- `partial_commit`: return `true` iff any tool from the rejected one-byte-over
  staging transaction is visible in the committed catalogue; otherwise
  `false`.
- `stub_received`: the in-memory MCP stub records exactly
  `{namespace,name,arguments}` from the one decoded invocation. Duplicate or
  missing invocations produce `null`.

Verifier outputs use only the literal types above. A missing or type-invalid
input returns `fail`, `false`, `[]`, or `null` as specified and therefore fails
the corresponding required assertion; it is not silently repaired.

## 8. Failure rules and freshness

The exact ordered base `protocol-v1-default` records and the one
expected-failure rule template are in the case authority. Control-specific
rules are included only by `expandFailureRules(case)`. Fixture/manifest
integrity and harness failures do not affect compatibility. Time/resource
limits are environmental blockers. The exact expected rejection of the V1
conformance negative control satisfies that control without producing
`UNSUPPORTED`; no protocol V1 case can produce `UNSUPPORTED`. Other required
deterministic mismatches are `protocol_failure`/`DEGRADED`.

Protocol V1 scenario and suite freshness are both unbounded (`null`) because
their exact scenario, suite, fixture, compatibility-version, adapter, and
behavior digests invalidate behavior changes. A future profile may still set a
stricter maximum age.

## 9. CL-01 boundary

CL-01 may materialize and execute only the protocol manifests in the case
authority. It must:

1. parse the authority as JSON and reject unknown fields;
2. recompute all fixture, scenario, and suite digests, including the mandatory
   synthetic fixture marker/provenance fields;
3. retain the exact case fixture bytes and expanded manifests
   content-addressably;
4. execute only loopback mocks, closed adapter vectors, and the four exact
   in-memory MCP action tokens above;
5. fail registration rather than invent semantics.

This document and the JSON authority authorize no runner, mock server, ledger,
SQLite projection, fixture extraction from tests, live probe, or Fabric
ingestion implementation in CL-00.
