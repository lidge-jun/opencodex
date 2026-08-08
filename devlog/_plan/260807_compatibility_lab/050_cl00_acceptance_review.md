# CL-00 independent acceptance review

Date: 2026-08-08

Scope: the complete CL-00 contract set on
`feat/cl-00-compatibility-contracts`, based on
`3ad5bb6bd3f76f6879d84b78ea39edd3e01ec296`.

The review was read-only and separate from the authoring pass. Every validated
Critical, High, and Medium finding was corrected and re-reviewed before this
record was finalized.

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

### Low

- Corrected the provider-test description: forward/static providers do not
  always perform a live `/models` request.
- Corrected historical reference `#745` from issue to pull request.
- Added `021`/`022` to the stack ledger and created this review record, closing
  all local document links.

## Mechanical review evidence

- `022_protocol_v1_cases.json` parses as JSON.
- 35 unique cases cover all required members of the eight initial suites.
- 46 fixture artifacts are present: 35 primary vectors and 11 initiating
  requests.
- Every fixture digest matches
  `sha256("ocx-lab:fixture:v1\0" || UTF8(bytesUtf8))`.
- Every response fixture has one initiating request.
- The MCP bound vector is exactly 64/65 UTF-8 bytes.
- All named verifier selectors have one closed deterministic definition.
- `vision-core.protocol.modality-gate` is the sole V1 negative control and is
  represented as such in case and suite expansion.

## Repository verification

- `bun run typecheck`: passed.
- `bun run privacy:scan`: passed.
- `bun test tests/repo-hygiene.test.ts`: 11 passed, 0 failed.
- Focused protocol/compatibility suite excluding Windows privileged-symlink
  state cases: 395 passed, 0 failed across 24 files.
- Focused continuation-state semantics: 2 passed, 95 filtered, 0 failed.
- Serial isolation of failures observed in the full run:
  - `tests/codex-models-cache-invalidate.test.ts`: 6 passed, 0 failed.
  - `tests/codex-native-residue.test.ts`: 63 passed, 2 platform skips,
    0 failed.
- Local link validation, canonical case/digest validation, and
  `git diff --check`: passed.

The full `bun run test` result is **not green**. On Windows with Bun 1.3.14 it
exited 3 after a cache-invalidation failure, an empty effective-account lookup,
and a Bun `index out of bounds` panic. A broader focused run separately found
four `responses-state.test.ts` failures, all Windows `EPERM` errors creating
symlinks (488 passed, 4 failed). The isolated cache/native tests and the
non-privileged protocol suite pass, but this review does not claim the full
suite passed.

## Required challenge results

1. Protocol conformance, live compatibility, and task effectiveness are
   separated: **PASS**.
2. Environmental failures cannot poison compatibility verdicts: **PASS**.
3. `VERIFIED` is reproducible from immutable evidence: **PASS**.
4. Exact route identity prevents false evidence reuse: **PASS**.
5. Routing Profiles remain the sole user-policy layer: **PASS**.
6. The Lab cannot become a second router: **PASS**.
7. The Lab cannot become a second provider registry: **PASS**.
8. Probes cannot access user data or arbitrary tools: **PASS**.
9. Historical incidents are representable as deterministic versioned
   scenarios: **PASS**.
10. CL-01 is implementable without semantic invention: **PASS**.

## Verdict

No Critical, High, or Medium findings remain.

**CL-00: ACCEPTED**

CL-01 remains not started and is not authorized by this review.
