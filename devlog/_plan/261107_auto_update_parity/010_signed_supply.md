# Signed supply and channel contracts — draft unit

**Status:** evidence and design options only. The exact artifact and trust
contract requires the architect proposal, independent security review and
roadmap audit before this becomes an executable unit.

## Existing supply

The release verifier expects standalone archives with SHA-256 sidecars, while
its required updater signatures cover desktop updater targets
(`desktop/scripts/verify-release-assets.ts:45`). The Tauri feed names exact
desktop artifact URLs and signatures (`desktop/scripts/updater-manifest.ts:18`).
The verifier pins the configured updater public key and verifies Ed25519
signatures (`desktop/scripts/verify-release-assets.ts:180`). npm trusted
publishing generates provenance (`.github/workflows/release.yml:1151`); a
publisher-verification contract must be established for the requested update
experience. Integrity metadata alone is not a publisher signature.

## Required design decision

The read-only `auto-update-signed-supply-research-01` investigation recommends
publisher-signed, self-contained installation trees as the primary candidate.
Existing npm provenance remains an alternative, but its entire executable
dependency closure and offline verification are not yet established. The
proposal is not a security review or proof that artifacts already exist.
Prove a reproducible, offline-testable signature contract for the *exact bytes*
used by every automatic installation, including publisher, version, platform,
channel, key rotation and artifact-to-install binding. A release must never be
published as part of this task.

Proposed signed supply consists of a versioned trust root
(`ocx.update.root/1`), a release record (`ocx.update.release/1`), a complete
tree inventory (`ocx.update.tree/1`) and a directly signed tree archive for
each supported platform. Sign exact UTF-8 metadata bytes, not a reconstructed
serialization. The release record binds source commit, version, channel,
sequence, target, archive digest and size, and tree-inventory digest. The tree
inventory covers every executable and dependency, including Bun, native keyring,
optional native modules and generated compatibility assets. Reject duplicate or
unknown fields, unsupported algorithms, invalid paths and oversized input.
The release builder freezes the tree only after package preparation
(`package.json:71`).

Proposed initial trust root: the existing updater public key already pinned in
`desktop/src-tauri/tauri.conf.json:68`, using the Tauri-compatible
Ed25519/BLAKE2b signature format and verifier precedent
(`desktop/scripts/verify-release-assets.ts:186`). The release record and tree
archive must each verify under a release key delegated by that pinned root;
a feed-provided key alone is never a trust root. Root revision updates require
authorization from both the currently trusted and replacement roots; persist
the highest accepted revision and channel sequence. A lost or compromised root
requires a separately authorized manual software/key recovery; do not silently
trust a replacement from the feed. Test fixtures use separate keys only.

The research lane also proposed a two-of-three offline root. The initial plan
does not assume three existing maintainer keys or perform a key ceremony; it
starts from the repository's existing publisher trust anchor. Security audit
must assess that operational tradeoff, the exact signer availability and
rotation procedure before implementation. No private signing material is
created, requested or used during this task's local tests.

## Proposed detached signature format and rotation

The existing release verifier parses the Tauri public-key box as `Ed`, an
eight-byte key ID and 32 public-key bytes, and its updater signature as `ED`,
an eight-byte key ID and a 64-byte signature
(`desktop/scripts/verify-release-assets.ts:155`, `:186`). `ED` verifies ordinary
Ed25519 over the BLAKE2b-512 digest of the **exact input bytes**, followed by
the minisign global signature over the raw signature and trusted comment
(`:204`, `:212`). It is not Ed25519ph. Keep Tauri's base64-wrapped minisign
signature box for artifacts; do not invent a different cryptographic meaning
for an existing `.sig` file.

For release and tree metadata, propose a closed `ocx.update.signatures/1` JSON
envelope `{schema, signatures}`. Root transitions use the separate closed
`ocx.update.root-transition-signatures/1` envelope with the same entry shape.
Each entry is
`{keyFingerprint, signatureBox}`, where `keyFingerprint` is lowercase SHA-256
of the 32-byte Ed25519 public key and `signatureBox` is canonical standard
base64 of the four-line Tauri minisign box. Each signature authenticates the
exact accompanying metadata file bytes; no parse-and-reserialize step occurs
before verification. The expected metadata schema and verification role are
chosen by the consumer and checked after cryptographic verification; a root
record cannot be accepted as a release record. Limit root metadata to 64 KiB,
release metadata to 1 MiB and tree inventory to 16 MiB. Ordinary signature
envelopes are limited to 64 KiB and 16 signatures; transition envelopes are
limited to 256 KiB and 32 signatures. Each root key set remains limited to 16
keys. A transition envelope may contain only distinct keys from the old/new
union; verify each set's threshold independently over the same successor bytes.
An overlapping key may count once for each set when its packet identifier
matches both root records. Reject duplicate fingerprints,
noncanonical encodings, unknown algorithms, short packet IDs that disagree with
the full authorized key, malformed UTF-8, invalid global comments, duplicate
JSON keys and schema/role mismatches. Initial key threshold is one, as stated
above; threshold counting is over distinct authorized full fingerprints.

The embedded initial root delegates release keys per channel and role; the
verified release record selects exactly one authorized artifact key fingerprint
for each target. The native client verifies the root and release first, selects
the target's delegated key, then passes the corresponding verified minisign
public-key box to the updater builder's `pubkey` override. The locally installed
`tauri-plugin-updater` 2.14.1 exposes this override in `src/updater.rs:348`;
the signed target digest and signature still bind the exact downloaded bytes.
The existing release verifier currently checks the configured pinned updater
key (`desktop/scripts/verify-release-assets.ts:202`), so the supply unit must
update it to check only an authorized delegated key and exercise both old and
rotated configurations. Root rotation accepts a strictly higher root revision
only when signatures by distinct keys meet both the current-root and proposed-
root thresholds; write the validated root and high-water mark atomically before
using newly delegated keys. Replayed or partially authorized root transitions,
unknown channels, mismatched key IDs and an interrupted persistence step refuse.
Producer, acquisition, persisted replay and native-verifier tests must use the
transition-specific schema and cap; ordinary metadata must reject that schema.

For desktop assets require a verified minisign trusted comment containing the
matching signed version on both fresh and restored updates. The pinned plugin
enforces this on restored metadata, but its fresh-check behavior depends on
`require_signed_version` (local crate `src/updater.rs:673`, `:1928`); the
implementation must set and test that option or prove an equivalent mandatory
check. Include shared fixture-key vectors for valid and invalid boxes, changed
bytes/comments/version, old/new root threshold transitions, replay, partial
write and cross-channel key selection. Run the existing Rust plugin verifier and
the Bun/Node verifier against the same fixture bytes; differing results block
the unit. Operational signer provisioning, offline root custody and recovery
after lost keys still require a separate independent security PASS.

## Platform and owner matrix to implement

| Surface | Existing published build targets in source | Required automatic behavior |
| --- | --- | --- |
| Tauri desktop | macOS arm64/x64, Windows x64, Linux x64 AppImage/deb (`desktop/scripts/updater-manifest.ts:30`) | Use the signed desktop feed for the exact bundle target; a missing target/channel is unavailable. Verify actual release assets and the Linux bundle-type selection. |
| Standalone runtime | macOS arm64/x64, Windows x64, Linux x64/arm64 (`scripts/standalone-targets.ts:7`) | A signed exact-platform artifact and an owner-specific replacement/recovery contract are required; current standalone ownership is not automatically eligible. |
| npm global | npm-owned package roots and bin links; platform-specific dependency tree selected by installation | Provide a signed complete tree for each supported platform and prove ownership, bin compatibility, stage and rollback. Missing closure is unsupported. |
| pnpm and Bun global | Existing owner-specific global operations, not a proved download-only stage | Implement and independently verify each manager's signed offline staging, activation, shims and rollback. Until proven, show unsupported; these rows remain open parity work. |
| mise, source, unknown or foreign owner | Existing plan refuses them (`src/update/orchestrated-plan.ts:28`) | Keep the refusal and provide the owning tool's manual guidance. A desktop-owned bundle uses the native desktop owner, never a package-manager swap. |

The release record's `targets` entries must identify platform/architecture,
owner-compatible artifact kind, signed archive size/digest, signed tree digest
and supported link capability metadata. They are a closed list of what the
release actually produced, not inferred from the host version. Tests must prove
each advertised target has a matching signed artifact and that an unlisted
target cannot be selected.

Each signed release record also binds bounded, plain-text release-note items
to its exact version and channel. The panel may gather verified same-channel
records newer than the installed version through the selected candidate and
format them under the bounded grouping contract in `050`; an untrusted
release listing locates records but supplies no authenticated notes or count.
Missing history remains explicitly unknown and never changes artifact trust.

Client preparation verifies signed metadata and archive bytes, extracts as
data without lifecycle scripts, validates every inventory entry and rejects
unlisted entries, then binds the owned stage and installation identity to an
opaque prepared handle. At activation, reacquire the existing ownership and
sync/update guards, revalidate the handle and stage, and execute only the
verified absolute paths after the guarded stop. The client must not fetch a
replacement dependency or run a package lifecycle script after verifying a
different archive. Publisher-signed output authenticates the publisher's
artifact; it is not a claim that the build is reproducible from source.

The user requires signatures for automatic updates, stronger than GOAT's
documented HTTPS-plus-checksum runtime supply
(`docs/internals/remote-updates.md:163`, GOAT reference revision). A missing,
invalid, unknown-publisher or mismatched signature yields a visible refusal,
never a fallback to unsigned bytes. The package unit must migrate every
affected manual and automatic installation path to verified supply while
preserving the command's documented interface; compatibility with existing
installations does not waive the new signature requirement.

Channel parity is an open deliverable, not a UI-label substitution: current
release authority accepts `main`/`latest` and `preview`/`preview`
(`scripts/release.ts:499`, `.github/workflows/release.yml:1051`), while GOAT
publishes a distinct nightly feed. The final design must specify how a signed
nightly feed would be produced under the existing workflow trigger and
permission constraints, how preview and stable feeds are selected and
authenticated, and how a client behaves before a feed has actually been
published. This task may implement and test the release machinery but may not
publish a release. An unavailable feed remains an explicit outstanding item,
not proof of parity.

The research lane proposes separate signed stable, preview and nightly
manifests through the existing manual release workflow. The earlier idea of
stamping a version into a workflow checkout after CI is rejected: current
release publication requires successful push CI for the exact source commit
(`.github/workflows/release.yml:1077`) and all version sources to match that
commit (`scripts/ci/release-preflight.sh:59`). A transformed source tree has
not received that proof and this task cannot weaken the CI policy.

Concrete release-routing proposal for audit: keep the existing
`workflow_dispatch` event, `main`/`preview` ref guard and job permission sets.
On the `preview` ref, add `nightly` as an explicit distinct release channel
and npm dist-tag, with the existing `X.Y.Z-preview.YYYYMMDD[.N]` version shape
already committed in all four version sources. The channel comes from signed
metadata and the explicit release input, not the prerelease spelling; a
nightly publication must not move `latest` or `preview`. A maintainer prepares
the version through the repository's normal release-line process and waits for
the existing successful push CI on that exact preview commit before dispatch.
This preserves the documented preview branch version shape while giving the
nightly channel its own signed feed. No part of this task creates the release
commit or publishes a release.

The four sources are `package.json`, `desktop/src-tauri/tauri.conf.json`,
`desktop/src-tauri/Cargo.toml` and the `opencodex-desktop` entry in
`desktop/src-tauri/Cargo.lock` (`scripts/release-version-sources.ts:153`).
Keep the expected-SHA/trusted-dispatch gate and exact commit CI proof. In every
packaging and publishing job, checkout that SHA and verify the four sources
against the selected version before generating assets; no workflow-side version
stamp is allowed. A signed release record binds channel, version, source SHA,
the verification-receipt digest and each target artifact digest. The receipt
also records the release workflow run/attempt and the exact four source-file
digests; verification checks the source bytes against the checkout and receipt
before signing. Release-generated packaging output is separately identified and
verified, not represented as a tested source commit.

Update both early and final branch/tag/version gates, release argument parsing,
cross-channel global-floor checks, prerelease classification and resume logic
together (`scripts/release.ts:499`, `scripts/ci/release-preflight.sh:34`,
`.github/workflows/release.yml:1051`, `:1371`). The operator selects an unused
version that satisfies `version-line.ts`'s existing global tag floor and dev
pre-move checks; no assumption that `nightly` sorts after `preview` is made.
Resume is valid only for the same SHA, version, signed record and artifact
digests, with the existing publication-side identity checks intact. Fixture
tests must show nightly cannot move either existing dist-tag, that all sources
and the exact-SHA CI gate remain binding, and that changed or absent receipts
fail closed. npm trusted-publisher configuration and the initial signed feed
remain operational prerequisites; no feed is claimed live until separately
published by a maintainer.

Because nightly and preview share the `-preview.*` version spelling, a version
string cannot identify the channel. Every supported installed owner stores an
owner-private authenticated provenance record binding installation identity,
exact artifact digest, signed release-record digest and channel. The installer
writes it only after verification and preserves it across startup and recovery;
the new code verifies the release record and actual owner before trusting it.
For a legacy installation without a provenance record, a stable version can
bootstrap as `latest` only with matching authenticated evidence; an ambiguous
prerelease is `channel-unknown` until the owner explicitly selects a channel
and a verified release establishes provenance. Corrupt, missing or conflicting
records never fall back from nightly to preview. A channel switch is an explicit
policy change and invalidates prior candidate authority.

Update the complete channel field chain: Node launcher `bin/ocx.mjs:129`,
`src/update/index.ts:78`, `:229`, `src/update/refresh-scheduler.ts:58`,
`src/update/notify.ts`, `src/update/job.ts:226`,
`src/update/orchestrated-arguments.mjs`, `src/update/orchestrated-entry.ts`,
`src/update/desktop-badge.ts:87`, management routes in
`src/server/management/config-routes.ts:948`, and the browser owners named in
`050`. New three-channel check/apply requests use separately versioned routes
and schemas; preserve existing two-channel wire shapes. A new nightly owner
refuses legacy check/apply requests that would infer preview, returning an
actionable upgrade-client state. A new server receiving an old Desktop snapshot
without authenticated channel projects `unknown` rather than asserting preview.
Do not send a nightly artifact to an old updater that cannot preserve its
channel. Test first install, lost/corrupt policy, old/new clients and rollback,
and prove no inferred cross-channel installation occurs.

For discovery, the client may inspect the GitHub release listing as an
untrusted index to locate a channel-specific signed record at an exact release
tag. Only a verified `ocx.update.release/1` record selects a target and
version; listing order or a mutable dist-tag is never installation authority.
Each immutable release attaches its own signed channel metadata and matching
desktop feed, rather than requiring an existing published asset to be edited.
Missing, stale, malformed, unavailable or unverified metadata leaves the
channel unknown or unavailable. The first in-scope release infrastructure unit
must prove exact source-version and record-to-artifact binding with fixtures;
this routing is still a proposal until the independent security audit passes.

Proposed rollout for unattended package and fleet activation: stable waits 48
hours after a signed rollout-not-before value, then opens deterministically
across local buckets over 72 hours; preview and nightly open over 12 hours only
for an explicitly selected channel. The bucket is computed locally from a
random per-installation identifier and exact target version, is never sent as
telemetry, and is stable across retries. Missing or invalid signed time,
unsupported channel, a downgrade and the recorded failed target are ineligible.
Manual checks can show an ineligible release and explain its wait; explicit
manual installation still requires signature and owner checks. GOAT's own
stable/nightly rollout constants are documented at
`apps/server/src/cloud/autoUpdatePolicy.ts:79` in the reference revision; this
proposal deliberately defines preview as a separate opt-in OpenCodex channel.
The current desktop manifest's `pub_date` is generated before publication
(`desktop/scripts/updater-manifest.ts:69`); it is not authenticated actual
publication time. Persist per-channel the highest verified sequence, its exact
release digest and version, and the latest accepted wall time in private owner
state, with an atomic write before automatic effects. A lower sequence, or the
same sequence with a different digest, is refused; an equal sequence and digest
is a retry of the same candidate. Root revision has its own independent
high-water mark. Record first observation per exact candidate; unattended
eligibility uses the later of signed `rolloutNotBefore` and local first-seen,
plus the channel delay. If the clock is unreadable or earlier than the last
accepted time, retain the state and defer until corrected. Test rollback,
restart, same-sequence substitution and write failure. These local checks do
not establish a trusted wall clock against a deliberate forward jump; document
that limit and do not describe them as a publication timestamp proof.

## Candidate file map to resolve

| Operation | Path | Purpose and evidence |
| --- | --- | --- |
| MODIFY if needed | `.github/workflows/release.yml`, `desktop/scripts/verify-release-assets.ts`, `desktop/scripts/updater-manifest.ts` | Produce and verify the selected signed supply and channel-specific manifests from exact release inputs; preserve the existing verified-bundle handoff (`release.yml:859`) and no new triggers, broadened permissions or unpinned third-party actions. |
| NEW | `src/update/signed-supply.mjs`, `src/update/signed-tree.mjs`, `src/update/prepared-install.mjs` and declaration siblings | Resolve signed metadata, verify bounded exact bytes and complete tree inventory, and retain an owner-held prepared handle. Final APIs, root provisioning, archive extraction and every caller remain audit blockers. |
| NEW | `src/update/update-contracts.mjs`, `src/update/update-contracts.d.mts`, `tests/update/update-contracts.test.ts`, `tests/fixtures/update-contracts/` | Own the first implementation of closed root, release, tree, policy, prepared, activation and capability-descriptor parsers plus shared test vectors described in `003_contracts.md`. `010` lands these before `020` consumes them; downstream owners create records and enforce their own authority. Register the test in both test-layout maps. The comparator remains owned by `060`. Exact exports and byte encodings still require final audit. |
| NEW | `scripts/build-update-tree.ts`, `desktop/scripts/sign-update-supply.ts` | Produce final self-contained per-platform trees and sign the verified bundle in an existing authorized release job; no additional workflow triggers, permission expansion or unpinned third-party actions. Bind exact SHA, toolchain and lock inputs in the signed release record. |
| NEW | `scripts/generate-update-trust-root.ts`, `src/update/trust-root.json` and a generated native resource under `desktop/ui/` | Derive identical initial public trust-root bytes from the existing Tauri public key, with deterministic output and a `--check` mode. The source key is public; tests compare Node/Bun and native inputs byte-for-byte. Never embed private signing material. Persist subsequent verified root revisions under the respective installation's private update state, not in the replaceable package tree. |
| NEW | `tests/helpers/mock-update-server.ts` and isolated fixture builders | Serve only test-generated signed metadata and artifacts from an isolated real root on loopback, using a test key, never the real install or production key. Mirror GOAT's bounded-root and traversal/symlink tests (`scripts/mock-update-server.ts:37`, `:144`; `scripts/mock-update-server.test.ts:23`, GOAT reference revision) and add controllable truncation, wrong-signature, timeout and progress responses. Verify a new helper is actually imported by the focused tests. |
| MODIFY if needed | `src/update/orchestrated-plan.ts`, `src/update/orchestrated-entry.ts`, `bin/ocx.mjs` | Bind automatic plan/apply to exact verified artifact identity while retaining current runtime ownership and token checks (`orchestrated-plan.ts:21`). Avoid widening existing explicit commands by accident. |
| MODIFY | `tests/ci-workflows/release-desktop-scripts.test.ts`, `tests/ci-workflows/release-pipeline-contract.test.ts`, focused `tests/update/` | Failing-first signature, publisher identity, tampered bytes, missing metadata, target/channel mismatch, fail-closed and release receipt tests. Register new domain test files in both layout and expected-fixture maps. |
| MODIFY | Source owners named by `structure/INDEX.md`; public update and release docs and translated pages | Describe only shipped behavior and supported channels; do not advertise a feed without a proven publisher. |

The candidate file map is not the final implementation. Enumerate every
creation, serialization, parsing and consumer site for any new contract before
locking the plan. Design an isolated fixture with a dedicated test key or
test identity; never use production signing secrets. Prove that a verified
payload is the payload actually installed, not just a separately verified copy.

## Acceptance and verification to ground

- A correctly signed target with the expected identity and metadata succeeds in
  an isolated home. Wrong key or publisher, altered bytes, absent signature,
  wrong version/platform/channel, stale metadata and failed verification all
  stop before installation or runtime mutation.
- Desktop stable and preview/nightly choices correspond only to signed feeds
  the release workflow actually publishes. Unsupported choices are explicit;
  no downgrade or cross-channel move occurs implicitly.
- Release dry-run fixtures verify exactly the assets that would be attached;
  receipt version and commit bind the verified set. Tests prove no workflow
  trigger, permission or unpinned-action expansion.
- Run the targeted release-script and update tests, `bun run typecheck`,
  `bun run privacy:scan`, `bun run structure:check`, and exact-head CI with an
  independent security PASS. Confirm every command's actual inputs and record
  fresh results before locking or review readiness; no full root suite.
