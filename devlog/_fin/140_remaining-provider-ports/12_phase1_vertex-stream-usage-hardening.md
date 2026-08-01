# 140.12 — Phase 1c: google-vertex stream + usage + ADC-refresh hardening

> Second hardening slice for Vertex: fail-closed stream truncation, correct usage tagging, and a
> hardened ADC token exchange (timeout + bounded retry). Copy-paste-ready. SOT = opencodex Kiro
> pattern (`kiro-truncation.ts`, `usage-log.ts`) + the existing `gcp-adc.ts`; external cross-check =
> CLIProxyAPI `helps/usage_helpers.go`. See `05_reference-repos.md`.

---

## What this covers

1. **Fail-closed truncation** — if a Vertex stream ends with `finishReason: MAX_TOKENS` (or the
   stream is cut) while a tool call is mid-emit, surface an error instead of silently yielding a
   half-built `functionCall`. Mirrors `kiro-truncation.ts`.
2. **Authoritative usage** — Vertex DOES return `usageMetadata` on the terminal chunk
   (cross-checked: `promptTokenCount / candidatesTokenCount / thoughtsTokenCount / totalTokenCount /
   cachedContentTokenCount`). So unlike Kiro/Cursor, Vertex usage is NOT estimated — keep it
   `reported`, and make sure `usage-log.ts` does NOT force-tag `google-vertex` as estimated.
3. **ADC refresh hardening** — `gcp-adc.ts` `postForToken` is a single `fetch` with no timeout and
   no retry. Add a per-attempt timeout + bounded retry on transient failures, matching the Cursor
   `refreshCursorToken` hardening.

---

## Part 1 — Plain explanation

If Vertex stops a response early in the middle of a tool call, we now report that clearly instead
of handing back a broken half-call. Token counts that Vertex actually reports stay accurate (not
marked as guesses). And fetching the Google access token now survives a flaky network: it times out
per try and retries transient errors a couple of times before giving up.

## Part 2 — Diff-level plan

### A) Fail-closed truncation in `parseStream` (`src/adapters/google.ts`)

Current loop (`google.ts:~146-180`) emits `tool_call_start`/`delta`/`end` per `functionCall` and
accumulates `usageMetadata`, then emits one terminal `done`. It never inspects `finishReason`. Add:

- Track the last seen `finishReason` from `candidates[0].finishReason`.
- A Vertex `functionCall` arrives as a complete `{name, args}` object, so mid-call byte truncation
  is not the failure mode (unlike Cursor's streamed text). The real fail-closed trigger is a
  terminal `finishReason` of `MAX_TOKENS` (or `OTHER`/`SAFETY` cutting off a started-but-unfinished
  turn). Treat `MAX_TOKENS` while at least one tool call was started this turn as truncation.

NEW helper file `src/adapters/google-truncation.ts` (mirror of `kiro-truncation.ts`):

```ts
import { redactSecretString } from "../redact";

const TRUNCATION_REASONS = new Set(["MAX_TOKENS", "MALFORMED_FUNCTION_CALL"]);

/** Vertex finishReason values that mean the turn was cut off, not cleanly stopped. */
export function isVertexTruncationReason(finishReason: string | undefined): boolean {
  return finishReason !== undefined && TRUNCATION_REASONS.has(finishReason);
}

export function vertexTruncationErrorMessage(reason?: string): string {
  const suffix = reason ? ` (${redactSecretString(reason).slice(0, 160)})` : "";
  return `Vertex AI response truncated upstream before the turn completed${suffix}`;
}
```

Patch in `parseStream` (sketch):

```ts
    let toolCallsStarted = 0;
    let lastFinishReason: string | undefined;
    // …inside the candidates loop:
    lastFinishReason = candidates[0].finishReason ?? lastFinishReason;
    // when emitting a functionCall: toolCallsStarted++;
    // …after the read loop, BEFORE the terminal done:
    if (isVertexTruncationReason(lastFinishReason) && toolCallsStarted > 0) {
      yield { type: "error", message: vertexTruncationErrorMessage(lastFinishReason) };
      return;
    }
```

> Scope guard: only apply this when `provider.googleMode === "vertex"` if we want AI-Studio Gemini
> behavior byte-identical. Recommended: apply to both (a `MALFORMED_FUNCTION_CALL` truncation error
> is correct for AI-Studio too), but if the existing AI-Studio tests assert silent completion on
> `MAX_TOKENS`, gate on `googleMode`. Decide in A-audit by reading `tests/google-adapter.test.ts`.

### B) Usage tagging stays `reported` (`src/usage-log.ts`)

Vertex returns authoritative `usageMetadata`, so it must NOT be force-estimated. The current
`isEstimatedUsageProvider` only tags `kiro*`/`cursor`, so `google-vertex` is already correct — but
pin it with a guard + a test so a future "tag all gemini as estimated" change can't regress it.

- The mapping function is **`usageFromGemini`** (`src/adapters/google.ts:115`), NOT `mapGeminiUsage`
  (no such symbol exists). It already sets `inputTokens`/`outputTokens`/`reasoningOutputTokens`/
  `cachedInputTokens` from `usageMetadata` and does NOT set `estimated: true` — both correct.
  Field mapping it already does:

| Vertex field | OcxUsage | Status |
|---|---|---|
| `promptTokenCount` | `inputTokens` | already mapped |
| `candidatesTokenCount` | `outputTokens` | already mapped |
| `thoughtsTokenCount` | `reasoningOutputTokens` | already mapped (conditional) |
| `cachedContentTokenCount` | `cachedInputTokens` | already mapped (conditional) |
| `totalTokenCount` | (derive if 0: input+output+reasoning) | **NEW — not currently read; add it** |

  So the only behavior change here is the `totalTokenCount` derive-if-0 (optional polish, matching
  CLIProxyAPI's `parseGeminiFamilyUsageDetail`). The estimated-tagging guard below is the real point.

- Test: a `google-vertex` request whose stream carries `usageMetadata` ends with
  `usageStatus === "reported"` (NOT `estimated`).

### C) ADC token-exchange hardening (`src/lib/gcp-adc.ts`)

`postForToken` is a single `fetch` with the caller's signal but no timeout and no retry. Harden it
the way Cursor's `refreshCursorToken` was hardened (timeout + bounded transient retry), keeping the
"never log token/key/refresh" guarantee.

```ts
const TOKEN_TIMEOUT_MS = 15_000;
const TOKEN_ATTEMPTS = 3;
const TOKEN_RETRY_BASE_MS = 300;

function tokenRetryDelayMs(attempt: number): number {
  const exp = TOKEN_RETRY_BASE_MS * 2 ** attempt;
  return Math.floor(exp * (0.8 + Math.random() * 0.4));
}
function isRetryableTokenStatus(s: number): boolean {
  return s === 429 || s === 500 || s === 502 || s === 503 || s === 504;
}
function tokenTimeoutSignal(parent: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function postForToken(body: URLSearchParams, signal: AbortSignal | undefined, fetchImpl: FetchImpl): Promise<TokenResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error("token exchange aborted");
    let response: Response;
    try {
      response = await fetchImpl(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: tokenTimeoutSignal(signal),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
      if (attempt === TOKEN_ATTEMPTS - 1) break;
      await new Promise(r => setTimeout(r, tokenRetryDelayMs(attempt)));
      continue;
    }
    if (response.ok) return (await response.json()) as TokenResponse;
    // Do NOT echo the body for auth errors (it can include grant details); use status only.
    if (!isRetryableTokenStatus(response.status) || attempt === TOKEN_ATTEMPTS - 1) {
      throw new Error(`Google OAuth token exchange failed (${response.status})`);
    }
    lastError = new Error(`Google OAuth token exchange failed (${response.status})`);
    await response.body?.cancel().catch(() => {});
    await new Promise(r => setTimeout(r, tokenRetryDelayMs(attempt)));
  }
  throw lastError instanceof Error ? lastError : new Error("Google OAuth token exchange failed");
}
```

> Behavior change worth flagging in A-audit: the old `postForToken` appended the raw response body
> to the error message (`…failed (${status}): ${detail}`). The detail can leak grant/account hints,
> so the hardened version drops it (status only). If a test asserts on the old `: detail` suffix,
> update it.

The metadata-server fetch (`fetchMetadataToken`) already has a 2s timeout and swallows errors —
leave it. The in-flight dedup + cache + skew in `getVertexAccessToken` are already correct; do not
touch them.

## Tests

- `tests/google-vertex-stream.test.ts`: a stream ending `finishReason:MAX_TOKENS` after a
  `tool_call_start` yields a terminal `error` (truncation), and a clean `finishReason:STOP` stream
  yields `done` with `reported` usage carrying the mapped token fields.
- `tests/gcp-adc.test.ts` (extend): `postForToken` retries a 503 then succeeds; retries a thrown
  network error then succeeds; fails fast on 400/401 (single attempt); token value never appears in
  a thrown error message.
- `tests/usage-*.test.ts` (extend): `google-vertex` usage with `usageMetadata` → `reported`.

## Verify

`bun x tsc --noEmit` clean + `bun test ./tests/` green. Minimal proof: MAX_TOKENS-mid-tool →
truncation error; 503→200 token-exchange retry.

## Depends-on / enables

- Depends-on: Phase 10 + 11.
- Enables: Phase 20 antigravity reuses the truncation helper and inherits the hardened ADC/OAuth
  refresh shape for its own token endpoint.

---

## ✅ Implemented (commit `c225642`)

- NEW `src/adapters/google-truncation.ts` — `isVertexTruncationReason` + `vertexTruncationErrorMessage`.
- `src/adapters/google.ts` parseStream — tracks `lastFinishReason` + `toolCallsStarted`; fail-closed
  error on MAX_TOKENS/MALFORMED_FUNCTION_CALL mid tool call (vertex + cloud-code-assist).
- `src/lib/gcp-adc.ts` `postForToken` — per-attempt 15s timeout + bounded retry (429/5xx/network),
  status-only error (no body leak). Usage stays `reported` (no estimated tag for google-vertex).
- Tests: `tests/google-vertex-stream.test.ts` + retry cases in `tests/gcp-adc.test.ts`. Suite 1023/0.
