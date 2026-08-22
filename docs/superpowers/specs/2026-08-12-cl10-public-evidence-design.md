# CL-10 Public Evidence Design

## Status

Design approved for contract drafting on 2026-08-12. Independent review accepted the contract on 2026-08-12, and explicit maintainer direction now authorizes CL-10.1 through CL-10.4 runtime implementation on this branch. CL-10.5 remote publishing remains blocked on an exact independently accepted transport/service contract.

Base: `dev` at `4fed8d3fe431ad23be83f3aff2af18ef8b8ecd71`, the CL-09 merge commit from #1489.

## Problem

Compatibility Lab now has local protocol, live-route, task-effectiveness, automatic-refresh, and passive-production evidence. The remaining programme boundary is public sharing.

Local evidence cannot be published directly because local schemas intentionally contain installation-scoped identity and operational metadata that is safe only inside the local trust domain. Community evidence also cannot be allowed to become canonical local truth merely because a remote bundle is syntactically valid or cryptographically signed.

## Chosen design

Use a deterministic, closed public projection with a separate community trust domain.

```text
local canonical evidence
  -> exportability gate
  -> allowlist-only public projection
  -> export privacy scan
  -> export-scoped IDs
  -> canonical bundle digest
  -> pseudonymous publisher signature
  -> explicit local export
  -> optional explicit publish after transport contract acceptance

community bundle
  -> bounded parser
  -> schema/digest/signature verification
  -> non-authoritative community cache
  -> clearly labelled read surface
  -> never local verdict/routing/scheduling authority
```

## Key decisions

### Public route identity

A local route is exportable only when its behavior can be represented entirely through entries in the versioned, content-addressed, repo-reviewed `PublicRouteRegistryManifestV1`; dynamic discovery, config, and imported bundles cannot extend that authority. Private/custom endpoint, header, provider-instance, project/location, tenant, account, or custom model/provider dimensions make the route `not_exportable`.

The exporter must never create a broader public claim by deleting a private dimension from an exact local route subject.

### Public schema

`PublicEvidenceBundleV1` is independently versioned and allowlist-only. Dedicated runtime validators enforce its closed types. Records use a layer-matched public subject union rather than assuming every evidence layer is a route. Incident references are closed `IC-NNN` corpus IDs only, and artifact references resolve only to public artifacts in the same bundle.

Unknown fields fail closed on export and import.

### IDs

Local subject, event, artifact, request, decision, and Fabric IDs never leave the installation. Public IDs are derived only from canonical public-safe bytes under explicit domain-separated hashes.

### Canonical bytes and signatures

CL-10 V1 freezes RFC 8785 JSON Canonicalization Scheme (JCS) over UTF-8 as the canonical byte representation. Raw imported JSON must be valid UTF-8 and must reject duplicate decoded object member names before semantic object construction, including equivalent escaped spellings such as `"a"` and `"\u0061"`.

Every public hash is:

```text
H(domain, value) = SHA-256(UTF8(domain) || 0x00 || UTF8(JCS(value)))
```

The exact V1 domains are `ocx-lab-public:subject:v1`, `ocx-lab-public:record:v1`, `ocx-lab-public:bundle:v1`, `ocx-lab-public:bundle-digest:v1`, `ocx-lab-public:artifact:v1`, `ocx-lab-public:publisher-key:v1`, `ocx-lab-public:revocation:v1`, and `ocx-lab-public:route-registry:v1` for their corresponding identities.

For a bundle, `C = {schemaVersion, exportPolicyVersion, createdDayUtc, publisher, records, artifacts}`. `bundleId = H("ocx-lab-public:bundle:v1", C)`. `bundleDigest = H("ocx-lab-public:bundle-digest:v1", {...C, bundleId})`. Therefore `bundleDigest` and `signature` are excluded from the bundle-digest preimage, and `bundleId`, `bundleDigest`, and `signature` are excluded from the bundle-ID preimage. Ed25519 signs the raw 32 bytes obtained by hex-decoding `bundleDigest`; `signature.signedDigest` must equal `bundleDigest` exactly.

A revocation similarly hashes `R = {schemaVersion, issuedDayUtc, publisher, targets, reason}` under `ocx-lab-public:revocation:v1`; `revocationId` and `signature` are excluded from `R`, and Ed25519 signs the raw 32 bytes of `revocationId`. Targets are sorted and unique before hashing.

Import verification order is fixed: byte cap; strict UTF-8 and duplicate-key rejection; JSON syntax/structural bounds; closed schema/version/field validation and publisher-key-ID recomputation; public identity/reference and bundle digest recomputation; `signedDigest` equality; Ed25519 key/signature decoding and verification; repository route/suite/scenario/Fabric authority validation; revocation bootstrap only against an already-verified exact target publisher/bundle; persistence only after every preceding check succeeds.

### Artifacts

Artifacts require explicit `public_export` policy. A second export sanitizer and secret/PII scan runs before public artifact hashing. Local visibility alone never authorizes export.

### Consent

There is no automatic telemetry. Preview is local and network-free. Export is explicit. Publishing is a second explicit action for a specific bundle and is not implemented until an exact remote-service contract is accepted.

### Publisher provenance

Publishable bundles use an installation-local Ed25519 publisher key. The public key provides pseudonymous continuity; the signature proves bundle integrity and signer continuity only. It does not prove that the compatibility claim is true.

### Community trust

Imported community evidence is `community_untrusted_v1`. A valid signature produces `cryptographically_valid`, not `locally_verified`.

Community evidence cannot:

- append to local `compatibility.jsonl`;
- alter local canonical verdicts or freshness;
- satisfy Routing Profile compatibility requirements;
- influence Router Intelligence;
- trigger CL-08 refresh scheduling;
- merge into a combined local/community score.

### Revocation

Publishers can issue signed revocations with finite reason codes. Revocation authority bootstraps from the exact publisher key embedded in the already-verified target bundle; V1 permits no cross-key revocation or key rotation, and duplicate identical revocations are idempotent while conflicting replay fails closed. Consumers suppress revoked records from default community summaries while retaining the audit relation. Remote deletion is transport-specific and does not replace revocation. CL-00 sensitive purge still removes every affected local generated export plus locally-originated community-cache copy fail-closed; local purge never depends on network acknowledgement.

### Remote service

Bundle semantics, signing, import, and trust are frozen before any network publishing implementation. A remote publisher requires a reviewed fixed service origin, authentication, TLS/redirect, request-budget, retry/idempotency, retention/deletion, revocation, abuse/rate-limit, and server-validation contract. Arbitrary upload URLs are forbidden.

## Delivery decomposition

1. **CL-10.0 Contract:** freeze privacy, exportability, schema, IDs, signatures, consent, trust, revocation, and transport gate.
2. **CL-10.1 Public projector:** closed DTOs, exportability rules, deterministic canonicalization, export privacy validator.
3. **CL-10.2 Bundle/signature substrate:** local exports, publisher-key lifecycle, digest/sign/verify.
4. **CL-10.3 Local surfaces:** preview and explicit local export via existing Lab CLI/API/UI conventions.
5. **CL-10.4 Community import:** bounded import, verification, separate community cache, revocation and labelled read surfaces.
6. **CL-10.5 Remote publishing:** only after exact service contract acceptance.
7. **CL-10.6 Closure:** adversarial privacy/trust tests, cross-platform validation, independent review, programme closure.

## Validation expectations

The implementation must include adversarial tests for secret/PII canaries, local IDs, private route dimensions, unknown fields, duplicate JSON object keys, oversized/deep bundles, invalid digest/signature, replay/deduplication, revocation, deterministic export, fixed canonical digest/signature vectors, and complete isolation from local verdicts/routing/CL-08.

The contract review gate is satisfied. Runtime CL-10.1 through CL-10.4 may now land on this PR under TDD and full validation; CL-10.5 remote publishing remains out of scope.

## Source of truth

The detailed normative contract is:

`devlog/_fin/260807_compatibility_lab/010_cl10_public_evidence_export.md`
