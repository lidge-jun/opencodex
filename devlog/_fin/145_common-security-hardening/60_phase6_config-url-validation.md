# 60 — Phase 6: Config URL and header validation

Purpose: reduce SSRF and credential forwarding risk from provider configuration
while preserving legitimate local providers such as Ollama, LM Studio, and vLLM.

Planned surfaces:

- `src/config.ts`
- `src/server.ts` provider create/update validation path
- `src/oauth/key-providers.ts` only if provider validation is centralized there.
- Existing provider/config/server tests.

Checks:

- Reject unsupported protocols for provider base URLs.
- Keep local/private provider URLs allowed only where the product intentionally
  supports local model servers.
- Prevent user-defined sensitive headers from being reflected through management
  APIs or logs.

Verification:

- Focused config/provider API tests.
- Typecheck.

## Diff-level plan

MODIFY `src/config.ts`

- Centralize provider base URL validation as `providerBaseUrlConfigError()`:
  http/https only, no embedded credentials, no query strings, no fragments.
- Add `providerHeadersConfigError()`:
  - headers must be a plain object with valid HTTP token names.
  - values must be strings without CR/LF.
  - sensitive credential headers (`Authorization`, `Cookie`, `Set-Cookie`,
    `Proxy-Authorization`, `x-api-key`, `x-goog-api-key`,
    `x-amz-security-token`) are rejected; callers must use `apiKey`/`authMode`.
- Reuse the same validation in config-file schema refinement so unsafe manual
  config does not load silently.

MODIFY `src/server.ts`

- Reuse config-owned provider URL/header validation in `/api/providers` POST.
- Keep the existing built-in ChatGPT `authMode: "forward"` exception unchanged.

MODIFY tests

- `tests/server-auth.test.ts`: provider management rejects sensitive or
  injectable headers.
- `tests/config.test.ts`: config diagnostics/load reject unsafe provider URLs
  and sensitive/injectable headers.

Out of scope:

- Do not block `http://127.0.0.1`, `localhost`, or private-network provider
  URLs because local Ollama/LM Studio/vLLM are documented supported use cases.
- Do not add DNS/IP resolution or private-address SSRF blocking in this phase.

## Build record

Files changed:

- MODIFY `src/config.ts`: added shared provider base URL and header validation;
  config-file load now rejects unsafe provider URL/header shapes.
- MODIFY `src/server.ts`: `/api/providers` now uses the shared URL/header
  validation before persisting provider config.
- MODIFY `tests/server-auth.test.ts`: added API regression coverage for
  sensitive provider headers and CR/LF header injection.
- MODIFY `tests/config.test.ts`: added diagnostics/load coverage for unsafe
  URLs and sensitive/injectable headers.
- MODIFY `devlog/_plan/145_common-security-hardening/60_phase6_config-url-validation.md`:
  this build/verification record.

Verification:

- `bun test tests/config.test.ts tests/server-auth.test.ts` -> 56 pass, 0 fail.
- `bun x tsc --noEmit` -> exit 0, no diagnostics.
