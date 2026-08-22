# CL-10 Public Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement CL-10.1 through CL-10.4: deterministic privacy-safe public evidence projection, signed local bundles, explicit local export, and quarantined community import/read surfaces, while keeping remote publishing blocked.

**Architecture:** Add a dedicated `src/lab/public/` boundary with independently versioned public types and strict validators. Public bundles are derived from valid local Lab evidence only after an exact exportability gate, signed with a local Ed25519 publisher key, and stored separately from the canonical ledger. Imported bundles are bounded, signature-checked, and stored only in a non-authoritative community domain that never feeds local verdicts, routing, or CL-08.

**Tech Stack:** TypeScript, Bun tests, Node `crypto` Ed25519, existing Lab JSONL/SQLite/query/digest/path infrastructure, existing `ocx lab` CLI and authenticated management API, existing Compatibility Matrix UI/i18n.

## Global Constraints

- No automatic telemetry or background publishing.
- No remote publishing implementation in this plan; CL-10.5 remains blocked until an exact reviewed service contract exists.
- No local subject/event/artifact/request/decision/Fabric identifier may appear in a public bundle.
- Private/custom route dimensions make evidence `not_exportable`; they are never dropped to broaden a public claim.
- Public schemas are closed and independently versioned; unknown fields fail closed.
- Public route identity uses a repo-reviewed, versioned allowlist authority. Dynamic discovery/configuration cannot extend it.
- Public incident references are closed corpus IDs only; historical URLs/devlog paths are never exported.
- Community evidence is `community_untrusted_v1`, never canonical local evidence, freshness, routing, or CL-08 input.
- Sensitive purge removes affected generated exports and locally-originated community copies; network revocation is never a prerequisite for completing a local purge.
- Publisher signatures prove integrity/continuity only, not evidence truth.

---

### Task 1: Freeze review amendments and implementation authority

**Files:**
- Modify: `devlog/_fin/260807_compatibility_lab/010_cl10_public_evidence_export.md`
- Modify: `docs/superpowers/specs/2026-08-12-cl10-public-evidence-design.md`

**Interfaces:**
- Consumes: CL-00 purge/public-export contracts and merged CL-09 state.
- Produces: final CL-10.1–CL-10.4 runtime contract; CL-10.5 remains explicitly blocked.

- [ ] **Step 1:** Add explicit purge/export/community-copy semantics consistent with CL-00 `purgeActions: export`.
- [ ] **Step 2:** Define `PublicRouteRegistryManifestV1` as the versioned local trust anchor for public provider/model identity.
- [ ] **Step 3:** Define bounded revocation bootstrap: target publisher key must match the original bundle publisher; duplicates are idempotent; conflicting replay fails closed; no V1 key rotation.
- [ ] **Step 4:** Replace arbitrary `incidentRefs` with closed `IC-NNN` references and require `artifactRefs` to resolve only to public artifact IDs in the same bundle.
- [ ] **Step 5:** Replace the route-only record assumption with a closed `PublicEvidenceSubjectV1` union for protocol/route/task evidence and require dedicated runtime validators/types.
- [ ] **Step 6:** Record that independent review accepted the contract and the user authorized CL-10.1–CL-10.4 runtime implementation on this PR; preserve the CL-10.5 transport hard stop.

### Task 2: Public schema, registry authority, and privacy projector

**Files:**
- Create: `src/lab/public/types.ts`
- Create: `src/lab/public/registry.ts`
- Create: `src/lab/public/validate.ts`
- Create: `src/lab/public/project.ts`
- Create: `src/lab/public/index.ts`
- Modify: `src/lab/index.ts`
- Test: `tests/lab-public-evidence.test.ts`

**Interfaces:**
- Produces: `PublicEvidenceBundleUnsignedV1`, `PublicEvidenceRecordV1`, `PublicEvidenceSubjectV1`, `PublicRouteRegistryManifestV1`, `projectPublicEvidence()`, `validatePublicEvidenceBundle()`.

- [ ] **Step 1: Write RED tests** for closed-schema rejection, deterministic public IDs/day buckets, protocol/route/task subject discrimination, exact route allowlist, private-route `not_exportable`, IC-only incident refs, no local ID leakage, and secret/PII canaries.
- [ ] **Step 2: Run focused test and verify expected RED failures.**
  Run: `bun test tests/lab-public-evidence.test.ts`
- [ ] **Step 3: Implement minimal closed public types/registry/validator/projector.**
  Public identities use domain-separated SHA-256 over JCS public-safe bytes. The registry manifest is repo-owned, versioned, digested, and cannot be supplied by an imported bundle as trust authority.
- [ ] **Step 4: Run focused test and verify GREEN.**

### Task 3: Bundle digest/signature and local storage

**Files:**
- Create: `src/lab/public/signature.ts`
- Create: `src/lab/public/storage.ts`
- Modify: `src/lab/paths.ts`
- Test: `tests/lab-public-evidence.test.ts`

**Interfaces:**
- Produces: `getOrCreatePublicPublisher()`, `signPublicEvidenceBundle()`, `verifyPublicEvidenceBundle()`, `writePublicEvidenceBundle()`, `readPublicEvidenceBundle()`.

- [ ] **Step 1: Write RED tests** for Ed25519 signing/verification, key-file permissions where enforceable, tamper rejection, deterministic bundle digest, bounded storage paths, and no private-key serialization.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement minimal key lifecycle, signing, verification, and safe local bundle storage.**
- [ ] **Step 4: Verify GREEN.**

### Task 4: Revocation and community quarantine

**Files:**
- Create: `src/lab/public/revocation.ts`
- Create: `src/lab/public/community.ts`
- Test: `tests/lab-public-evidence.test.ts`

**Interfaces:**
- Produces: `PublicEvidenceRevocationV1`, `verifyPublicEvidenceRevocation()`, `importCommunityBundle()`, `listCommunityBundles()`.

- [ ] **Step 1: Write RED tests** proving revocation accepts only the original bundle publisher key, duplicate identical revocations are idempotent, conflicting replay rejects, malformed/oversized bundles reject before persistence, and community import leaves canonical JSONL/SQLite verdict state unchanged.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement bounded revocation verification and separate community storage.**
- [ ] **Step 4: Verify GREEN.**

### Task 5: Sensitive purge integration

**Files:**
- Modify: `src/lab/ledger/purge.ts`
- Modify: `src/lab/paths.ts`
- Test: `tests/lab-public-evidence.test.ts`
- Test: `tests/lab-evidence-ledger.test.ts`

**Interfaces:**
- Consumes: existing `purgeSensitiveEvidence()` and `purgeActions: export`.
- Produces: fail-closed removal of generated exports and locally-originated community copies affected by local sensitive evidence.

- [ ] **Step 1: Write RED purge regression** showing an `export` purge removes CL-10 exports and local-origin community copies without requiring network access.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Extend purge-owned local directories/metadata minimally.**
- [ ] **Step 4: Run CL-10 and existing ledger purge tests.**

### Task 6: Explicit CLI and management surfaces

**Files:**
- Modify: `src/cli/lab.ts`
- Modify: `src/server/management/lab-routes.ts`
- Test: `tests/lab-public-evidence.test.ts`
- Test: relevant Lab CLI/management tests discovered in repository.

**Interfaces:**
- CLI: local preview/export, bundle verify, community import/list. No publish command.
- API: authenticated preview/export/verify/community endpoints only. No remote transport.

- [ ] **Step 1: Write RED CLI/API tests** for network-free preview, explicit export, verification, bounded community import, and absence of any publish endpoint/command.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement minimal surfaces using the public module APIs.**
- [ ] **Step 4: Verify focused CLI/API tests GREEN.**

### Task 7: Compatibility Matrix community context

**Files:**
- Modify: `gui/src/pages/compatibility-matrix-api.ts`
- Modify: `gui/src/pages/CompatibilityMatrix.tsx`
- Modify: locale catalog files under `gui/src/i18n/` as required by existing i18n rules.
- Test: existing Compatibility Lab GUI/i18n tests plus focused CL-10 additions.

**Interfaces:**
- Produces: clearly labelled, read-only community context separate from canonical local verdict UI.

- [ ] **Step 1: Write RED parser/render/i18n tests** proving community state is labelled non-authoritative and cannot replace the local verdict.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement the compact existing-detail-pane integration with no new product area.**
- [ ] **Step 4: Run GUI tests/lint/build GREEN.**

### Task 8: Closure validation

**Files:**
- Modify docs only if validation findings require factual updates.

- [ ] **Step 1:** Run `bun test tests/lab-public-evidence.test.ts tests/lab-evidence-ledger.test.ts`.
- [ ] **Step 2:** Run `bun x tsc --noEmit`.
- [ ] **Step 3:** Run `bun run privacy:scan`.
- [ ] **Step 4:** Run relevant Lab query/ledger/CLI/GUI tests.
- [ ] **Step 5:** Run GUI lint/build and React Doctor.
- [ ] **Step 6:** Run full Cross-platform CI on the exact final PR head.
- [ ] **Step 7:** Confirm no remote publishing code, arbitrary URL transport, routing feedback, local-verdict feedback, or CL-08 feedback was introduced.
