# Proposed update contracts — draft

These names bind the roadmap drafts to one vocabulary; none is implemented or
approved yet. Security review must resolve exact encoding, authorization and
rotation before a unit is executable. Existing `ocx.update.plan/1`,
`ocx.update.result/1`, `ocx.sync.fanout/1` and desktop v1 snapshots remain
compatible contracts; do not add fields to their strict parsers in place.

| Contract and fields | Creation → serialization → parsing → consumers |
| --- | --- |
| `ocx.update.root/1`: `schema`, `revision`, `expiresAt`, `rootKeys`, `rootThreshold`, `releaseKeys`, `releaseThreshold`, `channels` | The initial root is embedded in the shipped clients from the repository's existing pinned updater key (`010`); Node/Bun and native builds consume the same generated public-key bytes and a test compares them with `desktop/src-tauri/tauri.conf.json`. A root file is signed over its exact UTF-8 bytes by detached, bounded signature records. A later revision is accepted only when both old and new thresholds verify, the revision increases and the record is unexpired; the highest accepted root is stored atomically by the owning installation. Unknown, expired, rollback or unverifiable roots refuse automation. No private keys are embedded or created by local tests. |
| `ocx.update.release/1`: `version`, `channel`, `sequence`, `sourceCommit`, `rolloutNotBefore`, `targets` | Release builder creates the exact metadata and signs its bytes (`010`); saved/served as bounded UTF-8 bytes; `signed-supply.mjs` verifies signature before strict parsing; policy, package and remote selection consume the resulting verified candidate (`040`, `060`). Native Desktop selects its updater target and delegated artifact key only from the verified record, then separately verifies the artifact through Tauri (`030`). Unknown schema or signature is refused, not coerced. |
| `ocx.update.tree/1`: `version`, `target`, `entries` with path/type/mode/size/digest and internal-link target | Build after package preparation (`010`); signed release record binds the exact inventory bytes and archive digest; strict extractor and `signed-tree.mjs` validate the complete set before execution; package adapter and recovery consume the verified stage (`040`). No transport may introduce extra tree entries. |
| `ocx.link-capabilities/1`: exact version, channel, target and artifact digest; provided and required protocols; update actions; installer, recovery and journal-reader versions | Release builder emits bounded descriptor bytes and binds their digest in the signed target record (`010`); shared strict parser verifies the binding before returning typed data; fleet comparator checks each candidate and retained recovery artifact (`060`). Absence is unknown, not a capability inferred from version. |
| `ocx.update.policy/1`: `revision`, `channel`, `check`, `download`, `install` | Native and package policy owners create and atomically persist their own records (`030`, `040`); strict parser accepts only known values, distinguishes missing from corrupt, and never silently enables automation on corrupt state. Coordinator captures revision before effects, rechecks it at download and activation, and panel displays owner-projected values (`050`). Remote requests carry a destination revision but cannot change it (`060`). |
| `ocx.update.prepared/1`: `operationId`, candidate identity, stage identity/digest, installation owner, policy revision | Installer owner creates only after verification (`030`, `040`); persists bounded private recovery metadata where supported; owner reconstructs/reverifies bytes after restart. Admission consumes the opaque operation identity and exact stage binding (`020`); UI receives only state, not authority (`050`). Invalid or stale bindings refuse. |
| `ocx.update.activation/1`: operation ID/generation, runtime instance, endpoint, installation owner, candidate/stage digest, policy revision, deadline | Local update coordinator creates descriptor after verified preparation (`020`); authenticated stop transport carries bounded bytes; runtime admission parses under its locks and returns an owner-bound permit; the external stop owner commits or cancels it. No dashboard snapshot, peer observation or existing unkeyed plan hash is treated as permission. |
| `ocx.update.stop/1`: operation identity, disposition, runtime-exit and manager observations, teardown state | Receipt-backed stop owner produces after admission (`020`); native/CLI installer parses and verifies process exit and exact operation; only a proved stop permits swap. Unknown or lost responses are reconciled and never trigger another installer. Old clients do not invoke this contract. |
| `ocx.desktop.update/2`: current version, candidate identity/channel, phase, bounded progress/error, policy revision and values, release-note text, deferred state | Native updater owns and creates the panel result (`030`); local update-page commands return it and accept only validated candidate IDs or policy revisions (`050`). The bundled page renders text safely. This contract is not accepted from the dashboard origin and does not grant installation authority. |
| Desktop snapshot v2: `schema`, `sessionId`, `sequence`, `currentVersion`, `latestVersion`, `available`, `checkedAtMs`, `phase`, `progressPercent`, `errorCode`, `installedChannel`, `policyChannel`, `candidateChannel` | Native publisher creates the bounded projection (`030`, `050`) from the verified installed provenance, current policy and verified candidate respectively; each channel is `latest`, `preview`, `nightly` or null when unavailable. The body-authenticated session transport remains capped at 1 KiB; `desktop-badge.ts` accepts v1 or strict v2 and preserves per-session ordering. Badge values are display observations, never installation authority. A successful v1 publication may advertise `snapshotSchemas: [1, 2]` in the response; absent advertisement keeps v1. Auth/transport failures do not negotiate. V1 lacks provenance and cannot imply preview from version spelling. Release notes do not enter this projection. |
| `ocx.desktop.badge/2`: `schema`, `sessionId`, `currentVersion`, `latestVersion`, `updateAvailable`, `unknown`, `phase`, `progressPercent`, `errorCode`, `installedChannel`, `policyChannel`, `candidateChannel` | The server's session-scoped snapshot store produces a display-only projection; the separately versioned desktop badge GET serializes it, the GUI strictly parses and renders it (`050`). All three channels and unavailable session/version fields are nullable; never infer channel from version. Legacy GET keeps its old DTO when provenance is known and representable, otherwise returns an explicit non-success unavailable result. Package badge and legacy DTO shapes do not change. |
| `ocx.link-update.envelope/1`, `ocx.link-update.request/1`, `ocx.link-update.result/1`: operation identity, link, candidate, destination policy revision, expiry and action | Home creates bounded request after local selection (`060`); pinned SSH carries it to the destination; Child authenticates and validates link, local policy, candidate and owner under the proper locks before effects; Child journal emits idempotent status and Home fleet journal reconciles it after restart. Existing sync and read-only management relay remain separate. Exact proof format and lock sequence remain open. |
| `ocx.link-update.grant/1`: grant identity/epoch, Home public key identity, Child/configuration/installation and link binding, allowed actions and expiry | Destination owner explicitly approves and persists a local grant (`060`); Child validates it and its current local policy before an operation; Home cannot create or widen that grant remotely. Revocation, relink and key rotation invalidate the old binding. No credential or private key appears in status projections. |
| `ocx.link-update.dashboard-status/1`, `ocx.link-update.dashboard-action/1`, `ocx.link-update.dashboard-action-readback/1` | Home's authenticated management owner projects bounded, destination-scoped journal evidence and accepts revision-bound operator actions (`060`); request-ID readback binds original and resulting operations after a lost acknowledgement. The GUI validates responses and presents only observed outcomes. Destination-local grants and policy remain authoritative and the read-only relay is unchanged. |

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
role being verified.
Detached signatures carry `{keyFingerprint, signatureBox}` in the envelope
defined in `010` and authenticate the exact file bytes. Reject duplicate keys, duplicate JSON names, thresholds outside the
unique key count, unknown fields and unsupported algorithms. Initial threshold
is one pinned root key and one delegated release key; a feed cannot add a new
root without the rotation rule above. The signature-envelope proposal and
required cross-runtime test vectors are in `010`; they require independent audit.

The native candidate bridge must first verify the release record through the
same trusted root, select an exact `(channel, version, target, artifact digest)`
tuple, then construct the pinned Tauri updater's release input from that
verified record. The updater verifies the artifact signature on download and
again on install. Cached metadata is reconstructed with `restore_update`,
which requires signed-version binding; a mismatch, unsigned version or
unavailable verifier yields no ready stage. This applies to fresh checks too:
unsigned feed version or channel labels never select installation authority.

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
