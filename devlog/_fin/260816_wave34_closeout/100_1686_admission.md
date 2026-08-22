# 100 — #1686: bearer admission with guaranteed upstream substitution

One PABCD cycle. Security-boundary change: requires explicit security review per `MAINTAINERS.md`.

## The roadmap's framing is wrong

It claims a direct main path leaks the caller's admission secret upstream. Traced at `7c348a032`, that is not reachable: `/v1/responses` admission reads only `x-opencodex-api-key` (`src/server/auth-cors.ts:441`), and Direct runs `validateForwardAdmissionCredential` (executing at `src/server/auth-cors.ts:407`) before upstream auth resolution, throwing 401 on a recognized proxy secret (`src/server/responses/core.ts:970`). Pool and main-pool overwrite Authorization with the stored account token (`src/codex/auth-context.ts:460`). Non-forward adapters install their own credential. Only canonical `authMode: "forward"` forwards a caller bearer, which is intentional.

The real defect is the inverse: the proxy REFUSES the intended flow instead of admitting it and substituting stored main auth.

## Required shape

### 1. Presentation-source-aware admission

`DataPlaneAdmission` exists as `{ kind: "configured"; keyId } | { kind: "environment" } | { kind: "loopback" }` (`src/server/auth-cors.ts:314`). It records WHICH credential matched, not HOW it was presented. Add the source:

```ts
type DataPlaneAdmissionSource = "loopback" | "dedicated" | "bearer" | "x-api-key";
type DataPlaneAdmission =
  | { kind: "configured"; keyId: string; source: DataPlaneAdmissionSource }
  | { kind: "environment"; source: DataPlaneAdmissionSource }
  | { kind: "loopback"; source: "loopback" };
```

The source is currently lost before `resolveDataPlaneAdmissionSecret` — the broad resolver extracts headers in precedence order at `:416` and passes only the token. Both resolvers must pass the source through.

### 2. Accept bearer for Responses, keep the precedence

`resolveResponsesApiAuth` (`:441`) gains a bearer fallback with dedicated header still winning; `x-api-key` stays rejected there. Update `AUTH_MATRIX` (`:379`), which currently declares bearer rejected, and the SOT prose in `structure/05_gui-and-management-api.md:70`.

### 3. Thread the admission to where the decision happens

HTTP currently drops it before `handleResponses` (`src/server/index.ts:1214`) while WebSocket retains it (`src/server/ws-bridge.ts:63`). Enumerate the full chain and update each hop: HTTP Responses, compact Responses (`src/server/responses/compact.ts:353` repeats the selection locally), the Chat-translated path, and WebSocket.

### 4. One upstream-auth materializer

Build on today's `headersForCodexAuthContext(headers, ctx)` (`src/codex/auth-context.ts:454`):

```ts
function materializeCodexUpstreamAuth(
  headers: Headers,
  ctx: CodexAuthContext,
  admission: DataPlaneAdmission | undefined,
): Headers;
```

- `pool` / `main-pool`: always overwrite Authorization and `chatgpt-account-id` from the context credential (today's behavior, unchanged).
- `main` + admission bearer: require a live stored main token, overwrite BOTH headers, and throw before any I/O if unavailable.
- `main` + dedicated admission + a distinct real ChatGPT bearer: preserve today's intentional passthrough.

**Do not relax `validateForwardAdmissionCredential` on its own.** Without guaranteed overwrite that creates precisely the leak the guard prevents today. The guard may only be narrowed once substitution is proven to run first.

### 5. Modern injection

`src/codex/inject.ts:210` emits only `env_http_headers`. Emit `env_key = "OPENCODEX_API_AUTH_TOKEN"` for supported runtimes, with any legacy fallback capability-gated rather than emitting both blindly.

## Tests

- `tests/data-plane-admission-identity.test.ts:116` currently PINS bearer rejection — update it, and add source identity, precedence, invalid bearer, and unchanged `x-api-key` rejection.
- `tests/codex-auth-context.test.ts:1140`: unit matrix for `main` / `pool` / `main-pool` materialization.
- `tests/server-auth.test.ts:1325`: successful HTTP/compact/WebSocket Direct substitution, missing-main fail-closed, dedicated passthrough unchanged (`:1439`), pool override unchanged (`:1543`).
- `tests/forward-admission-separation.test.ts:63`: the admission secret never appears in captured upstream headers, in both the success and failure cases.
- `tests/codex-inject.test.ts:41`: modern `env_key` output and explicitly supported legacy behavior.
