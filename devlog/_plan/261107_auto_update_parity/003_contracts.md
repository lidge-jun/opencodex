# Proposed update contracts — draft

These names bind the roadmap drafts to one vocabulary; none is implemented or
approved yet. Security review must resolve exact encoding, authorization and
rotation before a unit is executable. Existing `ocx.update.plan/1`,
`ocx.update.result/1`, `ocx.sync.fanout/1` and desktop v1 snapshots remain
compatible contracts; do not add fields to their strict parsers in place.

| Contract and fields | Creation → serialization → parsing → consumers |
| --- | --- |
| `ocx.update.root/1`: `schema`, `revision`, `expiresAt`, `rootKeys`, `rootThreshold`, `releaseKeys`, `releaseThreshold`, `channels` | A planned trust-root record would define public verification material and rotation; the design remains subject to independent security review. |
| `ocx.update.release/1`: `version`, `channel`, `sequence`, `sourceCommit`, `rolloutNotBefore`, `targets` | The proposed release builder would create and sign metadata (`010`); the planned `signed-supply.mjs` would verify the signature before strict parsing, and policy, package and remote selection would consume the verified candidate (`040`, `060`). Native Desktop would select its target and delegated artifact key from that record and separately verify the artifact through Tauri (`030`). Unknown schemas or signatures would be refused. |
| `ocx.update.tree/1`: `version`, `target`, `entries` with path/type/mode/size/digest and internal-link target | After package preparation (`010`), the proposed signed release record would bind inventory bytes and archive digest. A strict extractor and planned `signed-tree.mjs` would validate the complete set before execution; the package adapter and recovery would consume the verified stage (`040`). No transport should introduce extra tree entries. |
| `ocx.update.channel-freshness/1`: `channel`, `freshnessSeq`, `releaseSeq`, `releaseDigest`, `issuedAt`, `expiresAt`, `rootRevision` | Renewable signed channel freshness is proposed; a compatible publisher and discovery path have not been demonstrated. Installation owners would validate expiry, selected release and per-channel high-water state as specified in `010`, subject to its open publication and validity blockers. |
| `ocx.link-capabilities/1`: exact version, channel, target and artifact digest; provided and required protocols; update actions; installer, recovery and journal-reader versions | A planned release descriptor would bind compatibility information to its candidate for fleet comparisons. |
| `ocx.update.policy/1`: `revision`, `channel`, `check`, `download`, `install` | Proposed native and package policy owners would persist and validate policy records, with corrupt or unreadable state disabling automatic effects. |
| `ocx.update.prepared/1`: `operationId`, candidate identity, stage identity/digest, installation owner, policy revision | Installer owners would create a verified, owner-bound prepared state and expose only status to the UI. |
| `ocx.update.activation/1`: operation ID/generation, runtime instance, endpoint, installation owner, candidate/stage digest, policy revision, deadline | A planned local coordinator would bind admission to the exact operation and owner before activation. |
| `ocx.update.stop/1`: operation identity, disposition, runtime-exit and manager observations, teardown state | A proposed stop owner would provide an observed, operation-bound result before a verified swap. |
| `ocx.desktop.update/2`: current version, candidate identity/channel, phase, bounded progress/error, policy revision and values, release-note text, deferred state | The planned native panel status would represent the candidate, stage readiness, check errors, policy state and safe release notes independently. |
| Desktop snapshot v2: `schema`, `sessionId`, `sequence`, `currentVersion`, `latestVersion`, `available`, `checkedAtMs`, `phase`, `progressPercent`, `errorCode`, `installedChannel`, `policyChannel`, `candidateChannel` | A proposed versioned publisher and decoder would provide a bounded display-only snapshot with explicit unknown values and legacy negotiation. |
| `ocx.desktop.badge/2`: `schema`, `sessionId`, `currentVersion`, `latestVersion`, `updateAvailable`, `unknown`, `phase`, `progressPercent`, `errorCode`, `installedChannel`, `policyChannel`, `candidateChannel` | A planned versioned desktop badge would project nullable channel and availability observations, while the old badge retains its existing compatibility behavior. |
| `ocx.link-update.envelope/1`, `ocx.link-update.request/1`, `ocx.link-update.result/1`: operation identity, link, candidate, destination policy revision, expiry and action | A proposed destination-authorized update exchange would carry bounded operations and results independently of sync. |
| `ocx.link-update.grant/1`: grant identity/epoch, Home public key identity, Child/configuration/installation and link binding, allowed actions and expiry | A planned destination-local grant would restrict authorized update operations and be revocable. |
| `ocx.link-update.dashboard-status/1`, `ocx.link-update.dashboard-action/1`, `ocx.link-update.dashboard-action-readback/1` | Proposed management endpoints would expose bounded status and accept revision-bound actions without transferring destination authority. |

The new field names above must be reflected verbatim in each unit's final
file map and tests. The proposed per-platform signed tree is a publisher
attestation of final build output; it is not a claim of reproducible builds.
Avoid sensitive data in all status records and logs. Capability absence or an
unknown schema produces an explicit unavailable/unknown result, never a
fallback to an unverified install.

## Exact release-candidate binding

`ocx.update.release/1` is a closed object containing `schema`, `version`,
`channel`, positive safe-integer `sequence`, full source commit,
`rolloutNotBefore`, `receipt`, `releaseNotes` and a bounded nonempty `targets`
array. `receipt` binds a SHA-256 and size. Each unique target has an exact
platform/architecture/owner-compatible `id`, `artifactKind`, `artifact`
(`sha256`, `size`, `signatureBox`, `signerFingerprint`), `tree` (null for
native bundle formats or signed inventory digest/size), `capabilities`
(descriptor digest/size), and approved source/asset identity. Reject duplicate
target IDs, malformed hashes, missing fields and unknown enums. A consumer
never accepts an arbitrary filesystem path or URL from a caller as install
authority. `010` derives the approved release URL and `030` enforces its
production transport policy.

The release builder first verifies the exact source, four version files and
artifact set and emits a bounded `ocx.update.verification/1` receipt containing
source commit, version, channel, workflow run/attempt, version-source digests
and ordered asset digests/sizes. The receipt does not contain the later release
record or its own digest. After verification, the signed release record binds
the exact receipt bytes and artifacts, avoiding a circular digest. Target
selection returns a candidate ID derived from a domain separator, the exact
release-record SHA-256 and the length-prefixed target ID. It is a lookup value,
not a replacement for an owner-held prepared handle or consent.

`010` owns the shared strict parser and golden vectors; `030`, `040`, `060`
and `070` create their owner-specific prepared state only from the verified
candidate. Tests must reject changed receipt/target/signature/bytes, wrong
channel or owner, ambiguous targets, same-sequence substitutions and an
unverified release listing. The selected candidate, policy revision and actual
owner are rechecked before every side effect. Old strict output schemas remain
separately decoded.

## Publisher payload and manager output

The publisher-signed tree inventory is an exact closed set for publisher
payload: every listed file/link/type/mode/digest must match and no unlisted
publisher payload is accepted. Package-manager output is a separate local
owner record, never relabeled publisher-signed. Each supported manager/version
adapter has a closed allowlist of generated metadata and bin/link paths, parsed
schemas and canonical wrapper templates; bind every target and path to the
selected installation, global/bin/cache/store identity and verified payload.
Reject unknown generated entries, executable text that differs from an
adapter-owned exact template, links escaping allowed roots, unexpected paths,
unrecognized manager versions/layouts and missing or conflicting ownership.
Do not use a locally generated checksum as publisher authentication.

The adapter journals the exact validated generated-output digest and owner
identity for readback and recovery; that digest detects drift but does not by
itself authenticate the manager. Manager execution is permitted only through
the selected trusted installed manager and under installation-scoped exclusion;
verify the signed consumed inputs and installed payload again before any new
candidate executable runs. A nonparticipating or unknown writer remains an
explicit unresolved boundary under `020`, not an assumed lock guarantee.
Per-manager tests cover every allowed metadata/wrapper class, foreign entries,
path changes, unsupported layouts and interrupted recovery. The actual supported
version/platform allowlist is enabled only after those tests and independent
security review pass.

## Signed-root draft encoding

The root is a strict JSON object with `schema: "ocx.update.root/1"`, positive
integer `revision`, RFC3339 `expiresAt`, `rootKeys` and `releaseKeys` as bounded
arrays of `{keyId, algorithm, publicKey}`, integer thresholds, and `channels`
as a distinct subset of `latest`, `preview`, `nightly`. `algorithm` is the
explicit Tauri-compatible minisign prehashed format; `keyId` is the full
public-key fingerprint, with the format's short identifier checked as well.
Each release-key entry additionally names its nonempty `channels` and `roles`
subsets; a target may select it only for an explicitly delegated channel and
role. Root-key entries have no release delegation fields. Allowed release
roles are `release`, `tree`, `desktop-artifact`, `standalone-artifact` and
`guardian-artifact`; threshold and unique-key checks apply separately to the
role being verified. The proposed desktop-artifact role is constrained to a
single signer until a multi-signature bridge is designed and reviewed.
The representation of independently configurable role thresholds remains
unresolved: the table's singular `releaseThreshold` is a placeholder, not a
final schema. Resolve and independently review that encoding, including
desktop-artifact constraints, before any implementation relies on it.
Detached signatures carry `{keyFingerprint, signatureBox}` in the envelope
defined in `010` and authenticate the exact file bytes. Reject duplicate keys, duplicate JSON names, thresholds outside the
unique key count, unknown fields and unsupported algorithms. Initial threshold
is one pinned root key and one delegated release key; a feed cannot add a new
root without the rotation rule above. The signature-envelope proposal and
required cross-runtime test vectors are in `010`; they require independent audit.

The native candidate bridge is a planned integration. Its security design and verification remain subject to independent review.

Channel discovery freshness, expiry, renewal and rotation are proposed in
`010`. Publication through an existing authorized path and independent
security review remain prerequisites; none of these contracts is implemented.

## Future link compatibility descriptor

`ocx.link-capabilities/1` is a closed JSON object with `schema`, `version`,
`channel`, `target`, `artifactSha256`, `homeProvides`, `childRequires`,
`updateActions`, `installerAdapters`, `recoveryProtocols` and
`fleetJournalReaders`. Each of the last six fields is a bounded array of
unique `{id, version}` pairs: `id` is a stable ASCII protocol/adapter/action
identifier and `version` is a positive integer. Arrays express exact supported
versions, not ranges inferred from release strings. Empty arrays are explicit;
missing, malformed, duplicated or unknown schema data is `unknown`. The
signed target record binds the digest and length of the exact descriptor bytes;
the descriptor's artifact digest and target must equal the selected target.
This avoids a circular release-record digest. A descriptor for a retained old
artifact must itself be publisher-authenticated and bound to that exact
artifact; a current peer report is not a substitute.

Add `compatibilityEpoch` and `compatibilityVectorSha256` to the descriptor.
The vector is canonical encoding of the provided/required protocols, update
actions, recovery and journal-reader versions relevant to interoperation, with
strict ordering and duplicate rejection. Publisher release checks certify that
every artifact declaring the same epoch and vector implements that vector; a
changed vector requires a new epoch. The artifact-specific descriptor still
binds version, target and digest, while the shared vector identifies the
compatibility horizon rather than claiming different artifacts have the same
digest. The release verifier must test this invariant against the source-owned
feature and protocol implementations before signing.

The `060` comparator first verifies both descriptors and their exact artifact
bindings. For each required `{id, version}` in the Child's `childRequires`, the
Home's `homeProvides` must contain the identical pair. The selected update
action, destination installer adapter, recovery protocol, and journal-reader
version required by the specific operation must likewise be explicitly present
in the relevant descriptor. A valid descriptor with a missing required pair is
`incompatible`; absent or unverifiable evidence is `unknown`. Neither result
permits automatic activation. Comparator test vectors cover all Home/Child and
recovery pairs, same release with different artifact, explicit empty arrays,
unknown schema, duplicate entries and forged or missing descriptor binding.
