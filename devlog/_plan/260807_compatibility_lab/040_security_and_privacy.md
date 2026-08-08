# CL-00 security, privacy, and probe sandbox contract

Compatibility evidence is useful only if collecting it does not turn the Lab
into a data-exfiltration or arbitrary-execution surface. These requirements are
release blockers for later implementation.

## 1. Data prohibition

The Lab must not read, accept, persist, or export:

- user prompts or conversation history;
- real user repositories, worktrees, patches, source files, or file paths;
- user MCP server definitions, resources, results, or credentials by default;
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

## 2. Future live-probe sandbox

A live probe is an explicit background/management/CLI action. It is never
started by the production request path, profile evaluator, Router Intelligence,
request-history read, dashboard render, or provider discovery.

The future runner must enforce a capability-deny sandbox:

### Network

- The immutable scenario manifest may authorize only fixed dependency roles
  and protocol classes, never a route-local URL. The only remote destinations
  are the exact primary endpoint and flat sidecar dependency endpoints named
  in the composite route subject, after existing provider destination-policy
  validation.
- DNS resolution and every redirect are revalidated. Redirects cannot widen
  scheme, host, port, or private-network access.
- Private/loopback endpoints require the route's existing explicit private
  network opt-in and an explicit Lab-run confirmation. Metadata endpoints
  remain blocked.
- No scenario-supplied URL, model output, tool argument, or redirect may add a
  destination.
- A sidecar dependency is allowed only when the scenario explicitly authorizes
  its role/protocol class, the composite subject names the exact dependency
  fingerprint and endpoint, the operator approves the composite live probe,
  and its credential is destination-bound independently. Unmanifested roles or
  subject-external/dynamically widened endpoints make the run
  `harness_failure`.
- Tools have no network capability. A model-requested web search, image
  generation, URL fetch, computer use, or hosted external tool is disabled or
  classified inapplicable unless a future separately reviewed scenario owns a
  fixed synthetic sidecar.
- Deterministic protocol tests may contact only a Lab-owned loopback mock.

### Credentials

- A credential broker resolves the existing route credential immediately
  before the request and binds it to the validated destination.
- Credentials exist in memory for the request only and are never included in a
  subject, assertion, error, artifact, log, event ID input, or SQLite row.
- Probe code receives no entire auth store and no unrelated provider/account
  credential.
- Credential absence/rejection produces `authentication_blocked`, never a
  compatibility failure.

### Process and system access

- The scenario DSL cannot express a shell command, executable, arbitrary
  module, callback, script, filesystem path, or dynamic import.
- The runner receives no general shell/process API and no inherited stdin.
- Filesystem access is restricted to a fresh Lab scratch directory, read-only
  packaged synthetic fixtures, and the bounded artifact writer.
- Environment inheritance is an allowlist. Secrets and proxy variables are
  supplied only through reviewed destination/credential plumbing, not copied
  wholesale.
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

## 3. Artifact contract

Artifacts are deny-by-default, normalized, sanitized, bounded, and
content-addressed after redaction.

Initial hard ceilings:

```text
maximum artifacts per run       16
maximum bytes per artifact      256 KiB
maximum aggregate artifact data 1 MiB
maximum normalized events       4,096
maximum sanitized string field  4 KiB
```

Scenario limits may be lower. Raising a hard ceiling requires a reviewed
security-contract change; a scenario manifest alone cannot raise it.

Allowed artifact classes:

- canonical scenario manifest;
- canonical suite manifest;
- canonical synthetic fixture;
- assertion report containing normalized expected/observed summaries;
- sanitized request shape with content replaced by type/length/digest markers;
- sanitized response shape with visible synthetic fixture output only;
- normalized bounded event trace;
- sanitized error taxonomy/status;
- deterministic verifier summary.

Artifact paths are derived from the SHA-256 digest and fixed extension under
`~/.opencodex/lab/artifacts/`. Manifests reject traversal, symlinks,
device/special files, alternate data streams, and digest/size mismatch. The
ledger stores relative content-addressed references, never arbitrary paths.

Scenario/suite manifests and synthetic fixtures use the domain-separated
digests in the evidence contract and remain retained while referenced by any
non-invalidated observation. Their content is still subject to the same
synthetic-data and size rules.

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

- configured instance, endpoint, custom headers, project and location use a
  per-installation keyed HMAC;
- credential/account identity does not participate;
- raw base URLs and private/custom headers are absent;
- model IDs are retained locally because they are required route identity, but
  custom model IDs are private-by-default for export;
- rotating the local subject salt invalidates local correlation and requires
  re-projection/reverification, never reverse lookup.

The salt is stored with secret-file permissions outside the JSONL/artifact
tree. It is not exported.

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

- JSONL is the immutable local authority, but a user can delete the entire Lab
  directory. Immutability describes in-ledger correction semantics, not a
  promise to resist user deletion.
- Artifact retention classes are versioned and bounded by storage policy.
  Deleting an expired artifact leaves its digest/reference and a typed
  unavailable marker; it does not alter the observation.
- SQLite is disposable and contains no data absent from valid ledger events and
  artifact metadata.
- Invalid or sensitive evidence is neutralized by an appended invalidation and
  secure artifact deletion. A security incident may require deleting the local
  ledger; append-only semantics never override the duty to remove leaked
  secrets.

## 8. Security acceptance tests required later

Before any live runner ships, tests must prove:

1. prompt/repository/MCP/user-tool inputs are unreachable from the scenario DSL;
2. redirects and model-supplied URLs cannot widen network access;
3. credential, account, custom header and endpoint canaries never enter
   evidence, errors, SQLite or artifacts;
4. tool arguments cannot execute;
5. artifact traversal/symlink/oversize/digest attacks fail closed;
6. timeout, quota, auth, DNS and harness failures remain blockers;
7. public export rejects unknown/private fields;
8. no probe runs from the production routing path.
