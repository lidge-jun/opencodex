# CL-10 Public Evidence Validation State

Validated implementation scope: CL-10.1 through CL-10.4 only. CL-10.5 remote publishing remains blocked by contract.

## Implemented

- Closed, independently versioned public evidence DTOs and runtime validators.
- Domain-separated public subject, record, bundle, artifact, publisher, and revocation identities.
- Repo-owned, versioned, content-addressed public route registry authority.
- Fail-closed protocol/route/task privacy projection. Private route dimensions are never dropped to broaden a public claim.
- Ed25519 publisher continuity with an installation-local restricted private key and public-only bundle identity.
- Deterministic signed local bundles and content-addressed local export storage.
- Same-publisher revocation with bounded targets and idempotent identical replay.
- Quarantined `community_untrusted_v1` import/cache with cryptographic validation followed by repository authority validation.
- Publisher-scoped community identity so identical content signed by different publishers can coexist and revoke independently.
- Sensitive `export` purge integration for generated exports and provably locally-originated community copies while preserving third-party evidence.
- Explicit local CLI/API preview, export, verify, import, and community-list surfaces.
- Compatibility Matrix read-only community context, labelled non-authoritative and kept separate from the canonical local verdict.

## Hard stops preserved

- No remote publish command or management endpoint.
- No arbitrary upload URL or remote transport implementation.
- No automatic telemetry or background public-evidence upload.
- No imported community write to `compatibility.jsonl` or `compatibility.sqlite`.
- No community evidence input to canonical local verdicts, routing, Router Intelligence, or CL-08.
- A valid signature yields `cryptographically_valid`, never `locally_verified`.

## Focused TDD evidence before closure run

- Public projection/registry/privacy tests: GREEN.
- Signing/local export tests: GREEN.
- Community/revocation/publisher-continuity tests: GREEN.
- Purge interaction tests: GREEN.
- Local CLI/API surface tests with network canaries: GREEN.
- Compatibility Matrix community parser/render/i18n tests: GREEN.
- Root TypeScript: GREEN on the implemented core/operator slices.
- GUI TypeScript and GUI lint: GREEN on the Matrix slice.

## Closure still required on exact final head

- Focused CL-10 tests including existing Lab purge regressions.
- Root TypeScript and privacy scan.
- Relevant Lab query/ledger/CLI/management tests.
- GUI targeted tests, lint, build, and React Doctor.
- Full Cross-platform CI.
- Final changed-file/static audit confirming the CL-10.5 remote-publish hard stop and zero feedback into routing/local verdict/CL-08.
