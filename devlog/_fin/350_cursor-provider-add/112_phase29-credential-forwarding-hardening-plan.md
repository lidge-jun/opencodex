# 350.112 — Cursor Credential / Auth-Forwarding Hardening (work-phase 29)

Date: 2026-06-27
Branch: dev
Work phase: close the **#2 release-blocking** finding — `resolveCursorToken` silently forwards an
arbitrary incoming `Authorization: Bearer …` to Cursor when no Cursor `apiKey` is configured.

> Status: **PLAN**. C4-class (credential boundary). Default behavior changes (forwarding removed),
> so the opt-in flag + docs are part of this phase.

---

## 1. Easy explanation

A client calling the opencodex proxy may send its own `Authorization` header (e.g. an OpenAI or
ChatGPT bearer). Today, if the Cursor provider has no configured key, opencodex grabs that incoming
bearer and **sends it upstream to Cursor**. That leaks one vendor's credential to a different vendor.
The fix: never forward a client bearer to Cursor unless the operator has explicitly opted in
(`forwardAuthToCursor: true`) and accepts that trust boundary. Otherwise use the configured Cursor
key, then the test-token env var, then fail with the existing clear "no token" error.

## 2. Pre-write evidence

### Current opencodex — implicit forward
```30:40:src/adapters/cursor/live-transport.ts
export function resolveCursorToken(provider: OcxProviderConfig, headers?: Headers): string {
  const providerKey = provider.apiKey?.trim();
  if (providerKey) return providerKey;

  const forwarded = headers?.get("authorization") ?? headers?.get("Authorization");
  if (forwarded?.toLowerCase().startsWith("bearer ")) return forwarded.slice("bearer ".length).trim();

  const envToken = process.env.OPENCODEX_CURSOR_TEST_TOKEN?.trim();
  if (envToken) return envToken;
  throw new CursorMissingCredentialError();
}
```
- The forward at `:34-35` runs **before** the env token and is unconditional.
- A test currently codifies this fallback (per the review, `tests/cursor-live-transport.test.ts`
  asserts the Authorization fallback) → that test must be updated to assert the **opt-in gated**
  behavior, not removed silently.

### Token redaction already exists (keep intact)
- `src/adapters/cursor.ts:50-57` `sanitizeCursorTransportCause` redacts `Bearer …`, `access_token=`,
  `api_key=`, `authorization=` and truncates to 220 chars. This phase must not weaken it.
- `live-transport.ts:74-76` `toJSON()` already returns `credential:"redacted"`.

## 3. Decision

Forwarding becomes **opt-in**. New optional provider field `forwardAuthToCursor?: boolean`
(default `false`). Precedence: `provider.apiKey` → (opt-in) forwarded bearer → `OPENCODEX_CURSOR_TEST_TOKEN`
→ throw `CursorMissingCredentialError`. The forwarded bearer is no longer first.

## 4. Diff-level plan

### MODIFY `src/adapters/cursor/live-transport.ts`
```ts
export function resolveCursorToken(provider: OcxProviderConfig, headers?: Headers): string {
  const providerKey = provider.apiKey?.trim();
  if (providerKey) return providerKey;

  // Do NOT forward a client Authorization bearer to Cursor by default — that leaks a
  // foreign vendor credential across a trust boundary. Operators opt in explicitly.
  if (provider.forwardAuthToCursor === true) {
    const forwarded = headers?.get("authorization") ?? headers?.get("Authorization");
    if (forwarded?.toLowerCase().startsWith("bearer ")) return forwarded.slice("bearer ".length).trim();
  }

  const envToken = process.env.OPENCODEX_CURSOR_TEST_TOKEN?.trim();
  if (envToken) return envToken;
  throw new CursorMissingCredentialError();
}
```
- Also update `CursorMissingCredentialError` message to stop advertising `Authorization` as a default
  source: `"requires a Cursor access token in provider.apiKey or OPENCODEX_CURSOR_TEST_TOKEN
  (set forwardAuthToCursor:true to forward a client bearer)."`

### MODIFY `src/types.ts` (`OcxProviderConfig`)
- Add `forwardAuthToCursor?: boolean;` with a doc comment describing the trust boundary.

### Config docs
- Note in the provider config docs/README that this defaults off and what enabling it means.

## 5. Verification plan (non-destructive)
- MODIFY `tests/cursor-live-transport.test.ts`:
  - `apiKey` present → used.
  - No key, `forwardAuthToCursor` unset/false, incoming `Authorization: Bearer X` → **NOT** forwarded;
    falls through to env/throw (assert the resolved token is the env token or that it throws
    `CursorMissingCredentialError`).
  - `forwardAuthToCursor:true` + incoming bearer → forwarded.
  - Redaction unchanged: a thrown transport error containing `Bearer abc.def` is sanitized to
    `Bearer [redacted]` via `sanitizeCursorTransportCause`.
- `bun test tests/cursor-*.test.ts` → green; `bun x tsc --noEmit` → exit 0.
- NO live call.

## 6. Out of scope
- The OAuth login/refresh flow (already tracked `100`–`104`) — unchanged here.

## 7. Cross-references
- GPT Pro review 260627 — finding **#2 (Critical)**.
- `111` (native exec gate, the other Critical) · `117` (false-safety error) · `118` (index).
