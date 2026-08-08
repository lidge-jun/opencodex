# CL-00 architecture and evidence contract

This document freezes the semantic model consumed by later Compatibility Lab
phases. Names shown in code blocks are contract names, not claims that
production TypeScript types already exist.

## 1. Evidence layers

### `protocol_conformance`

Question: does this OpenCodex build preserve the declared inbound-to-upstream
and upstream-to-client protocol contract?

Inputs are deterministic fixture requests and deterministic mock-upstream
responses. The subject includes the OpenCodex compatibility version, adapter,
inbound protocol, upstream protocol, surface, and relevant behavior
fingerprint. A real provider account is neither required nor permitted.

A pass proves only the exercised OpenCodex translation. It says nothing about a
provider's current availability or a model's coding quality.

### `live_route_compatibility`

Question: does this exact configured route satisfy this versioned scenario now?

The subject is an exact provider/model/effective-adapter/configuration route.
The run may contact only that route's configured upstream under the Lab
sandbox. A pass cannot be reused for a different route fingerprint.

A pass proves only the exercised route behavior at the observation time. It
does not prove task effectiveness.

### `task_effectiveness`

Question: did this exact route produce a successful, deterministically verified
outcome for a versioned task class?

Agent Fabric, not the Lab, owns real execution. The Lab receives a structured
outcome containing deterministic verifier results and sanitized artifact
references. Human ratings or LLM-judge output may be stored as advisory
annotations in a later phase, but cannot produce a canonical verdict.

### Non-collapse rule

The canonical projection key is:

```text
(subjectId, evidenceLayer, suiteId, suiteVersion, suiteManifestDigest,
 projectionSpecVersion)
```

There is no projection across all layers and no weighted universal score.
Callers may present multiple layer verdicts next to each other. A prerequisite
failure in one layer may make a later-layer run inapplicable, but it does not
rewrite evidence in the other layer.

## 2. Immutable ledger contract

The canonical JSONL ledger is a sequence of versioned events. The minimum
event kinds are:

```text
observation
claim_snapshot
invalidation
```

An `observation` records one scenario attempt. A `claim_snapshot` captures the
local declared-capability inputs and source revisions needed to reproduce
`CLAIMED`: registry/config, cached catalog or native metadata, including the
adapter inference currently assembled by `src/routing/capability.ts`. An
`invalidation` identifies prior evidence that a later-discovered harness,
fixture, redaction, or integrity defect makes unusable. Invalidations append;
they never delete or edit prior lines.

Each event has:

```text
schemaVersion
eventId
eventKind
recordedAt
producer
producerVersion
```

An observation additionally has:

```text
evidenceLayer
scenarioId
scenarioVersion
scenarioManifestDigest
suiteId
suiteVersion
suiteManifestDigest
fixtureDigests[]
subject
subjectId
startedAt
completedAt
executionMode          fixture | live | fabric
attempt
limits
outcome                pass | fail | blocked | inconclusive
assertions[]
failure?               { class, code, retryable, attribution }
expectedFailure?
environment
artifactRefs[]
sourceRefs?
```

Rules:

- Canonical JSON is RFC 8785 JSON Canonicalization Scheme (JCS), encoded as
  UTF-8 with no BOM.
- `eventId` is lowercase
  `sha256("ocx-lab:event:v1\0" || JCS(event without eventId))`.
- `subjectId` is lowercase
  `sha256("ocx-lab:subject:v1\0" || JCS(subject))`.
- Scenario and suite manifests use the same JCS construction with domains
  `ocx-lab:scenario-manifest:v1` and `ocx-lab:suite-manifest:v1`. Fixture
  digests are lowercase
  `sha256("ocx-lab:fixture:v1\0" || exact fixture bytes)`. A manifest's digest
  field and storage path are excluded from its preimage. Domain text is UTF-8
  and terminated by one NUL byte.
- Every observation carries the exact scenario, suite and fixture digests it
  executed. Version strings without matching digests are invalid evidence.
- Timestamps are UTC epoch milliseconds; duration alone is not sufficient.
- Assertions record expected value/shape, observed normalized value/shape, and
  pass/fail. They never require raw prompts or unbounded bodies.
- `failure.attribution` records whether the failure is attributable to
  OpenCodex, the exact route, the environment, or the harness.
- Artifact references contain digest, media type, byte count, redaction
  policy, and local relative path; never an arbitrary filesystem path.
- `sourceRefs` may contain existing request IDs, route-decision IDs, or future
  Fabric outcome IDs. It must not inline the referenced request or task.
- The shipped request-history explain surface already composes selection trace,
  `PersistedUsageAttempt[]`, and final outcome. A later Lab consumer should link
  that normalized composition instead of reading prompt-bearing
  `responses-state.json` or treating generated Cursor task protobufs as durable
  OpenCodex state.
- A structurally invalid or partially written line contributes no evidence and
  is reported as ledger corruption. SQLite must be rebuildable from all valid
  complete lines.

The canonical scenario manifest, suite manifest and synthetic fixture bytes
referenced by an observation are retained as content-addressed
`scenario_manifest`, `suite_manifest`, and `fixture` artifacts. These contract
artifacts have indefinite retention while any non-invalidated observation
references them. A missing or digest-mismatched contract artifact makes that
observation unusable and yields `harness_failure`; projection code must never
substitute the current manifest for the historical one.

The SQLite projection may cache derived verdict rows. Such rows must include
their `asOf`, projection spec, scenario/suite/fixture manifest digests, and
contributing event IDs. Deleting SQLite and replaying JSONL plus the referenced
content-addressed contract artifacts must reproduce them.

## 3. Canonical verdict contract

The closed verdict set is:

```text
UNKNOWN
CLAIMED
PROBED
VERIFIED
DEGRADED
BLOCKED
UNSUPPORTED
```

Verdicts are projections, not mutable evidence fields.

### `UNKNOWN`

Produced when no current registry support claim and no current, valid,
attributable observation can classify the projection key.

It can also result when all prior evidence became stale or was invalidated and
there is no current claim or blocker. Absence of a test is not
`UNSUPPORTED`.

### `CLAIMED`

Produced only by a current snapshotted positive local capability declaration
for the exact capability/subject, when no current executable evidence yields a
stronger state. The snapshot records whether the declaration came from explicit
provider config, Provider Registry, cached catalog, native metadata, or current
adapter inference rather than pretending every claim is registry-authored.

A claim cannot produce `PROBED` or `VERIFIED`. A registry negative declaration
is shown as claim metadata but does not by itself prove `UNSUPPORTED`.

### `PROBED`

Produced when at least one required executable scenario completed with an
attributable pass, but the suite's versioned verification rule is not yet
satisfied. Examples are partial required-scenario coverage or a scenario whose
assertions establish reachability/shape but not full suite verification.

Connectivity-only `/models` checks, registry discovery, doctor output, health
samples, and blocked attempts cannot produce `PROBED`.

### `VERIFIED`

Produced only when every requirement in the suite manifest's verification rule
is met by current, valid, attributable observations for the exact projection
key, and no newer current contradictory attributable failure remains
unresolved.

The projection must expose:

- exact contributing event IDs;
- suite/scenario versions and manifest digest;
- subject ID and full local subject;
- projection algorithm version and `asOf`;
- freshness calculation;
- any invalidations and contradictory events considered.

An LLM judge, user assertion, registry declaration, successful model listing,
or mutable `verified=true` flag cannot produce `VERIFIED`.

### `DEGRADED`

Produced when executable evidence proves that the capability works only
partially, loses required semantics, violates a required assertion while a
usable subset remains, or requires a suite-declared workaround.

Examples include malformed tool-call/result correlation, dropped reasoning
replay required by the suite, or incomplete stream semantics with otherwise
usable output. Environmental blockers cannot produce `DEGRADED`.

### `BLOCKED`

Produced when a current attempt cannot reach a compatibility assertion because
of an environmental or administrative precondition and no current
compatibility-attributable verdict should take precedence.

Authentication, quota, region policy, local network failure, provider
transients, harness failure, or exhausted Lab budget can yield `BLOCKED`. The
projection retains those classes separately.

A blocked retry does not erase a still-current `VERIFIED`, `PROBED`,
`DEGRADED`, or `UNSUPPORTED` verdict. Once that prior verdict is stale,
`BLOCKED` may become the current state until a conclusive run succeeds.

### `UNSUPPORTED`

Produced only by executable, suite-declared evidence that the exact capability
is unavailable by contract for this subject. The scenario must define an
unambiguous unsupported signal or negative-control assertion; a generic 4xx,
timeout, empty output, registry omission, or failed authentication is
insufficient.

Expected rejection of a deliberately unsupported feature can prove
`UNSUPPORTED` when the rejection itself matches the deterministic contract. It
is not a failed harness run.

### Projection precedence

For current valid evidence at the same projection key:

1. Satisfied full verification rule yields `VERIFIED`.
2. An unresolved attributable required-assertion failure yields `DEGRADED` or
   `UNSUPPORTED` according to the scenario's failure rule.
3. Partial positive coverage yields `PROBED`.
4. A blocker yields `BLOCKED` only when 1-3 have no current result.
5. A current positive registry claim yields `CLAIMED`.
6. Otherwise the result is `UNKNOWN`.

This is precedence, not a quality scale. In particular, `DEGRADED`,
`BLOCKED`, and `UNSUPPORTED` are not numeric values below `PROBED`.

## 4. Transitions, contradiction and freshness

Because verdicts are recomputed, a "transition" means that new events, time, or
version inputs change a projection.

Allowed transitions:

| From | May move to | Cause |
|---|---|---|
| `UNKNOWN` | any state | claim, observation, or blocker |
| `CLAIMED` | `UNKNOWN`, `PROBED`, `VERIFIED`, `DEGRADED`, `BLOCKED`, `UNSUPPORTED` | claim removal/staleness or executable evidence |
| `PROBED` | `UNKNOWN`, `CLAIMED`, `VERIFIED`, `DEGRADED`, `BLOCKED`, `UNSUPPORTED` | coverage, contradiction, staleness, invalidation |
| `VERIFIED` | `UNKNOWN`, `CLAIMED`, `PROBED`, `DEGRADED`, `BLOCKED`, `UNSUPPORTED` | partial remaining coverage after invalidation, contradiction, staleness, or changed inputs |
| `DEGRADED` | `UNKNOWN`, `CLAIMED`, `PROBED`, `VERIFIED`, `BLOCKED`, `UNSUPPORTED` | repair evidence, staleness, invalidation, or reclassification |
| `BLOCKED` | any state | blocker clears, prior evidence becomes current/stale, or claim changes |
| `UNSUPPORTED` | `UNKNOWN`, `CLAIMED`, `PROBED`, `VERIFIED`, `DEGRADED`, `BLOCKED` | route/version/config change, invalidation, or new evidence |

Direct transitions not listed are forbidden; implementations must not invent a
state outside this set.

Contradictory attributable evidence is never overwritten. The projection:

1. filters by exact subject/layer/suite/scenario versions;
2. applies invalidation events;
3. applies freshness;
4. orders observations by completion time and deterministic event-ID tie-break;
5. applies the suite's contradiction rule;
6. emits the contributing and contradicting event IDs.

The initial contradiction rule is conservative: a newer required-scenario
failure prevents `VERIFIED` until a newer pass of that scenario and all other
required coverage exists. A newer pass can restore `VERIFIED`; history remains.

### Freshness

Each scenario manifest declares its maximum evidence age. The suite manifest
may declare a stricter maximum, and a future Routing Profile may tighten it
again. Effective maximum age is the minimum of all finite scenario, suite and
profile values; `null` means no bound at that layer:

- deterministic protocol evidence has no wall-clock expiry by default, but is
  exact-match bound to scenario, suite, compatibility version, adapter and
  behavior fingerprint;
- initial live-route manifests default to seven days;
- initial task-effectiveness manifests default to thirty days;
- a profile's maximum evidence age is an additional upper bound, never an
  extension.

Stale observations remain queryable but cannot support current
`PROBED`/`VERIFIED`/`DEGRADED`/`UNSUPPORTED`. The projection may display a
`lastKnownVerdict` separately. Its current verdict falls to `CLAIMED`,
`BLOCKED`, or `UNKNOWN` according to current inputs.

### Version and configuration changes

- Evidence matches an exact scenario and suite version in contract v1. No
  implicit semver range reuse is allowed.
- A changed scenario assertion, fixture, requirement, or classification rule
  requires a new scenario version and invalidates old evidence for the new
  projection key.
- `opencodexCompatibilityVersion` is lowercase
  `sha256("ocx-lab:compatibility-version:v1\0" || JCS(manifest))`.
  The exact manifest object is:

  ```text
  {
    "schemaVersion": 1,
    "assertionDslVersion": "1.0.0",
    "evidenceSchemaVersion": "1.0.0",
    "bunRuntimeVersion": <exact Bun.version string>,
    "files": [
      {
        "path": <repository-relative POSIX path>,
        "sha256": <lowercase SHA-256 of exact raw file bytes>
      },
      ...
    ]
  }
  ```

  `files` contains every Git-index-tracked regular file under `src/`, plus
  `package.json`, `bun.lock`, and `scripts/model-metadata.source.json`, sorted
  by UTF-8 path bytes. Generation reads current working-tree bytes so a dirty
  behavior change cannot reuse clean-tree evidence. A missing file, a tracked
  symlink, a non-regular file, duplicate normalized path, invalid UTF-8 path,
  or unreadable file makes the run `harness_failure`; untracked files are not
  loaded by the compatibility harness. Release/package builds embed this
  generated manifest so an installed runtime does not require Git. This
  conservative whole-runtime input set may invalidate unrelated evidence, but
  cannot falsely reuse evidence after a behavior change. The package marketing
  version remains provenance only.
- A compatibility-version change starts a new subject projection.
- Any behavior-relevant configuration fingerprint change starts a new subject.
- Credential rotation alone does not change the subject.

## 5. Failure-attribution contract

Every non-pass observation uses exactly one primary class. Stable secondary
codes may add detail without changing these semantics.

| Class | Meaning | Affects verdict? | Default action |
|---|---|---:|---|
| `protocol_failure` | OpenCodex or the exact route emitted, accepted, ordered, translated, or terminated protocol data incorrectly | Yes, in the observation's layer | Conclusive; reverify after code/config/version change |
| `capability_failure` | The exact route cannot satisfy a capability assertion that it was expected to support | Yes | Conclusive when the scenario rules out an unsupported contract; otherwise retry once then `inconclusive` |
| `behavioral_failure` | A task-effectiveness deterministic verifier failed although protocol/capability prerequisites completed | Yes, task layer only | Conclusive for that task scenario |
| `authentication_blocked` | Missing, expired, rejected, or insufficient credentials prevented the assertion | No | `BLOCKED`; reauthenticate and retry |
| `quota_blocked` | Rate, credit, token, concurrency, or account quota prevented the assertion | No | `BLOCKED`; retry after reset/backoff |
| `region_blocked` | Region/tenant policy prevented execution | No | `BLOCKED`; retry only when route context changes |
| `network_failure` | DNS, TLS establishment, connect, local proxy, or transport reachability failed without provider response evidence | No | `BLOCKED`; repair environment and retry |
| `provider_transient` | Upstream returned a recognized transient/overload failure or interrupted a previously valid service path | No by default | `BLOCKED`; bounded retry/reverification |
| `timeout` | A versioned scenario deadline expired; secondary code distinguishes connect, first-byte, inactivity, or total budget | No by default | `BLOCKED`; bounded retry; reclassify only with deterministic protocol evidence |
| `harness_failure` | Runner, fixture, mock, sandbox, assertion engine, or artifact writer failed | No | Invalidate affected evidence and fix harness |
| `budget_exhausted` | Lab request/token/tool/byte/time budget ended the run before its assertion | No | `BLOCKED`; revise scenario limits/version or retry |
| `inconclusive` | Observations conflict or lack enough information for another class | No | No promotion/degradation; investigate/reverify |

Safety rules:

- Expired credentials never imply broken tool support.
- Quota exhaustion never implies model incompatibility.
- Local DNS/TLS/connect failure never degrades provider capability.
- A generic timeout never proves missing terminal semantics. A deterministic
  mock stream that closes without its required terminal event is
  `protocol_failure`; a live body that simply stalls is `timeout`.
- Malformed tool-call semantics, broken tool-result correlation, or lost
  required event ordering may legitimately produce `protocol_failure` and
  `DEGRADED`.
- `provider_transient` may be promoted to a compatibility-affecting class only
  by a scenario-specific deterministic rule and a new observation; projection
  code must not infer promotion from retry count.
- An expected failure is first-class scenario data. When the observed
  rejection exactly matches a declared unsupported assertion, it can produce
  `UNSUPPORTED`. Any other expected failure remains a pass/fail of the
  assertion, not a blanket suppression.

## 6. Canonical route subject

Evidence is never keyed by model name alone. `RouteSubjectV1` contains:

```text
subjectSchemaVersion
providerId
providerInstanceFingerprint
clientModelId
upstreamModelId
effectiveAdapter
inboundProtocol
upstreamProtocol
surface
opencodexCompatibilityVersion
behaviorFingerprint
endpointFingerprint
dependencies[]
```

Semantics:

- `providerId` is the built-in registry ID or `custom`; it is not a display
  label.
- `providerInstanceFingerprint` is a locally salted HMAC over the configured
  provider identity, allowing two instances of one preset to differ without
  leaking a user-selected name. All local opaque fingerprints use lowercase
  HMAC-SHA-256 over
  `UTF8("ocx-lab:local-fingerprint:v1\0" + fieldName + "\0") || JCS(value)`
  with the installation salt as key.
- `clientModelId` is the selected canonical route model; `upstreamModelId` is
  the effective wire model after namespace, virtual-model, combo and suffix
  resolution.
- `effectiveAdapter` reflects model-specific wire defaults/overrides and wire
  pins, not merely the provider-wide configured adapter.
- Protocol values distinguish OpenAI Responses, OpenAI Chat Completions,
  Anthropic Messages, and provider-specific wires.
- `surface` distinguishes behaviorally different ingress/transport paths such
  as Responses HTTP, Responses WebSocket, Chat HTTP/SSE, and Anthropic
  Messages HTTP/SSE.
- The package/build version remains observation provenance in
  `producerVersion`; only `opencodexCompatibilityVersion` participates in the
  subject so an unrelated release does not discard valid conformance evidence.
- `endpointFingerprint` is a locally salted HMAC of the normalized destination
  scheme/host/port/base path. Raw URLs, userinfo, query strings, and fragments
  are not evidence fields.
- `dependencies` is an ordered list of flat `RouteDependencyV1` records for
  behaviorally invoked sidecars. Each record contains role, provider ID,
  provider-instance fingerprint, client/upstream model IDs, effective adapter,
  upstream protocol, endpoint fingerprint, and behavior fingerprint. It cannot
  nest. Records sort by role, provider ID, upstream model ID, then endpoint
  fingerprint. An empty list is canonical when no sidecar is invoked.

### Behavior fingerprint allowlist

The fingerprint is SHA-256 over canonical JSON containing only effective,
behavior-changing values applicable to the selected model/surface:

- adapter/wire resolution and `responsesPath`;
- auth mode and auth transport, but no credential/account identity;
- stateful/stateless Responses behavior, upstream streaming mode, service-tier
  support, snapshot and item-ID repair;
- context/input/output limits and input modalities;
- reasoning capability, effort/default/mapping/wire/summary/replay/split/
  toggle/budget behavior;
- tool-choice restrictions, parallel-tool support, hosted-tool preference,
  freeform/custom-tool handling, built-in-name escaping;
- prompt-cache forwarding, Anthropic EOF policy, model suffix handling;
- Google mode and opaque project/location fingerprints where applicable;
- OpenRouter routing preferences where applicable;
- actual Bun runtime version and platform/architecture whenever the selected
  stream path or adapter has platform-sensitive behavior;
- effective vision and web-search sidecar enablement, backend, model,
  reasoning, per-turn limits, timeout/stall limits, and the matching flat
  dependency subject when that sidecar can execute;
- MCP schema/result/tool count bounds, with all Lab execution facilities forced
  to the sandbox settings in the security contract;
- effective global stream mode, fast/service-tier behavior, and effort caps
  when they can alter the scenario;
- a digest of non-credential custom header behavior.

Values that are inapplicable to the selected model/surface are omitted rather
than copied wholesale. Canonical JSON sorts keys, normalizes absent/default
values to their effective value, and sorts set-like arrays while preserving
order-sensitive arrays.

The following never participate:

- API keys, OAuth/access/refresh tokens, cookies, authorization headers;
- account IDs, emails, labels, aliases, quota balances or plan names;
- raw custom/private header names or values;
- prompts, messages, tool results, repository paths or contents;
- timestamps, transient health, latency, cost, quota or retry state.

Credential headers are excluded. Non-credential custom headers contribute only
through a locally salted HMAC over normalized names/values, so a behavior
change alters identity without disclosing the header. Project/location and
custom endpoint values use the same local opaque treatment.

Public export replaces all local fingerprints with export-scoped opaque IDs
and redacts custom model IDs unless the export policy explicitly classifies
them as public.

## 7. Task-effectiveness ingress

A future Fabric observation must provide, at minimum:

```text
producerSchemaVersion
outcomeId
taskClassId
taskClassVersion
subject
startedAt
completedAt
resourceLimits
result                   success | failure | blocked | inconclusive
verifiers[]              { id, version, result, normalizedMetrics? }
artifactRefs[]
```

The Lab rejects an outcome if the subject cannot be reconstructed, a verifier
is nondeterministic for a canonical assertion, or an artifact violates the
security contract. Free-form narrative may be retained only as bounded,
sanitized advisory metadata and never determines the verdict.

## 8. Consumer boundaries

- Provider Registry supplies claims; Lab does not rewrite them.
- Request history supplies route/outcome references; Lab does not copy its
  ledger.
- Selection and execution stay separate: `RouteDecisionTraceV1` records the
  pre-dispatch choice, `attempts[]` records physical execution/fallback, and
  final outcome is joined at read time.
- Routing Profiles express user requirements; Lab does not evaluate policy.
- Router Intelligence reads projections; Lab does not rank candidates.
- Route decision traces explain compatibility exclusions/penalties in the
  existing trace; Lab does not create a parallel route explanation.
- Agent Fabric executes tasks; Lab does not run arbitrary repository work.
