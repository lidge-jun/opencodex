# 30 - Phase 30 Plan: Local API Auth Gate And Safe DTOs

Date: 2026-06-24

Status: implemented and locally verified.

## Objective

Implement Patch 3 from `devlog/280_codex-multi-auth-security-patch-plan/00_patch_plan.md` in a bounded first slice:

- refuse externally reachable binding unless an explicit local API key is provided via environment;
- require that key on management routes and data-plane routes when auth is required;
- stop returning provider headers, API key prefixes, or unrestricted account emails from management DTOs;
- keep loopback-only default behavior working without adding a new GUI login flow in this slice.

This phase does not implement a full authenticated remote GUI UX. If a user chooses `hostname: "0.0.0.0"`, API clients must set `OPENCODEX_API_AUTH_TOKEN` before startup and send `x-opencodex-api-key`.

## Security Basis

- Origin/CSRF checks are browser defense in depth, not authentication.
- Data-plane requests can consume stored Codex pool credentials, so non-loopback exposure must require a server-side secret independent from upstream `Authorization`.
- The local API key must not use `Authorization` because `/v1/responses` may already carry upstream passthrough bearer credentials.

## Acceptance Criteria

- Default loopback binding (`undefined`, `127.0.0.1`, `localhost`, `::1`) continues to work without a local API key.
- Non-loopback binding (`0.0.0.0` or other externally reachable host) fails startup/config validation unless `OPENCODEX_API_AUTH_TOKEN` is present.
- When local API auth is required:
  - `/api/*` management routes require `x-opencodex-api-key`;
  - `/v1/responses` HTTP requires `x-opencodex-api-key`;
  - `/v1/responses` WebSocket upgrade requires `x-opencodex-api-key`;
  - missing `Origin` does not bypass auth.
- `/healthz` remains unauthenticated.
- The auth gate uses constant-time comparison for the configured token.
- The configured token is env-only and is never saved to config or returned by `/api/config`.
- `/api/config` returns an explicit safe DTO:
  - no provider `headers`;
  - no API key values or prefixes;
  - `hasApiKey` boolean only.
- `/api/codex-auth/accounts` returns masked email display by default for main and pool accounts.
- Existing GUI provider list continues to render using the safe config DTO.
- Tests cover loopback allowed, non-loopback refused without token, non-loopback authenticated/unauthenticated route behavior, safe config DTO redaction, and account email masking.

## File Plan

### `src/types.ts`

No code change. Phase 30 uses env-only `OPENCODEX_API_AUTH_TOKEN` to avoid persisting local API credentials into `~/.opencodex/config.json`.

### MODIFY `src/server.ts`

Add imports:

```ts
import { timingSafeEqual } from "node:crypto";
```

Add helpers near CORS/auth utilities:

```ts
function configuredApiAuthToken(config: OcxConfig): string | undefined;
function isLoopbackHostname(hostname: string | undefined): boolean;
function isApiAuthRequired(config: OcxConfig): boolean;
function hasValidApiAuth(req: Request, config: OcxConfig): boolean;
function requireApiAuth(req: Request, config: OcxConfig): Response | null;
function assertServerAuthConfig(config: OcxConfig): void;
function safeConfigDTO(config: OcxConfig): unknown;
```

Rules:

- `configuredApiAuthToken()` returns `process.env.OPENCODEX_API_AUTH_TOKEN?.trim()` only.
- `isLoopbackHostname()` accepts `undefined`, `""`, `localhost`, `127.0.0.1`, and `::1`.
- `isApiAuthRequired()` returns true only when host is non-loopback.
- `assertServerAuthConfig()` throws before `Bun.serve()` if host is non-loopback and no token exists.
- `hasValidApiAuth()` reads `x-opencodex-api-key`, rejects empty values, compares UTF-8 buffers using `timingSafeEqual`, and returns false for length mismatch.
- `requireApiAuth(req, config, kind)` returns `Response | null`; management calls pass `kind: "management"` and receive `jsonResponse({ error: "opencodex API key required" }, 401)`, while data-plane calls pass `kind: "data-plane"` and receive `formatErrorResponse(401, "authentication_error", "opencodex API key required")`.
- `corsHeaders()` must include `X-OpenCodex-API-Key` in `Access-Control-Allow-Headers`.

Apply gate:

- before `/v1/responses` WebSocket upgrade origin/auth handling:

```ts
const authError = requireApiAuth(req, config);
if (authError) return authError;
```

- before `handleManagementAPI()` for `/api/*`;
- before `/v1/responses` HTTP POST.
- Pin `/api/*` gate to the `fetch` handler immediately before `handleManagementAPI(req, url, config)` so direct internal calls to `handleManagementAPI()` in tests remain simple unless they intentionally test the helper.

Keep `/healthz`, GUI static files, and OPTIONS behavior unchanged.

Replace `/api/config` response with `safeConfigDTO(config)`:

```ts
{
  port,
  hostname,
  defaultProvider,
  codexAutoStart,
  websockets,
  providers: {
    [name]: {
      adapter,
      baseUrl,
      defaultModel,
      authMode,
      liveModels,
      models,
      hasApiKey,
      hasHeaders,
      contextWindow,
      modelContextWindows,
      reasoningEfforts,
      modelReasoningEfforts,
      noVisionModels,
      noReasoningModels,
      noTemperatureModels,
      noTopPModels,
      noPenaltyModels,
      autoToolChoiceOnlyModels,
      preserveReasoningContentModels,
      escapeBuiltinToolNames,
    }
  }
}
```

Never include provider `apiKey`, provider `headers`, or any env token.

Export the small helpers needed for tests:

```ts
export { assertServerAuthConfig, hasValidApiAuth, isApiAuthRequired, isLoopbackHostname, safeConfigDTO };
```

### MODIFY `src/codex-auth-api.ts`

Add:

```ts
function maskEmail(value: string | null | undefined): string | null;
```

Rules:

- no `@` => return value as-is;
- local part length 1 => `*@domain`;
- local part length 2 => first char + `*@domain`;
- local part length >= 3 => first char + `***` + last char + `@domain`;
- preserve `null`.

In GET `/api/codex-auth/accounts`:

- for main, use masked email in `email`;
- for pool accounts, return masked `email` and keep `hasCredential`, `quota`, `needsReauth`, `plan`;
- do not add a reveal endpoint in this phase.

This intentionally changes the UI display because the GUI already renders `email`.

### MODIFY `gui/src/pages/Providers.tsx`

Update the `Config` interface provider shape:

```ts
hasApiKey?: boolean;
hasHeaders?: boolean;
```

Render:

- `hasApiKey` via `t("prov.hasApiKey")`;
- `hasHeaders` via `t("prov.hasHeaders")`;
- do not read or display `apiKey`.

JSON edit remains visible but PUT `/api/config` is already disabled; the draft now contains safe DTO only.

### MODIFY `gui/src/i18n/en.ts`

Add:

```ts
"prov.hasApiKey": "api key configured",
"prov.hasHeaders": "custom headers configured",
```

### MODIFY `gui/src/i18n/ko.ts`

Add Korean equivalents for:

- `prov.hasApiKey`
- `prov.hasHeaders`

### MODIFY `gui/src/i18n/zh.ts`

Add Chinese equivalents for:

- `prov.hasApiKey`
- `prov.hasHeaders`

### MODIFY Tests

Add/modify backend tests:

- `tests/server-auth.test.ts` (new):
  - loopback host does not require auth;
  - non-loopback host requires matching `x-opencodex-api-key`;
  - non-loopback without token throws in `assertServerAuthConfig`;
  - non-loopback with env token passes;
  - wrong/missing token fails constant-time gate helper;
  - `safeConfigDTO()` omits `apiAuthToken`, provider `apiKey`, and provider `headers`, and exposes `hasApiKey`/`hasHeaders`.
  - CORS headers include `X-OpenCodex-API-Key`.
- existing server route tests are not required because route handling is currently not E2E-tested; helper tests plus full typecheck/full suite are the first slice.

Modify `tests/codex-auth-api.test.ts`:

- account list masks main and pool emails.
- existing tests expecting exact `example.test` emails should assert ids/flags/quota instead of full emails.

Modify GUI tests only if existing typecheck requires it.

### Explicit Deferrals

- `/api/oauth/status` still returns OAuth provider email in this phase; this remains Patch 6 privacy work because it is not the Codex multi-account pool boundary and needs a small GUI copy decision.

## Verification

Run:

```bash
bun test tests/server-auth.test.ts tests/codex-auth-api.test.ts
bun run typecheck
bun test tests
cd gui && bun run build
git diff --check
```

## Implementation Evidence

Changed source:

- `src/server.ts`
- `src/codex-auth-api.ts`
- `gui/src/pages/Providers.tsx`
- `gui/src/i18n/en.ts`
- `gui/src/i18n/ko.ts`
- `gui/src/i18n/zh.ts`

Changed tests:

- `tests/server-auth.test.ts`
- `tests/codex-auth-api.test.ts`

Implemented behavior:

- Non-loopback hostnames require env-only `OPENCODEX_API_AUTH_TOKEN` before `Bun.serve()`.
- When non-loopback auth is required, `x-opencodex-api-key` is validated with constant-time comparison.
- CORS allows `X-OpenCodex-API-Key`.
- `/api/*`, `/v1/responses` HTTP, and `/v1/responses` WebSocket have auth gates; loopback remains unchanged.
- `/api/config` now returns `safeConfigDTO()` with provider `hasApiKey`/`hasHeaders` booleans and no provider `apiKey` or `headers`.
- Codex Auth account list masks main/pool emails by default.
- Providers UI renders safe DTO booleans through i18n keys.

## Verification Results

Fresh local verification on 2026-06-24:

```bash
bun run typecheck
```

Result: `tsc --noEmit` passed.

```bash
bun test tests/server-auth.test.ts tests/codex-auth-api.test.ts
```

Result: 39 pass, 0 fail.

Full suite, GUI build, whitespace check, and independent build verification are still pending for this phase.

```bash
bun test tests
```

Result: 284 pass, 0 fail.

```bash
cd gui && bun run build
```

Result: production build passed.

```bash
git diff --check
```

Result: no whitespace errors.

Independent build verification is still pending for this phase.

## Independent Verification

Backend read-only verification result: DONE.

Evidence:

- `bun run typecheck`: exit 0.
- Focused verifier tests: 39 pass, 0 fail.
- Verified source paths:
  - `src/server.ts`
  - `src/codex-auth-api.ts`
  - `src/adapters/openai-responses.ts`
  - `gui/src/pages/Providers.tsx`
- Verified route gates:
  - `/api/*`
  - `/v1/responses` HTTP
  - `/v1/responses` WebSocket upgrade
- Verified DTO/privacy behavior:
  - `/api/config` safe DTO omits provider `apiKey` and `headers`;
  - `/api/codex-auth/accounts` masks main/pool emails;
  - Providers UI consumes `hasApiKey`/`hasHeaders` through i18n keys.

Residual risks accepted for this phase:

- Remote non-loopback GUI clients still need a client-side way to attach `x-opencodex-api-key`; this phase protects the server boundary but does not build remote GUI auth UX.
- `/v1/models` and `/healthz` remain unauthenticated by design.
- `/api/oauth/status` and transient login-state emails remain Patch 6 privacy work.
- Fetch-handler route gate coverage is by helper tests plus code inspection, not a live Bun.serve E2E route test.

## Deferred After This Phase

- Authenticated remote GUI token-entry UX.
- Browser E2E for remote/non-loopback deployment mode.
- Manual import disable/rework (Patch 4).
- Outcome classifier and quota freshness (Patch 5).

## Commit Boundary

One implementation commit for Phase 30 local API auth gate and safe DTOs. Do not mix in manual import identity changes or outcome classifier changes.
