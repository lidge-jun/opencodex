# 10 — Phase 1: Secret redaction foundation

Purpose: introduce or consolidate a shared redaction policy that can be reused by
request logs, crash diagnostics, usage debug records, OAuth/import diagnostics,
and server error surfaces.

Planned surfaces:

- `src/redact.ts` or existing nearest owner if one already exists.
- Tests proving redaction of:
  - `Authorization: Bearer ...`
  - `apiKey`, `accessToken`, `refreshToken`
  - cookies and `Set-Cookie`
  - Kiro `profileArn`
  - bearer-like strings embedded in nested objects and strings

Non-goals:

- Do not change Kiro adapter parity behavior.
- Do not change provider routing.

Verification:

- Focused redaction unit tests.
- Typecheck.

## Diff-level plan

NEW `src/redact.ts`

- Export `REDACTED_SECRET = "[REDACTED]"`.
- Export `redactSecretString(value: string): string`.
  - Redact bearer-like strings: `Bearer <token>`, `sk-...`, `api_key=...`,
    `access_token=...`, `refresh_token=...`, `refreshToken=...`.
  - Redact Kiro/AWS profile ARNs as a stable sensitive identifier class.
  - Preserve non-secret text so diagnostics stay useful.
- Export `redactSecrets(value: unknown): unknown`.
  - Recursively redact arrays and plain objects.
  - Redact values whose keys are sensitive (`authorization`, `cookie`,
    `set-cookie`, `apiKey`, `accessToken`, `refreshToken`, `token`,
    `profileArn`, `x-api-key`, `x-goog-api-key`, `x-amz-security-token`).
  - Redact string values by pattern even when the key is not sensitive.
  - Leave numbers, booleans, null, undefined, and Dates safe.
- Export `redactHeaders(headers: Headers | Record<string, string | string[] | undefined>): Record<string, string>`.
  - Normalize header keys to lower-case in the returned diagnostic object.
  - Mask sensitive headers by key.
  - Pattern-redact non-sensitive header values.
- Export `redactUrlForLog(url: string): string`.
  - Remove credentials and query/hash values.
  - Pattern-redact invalid URL strings best-effort.

NEW `tests/redact.test.ts`

- Verify `redactSecretString` masks bearer/API/access/refresh/profile values.
- Verify recursive `redactSecrets` masks nested objects and arrays without
  mutating primitive non-secrets.
- Verify `redactHeaders` masks `authorization`, `cookie`, `set-cookie`,
  `x-api-key`, and preserves safe metadata like `content-type`.
- Verify `redactUrlForLog` strips credentials/query/hash and keeps
  `protocol//host/path`.

MODIFY `devlog/_plan/145_common-security-hardening/10_phase1_redaction-foundation.md`

- Record the exact changed files, verification command, and commit after build.

Out of scope for Phase 10:

- Do not wire the redactor into `src/crash-guard.ts`, `src/server.ts`, or
  `src/usage-debug.ts` yet. Those are Phase 20 sink changes.
- Do not modify Kiro adapter request/stream semantics.

## Build record

Files changed:

- NEW `src/redact.ts`: shared redaction helpers for strings, nested objects,
  headers, and URLs.
- NEW `tests/redact.test.ts`: focused regression coverage for bearer/API token,
  access/refresh token, cookie/header, Kiro/AWS profile ARN, nested object, and
  URL redaction.
- MODIFY `devlog/_plan/145_common-security-hardening/10_phase1_redaction-foundation.md`:
  this build/verification record.

Verification:

- `bun test tests/redact.test.ts` -> 8 pass, 0 fail.
- `bun x tsc --noEmit` -> exit 0, no diagnostics.
