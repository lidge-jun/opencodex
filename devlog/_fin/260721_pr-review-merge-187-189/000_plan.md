# 000 — PR Review & Merge #187 + #189

## Objective

Review and merge two external contributor PRs onto dev after adversarial sol review.

## PRs under review

### PR #187 — fix(storage): use immutable readonly opens for DB row counts
- Author: Chang-Jin-Lee | Base: dev
- MODIFY `src/storage/scanner.ts`: replace `new Database(path, { readonly: true })` with `new Database(fileURI + "?immutable=1", IMMUTABLE_READONLY_FLAGS)` using `pathToFileURL` for safe URI encoding. Adds `IMMUTABLE_READONLY_FLAGS = SQLITE_OPEN_READONLY | SQLITE_OPEN_URI`. Removes `PRAGMA busy_timeout`.
- MODIFY `tests/storage-scanner.test.ts`: make `buildFixtureHome` accept optional `home` param; add `PRAGMA journal_mode=WAL` + `PRAGMA wal_checkpoint(TRUNCATE)` to fixtures; add URI-reserved-char path test; change exclusive-lock test from "returns null" to "reads through without blocking."

### PR #189 — fix: preserve configured Alibaba Token Plan base URL
- Author: rsk-731 | Base: main
- MODIFY `src/providers/registry.ts`: add `allowBaseUrlOverride: true` to `alibaba-token-plan` entry (1 line).
- MODIFY `tests/provider-registry-parity.test.ts`: add `"alibaba-token-plan"` to the override allowlist assertion.
- MODIFY `tests/router-template-baseurl.test.ts`: add `alibaba-token-plan` to override test array; change test URLs from `.lan:3210` to `.example.test`.

## Loop-spec

- Loop archetype: verifier-defined (pass/fail review + CI gate)
- Write scope: no code changes — reviewing and merging external PRs
- Out of scope: PR #188 (OrcaRouter), PR #169, PR #150
- Budget: single PABCD cycle

## Work-phase map

Single cycle — no multi-phase needed. Both PRs are independent with zero cross-dependency.

## Accept criteria

1. Both PRs pass adversarial sol review (PASS or GO-WITH-FIXES, blockers resolved)
2. `tsc --noEmit` exit 0 with both PRs applied
3. `bun test` exit 0 on `tests/storage-scanner.test.ts`, `tests/provider-registry-parity.test.ts`, `tests/router-template-baseurl.test.ts`
4. Both PRs squash-merged to dev
