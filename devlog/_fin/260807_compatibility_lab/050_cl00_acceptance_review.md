# CL-00 independent acceptance review

Date: 2026-08-08

Scope: the complete CL-00 contract set on
`feat/cl-00-compatibility-contracts`, based on
`3ad5bb6bd3f76f6879d84b78ea39edd3e01ec296`. The initial delayed-review
acceptance was recorded at `12e50a3502fb4af25283538cc717ead2291edd8b`.
CodeRabbit re-reviews were validated against current production code and the
contract authority before any change was accepted. This record supersedes the
stale acceptance/status statements from the earlier passes.

The review is contract-focused and separate from the original authoring pass.
Every validated Critical, High, and Medium finding was corrected. Valid
deterministic and security-contract defects were also corrected regardless of
review label. CL-02 was not started.

## Findings and corrections

### Critical

None.

### High

1. Initial scenario prose did not define executable selector/operator semantics
   or canonical per-case manifests.
   - Correction: added the closed assertion/selector/SSE contract in `021` and
     the 35-case machine-readable authority in `022`, with literal fixtures,
     expected values, row-specific requirements, roles, media types, limits,
     artifact policy, and failure rules.
2. Immutable observations lacked enough manifest/fixture provenance to
   reproduce `VERIFIED`.
   - Correction: observations now carry scenario, suite, and fixture digests;
     domain-separated digest preimages are exact; referenced manifests and
     fixtures are retained content-addressably and cannot be replaced by the
     current version during replay.
3. Route identity did not close compatibility-version and sidecar-dependent
   behavior.
   - Correction: froze the compatibility-version manifest/preimage, included
     effective runtime and sidecar settings, added flat dependency identities,
     and kept route-local endpoints in the composite subject rather than the
     provider-independent scenario manifest.
4. Response-only protocol vectors did not identify an initiating client
   request.
   - Correction: added 11 explicit initiating request fixtures. All
     `upstream_response` cases now have one request that fixes model, input,
     stream mode, and inbound surface.
5. Named verifier values had no deterministic derivation.
   - Correction: defined every V1 verifier as a closed pure function over the
     current synthetic fixture and normalized observation.
6. Catalogue prose and incident mappings initially implied coverage beyond the
   literal V1 assertions.
   - Correction: narrowed every protocol V1 row to its exact `022` evidence and
     made incident mappings explicit future scenario/version inputs when no
     literal V1 vector exists.
7. The three evidence layers lacked separate executable subject identities,
   and suites could span layers.
   - Correction: added the closed `ProtocolSubjectV1`, `RouteSubjectV1`, and
     `TaskSubjectV1` union, exact layer/subject matching, layer-qualified suite
     manifests, and one reserved deterministic Fabric task/verifier contract.
8. Behavior identity did not explicitly close effective
   `commandCodeVersion`, sampling-parameter omission sets, `cacheRetention`, or
   unknown future behavior inputs.
   - Correction: froze `BehaviorFingerprintV1`, its closed keys and source
     tags, required values from the production resolver, and fail-closed
     handling/tests for an unclassified behavior input.
9. A global protocol failure-rule list attached both control effects to every
   case, violating the legal control matrix.
   - Correction: the base rule set contains no control rule; expansion adds
     exactly one materialized rule only for a case with `expectedFailure`.
     Protocol V1 has one conformance control and no unsupported effect.
10. Tool/MCP assertions selected bare calls from the normalized SSE event array.
    - Correction: froze separate canonical `toolCalls[]` and `mcpCalls[]`
      semantic projections and moved all call/correlation selectors to them.
11. Chat-backed Responses cases expected adapter `done` instead of the
    client-visible `completed` terminal, and parallel-tool counting still used
    nonexistent `tool_call` SSE events.
    - Correction: those terminals now expect `completed`; parallel count/order
      derive from `/client/response/toolCalls`, and `toolCalls`/`mcpCalls` are
      part of the closed observation schema.

### Medium

1. `VERIFIED -> PROBED` was missing after partial invalidation.
   - Correction: added the transition for remaining partial coverage.
2. Scenario and suite freshness authorities conflicted.
   - Correction: effective age is the minimum finite scenario, suite, and
     profile bound.
3. Compatibility-version file hashing and dirty/missing/symlink behavior were
   underspecified.
   - Correction: froze the canonical object, file set, raw-byte hashes, sort
     order, current-working-tree behavior, and fail-closed cases.
4. Sidecar network wording incorrectly put route-local endpoints in scenario
   manifests.
   - Correction: manifests authorize only dependency roles/protocol classes;
     the composite subject owns exact destination fingerprints.
5. The MCP exact-bound vector was not actually at its stated boundary.
   - Correction: replaced it with exact 64-byte and 65-byte UTF-8 JSON schema
     payloads and a recomputed fixture digest.
6. The vision modality control could have made a compatible suite
   `UNSUPPORTED`.
   - Correction: made it a `negative_control`; its exact rejection satisfies
     the suite without projecting route-level `UNSUPPORTED`.
7. The compaction assertion tested presence rather than truth.
   - Correction: changed it to exact equality with `true`.
8. One result-content description claimed call correlation absent from its
   assertions.
   - Correction: removed the claim.
9. Environmental failure effects, claim supersession/currentness, and
   custom-header fingerprint ownership were not mechanically closed.
   - Correction: added the exhaustive class/effect matrix, formal
     `claim_snapshot`/`supersedes[]` schema and currentness algorithm, and a
     config-owner broker that exposes only a domain-separated header digest.
10. `ProtocolSubjectV1` named a second `runtimeFingerprint` without a schema.
    - Correction: removed it; the closed `runtime.*` behavior keys are the sole
      platform-sensitive identity inputs.

### Low

- Corrected the provider-test description: forward/static providers do not
  always perform a live `/models` request.
- Corrected historical reference `#745` from issue to pull request.
- Added `021`/`022` to the stack ledger and created this review record, closing
  all local document links.
- Corrected request-history evidence from “immutable” to canonical
  append-only, limited the profile claim to compatibility policy, and noted the
  explicit state-mutating `ocx doctor --fix-codex-runtime` mode.

## CodeRabbit remediation: first pass

All ten unresolved CodeRabbit threads in the first remediation pass were
inspected against current branch code/contracts before editing.

1. Stack audit metadata used a non-SHA dependency label where an exact CL-01
   base revision is required. The stack ledger now records exact base/head
   revisions and the CL-01 correction requirement.
2. `BehaviorFingerprintV1` did not define deterministic ordering for every
   array-valued closed key. V1 now classifies each allowed array as `set` or
   `ordered`, defines JCS-byte sorting/deduplication for sets, preserves source
   order for ordered arrays, and fails closed for any undeclared array input.
3. `all-applicable-required-pass-v1` admitted a vacuous `VERIFIED` result when
   zero required scenarios applied. Positive executable verdicts now require a
   non-empty applicable required set; zero-applicable falls through to current
   claim/unknown semantics, while attempted environmental blockers remain
   `BLOCKED`.
4. `[DONE]` handling was selected by the client-facing surface even for a Chat
   upstream fixture. Sentinel interpretation now follows the protocol of the
   byte stream being normalized; only OpenAI Chat recognizes exact `[DONE]`.
5. Two Chat-backed tool-result assertions incorrectly selected Responses
   `input[].call_id`. Production `openai-chat` emits the continuation as
   `messages[1].tool_call_id`; both selectors now assert the actual Chat wire.
6. Live-probe destination authorization could drift between endpoint
   fingerprinting, credential binding and connect. The security contract now
   requires one immutable per-run `LabDestinationV1` snapshot for every stage
   and fails closed before credential transmission on mutation/re-resolution or
   mismatch.
7. Ambient environment/proxy handling was not executable enough. The inherited
   environment allowlist is empty; the runner constructs only `TZ=UTC` and
   `NO_COLOR=1`, rejects uppercase/lowercase proxy variables, and cannot derive
   behavior from ambient variables.
8. Custom-header fingerprinting lacked resource/canonicalization bounds. The
   broker now enforces entry, duplicate-value, field-name, per-value and
   aggregate byte ceilings before JCS/HMAC, with unknown credential
   classification or overflow failing closed.
9. Ordinary invalidation wording allowed deletion of shared contract artifacts.
   Only event-private non-contract artifacts may be deleted after invalidation;
   shared scenario/suite/fixture artifacts survive until no usable observation
   references them.
10. Security acceptance coverage omitted the new invariants. Required tests now
    cover environment/proxy denial, destination snapshot mutation/address drift,
    custom-header canonicalization and bounds, subject-salt rotation, and
    retention expiry/cleanup/unavailable markers.

## CodeRabbit remediation: second pass

CodeRabbit reviewed the remediation again and raised additional deterministic
and security-contract issues. Every Major finding in that pass was validated as
material and corrected within CL-00:

1. `invalidation` had no executable payload. It now has a non-empty bounded,
   sorted/unique target-event set, a closed reason set, all-or-nothing target
   validation, earlier-event/type constraints, and no implicit uninvalidation.
2. `sourceManifestDigest` was not reproducible. `ClaimSourceManifestV1` now
   defines a closed sanitized source snapshot, a domain-separated digest,
   content-addressed retention, and replay validation. Missing/mismatched source
   bytes cannot produce `CLAIMED`.
3. Sidecar dependency sorting omitted `providerInstanceFingerprint`, so two
   otherwise-equal dependencies could compare as equal. The canonical total
   ordering now includes it.
4. Synthetic fixture trust was prose-only. Every expanded protocol V1
   `fixtureRef` now includes mandatory `ocx-lab-synthetic-v1` marker and
   `lab_authored` provenance bound to the authority and source commit; these
   fields participate in the scenario-manifest digest and are validated before
   fixture admission.
5. `synthetic_tool` did not say what MCP cases execute. The four MCP V1 cases
   now carry exact scenario-specific action tokens with closed fixture schemas,
   deterministic invocation/list/read/boundary behavior, and fail-closed
   registration for missing/wrong/multiple actions.
6. The credential broker could still expose the selected secret to Lab code.
   The contract now keeps secret bytes in trusted credential/transport plumbing
   and gives the Lab only a non-serializable, destination/auth-transport-bound,
   one-run/request `LabCredentialLeaseV1` capability.
7. Required execution limits had no hard maxima. V1 now freezes hard ceilings
   for wall/connect/first-byte/inactivity time, requests, aggregate input/output
   bytes, output tokens, tool calls, resident memory, child processes and
   artifacts; manifests/config/profiles/environment/callers can only tighten
   them.
8. Artifact path validation was vulnerable to path-race/symlink substitution if
   implemented like the unrelated current image-artifact helper. The future Lab
   store is now required to use trusted-directory-handle, no-follow,
   descriptor-bound validation/read/write and atomic publication. CL-00 did not
   alter `src/images/artifacts.ts`; that runtime is outside this contract-only
   phase.
9. Physical sensitive-evidence purge did not define canonical projection state.
   The ledger now defines privacy-safe `purge_tombstone` events, clean atomic
   ledger replacement, SQLite rebuild/removal, typed `purged_unavailable`
   artifacts, and mandatory exclusion of every verdict/claim that depended on
   purged evidence.

The protocol-authority rewrite also fixed the flagged missing final newline.
Two remaining review notes were editorial-only (`falsey` -> `falsy` in the
incident prose and a master-plan acceptance phrase); they do not change any
contract, deterministic behavior, security boundary, acceptance criterion, or
CL-01 implementation input and are handled as non-blocking review-thread
responses rather than expanding this contract remediation.

## Mechanical review evidence

- `022_protocol_v1_cases.json` remains valid JSON by inspection through the
  GitHub file API and contains the same 35 case objects / 46 fixture records as
  the accepted authority.
- Fixture `bytesUtf8` and fixture digest values were not changed by the
  CodeRabbit selector/provenance/MCP-action remediation.
- The two corrected Chat continuation selectors target
  `/upstream/requests/1/json/messages/1/tool_call_id`, matching the current
  `openai-chat` request builder's assistant-call then tool-result message order.
- `fixtureRef` expansion now adds mandatory marker/provenance fields. Therefore
  all expanded protocol scenario-manifest digests and dependent suite-manifest
  digests change even though fixture bytes/digests remain unchanged.
- Four MCP `requiredHarnessFeatures` arrays now additionally contain their exact
  closed action token. Those four scenario-manifest digests therefore also
  change for semantic reasons.
- `vision-core.protocol.modality-gate` remains the sole V1 negative control.
- Base failure rules contain no control effect; the vision case alone expands
  the conformance-control rule.
- The MCP bound fixture remains the accepted exact 64/65 UTF-8-byte vector.

## Repository verification

Initial acceptance verification remains the last executed local-suite evidence:

- `bun run typecheck`: passed.
- `bun run privacy:scan`: passed.
- `bun test tests/repo-hygiene.test.ts`: 11 passed, 0 failed.
- Focused protocol/compatibility suite excluding Windows privileged-symlink
  state cases: 395 passed, 0 failed across 24 files.
- Focused continuation-state semantics: 2 passed, 95 filtered, 0 failed.
- `tests/codex-models-cache-invalidate.test.ts`: 6 passed, 0 failed.
- `tests/codex-native-residue.test.ts`: 63 passed, 2 platform skips, 0 failed.
- Original local link/case/digest checks and `git diff --check`: passed.

The CodeRabbit remediation is documentation/contract-only. The GitHub connector
does not provide a local Bun execution environment, so this review does **not**
claim a new typecheck/privacy/test run after these documentation changes. Final
GitHub status/workflow contexts and unresolved review threads are checked after
the status-ledger sync.

The earlier full `bun run test` result was **not green**. On Windows with Bun
1.3.14 it exited 3 after a cache-invalidation failure, an empty effective-account
lookup, and a Bun `index out of bounds` panic. A broader focused run separately
found four `responses-state.test.ts` failures, all Windows `EPERM` errors
creating symlinks (488 passed, 4 failed). The isolated cache/native tests and
the non-privileged protocol suite passed; this review does not claim the full
suite passed.

## Required challenge results

1. Protocol conformance, live compatibility, and task effectiveness are
   separated: **PASS**.
2. Environmental failures cannot poison compatibility verdicts: **PASS**.
3. `VERIFIED` is reproducible, non-vacuous, and invalidation/purge aware:
   **PASS**.
4. Exact route/dependency identity prevents false evidence reuse: **PASS**.
5. `CLAIMED` is reproducible from retained sanitized source manifests:
   **PASS**.
6. Routing Profiles remain the sole compatibility-policy surface: **PASS**.
7. The Lab cannot become a second router or provider registry: **PASS**.
8. Synthetic-fixture admission, credentials, destinations, environment,
   resources, artifacts and purge behavior are fail-closed: **PASS**.
9. Historical incidents remain representable as deterministic versioned
   scenarios: **PASS**.
10. CL-01 remains implementable without semantic invention after synchronizing
    the refreshed V1 authority: **PASS WITH REQUIRED CL-01 REBASE, CORRECTION,
    AND REVALIDATION**.

## CL-01 impact

The independently accepted CL-01 branch exists at
`feat/cl-01-conformance-harness` at accepted head
`cc447ce9d19d5fb4e03988899f5fb495f9de8d0e`. It was built from the older CL-00
revision `c2113ca47b8a05c5a5f90679e4eaa640ca2c6a66`.

Its acceptance record explicitly documents a harness-only projection of
Chat-wire `messages` tool rows into a synthetic Responses-shaped `input[]` to
satisfy the old CL-00 selectors. That workaround is no longer authoritative:
CL-00 selects the actual Chat `messages[].tool_call_id` field. CL-01 also copied
the pre-remediation case authority and its SSE helper retained client-surface
sentinel selection.

Before CL-01 is stacked or merged it must therefore:

- rebase onto the final refreshed CL-00 accepted contract head;
- synchronize the two corrected Chat result selectors;
- remove or narrow the synthetic Chat-to-Responses `input[]` observation
  projection so upstream observations remain the actual Chat request;
- align SSE normalization with source-protocol `[DONE]` selection;
- implement/validate the mandatory synthetic fixture marker/provenance in
  expanded `fixtureRef` values and recompute all scenario/suite manifests;
- synchronize the four exact MCP action tokens and their closed execution
  semantics; and
- rerun the canonical CL-01 scenarios, negative controls, digest/manifest
  checks and independent CL-01 acceptance review.

This CL-00 remediation does not modify CL-01 and does not start CL-02.

## Verdict

All validated Critical, High, Medium, deterministic-contract and
security-contract findings found through the two CodeRabbit remediation passes
are corrected in the CL-00 contract set. Final GitHub thread/status checks are
recorded after the stack ledger is synchronized.

**CL-00: ACCEPTED AFTER CODERABBIT REMEDIATION**
