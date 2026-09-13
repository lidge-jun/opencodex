# OpenCodex 2.46.0 release delivery

Outcome: DONE. Owner requested readiness inspection, main/preview promotion and deployment. Source frozen at 0d8b0cd1e3d10bc6b85bfefb3d68555f558407b0; previous stable v2.45.0. No additional product patches were made during release.

## Published artifacts

| Channel | Version | Exact SHA | Promotion |
| --- | --- | --- | --- |
| stable/latest | 2.46.0 | bba63222d3eeb5c8e397edae35798225e4fa1a6f | #3851 |
| preview | 2.46.0-preview.20260907 | 9ef2aaf3f02ace0778b05e2112d944db61c1a06d | #3852 |

Dev advanced to 2.47.0 through #3850 (6cf38b59). Both release branches contain the frozen source; main tree exactly matches it and preview differs only in package version. Login remains required by default; authless needs explicit opt-in.

## Verification

- Frozen full-platform CI 34079952328 passed all 26 jobs, including Windows 6 shards and macOS control. Local typecheck, privacy and 21,112 tests passed, 16 skipped, zero failures.
- Main pushCI 34081245213 and lifecycle 34081245230 passed on bba63222. Preview pushCI 34082147716 and lifecycle 34082147733 passed on 9ef2aaf3. Main docs deploy 34081245209 passed.
- Both release dry-runs passed: main 34081837842, preview 34082893066.
- Both registry artifacts contain 1,067 files. SHA512 integrity, npm registry cryptographic signatures, SLSA provenance subject/source matching, CLI --version/--help all passed. Provenance payload matching is recorded separately from registry signature verification; no independent Sigstore certificate-chain validation is claimed.
- npm latest=2.46.0 and preview=2.46.0-preview.20260907; immutable GitHub tags/releases match their npm gitHead. Final live verifier PASS recorded in .codexclaw/evidence/01a078cd-8133-7c33-b020-d5b17a9b3a04/test-receipt.json.
- All 25 initial dirty files retain their original SHA256. Shared checkout identity unchanged; no installed proxy/service/account changes.

## Recovery and limits

Preview PR CI 34080243039 attempt 1 macOS 2/2 stalled in unchanged client-connect tests and hit 20 minutes. Only unsuccessful jobs reran unchanged; attempt 2 passed. No stall root cause or timeout fix is claimed.

Publication runs 34083011934 (preview) and 34083607269 (stable) both completed npm publishing with signed provenance, but failed only the 5-minute post-publish registry smoke while npm processed the packages. Later registry evidence proved successful publication. Skipped GitHub releases were created at the exact published commits with the repository changelog builder. No package was republished and these workflow runs are not described as green.

Independent source and plan audits passed. The 20 delivered feature PRs had no unresolved review threads. Late promotion comments were explicitly dispositioned, not silently counted as fixed: legacy mixed-envelope streaming/JSON ordering remains under #3719; display-name unknown-receipt recovery is a reversible label-only P2 follow-up; Raycast unsupported-platform messaging, CLI text-test coverage, historical plan formatting and locale documentation are nonblocking follow-ups. Each rationale is recorded on #3851/#3852; final unresolved count 0. Release notes retain the functional limitations. No new release-blocking defect was established.

Evidence: .tmp/release-246/state.json, run-*.json, artifact-*/verification.json, initial-dirty.json, promotion-reviews.json, postmerge-review-dispositions.json, review-disposition-verification.json. The rollback baseline v2.45.0 remains published at b0900e556; no rollback was performed. No remaining work within the authorized release scope.
