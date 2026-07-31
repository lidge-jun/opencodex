# Cycle 090 — modelMaxInputTokens Validation and Ownership

## Objective

Add `positiveIntegerRecordConfigError` to `src/config.ts` and apply it on both
disk-load (zod schema) and management admission (`providerManagementConfigError`).
Only plain own-property records of positive finite integers pass. Route merging uses
`mergePositiveNumberCaps` so user values can only lower registry baselines for the
API provider; other providers use normal fill semantics.

## Scope

- `positiveIntegerRecordConfigError(value, field)` exported from config.ts
- Disk config schema rejects inherited, null, array, zero, negative, fractional, string, Infinity
- Management API rejects same + returns 400 with field path
- `src/router.ts` `mergePositiveNumberCaps` for API tier; `mergeRecordFill` for others
- `modelMaxInputTokens` on `OcxProviderConfig` in `src/types.ts`
- Management admission accepts validated max-input maps, disk persists them, and
  routing consumes them, but `safeConfigDTO` and `/api/config` omit them
- `src/server/auth-cors.ts` FORBIDDEN_PROVIDER_RUNTIME_FIELDS excludes max-input

## Activation tests

- `tests/config.test.ts` "modelMaxInputTokens accepts only plain positive finite integer records"
- `tests/config.test.ts` "disk config rejects malformed modelMaxInputTokens"
- `tests/config.test.ts` "disk config rejects forged registry-only virtual model maps"
- `tests/server-auth.test.ts` management accepts valid map, rejects invalid variants
- `tests/provider-registry-parity.test.ts` route max-input metadata trusted, user only lowers

## Evidence

- See the Cycle A closure evidence below for the corrected ownership wording and
  disk/management/DTO activation proof; consolidated/final receipts are indexed by 190 and 050.

## Status

`done — closed by the Cycle A closure evidence below; see 190 + 050 evidence`

## Cycle A closure evidence (2026-07-17)

- The ownership wording now matches the landed Cycle-040 security contract:
  max-input maps are admitted, validated, persisted, and consumed internally, while
  `safeConfigDTO` and `/api/config` redact them.
- The Cycle A matrix, including `tests/config.test.ts` and `tests/server-auth.test.ts`,
  passed 266 tests with 0 failures and 1,492 assertions, covering disk/management
  rejection, valid persistence, and DTO redaction.
