# CL-00 scenario contract and initial catalogue

This document freezes the scenario schema and the initial IDs. CL-01 implements
the `*.protocol.*` scenarios only. Entries marked live or Fabric-reserved define
future semantics and are not authorization to execute them.

The normative V1 selector/operator semantics, immutable fixture anchors,
expanded defaults and complete protocol scenario/suite manifest records are in
[the protocol V1 manifest authority](./021_protocol_v1_manifest_authority.md);
its canonical fixture vectors and literal expectations are in
[`022_protocol_v1_cases.json`](./022_protocol_v1_cases.json).

## 1. Versioned scenario model

A `CompatibilityScenarioV1` has:

```text
schemaVersion           1
id                      stable lowercase dotted ID
version                 exact semver
suite                   { id, version, evidenceLayer }
evidenceLayer           protocol_conformance |
                        live_route_compatibility |
                        task_effectiveness
capability              stable capability ID
verificationRole        required | supplemental | negative_control
requirements
fixtures
executionLimits
assertions[]
failureRules[]
artifactPolicy
freshness
```

### Identity and versioning

- `id` names semantics and does not contain a provider, model, or version.
- `version` is exact-match in contract v1.
- Any assertion, fixture, limit that affects expected behavior, failure rule,
  artifact exposure, or requirement change increments the scenario version.
- Editorial description changes do not require a version change.
- A suite manifest has its own exact version and lists scenario IDs, versions,
  roles, and its verification rule.
- A suite manifest belongs to exactly one `evidenceLayer`; a scenario and suite
  with different layers are invalid. Human-facing suite stems may recur across
  layers, but their manifest keys are
  `(id, evidenceLayer, version, manifestDigest)`.
- Scenario and suite manifests are RFC 8785 canonical JSON with the
  domain-separated digest defined by the evidence contract.

### Requirements

Requirements are declarative and may include:

```text
inboundProtocols[]
upstreamProtocols[]
surfaces[]
requiredClaims[]
requiredHarnessFeatures[]
platforms[]
routePreconditions[]
```

An unmet deterministic fixture requirement is `harness_failure`. An unmet live
route precondition is either inapplicable or a typed blocker; it is never
silently counted as a capability failure.

### Fixtures

Fixture references include ID, content digest, media type, generator version
where generated, and role (`client_request`, `upstream_response`,
`adapter_vector`, `synthetic_tool`, `synthetic_image`, or `task_fixture`). A
fixture never embeds credentials, user data, or an external mutable URL.

Protocol fixtures run against a deterministic mock upstream. Live scenarios use
only Lab-owned synthetic requests and inert tools. Fabric scenarios refer to a
versioned synthetic task class; they do not place a repository in the Lab
ledger.

### Execution limits

Every scenario states:

```text
totalTimeoutMs
connectTimeoutMs?
firstByteTimeoutMs?
inactivityTimeoutMs?
maxRequests
maxInputBytes
maxOutputBytes
maxOutputTokens?
maxToolCalls
maxArtifactBytes
```

Absent limits are invalid. Limits may be stricter than Lab-wide ceilings but
not wider without a scenario version change and security review. Expiry of a
limit classifies as `timeout` or `budget_exhausted` according to the failed
limit; it does not imply incompatibility.

### Deterministic assertion DSL

Canonical assertions use a closed set of observable operators:

```text
http_status_equals
header_present
header_absent
header_value_equals
json_schema_matches
json_path_equals
json_path_present
json_path_absent
sse_field_equals
sse_event_sequence
sse_event_count
terminal_signal_equals
id_matches
id_stable_across_events
id_correlates
tool_call_equals
tool_result_correlates
fixture_request_matches
normalized_text_equals
byte_limit_observed
process_exit_equals
verifier_result_equals
```

Each assertion has an ID, operator, selector, expected value, required flag,
and redaction-safe observed summary. Implementations must exhaustively reject
unknown operators. Protocol V1 permits no arbitrary regular expressions; ID
grammars and all operator type/missing-value behavior are closed in the
manifest authority.

Core verdicts cannot use an LLM judge, free-form human interpretation, or a
snapshot that contains unstable timestamps/IDs without normalization.

### Failure rules

Rules are ordered and explicit:

```text
match                  assertion IDs, normalized status/error/event/timeout
classification         canonical failure class
secondaryCode
verdictEffect          none | degraded | unsupported
retry                  never | bounded | after_precondition_change
expected               boolean
```

The first exact rule wins. If no rule establishes a compatibility-attributable
class, the attempt is `inconclusive`. Generic HTTP 4xx/5xx rules may classify a
blocker or transient but cannot prove `UNSUPPORTED`.

Manifest registration must enforce the exhaustive classification/effect matrix
in `010_architecture_and_evidence_contract.md`. Environmental, timeout,
budget, harness, transient, and inconclusive classes permit only
`verdictEffect: none`; a manifest that maps any of them to `degraded` or
`unsupported` is invalid.

`expectedFailure`, when present, includes `controlKind`, exact class/code,
assertion IDs, `onMatch`, and `onMismatch`. A
`conformance_negative_control` exact rejection is a verification pass with no
verdict effect. A `capability_absence_control` may produce `UNSUPPORTED`. These
meanings cannot be combined in one scenario observation.

### Artifact policy

The policy is deny-by-default and names allowed normalized artifacts:

```text
assertion_report
sanitized_request_shape
sanitized_response_shape
normalized_event_trace
sanitized_error
verifier_summary
```

It states per-artifact and aggregate byte limits, retention class, local/public
visibility, and redaction profile. Raw credentials, prompts, hidden reasoning,
full task repositories, arbitrary headers, and arbitrary response bodies are
not valid artifact kinds.

Each scenario declares `freshness.maxAgeMs`; its suite may declare a stricter
bound, and a future profile may tighten it again. Effective maximum age is the
minimum finite bound, with `null` meaning unbounded at that layer.

## 2. Suite projection rules

For each exact suite manifest, first compute the required scenarios whose
manifest requirements are applicable to the exact subject. That applicable
required set must be non-empty for any positive executable verdict.

- `VERIFIED`: the applicable required set is non-empty; every applicable
  `required` scenario has a current pass; and every applicable
  `conformance_negative_control` observed its exact required rejection.
- `PROBED`: at least one applicable required scenario passed, with no current
  compatibility-attributable required-scenario failure, but the suite's
  verification rule is not fully satisfied.
- `DEGRADED`: a failure rule on an applicable required scenario yields
  `degraded`.
- `UNSUPPORTED`: a required scenario's exact
  `capability_absence_control` proves the capability unavailable.
- `BLOCKED`: only blockers exist and no current attributable verdict takes
  precedence.
- `CLAIMED`/`UNKNOWN`: follow the evidence contract.

An inapplicable required scenario contributes neither a pass nor a failure. If
no required scenario is applicable, the suite cannot project `PROBED` or
`VERIFIED`; it falls through to `CLAIMED` or `UNKNOWN` under the evidence
contract. If execution was attempted but an environmental or administrative
precondition prevented reaching assertions, that attempt is a typed blocker
and may project `BLOCKED` under normal precedence; it is not treated as
inapplicability.

Supplemental scenarios never block `VERIFIED` unless a new suite version makes
them required.

## 3. Initial suite catalogue

All initial scenario versions and suite versions are `1.0.0`.

For protocol V1, the literal fixtures/assertions in `022` are the complete
verification boundary. Descriptions below summarize those exact vectors; they
do not silently incorporate every historical incident mapped to the same
scenario ID. An incident absent from `022` is candidate coverage for a reviewed
scenario/suite version amendment and cannot be claimed by a V1 `VERIFIED`
verdict.

### `responses-core`

Purpose: preserve the OpenAI Responses request, output-item lifecycle, stream
framing, IDs, terminal state, and JSON/SSE equivalence.

Capability: `protocol.responses.core`.

| Scenario ID | Layer/applicability | Required observable assertions |
|---|---|---|
| `responses-core.protocol.request-shape` | Deterministic; CL-01 | Mock receives the exact model, first user text and zero temperature |
| `responses-core.protocol.sse-framing` | Deterministic; CL-01 | Spaced and unspaced data fields, a non-record `null` frame, data-only event inference, exact text and completion terminal |
| `responses-core.protocol.item-lifecycle` | Deterministic; CL-01 | One added/done/completed lifecycle with stable valid message ID |
| `responses-core.protocol.terminal-state` | Deterministic; CL-01 | One explicit failed terminal is preserved exactly |
| `responses-core.protocol.json-sse-equivalence` | Deterministic; CL-01 | One normalized JSON/SSE pair has equal text and completion terminal |
| `responses-core.live.basic-turn` | Live-reserved | 2xx, bounded output, valid lifecycle and terminal state from exact route |

Unsupported means a route deterministically rejects the Responses surface with
a suite-recognized unsupported signal. Semantic loss, invalid IDs, malformed
event order, or missing terminal state is degraded. Auth/quota/region/network,
transient upstream errors, and body stalls are blocked.

### `chat-core`

Purpose: preserve OpenAI Chat Completions request/response semantics for JSON
and streaming routes.

Capability: `protocol.chat.core`.

| Scenario ID | Layer/applicability | Required observable assertions |
|---|---|---|
| `chat-core.protocol.request-mapping` | Deterministic; CL-01 | System/developer/user order and JSON-object response format match the fixture |
| `chat-core.protocol.nonstream-envelope` | Deterministic; CL-01 | One valid choice/message/finish/usage envelope yields exact text and terminal |
| `chat-core.protocol.stream-assembly` | Deterministic; CL-01 | Fragmented/interleaved deltas assemble in order and emit one finish |
| `chat-core.protocol.stream-terminal` | Deterministic; CL-01 | One stop finish plus `[DONE]` yields exact text and one terminal |
| `chat-core.live.basic-turn` | Live-reserved | Exact route returns bounded text and a valid finish contract |

Unsupported is a deterministic surface rejection. Incorrect role mapping,
malformed choices, lost stream fragments, or invalid finish semantics is
degraded. Environmental and transient failures are blocked.

### `anthropic-core`

Purpose: preserve Anthropic Messages roles/content blocks, tool/thinking block
ordering, stop reasons, usage, and SSE lifecycle.

Capability: `protocol.anthropic.messages.core`.

| Scenario ID | Layer/applicability | Required observable assertions |
|---|---|---|
| `anthropic-core.protocol.request-mapping` | Deterministic; CL-01 | Model, system instruction and first user text map exactly |
| `anthropic-core.protocol.content-sequence` | Deterministic; CL-01 | `message_start`, monotonic content blocks/deltas/stops, `message_delta`, `message_stop` |
| `anthropic-core.protocol.tool-round-trip` | Deterministic; CL-01 | One `tool_use`/`tool_result` pair preserves its ID correlation and result text |
| `anthropic-core.protocol.terminal-errors` | Deterministic; CL-01 | One explicit Responses failure maps to the Anthropic error/failed terminal |
| `anthropic-core.live.basic-turn` | Live-reserved | Exact route returns a valid bounded Messages lifecycle and terminal |

Unsupported is a recognized Messages-surface rejection. Wrong block ordering,
lost tool correlation, invalid stop reason, or clean EOF accepted without the
suite's terminal contract is degraded. Authentication, quota, region, network,
transient failure, and silence timeout are blocked.

### `tools-core`

Purpose: prove deterministic function/custom tool declaration, call assembly,
parallel correlation, and result continuation.

Capability: `tools.round_trip`.

| Scenario ID | Layer/applicability | Required observable assertions |
|---|---|---|
| `tools-core.protocol.function-round-trip` | Deterministic; CL-01 | One function call preserves ID/name/parsed arguments and its continuation result correlates |
| `tools-core.protocol.custom-freeform-round-trip` | Deterministic; CL-01 | One `apply_patch` call preserves exact freeform input and its continuation result correlates |
| `tools-core.protocol.parallel-correlation` | Deterministic; CL-01 | Two interleaved calls assemble once in first-seen order without overlap |
| `tools-core.protocol.result-content` | Deterministic; CL-01 | One result preserves exact text and data-image parts |
| `tools-core.protocol.choice-and-allowed-set` | Deterministic; CL-01 | One required single-tool allowed set narrows exactly without widening |
| `tools-core.live.function-round-trip` | Live-reserved | Inert deterministic function is called once with schema-valid args and static result is continued |
| `tools-core.live.custom-freeform-round-trip` | Live-reserved | Route emits exact custom/freeform call and accepts static result continuation |

An explicit route `capability_absence_control` that rejects a tool kind can
prove unsupported.
Malformed arguments, dangling IDs, widened choice, dropped calls/results, or
incorrect parallel assembly is degraded. A model choosing not to call an
`auto` tool is inconclusive; required tool choice is used for conclusive live
coverage. Environmental failures are blocked.

### `codex-core`

Purpose: establish the minimum end-to-end semantics required to advertise a
route as usable by Codex. A basic Responses text request is insufficient.

Capability: `client.codex.core`.

| Scenario ID | Layer/applicability | Required observable assertions |
|---|---|---|
| `codex-core.protocol.streaming-turn` | Deterministic; CL-01 | One Chat-backed stream yields exact text, final-answer phase and one completed terminal |
| `codex-core.protocol.apply-patch-turn` | Deterministic; CL-01 | One custom `apply_patch` call preserves exact patch text and its result ID correlates |
| `codex-core.protocol.tool-continuation` | Deterministic; CL-01 | One function result follows and correlates with its prior call |
| `codex-core.protocol.previous-response-replay` | Deterministic; CL-01 | One local expansion preserves stored input/output/new-input order and strips `previous_response_id` |
| `codex-core.protocol.structured-output` | Deterministic; CL-01 | One JSON-schema request maps to the exact Chat `response_format` |
| `codex-core.protocol.compaction-and-special-items` | Deterministic; CL-01 | Compaction, local shell, tool search and hosted-tool items are normalized without leaking opaque raw data |
| `codex-core.live.tool-turn` | Live-reserved | Valid stream plus required inert tool call/result continuation and terminal |
| `codex-core.live.custom-tool-turn` | Live-reserved | Required custom/freeform call/result continuation and valid terminal |

The `codex-core` manifest requires all six protocol scenarios for conformance
verification. Future live verification requires both live scenarios plus
current `responses-core.live.basic-turn`. Text-only success is at most partial
coverage, never `codex-core: VERIFIED`.

An exact route may be unsupported when it deterministically lacks a mandatory
Codex surface or tool kind. Lossy lifecycle, call/result correlation,
continuation, or special-item behavior is degraded. Environmental failures are
blocked.

### `vision-core`

Purpose: preserve declared image input and tool-result image behavior and prove
exact-route image understanding without user media.

Capability: `modalities.image.input`.

| Scenario ID | Layer/applicability | Required observable assertions |
|---|---|---|
| `vision-core.protocol.input-image` | Deterministic; CL-01 | One data-URL image preserves detail and text/image ordering |
| `vision-core.protocol.tool-result-image` | Deterministic; CL-01 | Image content in function/tool result remains structured and correlated |
| `vision-core.protocol.modality-gate` | Deterministic negative control; CL-01 | A text-only/no-sidecar synthetic vector produces the typed unsupported path without silent image drop |
| `vision-core.live.synthetic-ocr` | Live-reserved | Lab-generated image nonce is returned in an exact JSON schema |

A deterministic declared no-image `capability_absence_control` may prove
unsupported. The protocol V1 modality gate is instead a conformance negative
control whose exact rejection is a verification pass. Dropping, textifying
without a declared sidecar, corrupting, or misordering image content is
degraded. Failure of the optional sidecar route is attributed to that exact
subject. Auth/quota/network/transient failures are blocked.

### `reasoning-core`

Purpose: preserve supported reasoning controls, summaries, signatures and
replay while preventing provider-private reasoning material from crossing an
incompatible boundary.

Capability: `reasoning.round_trip`.

| Scenario ID | Layer/applicability | Required observable assertions |
|---|---|---|
| `reasoning-core.protocol.effort-mapping` | Deterministic; CL-01 | Effective effort maps to the declared wire form and unsupported parameters are omitted |
| `reasoning-core.protocol.summary-stream` | Deterministic; CL-01 | One summary-part/delta/completed sequence preserves ordering and reasoning ID |
| `reasoning-core.protocol.replay` | Deterministic; CL-01 | One synthetic plaintext/signature replay reaches the second turn exactly |
| `reasoning-core.protocol.private-content-isolation` | Deterministic; CL-01 | One provider-private value is absent from an incompatible upstream and client response |
| `reasoning-core.live.replay` | Live-reserved | Synthetic two-turn route accepts its declared replay form and completes |

An explicit no-reasoning route can prove unsupported. Rejected or corrupted
declared replay, lost required signatures, or private content sent across an
incompatible provider boundary is degraded (and the latter is also a security
finding). Environmental failures are blocked.

### `mcp-core`

Purpose: preserve MCP namespace, schema, tool/resource invocation and result
contracts through supported adapters without touching user MCP servers.

Capability: `tools.mcp.core`.

| Scenario ID | Layer/applicability | Required observable assertions |
|---|---|---|
| `mcp-core.protocol.namespace-mapping` | Deterministic; CL-01 | One namespace/name pair flattens and reverses exactly |
| `mcp-core.protocol.schema-and-bounds` | Deterministic; CL-01 | Tool schemas encode correctly; exact configured bounds admit and one-byte-over rejects atomically |
| `mcp-core.protocol.call-result` | Deterministic; CL-01 | Lab stub receives one exact call and returns one successful text result |
| `mcp-core.protocol.resource-round-trip` | Deterministic; CL-01 | One list/read resource success shape preserves URI, name and text |
| `mcp-core.live.synthetic-tool` | Live-reserved | Lab-owned loopback pure-function MCP tool is advertised, called and correlated |

Only a Lab-owned in-memory or loopback fixture is allowed. A route that
deterministically cannot expose MCP may be unsupported. Namespace loss, schema
corruption, partial bound commits, or result miscorrelation is degraded.
User-server unavailability is never tested; environmental failures are blocked.

### `fabric-core` task-effectiveness reservation

This is a distinct `task_effectiveness` suite manifest, not an extension of a
protocol or live-route manifest:

```text
suite.id                 fabric-core
suite.version            1.0.0
suite.evidenceLayer      task_effectiveness
verificationRule         all-applicable-required-pass-v1
freshness.maxAgeMs       2592000000
```

The first reserved scenario is
`fabric-core.task.synthetic-patch@1.0.0`:

- subject: exact `TaskSubjectV1`;
- verification role: `required`;
- fixture: a content-addressed synthetic scratch tree containing
  `src/value.txt` with UTF-8 bytes `before\n`, plus a task-class manifest that
  requests the exact final bytes `after\n`;
- execution: Fabric-owned, no user repository/prompt, no network, no user MCP,
  no shell, and filesystem access restricted to that synthetic scratch tree;
- limits: one file, 64 KiB aggregate input/output, one patch operation,
  30-second total, 5-second inactivity, and 1 MiB aggregate artifacts;
- verifier manifest: `exact-tree-diff-v1`, whose digest participates in
  `TaskSubjectV1`;
- deterministic verifier: sort repository-relative POSIX paths by UTF-8 bytes,
  reject symlinks/special files/path traversal, hash exact file bytes, and pass
  only when the sole diff changes `src/value.txt` from `before\n` to `after\n`
  with no added/deleted/renamed file;
- success assertion: verifier result `pass`;
- failure rules: verifier `fail` is `behavioral_failure -> degraded`;
  unavailable Fabric/sandbox is `harness_failure -> none`; exhausted time/bytes
  is the corresponding blocker with effect `none`;
- artifact policy: retain only the bounded normalized path/digest diff and
  verifier summary, never file bodies.

This reservation freezes task-subject and verifier semantics for a later Fabric
phase. It does not authorize CL-01 to implement or execute the task.

## 4. CL-01 implementation boundary

CL-01 may implement the scenario registry, deterministic mock-upstream harness,
closed assertion DSL, and only the `protocol_conformance` manifests frozen in
`021_protocol_v1_manifest_authority.md`. It must not:

- contact a real provider;
- write the planned production evidence ledger or SQLite projection;
- add profile/routing controls;
- execute a user tool, shell, filesystem, repository, MCP server, or external
  network action;
- implement live/Fabric scenarios merely because their IDs are reserved here.

If CL-01 discovers that an observable assertion cannot be implemented without
new semantics, it must amend this contract in a reviewed change rather than
quietly inventing behavior.
