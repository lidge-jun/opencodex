# 40 — Phase 4: Usage privacy minimization

Purpose: ensure persistent usage accounting and debug summaries stay numeric and
coarse, without prompts, tool inputs, profile ARNs, raw upstream bodies, or
credential-derived identifiers.

Planned surfaces:

- `src/usage-log.ts`
- `src/usage-summary.ts`
- `src/usage-debug.ts`
- `tests/usage-log.test.ts`
- `tests/usage-summary.test.ts`
- `tests/usage-debug.test.ts`

Verification:

- Usage records use mode `0o600`.
- Stored records contain provider/model/status/counts but not prompt/tool text.
- Debug body samples are redacted and size-capped.
- Typecheck.

## Diff-level plan

MODIFY `src/usage-log.ts`

- Add an internal `normalizeUsageEntry(entry: PersistedUsageEntry): PersistedUsageEntry`.
- `appendUsageEntry()` writes only the normalized allowlisted fields:
  `requestId`, `timestamp`, `provider`, `model`, optional `resolvedModel`,
  `status`, `durationMs`, `usageStatus`, optional numeric `usage`, and optional
  `totalTokens`.
- Ignore any runtime extra keys such as `prompt`, `input`, `messages`,
  `headers`, `authorization`, `accessToken`, `refreshToken`, `profileArn`, or
  tool payloads even if a caller passes a widened object.

MODIFY `tests/usage-log.test.ts`

- Add a regression test that passes an object with secret-bearing extra keys via
  a widened cast and proves the persisted JSONL line omits them.
- Keep existing mode `0o600` and malformed-line tests.

MODIFY `devlog/_plan/145_common-security-hardening/40_phase4_usage-privacy.md`

- Record changed files, verification commands, and commit.

Out of scope:

- Do not change `/api/usage` response shape unless this phase reveals a leak.
- Do not change usage aggregation semantics.
- Do not change `usage-debug` again; diagnostic debug sink redaction was Phase 20.

## Build record

Files changed:

- MODIFY `src/usage-log.ts`: `appendUsageEntry()` now writes a normalized
  allowlisted `PersistedUsageEntry` so runtime extra fields cannot persist into
  `usage.jsonl`.
- MODIFY `tests/usage-log.test.ts`: added widened-object regression coverage for
  prompt/message/header/token/profile extra fields.
- MODIFY `devlog/_plan/145_common-security-hardening/40_phase4_usage-privacy.md`:
  this build/verification record.

Verification:

- `bun test tests/usage-log.test.ts tests/usage-summary.test.ts` -> 15 pass,
  0 fail.
- `bun x tsc --noEmit` -> exit 0, no diagnostics.
