# CL-00 security, privacy, and probe sandbox contract

Compatibility evidence is useful only if collecting it does not turn the Lab
into a data-exfiltration or arbitrary-execution surface. These requirements are
release blockers for later implementation.

## 1. Data prohibition

The Lab must not read, accept, persist, or export:

- user prompts or conversation history;
- real user repositories, worktrees, patches, source files, or file paths;
- user MCP server definitions, resources, results, or credentials, with no
  Lab mode, CLI flag, profile, or override that can load them;
- arbitrary shell commands or process output;
- arbitrary filesystem contents;
- arbitrary external-network tool requests or responses;
- API keys, OAuth/access/refresh tokens, cookies, authorization material, or
  raw credential errors;
- account IDs, account emails, aliases, plan labels, tenant IDs, or other PII;
- raw private/custom headers;
- hidden reasoning, chain of thought, encrypted reasoning payloads, provider
  thought signatures, or decrypted private task content.

Scenarios contain Lab-authored synthetic prompts, fixtures, tool definitions
and results only. They must be recognizable as synthetic and contain no copied
customer material.

### Synthetic-input admission

Synthetic status is machine-checked, not inferred from content or a friendly
name. Every fixture admitted to the Lab has a canonical reference containing:

```text
syntheticMarker          ocx-lab-synthetic-v1
provenance.kind          lab_authored
provenance.authority     reviewed manifest/authority identifier
provenance.sourceCommit  immutable source revision
digest                   domain-separated content digest
byteLength               exact admitted byte length
```

The reference participates in the scenario manifest digest. Admission verifies
the marker, closed provenance kind, expected authority/source revision, digest,
and byte length before fixture bytes reach an adapter, mock, tool stub, event
normalizer, or artifact writer. A request payload, model output, local path,
repository file, MCP object, URL response, or runtime caller cannot label
itself synthetic. Protocol V1 uses the exact `fixtureRef` contract in
`021_protocol_v1_manifest_authority.md`; future live/Fabric suites must define
an equally closed provenance authority before they may run.

## 2. Future live-probe sandbox

A live probe is an explicit background/management/CLI action. It is never
started by the production request path, profile evaluator, Router Intelligence,
request-history read, dashboard render, or provider discovery.

The future runner must enforce a capability-deny sandbox:

### Network

- The immutable scenario manifest may authorize only fixed dependency roles
  and protocol classes, never a route-local URL.
- Network authorization uses a trusted in-memory `LabDestinationV1` record
  owned by the existing provider destination/credential plumbing: scheme,
  host, port, base path, resolved IP family/address set after policy checks,
  TLS SNI/Host values, and private-network opt-in. That record is never
  written to JSONL, SQLite, artifacts, or export.
- Provider destination/credential plumbing creates one per-run immutable
  `LabDestinationV1` snapshot before endpoint fingerprinting. The exact same
  snapshot must be used unchanged for endpoint fingerprinting, destination
  authorization, credential binding, and connection. Mutation, replacement,
  re-resolution to a different address set, or any mismatch between those
  stages fails closed as `harness_failure` before credentials are sent.
- The composite route subject stores only the keyed opaque
  `endpointFingerprint` derived from the normalized destination. Raw URLs are
  never evidence fields.
- The only remote destinations are the exact primary and flat sidecar
  destinations named by those in-memory records after existing provider
  destination-policy validation.
- DNS is resolved once before the policy check. The HTTP client must connect
  to the validated IP set (pin/connect to the approved addresses) while
  preserving the intended Host/SNI. A later resolution that differs fails
  closed as `harness_failure`.
- Redirects are rejected by default for Lab probes, matching the existing
  SSRF fail-closed posture. A future scenario that explicitly opts into
  redirects must authorize every hop with the same destination policy, IP
  pinning, and Host/SNI preservation; redirects still cannot widen scheme,
  host, port, or private-network access.
- Private/loopback endpoints require the route's existing explicit private
  network opt-in and an explicit Lab-run confirmation. Metadata endpoints
  remain blocked.
- No scenario-supplied URL, model output, tool argument, or redirect may add a
  destination.
- A sidecar dependency is allowed only when the scenario explicitly authorizes
  its role/protocol class, the composite subject names the exact dependency
  fingerprint, an in-memory destination record exists for that fingerprint,
  the operator approves the composite live probe, and its credential is
  destination-bound independently. Unmanifested roles or subject-external/
  dynamically widened endpoints make the run `harness_failure`.
- Inherited `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `http_proxy`,
  `https_proxy`, `all_proxy`, and `no_proxy` values are rejected for Lab runs.
  If a future reviewed scenario requires a proxy, that proxy endpoint is
  authorized as its own exact destination under the same SSRF checks and never
  inherits ambient proxy environment variables.
- Tools have no network capability. A model-requested web search, image
  generation, URL fetch, computer use, or hosted external tool is disabled or
  classified inapplicable unless a future separately reviewed scenario owns a
  fixed synthetic sidecar.
- Deterministic protocol tests may contact only a Lab-owned loopback mock.

### Credentials

- Secret bytes remain owned by the existing trusted provider credential/
  transport layer. Lab runner code never receives an API key, token, cookie,
  authorization value, entire auth store, or credential-bearing header.
- Immediately before a live request, the credential broker validates the exact
  immutable `LabDestinationV1` snapshot and returns an opaque,
  non-serializable `LabCredentialLeaseV1` capability bound to that destination,
  auth transport, and one run/request budget. The lease exposes no secret
  bytes, string conversion, header map, equality/debug representation, or
  credential identity.
- The trusted transport consumes the lease and injects authorization only after
  its connection is bound to the same approved destination/address set. A
  destination, Host/SNI, address-set, transport, or lease-scope mismatch fails
  closed before authorization is emitted. The lease expires after its bounded
  request/run and cannot be reused for another destination or sidecar.
- Credentials therefore never enter a subject, assertion, error, artifact,
  log, event-ID input, SQLite row, callback, mock, or Lab-owned memory buffer.
- Credential absence/rejection produces `authentication_blocked`, never a
  compatibility failure.

### Process and system access

- The scenario DSL cannot express a shell command, executable, arbitrary
  module, callback, script, filesystem path, or dynamic import.
- The runner receives no general shell/process API and no inherited stdin.
- Filesystem access is restricted to a fresh Lab scratch directory, read-only
  packaged synthetic fixtures, and the bounded artifact writer.
- The V1 inherited-environment allowlist is empty: Lab code must not read an
  ambient variable to determine behavior, routing, credentials, destinations,
  paths, locale, or proxying. The runner may expose only a constructed,
  non-inherited environment view with exact constants `TZ=UTC` and
  `NO_COLOR=1`; every other name is absent. In particular all uppercase and
  lowercase proxy variables are rejected as stated in Network above. Secrets
  are supplied only through reviewed destination/credential plumbing.
- The run has enforced wall-clock, inactivity, byte, request, token, tool-call,
  memory, process and artifact limits. If the platform cannot enforce a
  required boundary, the run fails as `harness_failure`.
- Scratch data is deleted after artifact sanitization. Cleanup failure is
  visible and retried by bounded maintenance; it does not silently retain user
  data because none was admitted.

### Tools and MCP

- Function/custom tool scenarios expose inert Lab-authored definitions. The
  harness returns static or pure-function results and never executes model
  arguments.
- `apply_patch`, shell, file, browser, web-search, image-generation, computer
  use and similar names are protocol tokens only. They do not invoke the real
  facility.
- MCP scenarios use an in-memory or Lab-owned loopback stub with fixed schemas,
  resources and pure results. User MCP configuration is not loaded.
- Cursor `nativeLocalExec`, `unsafeAllowNativeLocalExec`, desktop executors and
  configured `mcpServers` are forced off for the Lab subject. Their disabled
  state participates in the behavior fingerprint.

### Agent Fabric

- Real task execution remains in Agent Fabric's separately reviewed sandbox.
- The Lab accepts a structured outcome and sanitized content-addressed
  references only.
- Outcome ingestion cannot dereference an arbitrary path or URL. Artifact
  transfer uses an allowlisted broker and re-runs Lab validation.
- No task repository, prompt transcript, worktree, patch body, terminal log, or
  hidden reasoning is copied into `~/.opencodex/lab/`.

## 3. Artifact and resource contract

Artifacts are deny-by-default, normalized, sanitized, bounded, and
content-addressed after redaction.

Initial hard ceilings:

```text
maximum wall-clock time per run         120,000 ms
maximum connect time                    10,000 ms
maximum first-byte time                 30,000 ms
maximum inactivity time                 30,000 ms
maximum requests per run                16
maximum aggregate input bytes           8 MiB
maximum aggregate output bytes          16 MiB
maximum output tokens                    32,768
maximum tool calls                       32
maximum runner resident memory          512 MiB
maximum child processes                 0
maximum artifacts per run               16
maximum bytes per artifact              256 KiB
maximum aggregate artifact data         1 MiB
maximum normalized events               4,096
maximum sanitized string field          4 KiB
maximum serialized bytes per event      64 KiB
maximum aggregate normalized event bytes 1 MiB
maximum event JSON nesting depth        8
maximum object keys per event object    64
maximum array elements per event array  256
```

Scenario limits may be lower. No scenario, CLI flag, profile, provider config,
environment variable, route metadata, or runtime caller may raise a hard
ceiling. Raising one requires a reviewed security-contract version change.
Timeout ceilings classify with the matching typed `timeout`; request/byte/
token/tool/artifact ceilings classify `budget_exhausted`. A memory ceiling
breach or attempted child-process creation terminates the sandboxed run and is
`budget_exhausted`; inability to enforce any required ceiling is
`harness_failure` before executable evidence is accepted.

Event bounds are enforced while decoding/normalizing, before an event is
buffered into the observation or any artifact. Exceeding an event structural
bound fails the run as `harness_failure` without retaining the oversized
fragment.

Allowed artifact classes:

- canonical scenario manifest;
- canonical suite manifest;
- canonical synthetic fixture;
- canonical claim-source manifest;
- assertion report containing normalized expected/observed summaries;
- sanitized request shape with content replaced by type/length/digest markers;
- sanitized response shape with visible synthetic fixture output only;
- normalized bounded event trace;
- sanitized error taxonomy/status;
- deterministic verifier summary.

Artifact names are derived only from the expected lowercase SHA-256 digest and
a fixed extension under `~/.opencodex/lab/artifacts/`. The Lab artifact store
must use descriptor/handle-bound, no-follow I/O rather than validate a pathname
and reopen it later:

- open and retain a trusted handle to the artifact directory after verifying it
  is a directory and not a symlink/reparse-point redirection;
- create writes relative to that directory handle with exclusive/no-follow
  semantics, reject special files and `st_nlink != 1`, and write only already
  redacted bytes;
- compute size and digest from the same open descriptor/handle that received
  the bytes, flush it, then publish by an atomic rename relative to the trusted
  directory handle;
- when a content-addressed target already exists, open it with no-follow
  semantics and verify regular-file type, single-link status, size, and digest
  from that same descriptor before reuse;
- reads open the digest-derived name relative to the trusted directory handle,
  verify file type/link count/size, hash the bytes, and return/consume those
  exact bytes from the same open descriptor without closing and reopening by
  path;
- traversal, separators, absolute paths, alternate data streams, symlinks,
  reparse points, hard links, device/special files, digest/size mismatch, or a
  directory-handle identity change fail closed;
- on a platform where equivalent descriptor/handle-bound no-follow operations
  cannot be enforced, the artifact operation is `harness_failure`; it must not
  fall back to path-only `exists/stat/read` validation.

The ledger stores relative content-addressed references, never arbitrary paths.
This contract applies to the future Lab artifact store; it does not silently
reuse a different existing application artifact reader whose path-race
properties have not been reviewed for Lab evidence.

Scenario/suite manifests and synthetic fixtures use the domain-separated
digests in the evidence contract and remain retained while referenced by any
non-invalidated, non-purged observation. Claim-source manifests remain retained
while a non-purged claim snapshot references them. Their content is still
subject to the same synthetic/sanitized-data and size rules.

Redaction occurs before hashing and writing. A redaction failure discards the
artifact and marks the run `harness_failure`; "write now, redact later" is
forbidden.

## 4. Diagnostic sanitization

Provider diagnostics retain only:

- normalized HTTP status;
- allowlisted non-sensitive error type/code;
- coarse phase (`dns`, `connect`, `tls`, `first_byte`, `stream`, `terminal`);
- bounded latency/duration;
- redacted, bounded message selected by an explicit provider sanitizer.

They remove URLs, query strings, authorization values, header dumps, request/
response bodies, account identifiers, project/tenant names, local paths, IPs
where identifying, and token-like strings. Unknown provider diagnostics are
reduced to taxonomy and phase rather than persisted verbatim.

Sanitizers are tested with seeded canary secrets and common credential forms.
`bun run privacy:scan` remains required but is defense in depth, not the
redaction mechanism.

## 5. Subject privacy

The local route subject distinguishes exact behavior without raw secrets:

- configured instance, endpoint, custom-header behavior, project and location
  use a per-installation keyed HMAC;
- credential/account identity does not participate;
- raw base URLs and private/custom headers are absent;
- model IDs are retained locally because they are required route identity, but
  custom model IDs are private-by-default for export;
- rotating the local subject salt invalidates local correlation and requires
  re-projection/reverification, never reverse lookup.

The salt is stored with secret-file permissions outside the JSONL/artifact
tree. It is not exported.

### Custom-header fingerprint broker

Raw custom headers remain owned by the provider/config request builder and are
never passed to Lab code. That owner computes
`headers.nonCredentialBehaviorDigest` through a narrow fingerprint broker:

1. resolve the effective static custom headers after preset/config merge but
   before request-specific or credential injection;
2. remove every credential-bearing header according to the same auth transport
   classification used by the request builder;
3. before canonicalization, enforce at most 64 non-credential header entries,
   at most 16 duplicate values for one lowercase name, at most 256 ASCII bytes
   per field name, at most 8 KiB UTF-8 bytes per value, and at most 64 KiB of
   aggregate normalized name/value bytes; exceeding any bound is
   `harness_failure` and no digest is emitted;
4. lowercase valid ASCII field names, reject invalid names, preserve duplicate
   value order, and preserve exact UTF-8 value bytes without trimming;
5. sort entries by lowercase name while retaining duplicate order and encode
   JCS `[{"name": string, "values": string[]}, ...]`;
6. return lowercase HMAC-SHA-256 with installation salt and domain
   `ocx-lab:local-fingerprint:v1\0customHeaderBehavior\0`.

The broker returns only the digest. Its API cannot return normalized names,
values, intermediate bytes, the salt, or the credential classification.
Unknown classification fails subject construction; it never falls back to
hashing or logging the raw header. Canary tests must prove raw names/values do
not enter Lab events, errors, SQLite, or artifacts.

## 6. Local evidence versus public export

Local evidence is already sanitized. Public export is stricter and uses a new,
allowlist-only schema:

- include suite/scenario versions, evidence layer, verdict, observation time
  bucket, public registry provider/model where permitted, assertion summaries,
  and public incident/scenario references;
- replace local subject/event/artifact IDs with export-scoped opaque IDs;
- omit endpoint and provider-instance fingerprints, local request/decision/
  Fabric references, precise local paths, custom headers, project/location,
  custom provider/model names, account context, raw latency traces, and local
  errors;
- include artifact content only when its policy explicitly says
  `public_export`; local visibility does not imply export permission;
- run export-specific secret/PII scanning and fail closed on an unknown field.

Public publishing is not authorized in CL-00 and remains a later phase.

## 7. Retention and deletion

- JSONL is the immutable local authority for non-sensitive evidence, but a
  user can delete the entire Lab directory. Immutability describes in-ledger
  correction semantics, not a promise to resist user deletion. Confirmed
  sensitive evidence is the explicit privacy exception below.
- Retention ceilings by class:
  - scratch/temp run directories: deleted at run end; cleanup retry within 24h;
  - export staging: maximum 24h;
  - disposable SQLite projection: rebuildable anytime; may be deleted at any
    time and must be deleted during a sensitive purge;
  - sanitized non-contract artifacts (`assertion_report`, shapes, traces,
    errors): default 90 days, hard ceiling 365 days;
  - content-addressed scenario/suite/fixture contract artifacts: retained
    while any non-invalidated, non-purged observation references them, because
    reproducible executable projection requires the exact historical bytes;
  - content-addressed claim-source manifests: retained while any non-purged
    claim snapshot references them, because reproducible `CLAIMED` projection
    requires the exact historical sanitized source bytes.
  Contract artifacts remain synthetic/sanitized and size-bounded. User deletion
  of the Lab directory remains absolute.
- Deleting an expired non-contract artifact leaves its digest/reference and a
  typed unavailable marker; it does not alter the observation.
- SQLite is disposable and contains no data absent from valid ledger events,
  privacy-safe purge tombstones, and artifact metadata.
- Invalid non-sensitive evidence is neutralized by a valid appended
  invalidation under the evidence contract. Event-private non-contract
  artifacts may then be securely deleted. A shared scenario, suite, fixture,
  or claim-source contract artifact must remain while any other usable event
  references its digest, and may be deleted only after the last such reference
  is invalidated or purged.
- Confirmed sensitive evidence is distinct from ordinary invalidation. It
  requires a fail-closed purge of every local copy: offending JSONL event
  lines, SQLite rows, artifacts, scratch/temp files, and generated exports.
  The purge first determines the affected event IDs/artifact digests without
  retaining the leaked value, then creates a clean replacement ledger that
  omits the sensitive event lines and includes the canonical privacy-safe
  `purge_tombstone` defined in the evidence contract. The replacement ledger
  is flushed and atomically installed; SQLite is deleted/rebuilt from it and
  targeted artifacts/temp/exports are removed. If any required replacement or
  deletion cannot be completed, the purge remains visibly failed and evidence
  projection is disabled rather than serving stale compatibility state.
- Projection applies purge tombstones before ordinary invalidation/supersession.
  Targeted events contribute no `CLAIMED`, `PROBED`, `VERIFIED`, `DEGRADED`, or
  `UNSUPPORTED` state; targeted artifacts surface only
  `purged_unavailable`. A previously cached verdict that depended on purged
  material is invalid and must not survive SQLite rebuild.
- A purge tombstone stores only event IDs/artifact digests, the fixed
  `sensitive_evidence` taxonomy, time/producer metadata, and closed action
  names. It never records the leaked value, raw path, credential, prompt, or
  identifying diagnostic. Append-only semantics never override the duty to
  remove sensitive bytes.

## 8. Security acceptance tests required later

Before any live runner ships, tests must prove:

1. prompt/repository/MCP/user-tool inputs are unreachable from the scenario DSL;
2. every admitted fixture has the required synthetic marker/provenance and a
   runtime/user/repository/MCP/network object cannot self-assert synthetic
   status;
3. redirects and model-supplied URLs cannot widen network access, and Lab
   clients pin connections to the validated IP set;
4. the inherited-environment allowlist is empty, all uppercase/lowercase proxy
   variables are rejected, and no ambient variable changes Lab behavior;
5. destination-record mutation, replacement, or address-set drift between
   authorization, fingerprinting, credential binding, and connect fails closed;
6. credential canaries never enter Lab memory/objects through the broker: the
   runner receives only an opaque destination-bound one-run lease, and lease
   scope/transport/destination mismatch fails before authorization is sent;
7. account, custom-header and endpoint canaries never enter evidence, errors,
   SQLite or artifacts;
8. custom-header canonicalization is deterministic; unknown credential
   classification and every count/name/value/aggregate bound fail closed;
9. local subject-salt rotation breaks prior correlation and forces
   re-projection/reverification without reverse lookup;
10. tool arguments cannot execute;
11. every wall-clock/connect/first-byte/inactivity/request/input/output/token/
    tool-call/memory/process/artifact hard ceiling is enforced and cannot be
    widened by a manifest, config, profile, environment variable, or caller;
12. artifact traversal, symlink/reparse, hard-link, path-race, oversize and
    digest attacks fail closed, and validated artifact bytes are consumed from
    the same descriptor/handle that was checked;
13. normalized event byte/depth/key/array ceilings fail closed before buffering;
14. timeout, quota, auth, DNS and harness failures remain blockers;
15. retention expiry emits typed unavailable markers; cleanup retry/failure is
    visible and bounded; shared contract artifacts survive invalidation while
    any usable event still references them;
16. ordinary invalidations reject unknown/future/cross-kind/partial target
    lists and deterministically remove only valid named evidence;
17. confirmed sensitive evidence is removed from JSONL, SQLite, artifacts,
    temp files and exports; the replacement ledger retains only a privacy-safe
    purge tombstone; replay cannot preserve a verdict that depended on purged
    evidence;
18. public export rejects unknown/private fields;
19. no probe runs from the production routing path.
