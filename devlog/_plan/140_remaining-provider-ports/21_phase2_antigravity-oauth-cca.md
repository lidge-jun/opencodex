# 140.21 — Phase 2b: google-antigravity OAuth + projectId + CCA envelope (hardened wire)

> Builds the Antigravity (Cloud Code Assist) wire on top of the Phase 10/20 `googleMode` hook, and
> bakes in the same HTTP hardening as Vertex (Phase 11) from day one. Copy-paste-ready.
> External SOT cross-check = `router-for-me/CLIProxyAPI` (`internal/auth/antigravity/*`,
> `internal/runtime/executor/antigravity_executor.go`, `internal/translator/antigravity/gemini/*`).
> See `05_reference-repos.md`. The reasoning-replay quirk is split into `22_…`.

---

## Corrections to the existing 20_ plan (from CLIProxyAPI cross-check)

The original `20_phase2_google-antigravity.md` was grounded in jawcode. The CLIProxyAPI audit
surfaces details to pin precisely:

1. **Default streaming host is `daily-cloudcode-pa.googleapis.com`**, with `cloudcode-pa.googleapis.com`
   as the prod fallback. `loadCodeAssist` uses the **prod** host; `onboardUser` uses the **daily**
   host. Make the base configurable, daily-first, prod as fallback.
2. The envelope field **`userAgent` is the literal string `"antigravity"`** — a body field, NOT the
   HTTP `User-Agent` header (those are separate).
3. `request.safetySettings` is attached then **deleted** before send — net: send none.
4. **`anthropic-beta: interleaved-thinking-…` is NOT part of the CCA wire.** Do not add it (the
   original 20_ plan mentioned it; drop that). Claude-on-Antigravity thinking is handled in-body via
   signature sanitization (Phase 22), not a header.
5. Response chunks nest under **`response.candidates`** (confirmed); our parser must unwrap `response`.
6. `requestType` defaults to `"agent"`; `requestId` = `"agent-" + uuid`.

## Constants (paste-ready, from CLIProxyAPI `internal/auth/antigravity/constants.go`)

```
ClientID         1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com
ClientSecret     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
CallbackPort     51121
TokenEndpoint    https://oauth2.googleapis.com/token
AuthEndpoint     https://accounts.google.com/o/oauth2/v2/auth
APIEndpoint      https://cloudcode-pa.googleapis.com          (prod; loadCodeAssist)
DailyAPIEndpoint https://daily-cloudcode-pa.googleapis.com    (default stream + onboardUser)
APIVersion       v1internal
Scopes           cloud-platform, userinfo.email, userinfo.profile, cclog, experimentsandconfigs
```

> The client_id/secret above are public OAuth client identifiers embedded in the Antigravity
> desktop client (not user secrets); they are how CLIProxyAPI authenticates the OAuth flow. Treat
> them as config defaults overridable by env (`GOOGLE_ANTIGRAVITY_CLIENT_ID/SECRET`).

---

## Part 1 — Plain explanation

Antigravity is Google's Cloud Code Assist endpoint. To use it we log in with Google OAuth, discover
the user's cloud project (auto-onboarding if needed), then wrap each Gemini request in a small
"envelope" with the project id and a request id before streaming. We build it with the same retry,
timeout, and error-classification armor Vertex got, so it's production-grade from the start.

## Part 2 — Diff-level plan

### A) Config + registry

`src/types.ts` — extend the `google` mode union:

```ts
  googleMode?: "ai-studio" | "vertex" | "cloud-code-assist";
```

`src/providers/registry.ts` — add the provider entry (adapter stays `google`, no new `resolveAdapter` case):

```ts
  { id: "google-antigravity", label: "Google Antigravity", adapter: "google",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com", authKind: "oauth",
    oauthId: "antigravity",                       // OAUTH_PROVIDERS key (derive.ts: oauthId ?? id)
    dashboardUrl: "https://antigravity.google", defaultModel: "gemini-3-pro",
    googleMode: "cloud-code-assist", jawcodeBundle: "google",
    extraMetadataAliases: ["antigravity", "gemini-antigravity"] },
```

> `oauthId` matters: every other `authKind:"oauth"` registry entry sets it, and `derive.ts:147`
> resolves the `OAUTH_PROVIDERS` registration key as `entry.oauthId ?? entry.id`. With
> `oauthId:"antigravity"` the OAuth provider in `src/oauth/index.ts` must be registered under the key
> `"antigravity"`. (Omit `oauthId` only if you instead key `OAUTH_PROVIDERS` by `"google-antigravity"`.)

### B) OAuth provider — NEW `src/oauth/google-antigravity.ts`

Register in `OAUTH_PROVIDERS` (`src/oauth/index.ts`) under key `"antigravity"` (matching `oauthId`
above). Implements login + refresh + project discovery. **`OAuthCredentials` (`src/oauth/types.ts`)
gains an optional `projectId?: string`** — note this is the OAuth credential type, NOT
`OcxProviderConfig` (which already uses `project`/`location` for Vertex and needs no change here).
The server injects only the bare access token into `apiKey`, so the adapter reads `projectId` from
the stored credential — same audit fix the 20_ plan noted. `OcxProviderConfig`'s allowed-key union
(`types.ts:58`) does NOT need editing for this (no new `OcxProviderConfig` field).

Project discovery (mirror CLIProxyAPI `FetchProjectID` / `OnboardUser`):

```ts
// 1. POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
//    body: { metadata: { ideType: "ANTIGRAVITY" } }
//    extract project from cloudaicompanionProject | projectId | project(.id)
// 2. if no project → onboarding loop on the DAILY host:
//    POST https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser
//    body: { tier_id: <default tier>, metadata: { ide_type:"ANTIGRAVITY", ide_name:"antigravity", ide_version:<ua> } }
//    poll up to 5 attempts, 2s sleep between, each attempt 30s timeout,
//    until 200 && done===true → response.cloudaicompanionProject
```

Refresh (mirror CLIProxyAPI `refreshTokenSingleFlight`), hardened like Cursor/Vertex token refresh:

```ts
// POST https://oauth2.googleapis.com/token
//   form: client_id, client_secret, grant_type=refresh_token, refresh_token
// proactive refresh when expiry < now + 50min skew
// single-flight per refresh token (coalesce concurrent refreshes)
// per-attempt 15s timeout + bounded retry (3x) on 429/5xx/network; honor Retry-After
// NEVER log token/refresh/secret
```

### C) Adapter — extend the `googleMode` branch in `src/adapters/google.ts`

Add a `cloud-code-assist` arm next to `vertex`. It builds the daily-host CCA URL, wraps the flat
Gemini body in the envelope, sets the whitelist headers, and resolves the project from the stored
credential.

```ts
if (provider.googleMode === "cloud-code-assist") {
  const base = provider.baseUrl || "https://daily-cloudcode-pa.googleapis.com";
  const method = parsed.stream ? "streamGenerateContent" : "generateContent";
  const streamParam = parsed.stream ? "?alt=sse" : "";
  const url = `${base}/v1internal:${method}${streamParam}`;

  const project = resolveAntigravityProjectId(provider); // from credential.projectId
  if (!project) throw new Error("Antigravity requires a discovered Google Cloud project id (re-run login).");

  const envelope = {
    model: parsed.modelId,
    userAgent: "antigravity",                 // literal body field
    requestType: "agent",
    project,
    requestId: `agent-${crypto.randomUUID()}`,
    request: {
      ...body,                                  // the flat Gemini body (contents/tools/generationConfig…)
      sessionId: stableAntigravitySessionId(parsed), // sha256(first user text) → masked int, "-" prefix
    },
  };
  // body.systemInstruction already correct; ensure request.model is NOT present; send NO safetySettings.
  delete (envelope.request as Record<string, unknown>).model;
  delete (envelope.request as Record<string, unknown>).safetySettings;

  const token = provider.apiKey; // server injects the OAuth access token here
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": ANTIGRAVITY_REQUEST_UA,
    Authorization: `Bearer ${token}`,
  };
  return { url, method: "POST", headers, body: JSON.stringify(envelope) };
}
```

Helpers (small, in `google.ts` or a new `src/adapters/google-antigravity-wire.ts`):
- `stableAntigravitySessionId(parsed)`: sha256 of first user message text → BigEndian uint64 masked
  `0x7FFFFFFFFFFFFFFF`, prefixed `-`; fallback random `-<19 digits>`.
- `resolveAntigravityProjectId(provider)`: reads the stored credential's `projectId`.
- `ANTIGRAVITY_REQUEST_UA`: the Antigravity client UA string (config-overridable).

### D) parseStream — unwrap `response`

Antigravity chunks are `{"response":{"candidates":[…],"usageMetadata":…},"traceId":…}`. The existing
google `parseStream` reads top-level `chunk.candidates`. Add a mode-aware unwrap so CCA reads
`chunk.response.candidates` (and `chunk.response.usageMetadata`). Keep AI-Studio/Vertex on the
top-level path.

```ts
const root = provider.googleMode === "cloud-code-assist"
  ? (chunk.response as Record<string, unknown> | undefined) ?? chunk
  : chunk;
const candidates = root.candidates as …;
const usageMeta = root.usageMetadata as …;
```

### E) HTTP hardening — reuse Vertex's wrapper

`fetchResponse` for `cloud-code-assist` routes through `fetchVertexWithRetry` (Phase 11) — same
retry/timeout/backoff. Error classification reuses `safeVertexHttpErrorMessage`; Antigravity's 429
RESOURCE_EXHAUSTED + `ErrorInfo.reason` (QUOTA_EXHAUSTED vs RATE_LIMIT_EXCEEDED) maps onto the same
"quota exhausted" vs "rate limit" split. Generalize the prefix from "Vertex AI" to a provider-aware
label, or add a thin `safeAntigravityHttpErrorMessage` that delegates with an `"Antigravity"` prefix.

```ts
    fetchResponse: (provider.googleMode === "vertex" || provider.googleMode === "cloud-code-assist")
      ? (request, ctx) => fetchVertexWithRetry(request, ctx)
      : undefined,
```

## Tests

- `tests/google-antigravity-wire.test.ts`: envelope shape (project/userAgent/requestType/requestId/
  request.sessionId; no `request.model`, no `safetySettings`); daily-host stream URL `?alt=sse`;
  parseStream unwraps `response.candidates` and `response.usageMetadata`.
- `tests/google-antigravity-oauth.test.ts`: loadCodeAssist project extraction across the three key
  shapes; onboardUser poll loop (not-done→done); refresh retry on 503 then success; single-flight
  coalescing; token never logged.
- stable sessionId is deterministic for the same first user text.

## Verify

`bun x tsc --noEmit` clean + `bun test ./tests/` green. Minimal proof: a mocked envelope build + a
`response`-wrapped SSE chunk parsed into text/tool events; a 503→200 refresh retry.

## Depends-on / enables

- Depends-on: Phase 10/11/12 (googleMode hook, `fetchVertexWithRetry`, `google-errors`, truncation).
- Enables: Phase 22 (thoughtSignature reasoning-replay) layers onto this wire.

---

## ✅ Implemented (commit `0909f4a`)

- `src/types.ts` + `src/providers/registry.ts` — `googleMode` union gains `"cloud-code-assist"`;
  NEW `google-antigravity` registry entry (adapter `google`, authKind `oauth`, keyed by its id).
- `src/oauth/types.ts` — `OAuthCredentials.projectId?`. `src/oauth/index.ts` — `OAUTH_PROVIDERS["google-antigravity"]`
  + `getOAuthCredentialProjectId`. NEW `src/oauth/google-antigravity.ts` (PKCE login, loadCodeAssist/onboardUser
  discovery, hardened refresh).
- `src/providers/derive.ts` — `providerConfigSeed` now propagates `googleMode`/`project`/`location` (was dropped).
- `src/server.ts` — injects credential `projectId` → `provider.project` for cloud-code-assist.
- `src/adapters/google.ts` + NEW `src/adapters/google-antigravity-wire.ts` — CCA envelope (daily host,
  `userAgent` literal, stable sessionId), `response`-unwrap in parseStream, `fetchAntigravityWithRetry`.
- Tests: `tests/google-antigravity-wire.test.ts` + `tests/google-antigravity-oauth.test.ts`;
  `provider-registry-parity` alias snapshot updated. Suite 1034/0, tsc clean.
