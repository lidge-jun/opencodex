# CL-10 - Public Evidence Export, Publishing, and Community Trust

## Programme position

**Repository:** `lidge-jun/opencodex`
**Integration target:** `dev`
**Branch:** `feat/cl-10-public-evidence-contract`
**Starting SHA:** `4fed8d3fe431ad23be83f3aff2af18ef8b8ecd71`
**CL-09 merge prerequisite:** satisfied by #1489 at `4fed8d3fe431ad23be83f3aff2af18ef8b8ecd71`

CL-09 is merged. CL-10 is the final planned Compatibility Lab phase.

This PR began contract-only and the contract was independently reviewed and accepted on 2026-08-12. CL-10.1 through CL-10.4 runtime implementation is now authorized on this branch. CL-10.5 remote publishing remains blocked until the exact transport/service contract in section 18 is independently accepted.

---

# 1. Goal

CL-10 answers:

> How can a user deliberately export and, later, publish a narrowly allowlisted subset of Compatibility Lab evidence for community use without leaking installation-local identifiers, custom configuration, user data, credentials, or private operational metadata, and without letting untrusted community data silently affect local canonical verdicts or routing?

The architecture is deliberately one-way at the local trust boundary:

```text
Local canonical Lab evidence
        |
        | explicit export projection only
        v
Public allowlist projector
        |
        +--> export privacy scan / fail closed
        |
        +--> export-scoped IDs
        |
        +--> optional public-export artifacts only
        v
Canonical public bundle
        |
        +--> local preview/export
        +--> explicit publish action, only after transport contract is accepted
        v
Community bundle
        |
        +--> schema/digest/signature verification
        +--> separate community trust/cache domain
        |
        X--> no write into local compatibility.jsonl
        X--> no canonical verdict promotion/degradation
        X--> no Routing Profile or Router Intelligence input
        X--> no CL-08 scheduling input
```

CL-10 shares evidence. It does not transfer local authority.

---

# 2. Existing authority carried forward

CL-10 must preserve the existing CL-00 security/privacy contract, especially its `Local evidence versus public export` boundary:

- public export uses a new allowlist-only schema;
- local subject/event/artifact IDs are replaced with export-scoped opaque IDs;
- endpoint and provider-instance fingerprints are omitted;
- local request, decision, and Fabric references are omitted;
- precise local paths, custom headers, project/location, account context, local errors, and raw latency traces are omitted;
- custom provider/model names are private by default;
- artifact bytes are exportable only when their policy explicitly allows `public_export`;
- export-specific secret/PII scanning is mandatory;
- unknown fields fail closed.

CL-10 may tighten those rules. It must not weaken them silently.

---

# 3. Hard CL-10 invariants

CL-10 V1 must guarantee:

```text
0 automatic telemetry upload
0 background publishing without an explicit user action
0 export of local subject/event/artifact/request/decision/Fabric identifiers
0 export of endpoint/provider-instance/custom-header/project/location fingerprints
0 export of credentials, account identity, prompts, responses, tool payloads, repository data, paths, or hidden reasoning
0 export of custom provider/model names unless a later reviewed public-registry authority explicitly permits them
0 community bundle writes into compatibility.jsonl
0 community evidence promotion/degradation of canonical local verdicts
0 community evidence influence on Routing Profiles or Router Intelligence
0 community evidence influence on CL-08 scheduling
0 combined local/community compatibility score
```

Export, publish, import, verification, or community-cache failure must not affect normal production request execution.

---

# 4. Chosen approach

Three approaches were considered.

## 4.1 Chosen: deterministic public projection plus separate community trust domain

Project local evidence into a new public schema containing only export-safe fields. Produce a canonical bundle with a digest and publisher signature. Community imports are verified and stored outside the local canonical evidence authority.

Benefits:

- privacy boundary is explicit and machine-testable;
- exported bytes are reproducible from the same local evidence and export policy;
- local IDs never leave the installation;
- community provenance can be verified without treating publisher claims as canonical truth;
- imported evidence cannot contaminate local verdicts or routing.

## 4.2 Rejected: publish local Lab JSONL or SQLite rows directly

The local schemas contain installation-scoped identifiers and fields whose local visibility does not imply public-export permission. Direct publication would make privacy depend on callers remembering ad-hoc redaction rules.

## 4.3 Rejected: remote service as canonical evidence authority

A hosted service may aggregate public bundles later, but it must not become the canonical authority for local Lab verdicts. OpenCodex must remain able to reproduce local verdicts from local canonical evidence without network access.

---

# 5. Public exportability gate

An observation is exportable only when all required public identity fields can be represented without private configuration.

V1 exportable routes are limited to entries in the repo-reviewed `PublicRouteRegistryManifestV1` whose exported behavior identity is entirely composed from reviewed public fields.

The public-route authority is a versioned, content-addressed repository artifact owned by OpenCodex, not a publisher-supplied assertion:

```ts
interface PublicRouteRegistryManifestV1 {
  schemaVersion: "public_route_registry_v1";
  registryVersion: string;
  sourceCommit: string;
  entries: PublicRouteRegistryEntryV1[];
  manifestDigest: string;
}

interface PublicRouteRegistryEntryV1 {
  providerId: string;
  modelId: string;
  adapterFamilies: Array<"openai-responses" | "openai-chat" | "anthropic-messages">;
}
```

CL-10.1 must ship and validate this manifest before any route-scoped record is exportable. The manifest may be updated only by reviewed repository changes with a new digest/version. Dynamic model discovery, cached catalogs, user configuration, imported bundles, and a matching spelling alone can never extend this authority.

A route is not exportable when any behavior-relevant identity depends on a private/custom value, including:

- custom provider instance or custom provider name;
- custom model ID or alias not in the reviewed public registry authority;
- non-default/custom endpoint identity;
- private/custom header behavior;
- project, location, tenant, deployment, organization, or account context;
- private-network destination behavior;
- any other local behavior fingerprint that cannot be represented publicly without weakening exact-route semantics.

Failing this gate is `not_exportable`, not an error and not a compatibility verdict.

CL-10 must never broaden exact local evidence into a more general public claim merely by dropping private route dimensions.

---

# 6. Public evidence schema

CL-10 introduces `PublicEvidenceBundleV1` as a closed, versioned, allowlist-only schema.

Conceptually:

```ts
interface PublicEvidenceBundleV1 {
  schemaVersion: "public_evidence_bundle_v1";
  exportPolicyVersion: "public_export_policy_v1";
  bundleId: string;
  createdDayUtc: string;
  publisher: PublicPublisherV1;
  records: PublicEvidenceRecordV1[];
  artifacts: PublicArtifactV1[];
  bundleDigest: string;
  signature: PublicBundleSignatureV1;
}

interface PublicEvidenceRecordV1 {
  recordId: string;
  subjectId: string;
  evidenceLayer: "protocol_conformance" | "live_route_compatibility" | "task_effectiveness";
  suiteId: string;
  suiteVersion: string;
  scenarioId: string;
  scenarioVersion: string;
  verdict: "CLAIMED" | "PROBED" | "VERIFIED" | "DEGRADED" | "UNSUPPORTED" | "BLOCKED" | "UNKNOWN";
  observedDayUtc: string;
  subject: PublicEvidenceSubjectV1;
  assertions: PublicAssertionSummaryV1[];
  incidentRefs?: PublicIncidentRefV1[];
  artifactRefs?: string[];
}

type PublicEvidenceSubjectV1 =
  | PublicProtocolSubjectV1
  | PublicRouteSubjectV1
  | PublicTaskSubjectV1;

interface PublicIncidentRefV1 {
  corpusId: string; // exact reviewed `IC-NNN` identifier only
}
```

The public runtime types are dedicated CL-10 types. They may import closed scalar unions such as the existing verdict/evidence-layer literals, but they must not alias, extend, spread, or serialize local ledger/query DTO interfaces. A compile-time TypeScript shape is not the security boundary: every export/import path must pass the dedicated runtime validator for the matching public schema version.

`PublicEvidenceSubjectV1` is layer-matched: protocol records use only a public protocol descriptor, live-route records use only a public route descriptor backed by `PublicRouteRegistryManifestV1`, and task records use a public task descriptor that nests the same public route descriptor plus reviewed public task/verifier authority fields. A layer/subject-kind mismatch is `schema_rejected`.

Unknown top-level or nested fields fail export and import validation.

`incidentRefs` contain only exact reviewed corpus identifiers matching `^IC-[0-9]{3}$` that exist in the repository incident authority. They never contain the corpus entry's historical issue URLs, devlog paths, test paths, prose, or source metadata. `artifactRefs` contain only public artifact IDs present in the same bundle; local artifact digests/relative paths are forbidden.

---

# 7. Export-scoped identity

Local identifiers must never be serialized into a public bundle.

`bundleId`, `recordId`, `subjectId`, and public artifact IDs are derived only from canonical export-safe bytes under explicit domain-separated SHA-256 inputs. They must have no reversible or keyed relationship to:

- local `RouteSubjectV1.subjectId`;
- local observation/event IDs;
- local artifact digests when the artifact is not explicitly public-exportable;
- request IDs;
- route decision IDs;
- Fabric/task references;
- installation salt.

A public subject ID may be deterministic across publishers only from fields that are already public in `PublicRouteDescriptorV1`. It must never include or hash a private local dimension.

---

# 8. Public route descriptor

`PublicRouteDescriptorV1` contains only reviewed public registry identity and protocol behavior needed to interpret a community record.

At minimum it may contain:

```ts
interface PublicRouteDescriptorV1 {
  providerId: string;
  modelId: string;
  adapterFamily: "openai-responses" | "openai-chat" | "anthropic-messages";
  compatibilityVersion: string;
}
```

`providerId` and `modelId` must come from an explicit public-registry allowlist. A configured value matching the spelling of a public ID is insufficient if the effective route uses private behavior dimensions that make the public claim ambiguous.

No endpoint, headers, project/location, provider-instance identifier, account identifier, credential class, quota plan, or private capability fingerprint is included.

---

# 9. Time and diagnostic minimization

Public records use UTC day buckets (`YYYY-MM-DD`), not precise local timestamps.

V1 exports no raw request latency, token timing, transport phase trace, provider error message, local error code, or local failure string.

Assertion summaries must use scenario-defined closed assertion IDs and bounded result enums. They must not contain arbitrary observed strings.

If an existing scenario assertion cannot be represented without free-form/private output, that assertion is omitted only when the scenario contract permits a complete public summary without it; otherwise the record is `not_exportable`.

---

# 10. Public artifact policy

Local artifact visibility does not imply public-export permission.

An artifact may appear in a public bundle only when all are true:

1. its producer/scenario policy explicitly marks the artifact class `public_export`;
2. bytes are already synthetic/sanitized under Lab artifact rules;
3. CL-10 performs a second export-specific sanitizer and secret/PII scan;
4. the artifact satisfies public bundle size/type limits;
5. the public artifact digest is computed from the final exported bytes, not copied from a private/local reference by assumption.

V1 does not export arbitrary text logs, provider errors, traces containing timing detail, task patches, terminal logs, repository content, or raw request/response shapes.

---

# 11. Export privacy scanner

Before a bundle can be written as publishable, CL-10 must run an export-specific fail-closed validator.

It must reject:

- unknown fields;
- strings outside field-specific bounds;
- token/credential canaries;
- email/account/project/tenant identifiers;
- URLs, local paths, IP addresses where identifying, query strings, header-like material, or authorization values;
- local Lab IDs and known request/decision/Fabric ID formats;
- custom provider/model identifiers;
- precise timestamps where only day buckets are allowed;
- artifact bytes not explicitly marked `public_export`.

`bun run privacy:scan` remains defense in depth and is not a substitute for this validator.

---

# 12. Consent and user control

There is no automatic export or publishing.

V1 user flow must be explicit:

```text
select export scope
      -> generate local preview
      -> show included record/artifact counts and excluded/not_exportable counts
      -> explicit export action
      -> local canonical bundle
      -> optional explicit publish action only if a publish transport is authorized
```

Generating a preview performs no network request.

A publish action must require an explicit user action for the specific bundle. CL-10 V1 must not introduce an always-on telemetry toggle, silent background upload, startup upload, or production-request-path upload.

Deleting local Lab data remains absolute locally. Public copies already distributed cannot be cryptographically erased, so revocation semantics are required separately.

## Sensitive purge interaction

CL-00 sensitive purge remains authoritative over CL-10 local copies. A purge whose closed action set includes `export` must fail closed until every affected local export/staging copy is removed. CL-10 must additionally remove any locally-originated copy of an affected bundle that has been imported into the local `community/` cache. Third-party community bundles are unrelated to the local sensitive bytes and are not deleted merely because they contain the same public route identity.

A local sensitive purge never waits for network access. If an affected bundle was previously published, CL-10 records or emits a bounded signed `privacy_retraction` revocation for its public bundle/record IDs when the reviewed transport is available, but remote acknowledgement is not a prerequisite for completing the mandatory local purge. The purge must not retain sensitive bytes merely to construct a later revocation.

---

# 13. Publisher provenance and signatures

A published bundle must be self-verifying for integrity and publisher continuity without exposing account identity.

CL-10 V1 uses an installation-local Ed25519 publisher key created only when the user first requests a publishable bundle or publication.

The private key:

- lives outside JSONL, SQLite, artifacts, export bundles, and community cache;
- uses secret-file permissions;
- is never logged or exposed through API/UI/CLI output;
- is never used for route-subject identity or local verdict derivation.

The public bundle contains:

```ts
interface PublicPublisherV1 {
  algorithm: "ed25519";
  keyId: string;
  publicKey: string;
}

interface PublicBundleSignatureV1 {
  algorithm: "ed25519";
  signedDigest: string;
  signature: string;
}
```

`keyId` is a domain-separated SHA-256 digest of the public key.

A valid signature proves only that the same publisher key signed those exact canonical bytes. It does not prove the evidence is honest, representative, current, or trustworthy.

## 13.1 Frozen canonical byte and signature contract

CL-10 V1 uses RFC 8785 JSON Canonicalization Scheme (JCS) as the only canonical JSON representation. Canonical JSON bytes are UTF-8 bytes of the JCS string. Raw serialized imports must be valid UTF-8 JSON and must reject duplicate decoded object member names before semantic object construction. Duplicate detection is semantic after JSON string escape decoding, so `"a"` and `"\u0061"` are the same member name and must fail closed if both appear in one object.

All public hash identities use the exact construction:

```text
H(domain, value) = SHA-256(UTF8(domain) || 0x00 || UTF8(JCS(value)))
```

No trailing NUL is added. The exact V1 domain strings are:

```text
subject        ocx-lab-public:subject:v1
record         ocx-lab-public:record:v1
bundle         ocx-lab-public:bundle:v1
bundle_digest  ocx-lab-public:bundle-digest:v1
artifact       ocx-lab-public:artifact:v1
publisher_key  ocx-lab-public:publisher-key:v1
revocation     ocx-lab-public:revocation:v1
route_registry ocx-lab-public:route-registry:v1
```

The bundle identity preimages are frozen as semantic objects before JCS:

```text
C = {
  schemaVersion,
  exportPolicyVersion,
  createdDayUtc,
  publisher,
  records,
  artifacts
}

bundleId = H("ocx-lab-public:bundle:v1", C)

bundleDigest = H(
  "ocx-lab-public:bundle-digest:v1",
  { ...C, bundleId }
)
```

Therefore `bundleId` is excluded from its own preimage, and both `bundleDigest` and `signature` are excluded from the `bundleId` preimage. `bundleDigest` includes the computed `bundleId`, but excludes both `bundleDigest` and `signature`. A bundle signature is exactly:

```text
signature.algorithm = "ed25519"
signature.signedDigest = bundleDigest
signature.signature = Base64(Ed25519.Sign(privateKey, HexDecode(bundleDigest)))
```

The signature input is exactly the raw 32 bytes produced by hex-decoding the 64-character lowercase SHA-256 `bundleDigest`. There is no additional signature prefix because the signed digest is already domain-separated by `ocx-lab-public:bundle-digest:v1`.

Publisher identity is exactly:

```text
keyId = H(
  "ocx-lab-public:publisher-key:v1",
  { algorithm: "ed25519", publicKey }
)
```

where `publicKey` is the canonical Base64 representation of the Ed25519 SPKI DER bytes.

Revocations use the same construction with a separate domain. After canonical sorting and duplicate rejection of targets:

```text
R = {
  schemaVersion,
  issuedDayUtc,
  publisher,
  targets,
  reason
}

revocationId = H("ocx-lab-public:revocation:v1", R)
signature.signedDigest = revocationId
signature.signature = Base64(Ed25519.Sign(privateKey, HexDecode(revocationId)))
```

`revocationId` and `signature` are excluded from `R`. This binds schema/version, exact publisher identity, target bundle/record IDs, issued day, and finite reason under the dedicated revocation domain.

Verification order is normative and exact for raw imported bundles:

1. enforce the serialized byte ceiling;
2. require valid UTF-8 and reject duplicate decoded JSON object member names before object construction;
3. parse JSON and enforce nesting, array, object-key, and string bounds;
4. enforce the closed schema/version/field rules and recompute `publisher.keyId`;
5. recompute public subject/record/artifact identities, references, `bundleId`, and `bundleDigest` from canonical public-safe fields;
6. require `signature.signedDigest === bundleDigest`;
7. decode the canonical Ed25519 SPKI key and Base64 signature and verify Ed25519 over `HexDecode(bundleDigest)`;
8. validate repository-owned public-route, suite, scenario, verifier, and Fabric authority references;
9. for revocations, bootstrap authority only from an already-verified target bundle and require the exact publisher algorithm, `keyId`, and public key plus valid target membership before applying the revocation;
10. persist only after every preceding applicable check succeeds.

A fixed test vector must lock these byte-level semantics so serializer, hash-domain, field-set, digest, or signing changes cannot silently create a second V1 wire format.

---

# 14. Community trust model

Imported community evidence is a separate trust class: `community_untrusted_v1`.

Verification checks:

- closed schema version;
- size/structure limits;
- canonical bundle digest;
- publisher signature;
- public route allowlist;
- scenario/suite authority references;
- export-policy version;
- revocation status when available.

Passing verification means `cryptographically_valid`, not `locally_verified`.

Community evidence must not:

- append to `compatibility.jsonl`;
- rebuild or alter local canonical verdicts;
- refresh local evidence freshness;
- satisfy Routing Profile compatibility requirements;
- change Router Intelligence eligibility or scoring;
- trigger CL-08 refresh work;
- merge with local evidence into a single score.

The UI/API/CLI must label it explicitly as community evidence and distinguish signature validity from compatibility truth.

---

# 15. Community storage boundary

Community bundles, if persisted, live outside the local canonical Lab ledger in a separate non-authoritative object/cache domain under the Lab root.

Conceptually:

```text
~/.opencodex/lab/
    compatibility.jsonl        # local canonical authority, unchanged
    compatibility.sqlite       # local disposable projection, unchanged
    artifacts/                 # local Lab artifacts, unchanged
    exports/                   # user-created public bundles
    community/                 # non-authoritative imported public bundles/cache
```

The community store must not reuse local event IDs or masquerade as local observations.

Deleting `community/` loses only imported community context and has no effect on local verdict reproducibility.

---

# 16. Import boundary

CL-10 V1 import accepts only bounded bundle bytes through reviewed entry points. It must not dereference arbitrary embedded URLs, paths, artifact references, or publisher-controlled network locations.

A bundle is parsed with strict byte, UTF-8, duplicate-object-member, nesting, array, object-key, and string limits before expensive signature or projection work. Duplicate decoded object member names are rejected before `JSON.parse`-style semantic object construction so parsers cannot silently collapse an ambiguous wire representation.

Invalid bundles are rejected without partial persistence.

Artifact content embedded in/imported with a bundle is accepted only for closed `public_export` artifact classes and is revalidated locally before storage.

---

# 17. Revocation and deletion semantics

CL-10 defines `PublicEvidenceRevocationV1` as a signed, bounded public statement from the same publisher key that signed the target bundle and references one or more bundle/record IDs plus a finite reason code.

A consumer bootstraps revocation authority from the already-verified target bundle: `publisher.keyId` and the exact Ed25519 public key in the revocation must match that target bundle before the revocation signature is considered. V1 does not support cross-key revocation or key rotation. A key-rotation protocol requires a later reviewed schema version.

A revocation contains its own domain-separated digest/ID, `issuedDayUtc`, at most 256 sorted unique target IDs, and no free-form reason text. Re-importing the exact same revocation ID and bytes is idempotent. The same revocation ID with different canonical bytes, duplicate target IDs, an unknown target, unsupported reason/version, or a publisher-key mismatch is rejected. Consumers may retain bounded revocations received before a referenced record only in a quarantined pending set with the same structural limits; they do not become effective until the matching publisher/target bundle is present and verified.

Allowed reason classes include:

- `publisher_retracted`;
- `privacy_retraction`;
- `evidence_invalidated`;
- `superseded`.

A revocation never edits the original local Lab ledger.

Community consumers mark matching imported records revoked and exclude them from default community summaries while preserving the revocation audit relation.

Remote physical deletion is a transport/service concern and cannot replace cryptographic revocation semantics.

---

# 18. Remote publishing boundary

This contract freezes bundle, consent, signing, verification, and trust semantics before choosing a remote service.

No network publishing implementation is authorized until the same CL-10 branch or a reviewed follow-up contract records:

- the exact service origin(s);
- authentication model, if any;
- maximum request/body budgets;
- TLS and redirect policy;
- retry/idempotency semantics;
- server retention and deletion policy;
- abuse/rate-limit behavior;
- revocation endpoint semantics;
- server-side schema validation;
- operator ownership and privacy policy.

The publisher must not accept an arbitrary user-supplied upload URL as a shortcut around this gate.

A fixed reviewed service may aggregate community bundles later, but local OpenCodex behavior remains fully functional without it.

---

# 19. Read surfaces

CL-10 implementation should extend existing Lab surfaces rather than create an unrelated product area. CL-10.1 through CL-10.4 are authorized after the accepted contract review; this does not relax the remote-publishing gate.

Planned surfaces after contract acceptance:

- CLI preview/export/verify/community inspection commands under `ocx lab`;
- authenticated management API for preview/export metadata and local community inspection;
- Compatibility Matrix detail UI for clearly separated community context;
- explicit publish UI only after the remote publishing transport contract is accepted.

The local Compatibility Matrix must never silently replace its canonical verdict with a community result.

---

# 20. Bounds

V1 hard export/import ceilings:

```text
maximum records per bundle              256
maximum public artifacts per bundle      16
maximum bytes per public artifact       256 KiB
maximum aggregate public artifact data    1 MiB
maximum serialized bundle bytes           2 MiB
maximum assertion summaries per record    64
maximum incident references per record    32
maximum serialized string field            4 KiB
maximum JSON nesting depth                  8
maximum object keys                         64
maximum array elements                     512
```

Implementations may use lower limits. Raising a hard ceiling requires a reviewed contract change.

---

# 21. Failure semantics

Export and import use explicit non-verdict outcomes.

At minimum:

```text
exportable
not_exportable
privacy_rejected
schema_rejected
signature_invalid
digest_invalid
revoked
unsupported_version
storage_failure
transport_unavailable
publish_rejected
```

These outcomes must never be mapped to local compatibility `DEGRADED` or `UNSUPPORTED` verdicts.

---

# 22. Security tests required before implementation acceptance

CL-10 implementation must include adversarial tests for:

- prompt/response/tool/repository/path canaries;
- API keys, OAuth tokens, cookies, authorization headers, and common secret formats;
- account/email/project/tenant/location canaries;
- local subject/event/artifact/request/decision/Fabric IDs;
- custom provider/model IDs;
- URLs/query strings/IP addresses/header dumps;
- precise timestamps and raw latency/error fields;
- unknown JSON fields at every public schema level;
- duplicate decoded JSON object member names, including escape-equivalent keys;
- malformed/oversized/deeply nested import bundles;
- invalid signatures and digests;
- a fixed RFC 8785/domain-separated bundle digest and Ed25519 signature vector;
- bundle replay/deduplication;
- revoked bundles;
- community evidence isolation from local verdicts, routing, and CL-08;
- deterministic export from identical local inputs;
- non-exportability when private route dimensions would be erased.

---

# 23. Delivery sequence

## CL-10.0 - Audit and contract

Contract work completed on this PR before runtime implementation:

- record CL-09 closure;
- freeze public exportability and privacy rules;
- freeze public bundle schema and export-scoped identity;
- freeze publisher-signature and community trust semantics;
- freeze consent, revocation, import isolation, and remote-publishing gate;
- define implementation sequence and validation requirements.

Independent review accepted CL-10.0 on 2026-08-12. CL-10.1 through CL-10.4 are therefore authorized on this branch by explicit maintainer direction. CL-10.5 remains blocked by section 18.

## CL-10.1 - Public projector and privacy validator

Implement closed public DTOs, exportability checks, export-scoped IDs, deterministic canonicalization, and fail-closed privacy validation.

## CL-10.2 - Public bundle storage and publisher signatures

Implement local public-bundle storage plus publisher-key lifecycle, bundle digesting, Ed25519 signing, and verification.

## CL-10.3 - Local preview/export surfaces

Implement CLI/API/UI preview and explicit local export. No remote publishing yet.

## CL-10.4 - Community import and quarantine/read surfaces

Implement strict import/verification, separate non-authoritative community storage, revocation handling, and clearly labelled read surfaces. No routing/verdict integration.

## CL-10.5 - Remote publishing transport

Implement only after the exact remote-service contract in section 18 is completed and independently accepted.

## CL-10.6 - Adversarial closure and programme acceptance

Run privacy, trust, cross-platform, no-feedback, reproducibility, and independent review gates. On acceptance, mark Compatibility Lab CL-00 through CL-10 complete.

---

# 24. Explicit non-goals

CL-10 V1 must not implement:

- automatic telemetry;
- background production evidence upload;
- raw local Lab ledger export;
- custom/private route publication;
- user prompt/response/tool/repository export;
- account-linked public identity;
- community evidence as canonical local evidence;
- community-driven Routing Profile or Router Intelligence behavior;
- community-driven CL-08 scheduling;
- global compatibility score or leaderboard that mixes incomparable evidence layers;
- arbitrary upload/download URLs;
- remote code/tool execution;
- public artifact classes without explicit `public_export` policy.

---

# 25. Contract acceptance criteria

CL-10.0 is accepted only when independent review agrees that:

1. no local/private identifier is required by the public schema;
2. exact local evidence cannot be generalized into a misleading public claim by dropping private route dimensions;
3. exported fields are closed, bounded, versioned, and fail closed on unknown fields;
4. public artifacts require explicit opt-in policy and second-pass sanitization;
5. export/publish requires explicit user action and creates no automatic telemetry path;
6. publisher signatures prove integrity/continuity without being misrepresented as evidence truth;
7. imported community evidence is isolated from local canonical evidence, freshness, routing, and scheduling;
8. revocation semantics are defined independently of remote physical deletion;
9. remote transport remains gated until an exact service/security contract exists;
10. implementation tasks have adversarial privacy and trust tests sufficient to prevent silent boundary regression.

---

# 26. Validation

Contract PR minimum:

```text
git diff --check
repository markdown / hygiene checks
CodeRabbit / independent review
```

Implementation phases must additionally run:

```text
bun x tsc --noEmit
bun run privacy:scan
focused Lab export/import/signature tests
focused ledger/projection isolation tests
Routing Profile / Router Intelligence no-feedback regressions
CL-08 no-feedback regressions
CLI/API/GUI tests for implemented surfaces
cross-platform CI
```

---

# 27. Hard stop

The CL-10 contract was independently accepted on 2026-08-12 and explicit maintainer direction authorizes CL-10.1 through CL-10.4 runtime implementation on this branch.

No CL-10.5 remote publishing code, upload transport, remote fetch, or arbitrary network publication is authorized until section 18 has been completed with an exact reviewed transport contract and independently accepted.
