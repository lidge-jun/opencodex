# 30 - Phase 3: Local API Auth And Safe DTOs

Status: implementation-ready plan.

## Objective

Stored credentials must not be usable by arbitrary network clients. Management and data-plane routes need real local authentication when the proxy is reachable beyond trusted loopback.

## Planned Changes

### MODIFY `src/types.ts`

Add config fields:

```ts
managementSecret?: string;
requireManagementAuth?: boolean;
```

Avoid storing generated secrets in tracked files. If auto-generated, store in the user config/home with `0600` permissions.

### MODIFY `src/config.ts`

Add helpers:

- generate/load local management secret;
- refuse non-loopback bind when no secret exists;
- expose only `hasManagementSecret` to GUI.

### MODIFY `src/server.ts`

Add `requireLocalAuth(req, scope)` middleware helper.

Default-deny rule:

- every `/api/*` route requires local auth by default;
- `/healthz` remains public because it has no credential-bearing data and is not under `/api/*`;
- any unauthenticated exception must be explicitly listed with rationale before implementation;
- `/v1/responses` requires local auth when stored pool credentials can be injected;
- WebSocket upgrade requires local auth whenever a stored pool binding can be selected.

Route matrix to cover:

| Surface | Methods | Rule |
| --- | --- | --- |
| `/api/config` | `GET`, disabled `PUT` | Require auth; return safe DTO only. |
| `/api/settings` | `GET`, `PUT` | Require auth. |
| `/api/sidecar-settings` | `GET`, `PUT` | Require auth. |
| `/api/logs` | `GET` | Require auth and redacted rows. |
| `/api/providers` | `GET`, `POST`, `DELETE` | Require auth. |
| `/api/models` | `GET` | Require auth if routed provider data may expose local config. |
| `/api/disabled-models` | `PUT` | Require auth. |
| `/api/subagent-models` | `GET`, `PUT` | Require auth. |
| `/api/oauth/providers`, `/api/oauth/login`, `/api/oauth/status`, `/api/oauth/logout` | listed methods | Require auth. |
| `/api/codex-auth/accounts`, `/api/codex-auth/active`, `/api/codex-auth/auto-switch`, `/api/codex-auth/failover`, `/api/codex-auth/quota`, `/api/codex-auth/login`, `/api/codex-auth/login/cancel`, `/api/codex-auth/login-status` | listed methods | Require auth. |
| `/api/stop` | `POST` | Require auth. |
| `/v1/responses` | `POST` | Parse and route first, then require auth before `resolveCodexAuthContext()` if route/provider can use stored pool credentials. |
| `/v1/responses` WebSocket upgrade | `GET` upgrade | Require auth before selecting/storing socket binding if a stored pool account can be selected. |

Add the chosen secret header to CORS allow headers. Missing `Origin` is not authentication.

Origin/Host checks remain defense-in-depth and cannot be the only gate.

### Safe Config DTO

Replace deep-copy config response with explicit DTO:

```ts
{
  port,
  hostname,
  providers: {
    [name]: {
      adapter,
      baseUrl,
      hasApiKey,
      hasHeaders,
      authMode,
      modelCount
    }
  },
  hasManagementSecret,
  ...
}
```

Never return:

- provider headers;
- token material;
- API key prefixes;
- raw cookies or authorization values.

### Safe Account DTO

`/api/codex-auth/accounts` must return a dedicated DTO, not raw stored account metadata.

Required DTO behavior:

- masked email/display identity by default;
- no raw email-like values in deployable/authenticated mode;
- no raw local alias if it identifies the user;
- no token material;
- no provider headers, key prefixes, cookies, or authorization values;
- quota fields include freshness/error state after Phase 50.

### GUI

Add request header support for local management secret if GUI needs it. Prefer same-origin bootstrapped local secret only when safe.

## Tests

Add/update:

- `tests/server-auth.test.ts`
- `tests/config-api.test.ts`
- `tests/ws-endpoint.test.ts`

Required cases:

- non-loopback bind without auth rejected;
- missing `Origin` is not sufficient;
- missing secret, bad secret, and correct secret cases for every route class in the matrix;
- unauthenticated `/api/*` rejected by default except explicitly documented exceptions;
- unauthenticated data-plane/WebSocket rejected when stored credentials may be used;
- `/api/config` redacts headers and key prefixes;
- `/api/codex-auth/accounts` masks account identity and returns no raw email-like values, local aliases, token material, provider headers, or key prefixes.

## Verification

```bash
bun test tests/server-auth.test.ts tests/config-api.test.ts tests/ws-endpoint.test.ts
bun run typecheck
cd gui && bun run build
```
