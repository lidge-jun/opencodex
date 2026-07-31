# 20 — Phase 2: Diagnostic sink redaction

Purpose: route existing crash-guard, request-log, and usage-debug diagnostic
sinks through the shared redactor before any data is stored or returned through
the GUI/API.

Planned surfaces:

- `src/crash-guard.ts`
- `src/server.ts` request log helpers
- `src/usage-debug.ts`
- Existing tests near `tests/crash-guard.test.ts`, `tests/request-log.test.ts`,
  and `tests/usage-debug.test.ts`

Verification:

- Tests assert marker secrets never appear in diagnostic output.
- Existing request-log filtering still works.
- Typecheck.

## Diff-level plan

MODIFY `src/crash-guard.ts`

- Import `redactSecretString` and `redactUrlForLog` from `./redact`.
- Redact error messages, stacks, causes, codes, inspect output, promise render,
  and fetch rejection strings before formatting crash entries.
- Replace local `redactUrl()` with shared `redactUrlForLog()`.

MODIFY `src/usage-debug.ts`

- Import `redactSecretString` and `redactSecrets` from `./redact`.
- Make `truncateForDebug()` redact before truncation so truncated samples cannot
  preserve the beginning of a token.
- Make `appendUsageDebug()` sanitize the full record before JSONL write.

MODIFY `tests/crash-guard.test.ts`

- Add a regression test proving `formatCrashEntry()` does not include bearer
  tokens, refresh tokens, API keys, cookies, or Kiro/AWS profile ARNs from error
  message/stack/cause/code paths.
- Extend the recent-fetch test to prove query, credentials, and bearer-like
  invalid URL strings are redacted.

MODIFY `tests/usage-debug.test.ts`

- Add a test proving `truncateForDebug()` redacts before applying the byte cap.
- Add a test proving `appendUsageDebug()` writes redacted body samples and
  extracted usage metadata only.

MODIFY `devlog/_plan/145_common-security-hardening/20_phase2_diagnostic-sinks.md`

- Record build evidence and verification commands.

Out of scope:

- Do not change the shape of `RequestLogEntry` unless tests reveal an actual
  secret-bearing field.
- Do not alter Kiro adapter stream/retry behavior.

## Build record

Files changed:

- MODIFY `src/crash-guard.ts`: crash detail, stack, cause, code, inspect output,
  promise render, fetch rejection strings, and fetch URLs are now passed through
  shared redaction helpers before formatting.
- MODIFY `src/usage-debug.ts`: debug body samples are redacted before truncation,
  and the full debug record is redacted before JSONL append.
- MODIFY `tests/crash-guard.test.ts`: added secret-leak regression coverage for
  crash entry details and diagnostics.
- MODIFY `tests/usage-debug.test.ts`: added redaction-before-truncation and JSONL
  body sample redaction coverage.
- MODIFY `devlog/_plan/145_common-security-hardening/20_phase2_diagnostic-sinks.md`:
  this build/verification record.

Verification:

- `bun test tests/crash-guard.test.ts tests/usage-debug.test.ts tests/redact.test.ts`
  -> 29 pass, 0 fail.
- `bun test tests/request-log.test.ts` -> 8 pass, 0 fail.
- `bun x tsc --noEmit` -> exit 0, no diagnostics.
