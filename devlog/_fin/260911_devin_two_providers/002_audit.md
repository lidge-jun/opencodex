# 002 — wp1 audit: folded reviewer findings

Four independent reviewers (xai/grok-4.6, high effort) audited the carried commit
`142c095673`. Three returned; the streaming reviewer is still running and its
findings fold into this same cycle if they arrive before C. Verdicts below are mine
after reading the cited code.

## Accepted — blocker

**Raw upstream bodies in auth error messages.** `register-user.ts:96,113` and
`cloud-direct/auth.ts:99,126` copy the response body into `Error.message`. That
message reaches CLI output, the adapter's `emit({ type: "error" })`, and
`/api/logs`. A Connect error that echoes `firebase_id_token`, or a 200 whose
`user_jwt` fails the shape regex, publishes a live credential; `redactSecretString`
does not match a bare `eyJ…` JWT. Confirmed by reading both files. Fix: status plus
allowlisted Connect code plus trace id, never the body.

## Accepted — major

1. **Tenant api-server routing.** `credential.apiBaseUrl` is written at login but
   no call site reads it, and `store.ts:461` only persists Copilot origins, so an
   EU/FedStart host is dropped on the next load anyway. Thread it through
   `mintUserJwt`, the catalog fetch, and `streamChatEvents`, and teach the store to
   persist a validated Devin origin.
2. **Redirect following on credential POSTs.** Both credential POSTs use the default
   `redirect: "follow"`, so a 307/308 forwards the Firebase token or the protobuf
   `api_key` to an attacker-chosen `Location`. Set `redirect: "error"` and validate
   the host the same way `validateCopilotApiBaseUrl` does.
3. **Credential shape.** `refresh: ""` makes `detectOAuthWarning` report
   `stale_credentials` for every Devin account from the moment of login, and
   `refreshDevinToken` extends the expiry without contacting Cognition, so a revoked
   key keeps looking valid. Use the durable-key house pattern: `refresh` carries the
   key, expiry is effectively unbounded, and refresh throws so a 401 marks
   `needsReauth`.
4. **Paste parsing.** `loginDevin` posts the entire pasted string as
   `firebase_id_token`. The on-screen value is a token, but a user who pastes the
   callback URL instead sends a URL. Parse a fragment/query token out of a URL paste
   and reject a paste that contains no token.
5. **`clearCachedUserJwt` is never called.** The cached `user_jwt` (its payload
   contains `api_key`) survives logout in process memory. Wire it into the Devin
   logout path.

## Accepted — minor

6. `result.name` overwrites the JWT `email` with a display name, so reauth identity
   comparison collides. Keep the email; the name is not an identity.
7. `registerUser` does not receive `ctrl.signal`, so cancelling login does not abort
   the exchange.
8. No dotted-to-hyphen model-id map, so a degraded-path `swe-1.6` becomes
   `swe-1.6-medium` and Cognition answers `permission_denied`.

## Rejected / deferred

- **Copying the reference's gRPC-web framing.** `.tmp/openproxy-ref` talks to
  `LanguageServerService` over gRPC-web with a Bearer header; we talk to
  `ApiServerService` over Connect-RPC with the key inside `Metadata`. They are two
  different products. Adopting the reference's headers or field numbers would break
  auth and proto decode. Reference value is the CLI/ACP executor, which is wp3.
- **`defaultRefreshPolicy: "disabled"`.** Correct for a durable key; keep it.
- **Docs/locale parity.** Real and required, but the final surface is not known until
  `devin-cli` lands, so it is wp4.
- **Dead plugin types** (`PersistedCredentials`, `syncedViaOpencodeAuth`). Removed
  where they are genuinely unreferenced; not a leak either way.

## Verification for this cycle

`bun x tsc --noEmit`, the focused Devin/adapter/layout suites, `bun run privacy:scan`,
plus new regression tests for: error messages that must not contain a token, redirect
refusal, host allowlist rejection, tenant host threading, and the dotted model id.
