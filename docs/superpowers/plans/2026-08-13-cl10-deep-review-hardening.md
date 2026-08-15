# CL-10 Deep Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all twelve adversarial findings from the post-CI CL-10 deep review, remove the catalog-timeout workaround, and make PR #1510 accurately describe the implemented CL-10.1 through CL-10.4 runtime scope.

**Architecture:** Keep the existing `src/lab/public/` trust boundary and wire schema, but make verification canonical instead of normalizing attacker input, make community import no more permissive than local export, make revocation application publisher-scoped, and use crash-safe immutable-file publication. Public API/CLI DTOs remain separate from local operator metadata, and purge gains a bounded public-origin index so provenance does not depend on recovering mutable local files.

**Tech Stack:** TypeScript, Bun tests, Node `crypto`/`fs`, existing Lab JCS/digest/path infrastructure, GitHub Actions.

## Global Constraints

- CL-10.5 remote publishing remains blocked and must not be implemented.
- No automatic telemetry, background publishing, arbitrary URL fetch, or community-to-local authority feedback.
- Keep `PublicEvidenceBundleV1` and revocation V1 domain strings frozen.
- New production behavior must be introduced test-first.
- Public bundle verification must reject non-canonical wire order rather than silently normalize it.
- Until a reviewed `public_export` artifact authority exists, both local and community V1 paths reject non-empty public artifacts.
- Publisher-key creation must not occur for invalid signing or revocation requests.
- Public management/CLI JSON must not disclose local filesystem paths or local Lab event IDs.
- Sensitive purge must remove locally-originated community copies even if the export or publisher key is damaged or missing.
- Exact-head GitHub Actions success is required before completion; do not merge.

---

### Task 1: Add adversarial RED coverage

**Files:**
- Create: `tests/lab-public-deep-review-regressions.test.ts`
- Modify: `tests/ci-workflows.test.ts`

**Interfaces:**
- Consumes: current CL-10 public module APIs.
- Produces: failing tests for canonical array order, artifact quarantine, publisher-scoped record revocation, invalid-input key non-creation, JCS Unicode validity, exact assertion authority, cache quota, public DTO redaction, purge origin recovery, bounded duplicate-key diagnostics, IPv6 privacy rejection, and test-local catalog timeout behavior.

- [ ] **Step 1:** Add one focused regression per finding using real public module behavior and deterministic test-only publisher keys where signatures are required.
- [ ] **Step 2:** Add a CI-policy regression that requires the catalog hardening test to own its timeout and forbids a catalog-specific timeout branch in the Linux batch runner.
- [ ] **Step 3:** Push tests only and verify the exact test-only head is red for the intended missing behavior.

### Task 2: Canonical wire verification and JCS correctness

**Files:**
- Modify: `src/lab/conformance/jcs.ts`
- Modify: `src/lab/public/bundle.ts`
- Modify: `src/lab/public/signature.ts`

**Interfaces:**
- Produces: strict RFC-8785-compatible Unicode rejection and `verifyPublicEvidenceBundle()` rejection of non-canonical top-level record/artifact order.

- [ ] **Step 1:** Reject lone UTF-16 surrogates in JCS strings and object keys.
- [ ] **Step 2:** Normalize bundle content once for local construction, but compare received record/artifact ordering against that normalized representation during verification.
- [ ] **Step 3:** Run the focused wire regressions green.

### Task 3: Align community artifact/privacy authority

**Files:**
- Modify: `src/lab/public/community.ts`

**Interfaces:**
- Consumes: `validatePublicEvidencePrivacy()` and the current V1 artifact hard stop.
- Produces: community imports that reject all non-empty artifacts until reviewed authority exists and run the same second-pass privacy validator before persistence.

- [ ] **Step 1:** Add a community-import gate before persistence.
- [ ] **Step 2:** Verify signed artifact-bearing external bundles are rejected and artifact-empty valid bundles still import.

### Task 4: Make record revocation publisher-scoped

**Files:**
- Modify: `src/lab/public/community.ts`
- Modify: `src/lab/public/revocation.ts` only if helper semantics need to be exposed.

**Interfaces:**
- Produces: deterministic verification of record-only revocations against any matching verified bundle for the publisher and application to every matching record in that publisher's imported bundles.

- [ ] **Step 1:** Resolve record-only revocation authority against a deterministic matching verified bundle instead of requiring exactly one bundle.
- [ ] **Step 2:** During listing, apply each verified revocation by publisher plus bundle/record target membership rather than binding it permanently to one bundle.
- [ ] **Step 3:** Verify a later bundle containing the same record remains revoked.

### Task 5: Crash-safe immutable persistence and key lifecycle

**Files:**
- Create: `src/lab/public/private-file.ts`
- Modify: `src/lab/public/signature.ts`
- Modify: `src/lab/public/storage.ts`
- Modify: `src/lab/public/community.ts`

**Interfaces:**
- Produces: temp-file + file fsync + exclusive hard-link publication for immutable secret/public objects, deterministic EEXIST conflict handling, POSIX parent-directory durability before success is reported, an explicit Windows fallback where directory fsync is not portable, and test-only publication fault seams.

- [ ] **Step 1:** Implement a small shared helper that writes a mode-0600 private temp file, fsyncs it, publishes it by exclusive hard link, fsyncs the parent directory on POSIX, and removes the temp name only after the publication durability boundary succeeds. On Windows, retain atomic exclusive publication without requiring unsupported directory fsync.
- [ ] **Step 2:** Migrate publisher-key creation, local exports, and community bundle/revocation persistence to the helper.
- [ ] **Step 3:** Verify an injected pre-publish failure leaves no final partial file, a POSIX parent-directory-sync failure is reported and can be recovered by an idempotent retry, and Windows publication does not depend on directory fsync.

### Task 6: Validate before publisher-state mutation

**Files:**
- Modify: `src/lab/public/bundle.ts`
- Modify: `src/lab/public/signature.ts`
- Modify: `src/lab/public/revocation.ts`

**Interfaces:**
- Produces: a publisher-independent content-normalization function used before key access; revocation creation requires an existing matching local publisher key.

- [ ] **Step 1:** Split public bundle content validation/normalization from publisher attachment.
- [ ] **Step 2:** Run closed-schema/day/record/authority/privacy validation before `getOrCreatePublicPublisher()`.
- [ ] **Step 3:** Add an existing-publisher loader and use it for revocation creation so foreign/invalid revocation attempts cannot create identity state.

### Task 7: Exact assertion authority

**Files:**
- Modify: `src/lab/public/community-authority.ts`

**Interfaces:**
- Produces: exact one-to-one assertion-ID/required-flag coverage of the reviewed scenario authority.

- [ ] **Step 1:** Reject duplicate assertion IDs.
- [ ] **Step 2:** Reject missing reviewed assertions as well as unknown ones.
- [ ] **Step 3:** Keep passed/failed values publisher-supplied evidence while freezing only identity/required authority.

### Task 8: Bound community cache writes and read cost

**Files:**
- Modify: `src/lab/public/community.ts`

**Interfaces:**
- Produces: pre-create limits of 512 cache files and 64 MiB aggregate serialized bytes, with idempotent existing objects still readable/importable at the limit.

- [ ] **Step 1:** Measure only descriptor-bound regular files without following symlinks.
- [ ] **Step 2:** Enforce count and aggregate-byte capacity before creating a new object.
- [ ] **Step 3:** Enforce the same bounds when listing so corrupted/external directory growth fails closed before bulk materialization.

### Task 9: Separate public DTOs from local operator metadata

**Files:**
- Modify: `src/lab/public/operator.ts`
- Modify: `src/cli/lab.ts`
- Modify: `src/server/management/lab-routes.ts`
- Modify: `tests/lab-public-surfaces.test.ts`

**Interfaces:**
- Produces: preview/export results that expose exclusion indices/reasons and `stored.created` only, never local event IDs or filesystem paths.

- [ ] **Step 1:** Replace public exclusion `eventId` with bounded `selectionIndex`.
- [ ] **Step 2:** Discard storage paths from public operator return values and CLI/API JSON.
- [ ] **Step 3:** Keep human CLI output useful without printing local absolute paths.

### Task 10: Persist public-origin provenance for purge

**Files:**
- Modify: `src/lab/paths.ts`
- Create: `src/lab/public/origin.ts`
- Modify: `src/lab/public/operator.ts`
- Modify: `src/lab/public/purge.ts`

**Interfaces:**
- Produces: bounded immutable `public-origin-v1` markers containing only public publisherKeyId/bundleId identities. The origin marker is durably committed before a new local export file is published, so export success can never be reported without purge-owned provenance; an orphan marker after a later export failure is conservative and safe. Under retention pressure, markers without an exact community bundle copy may be reclaimed because no community object remains for that provenance marker to classify; markers backing retained community bundles are preserved.

- [ ] **Step 1:** Commit the public origin identity before publishing the local export file; if export publication later fails, preserve the orphan marker so retry/purge can recover conservatively.
- [ ] **Step 2:** Make purge union origin markers with legacy recoverable export/key provenance.
- [ ] **Step 3:** Delete origin markers only after locally-originated community copies are removed, except bounded retention reclamation of markers with no exact community bundle copy.
- [ ] **Step 4:** Verify purge still succeeds if the export and publisher key are corrupted/missing.

### Task 11: Harden diagnostics and privacy scanner

**Files:**
- Modify: `src/lab/public/strict-json.ts`
- Modify: `src/lab/public/privacy.ts`

**Interfaces:**
- Produces: constant-size duplicate-key errors and detection of unbracketed IPv6 literals in semantic public strings.

- [ ] **Step 1:** Stop reflecting attacker-controlled duplicate key names in errors.
- [ ] **Step 2:** Add bounded IPv6-literal recognition without rejecting ordinary colon-bearing public identifiers such as versioned names.

### Task 12: Move catalog timeout to the flaky test only

**Files:**
- Modify: `tests/codex-catalog-sync-hardening.test.ts`
- Modify: `scripts/ci/run-bun-test-batches.sh`

**Interfaces:**
- Produces: one 15-second Bun test timeout on the known degraded-provider case; all neighboring batch tests remain on the default timeout on Linux and macOS uses the same test-local timeout.

- [ ] **Step 1:** Add `15_000` only to the degraded-provider test definition.
- [ ] **Step 2:** Remove catalog-specific timeout detection/variables from the batch runner.
- [ ] **Step 3:** Run CI-policy regression green.

### Task 13: Exact-head closure and PR metadata

**Files:**
- Modify PR #1510 title/body only after runtime verification.

**Interfaces:**
- Produces: accurate ready-for-review description of CL-10.1 through CL-10.4 with CL-10.5 explicitly blocked.

- [ ] **Step 1:** Run focused tests, typecheck/privacy/GUI gates via GitHub Actions on the exact final head.
- [ ] **Step 2:** Confirm Cross-platform CI and React Doctor are green on that exact head.
- [ ] **Step 3:** Update PR title to describe the runtime implementation rather than contract-only scope.
- [ ] **Step 4:** Replace the stale body with implemented scope, trust/privacy invariants, validation evidence, and the CL-10.5 hard stop.
- [ ] **Step 5:** Confirm PR remains open, unmerged, and ready for review.
