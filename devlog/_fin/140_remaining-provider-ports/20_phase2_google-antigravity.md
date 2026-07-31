# 140.20 — Phase 2: google-antigravity (extend `google` + OAuth, MEDIUM)

> One PABCD pass. Reuses Phase 10's `googleMode` hook; adds OAuth + the Cloud-Code-Assist (CCA)
> envelope. Grounded in jawcode (cites are jawcode paths).
>
> External cross-check: `router-for-me/CLIProxyAPI` antigravity auth/executor/translator + the
> thoughtSignature reasoning-replay quirk — see `05_reference-repos.md`.

---

## Goal

Stream Gemini/Claude through Google **Antigravity** (Cloud Code Assist) — an OAuth-authed endpoint that
wraps the flat Gemini body in a CCA envelope. Reuses the `google` adapter (mode = `cloud-code-assist`).

## What we port (jawcode)

- **OAuth + project onboard** (`utils/oauth/google-antigravity.ts:116-207`):
  - `loginAntigravity` (`:160-172`) → `runGoogleOAuthLogin` with `discoverProject`: call `/v1internal:loadCodeAssist`; if no project, `/v1internal:onboardUser` retry loop (5×, 2s) → `operation.response.cloudaicompanionProject`.
  - refresh via `https://oauth2.googleapis.com/token` (`:177-207`).
  - env secrets `GOOGLE_ANTIGRAVITY_CLIENT_ID/SECRET` (`:10-11`); scopes `cloud-platform`/userinfo/cclog (`:15-21`).
  - credential JSON `{ refresh, access, expires, projectId }` (`:201-206`).
- **CCA envelope** (`google-gemini-cli.ts:735-856`): wrap the flat Gemini `request` in
  `{ project, model, request, requestType:"agent", userAgent:"antigravity", requestId:"agent-{uuid}" }`;
  endpoint `${baseUrl}/v1internal:streamGenerateContent?alt=sse` (`:349`).
- **Headers** (`:314-352`): Antigravity User-Agent; `anthropic-beta: interleaved-thinking-2025-05-14` for Claude+reasoning (`:101-102,329`).
- **Quirks** (`:814-842`): drop `maxOutputTokens` for non-Claude; inject system instruction for Claude+Gemini-3; tool mode `VALIDATED` for Claude forced choice; `parametersJsonSchema → parameters` normalize (`:729`). sessionId = hash of first user text (`:686-714`).

## opencodex fit

- **OAuth** (`src/oauth/`): NEW `src/oauth/google-antigravity.ts` (login + refresh + discoverProject/onboard). Extend `OAuthCredentials` (`src/oauth/types.ts`) with `projectId?`. Register in `OAUTH_PROVIDERS` (`src/oauth/index.ts:36-61`).
- **projectId wiring (audit fix):** the CCA envelope needs `project` from the stored credential, but opencodex's server injects only the bare access token into `apiKey` (`server.ts:299-301`). So the adapter must read the credential's `projectId` directly (`getCredential("google-antigravity").projectId`) — store `{token, projectId}` like jawcode `parseGeminiCliCredentials` (`google-gemini-cli.ts:143-159`), and use it in both the envelope and the refresh closure.
- **Adapter** (`src/adapters/google.ts`): extend the Phase-10 `googleMode` branch with `cloud-code-assist` → wrap body in CCA envelope + antigravity headers.
- **⚠️ `parseStream` IS changed for antigravity (audit fix):** antigravity nests output under `chunk.response.candidates` + thinking parts (jawcode `google-gemini-cli.ts:399-402`), but opencodex's current parser reads **top-level** `chunk.candidates` (`google.ts:155`). Phase 20 adds a **mode-aware** `parseStream` that unwraps `response` and handles thinking deltas. (Phase 10 vertex is top-level, so it left `parseStream` untouched — this change is antigravity-only.)
- **Registry:** `adapter:"google"`, `authKind:"oauth"`, `oauthId:"google-antigravity"`, baseUrl `daily-cloudcode-pa.googleapis.com` **with prod fallback `cloudcode-pa.googleapis.com`** (`google-gemini-cli.ts:69-71`), ~15 bundled models.

## Sub-steps (this PABCD pass)

1. **A:** port `src/oauth/google-antigravity.ts` (login/refresh/onboard); extend creds with `projectId`; register in `OAUTH_PROVIDERS`. Unit-test mocked `loadCodeAssist`/`onboardUser`.
2. **B:** extend `createGoogleAdapter` with the CCA-envelope branch + headers + a **mode-aware `parseStream`** (unwrap `response.candidates` + thinking deltas) + the quirks table (maxTokens drop, system-instr inject, tool-mode map, schema normalize, sessionId hash).
3. **B:** registry entry + 15 models.
4. **C:** `ocx login google-antigravity` → creds with projectId; envelope-builder asserts (`project`, `requestType:"agent"`); one text stream + one tool call (schema normalization); `tsc`/`bun test`.

## Risks

| Risk | Mitigation |
|------|------------|
| OAuth client id/secret distribution | env vars, no secrets in repo (`02:204`); sandbox creds for test |
| onboard timeout / quota | retry loop (5×,2s) + clear error |
| CCA envelope rejected upstream | validate envelope vs jawcode golden |
| Claude thinking-beta header missing | gate on `model.includes("claude") && reasoning` |
| tool schema normalize bug | port `normalizeSchemaForCCA` exactly; test complex tool sets |

## Verify (minimal proof)

`ocx login google-antigravity`; one tool-call + thinking-model stream (`02:217`).

## Depends-on / enables

- **Depends-on:** Phase 10 (the `googleMode` hook + the `google` adapter branch structure).
- **Enables:** the `OAUTH_PROVIDERS` registration pattern reused by Phase 50 (cursor).
