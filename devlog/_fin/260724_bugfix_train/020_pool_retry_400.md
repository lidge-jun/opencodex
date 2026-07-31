# 020 — Cycle 2: bounded pool retry for account-specific unsupported-model 400

> DIFFLEVEL-ROADMAP-01: this is the implementation contract for issue #335. It
> fixes one account/model capability mismatch without changing the general 4xx
> health taxonomy introduced by `35d28a02`.

> **Stale-check 2026-07-24:** re-verified against `origin/dev` design base
> `097cadc1` plus PR #350 / cycle-1 head `4b60f5ee`. Since the original
> `d9e06c8d` draft, `3781448a`/`e0c7caba` inserted the runtime stream-capability
> gate and eager bounded SSE relay at `src/server/responses/core.ts:1023-1123`,
> after this cycle's retry insertion point. Cycle 1 changed replay metadata and
> SSE completion reconstruction but did not change `core.ts`: `_replayPrefixLen`
> is parser/collaboration metadata, while the new inspector accumulator exists
> only after a successful SSE response enters a relay. The dispatch, outcome,
> error-classifier, and bounded-body anchors and both stream-mode commitment
> boundaries were re-validated below.

## Loop-spec

- **Work class:** C4 for the affected slice. The implementation changes pooled
  account selection and therefore crosses an authentication/security boundary;
  the change remains a narrowly bounded spec-satisfaction repair.
- **Loop archetype:** verifier-defined **spec-satisfaction repair**.
- **Specification:** in canonical OpenAI Pool mode, recognize only the captured
  ChatGPT account/model rejection, then make at most one additional upstream
  dispatch with a different eligible pooled account before any client-facing
  `Response` or relay is constructed.
- **Primary verifier:** activation tests in `tests/server-auth.test.ts` plus the
  focused auth-selection tests in `tests/codex-auth-context.test.ts`.
- **Policy-preservation verifier:** the existing test named `caller and model 4xx
  responses do not penalize account health` in `tests/codex-routing.test.ts` must
  remain unchanged and green.
- **Completion verifier:** `bun run typecheck`, `bun run test`, and
  `bun run privacy:scan`, all exit 0. Run the focused files first for fast
  diagnosis, then the repository gates.
- **Escalate up:** stop and return to Plan/Audit if implementation needs to (a)
  classify generic `unsupported model`, `model not found`, or `invalid request`
  substrings, (b) change `classifyCodexUpstreamOutcome`, health penalties,
  cooldowns, or global active-account state, (c) retry after a client-facing relay
  is constructed, after a visible byte, or after an SSE `200` terminal event, (d)
  make more than one account-switch retry, or (e) expose account IDs/tokens/error
  bodies in logs.
- **Escalate down:** once the exact-body matcher, one-account exclusion, four
  required activation scenarios, streaming safety scenario, and C4 gates are
  green, do not add diagnostics, catalog changes, affinity redesign, or broader
  provider retry abstractions in this cycle.
- **Budget/bounds:** one logical bug fix; no dependencies, schema/config changes,
  GUI changes, release work, or public API additions.

## Evidence and invariant lock

### Reproduction evidence

Issue #335 captured this exact upstream payload for `gpt-5.6-sol`:

```json
{"detail":"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."}
```

Repository search found the same ChatGPT/Codex sentence in
`devlog/_plan/issue_017_mobile-thread-bypass-proxy/00_review.md`; no test fixture
or source capture supports broader alternatives such as bare `unsupported model`,
`model is not supported`, or `model not found for this account`.

### Existing behavior that must remain true

- `src/codex/auth-context.ts:92-141` resolves one pool account and its credential
  before provider dispatch.
- `src/codex/routing.ts:116-125` maps every non-auth/non-quota 4xx to `caller`.
- `src/codex/routing.ts:450-480` returns without mutating health for `caller`.
- `tests/codex-routing.test.ts:217-226` pins 400/404/422 as zero-penalty and keeps
  account `a` selectable.
- `src/server/responses/core.ts:923-951` builds a replayable passthrough request
  and performs the existing bounded transient/5xx dispatch before returning a
  client `Response`.
- `src/server/responses/core.ts:1015-1020` records the selected pool account's
  HTTP outcome. The new retry must converge back into this path with the final
  account/response; it must not invent a model-health penalty.
- `src/server/responses/core.ts:1023-1123` now chooses between the eager bounded
  single-reader relay and the legacy tee relay for successful SSE responses. Both
  branches remain downstream of the retry decision and must observe only the
  final account/response.
- `src/lib/errors.ts:79-190` is response/error-envelope classification. Its broad
  `model unavailable` / `model not found` / `unsupported model` bucket at
  `src/lib/errors.ts:172-183` is intentionally unsuitable as a retry signal.
- `src/lib/bounded-body.ts:1-5,75-201` still owns the 64 KiB cap, 5 s total and
  inactivity defaults, abort propagation, unsafe timeout/oversize results, and
  cancellation without waiting. No matcher-specific unbounded read is allowed.

### Policy statement for the PR description

The PR description must include this sentence (wording may be lightly edited,
meaning may not):

> This intentionally refines the request-dispatch behavior around the
> `35d28a02` outcome policy: allow-listed account/model 400s may trigger one
> different-account Pool retry, while all 4xx responses remain caller outcomes
> with zero account-health penalty.

## Scope

### IN

- Canonical OpenAI `openai-responses` passthrough with `codexAccountMode: "pool"`.
- HTTP status exactly `400`.
- Top-level JSON `detail` exactly matching the captured account/model sentence
  after narrow normalization, with the requested routed model interpolated.
- At most one alternate-account dispatch, selected from the existing eligible
  pool while excluding the first account.
- Both `stream: false` and a streaming request whose upstream rejects with HTTP
  400 before the server returns a `Response` to the client.
- Preservation of current status/body/headers when no retry is allowed or the
  alternate account also rejects.

### OUT

- Generic 400/404/422 retry, substring/keyword heuristics, fuzzy matching, locale
  variants, and provider-specific error taxonomies outside canonical ChatGPT.
- Model catalog correction, capability caching, per-model account health, quota
  penalty, cooldown, reauth marking, or permanent account quarantine.
- Changing global active-account selection or thread-affinity persistence. This
  cycle makes a request-local alternate selection; a successful retry does not
  rewrite global account preference.
- Retry of an HTTP `200` SSE stream that later emits `response.failed`, even if
  the terminal payload contains similar text.
- WebSocket-specific replay, diagnostics fields, GUI/history account labels, and
  issue #335's optional diagnostics suggestion.
- Compact endpoint behavior, release/version changes, and dependency changes.

## Allow-list contract

### Accepted phrase template

The allow-list contains exactly one evidence-backed template:

```text
The '<requested routed model id>' model is not supported when using Codex with a ChatGPT account.
```

Normalization is deliberately limited to:

1. parse JSON and require a **top-level string** property named `detail`;
2. trim leading/trailing whitespace;
3. collapse internal ASCII/Unicode whitespace runs to one space;
4. compare case-insensitively to the expected sentence built from
   `route.modelId`.

Do not strip punctuation, remove quotes, search substrings, inspect arbitrary
nested fields, or accept a different model ID. Consequently these remain false:

```text
unsupported model
model is not supported
model not found for this account
The 'other-model' model is not supported when using Codex with a ChatGPT account.
Invalid request: malformed tool schema
```

The three generic phrases are leads only. Add one in a later change only after a
sanitized primary ChatGPT response fixture proves its complete envelope and exact
wording. This is the tightest defensible list from current repository and issue
evidence.

## Safe retry boundary

The retry decision occurs after `fetchWithTransientRetry(...)` has returned an
HTTP response but **before** `sanitizePassthroughHeaders`, terminal recorder
installation, either body relay, or construction/return of the client-facing
`Response` (`src/server/responses/core.ts:941-966`). At that point:

- the request body is already a replayable string from `adapter.buildRequest`;
- no upstream body byte has been relayed to the client (although clone inspection
  deliberately reads the HTTP 400 body from upstream);
- no client response headers have been committed;
- an HTTP 400 is a pre-stream rejection even when `parsed.stream === true`.

Inspect only `upstreamResponse.clone()` with `readBoundedResponseBody`, using the
existing 64 KiB/5 s bounds and the request abort signal. A timeout, oversized body,
invalid JSON, missing/non-string `detail`, or normalization mismatch means **no
retry** and returns the untouched original response. The clone prevents matcher
inspection from consuming or rewriting a non-matching response.

The stream-capability gate does not move or narrow this decision point. In
`legacy-tee` mode, tee/inspection setup begins only in the successful-SSE branch
at `src/server/responses/core.ts:1077-1123`. In `eager-relay` mode,
`relaySseEagerBounded` is constructed at `src/server/responses/core.ts:1037-1075`;
its `ReadableStream.start()` immediately starts the producer and may read/queue
upstream bytes before the downstream client pulls. That eager read still happens
only after the HTTP status classifier has declined retry and the code has entered
the successful-SSE branch. Therefore eager relay does **not** cause client bytes
to flow before the 400 decision, but it makes the post-construction boundary
especially strict: never attempt account switching after either relay is created.

Accordingly, “pre-first-byte” means **before any client-facing `Response` or relay
is constructed/returned**, not before any upstream body byte has been read. Once
an HTTP 200 SSE response enters either relay mode, the retry window is closed. A
later `response.failed`/EOF/error event never enters this path, even if no client
pull has happened yet. This avoids duplicate visible output and mode-dependent
retry behavior.

Cycle 1 does not alter clone inspection. `_replayPrefixLen` stays on the parsed
request and is reused unchanged when the alternate adapter rebuilds the same
request; it is not consulted by the 400 matcher. The SSE completion accumulator
is allocated by `createSseInspector` only for a final successful SSE relay, after
the retry decision, and never sees the cloned 400 body.

The unsupported-model budget is one account switch and one alternate HTTP
dispatch. The initial account is excluded from alternate selection, the alternate
dispatch is deliberately **not** wrapped in `fetchWithTransientRetry`, and its
response is returned directly. Existing transient transport/5xx retry behavior on
the initial dispatch before this classifier is not broadened; it is a separate
pre-existing policy. No recursive call to `handleResponses` is permitted.

## Exact file change map

| Action | Path | Diff responsibility |
| --- | --- | --- |
| MODIFY | `src/codex/auth-context.ts` | Add an optional request-local excluded account to `resolveCodexAuthContext`; use existing eligible-pool ranking for the alternate and reuse the exact credential resolution path. |
| MODIFY | `src/server/responses/core.ts` | Add the exact `detail` matcher and bounded clone inspection; perform one alternate-account request rebuild/dispatch before response commitment; preserve final response fidelity and health policy. |
| MODIFY | `tests/codex-auth-context.test.ts` | Prove exclusion selects a different eligible account and fails closed when none exists. |
| MODIFY | `tests/server-auth.test.ts` | Add endpoint activation scenarios for success, one-account, malformed 400, bounded double rejection, and both-mode pre-response streaming safety. |
| NEW | none | No new abstraction/module is justified for one private matcher and one optional auth-resolution input. |
| DELETE | none | No production/test file is removed. |

Explicitly unchanged:

- `src/codex/routing.ts`: no outcome-class, health, cooldown, affinity, or active
  account changes.
- `src/lib/errors.ts`: no retry semantics added to provider-agnostic error
  presentation.
- `tests/codex-routing.test.ts`: do not weaken or rewrite the pinned 4xx test;
  execute it as a policy-preservation gate.
- `docs-site/`: no user-configurable or public contract change; see Docs sync.

## Diff-level implementation sketches

The sketches below use current names/signatures and define the intended diff.
Minor extraction for formatting is allowed only if behavior remains identical.

### 1. `src/codex/auth-context.ts` — alternate selection with one exclusion

Before (`src/codex/auth-context.ts:92-105`):

```ts
export async function resolveCodexAuthContext(
  headers: Headers,
  config: OcxConfig,
  mode: CodexAccountMode,
): Promise<CodexAuthContext> {
  if (mode === "direct") {
    if (!hasCallerCodexBearer(headers)) throw new CodexDirectAuthenticationError();
    return { kind: "main", accountId: null };
  }
  const threadId = headers.get("x-codex-parent-thread-id");
  const resolution = resolveCodexAccountForThreadDetailed(threadId, config);
  if (resolution.status === "expired") throw new CodexThreadAffinityExpiredError(resolution.accountId);
  const accountId = resolution.status === "selected" ? resolution.accountId : null;
  if (!accountId) throw new CodexPoolAuthenticationError();
```

After:

```ts
export interface ResolveCodexAuthContextOptions {
  excludeAccountId?: string;
}

export async function resolveCodexAuthContext(
  headers: Headers,
  config: OcxConfig,
  mode: CodexAccountMode,
  options: ResolveCodexAuthContextOptions = {},
): Promise<CodexAuthContext> {
  if (mode === "direct") {
    if (!hasCallerCodexBearer(headers)) throw new CodexDirectAuthenticationError();
    return { kind: "main", accountId: null };
  }
  const threadId = headers.get("x-codex-parent-thread-id");
  const resolution = options.excludeAccountId
    ? (() => {
        const accountId = pickLowestUsageCodexAccount(config, options.excludeAccountId);
        return accountId
          ? { status: "selected" as const, accountId }
          : { status: "none" as const };
      })()
    : resolveCodexAccountForThreadDetailed(threadId, config);
  if (resolution.status === "expired") throw new CodexThreadAffinityExpiredError(resolution.accountId);
  const accountId = resolution.status === "selected" ? resolution.accountId : null;
  if (!accountId) throw new CodexPoolAuthenticationError();
```

Required import change:

```ts
import {
  getCodexAccountCooldownUntil,
  pickLowestUsageCodexAccount,
  resolveCodexAccountForThreadDetailed,
} from "./routing";
```

The remainder of `resolveCodexAuthContext` at lines 106-140 stays the single
credential owner for main-pool and stored pool accounts. The exclusion branch
must not call `setActiveCodexAccount`, bind/clear thread affinity, bypass
`isCodexAccountUsable`, or fall back to the inbound caller bearer.

### 2. `src/server/responses/core.ts` — exact matcher

Add private helpers near the existing Codex passthrough helpers
(`codexLogAccountId`, `usesCodexForwardPoolAuth`):

```ts
function normalizeCodexUnsupportedModelDetail(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function isAllowListedCodexAccountModel400(
  status: number,
  bodyText: string,
  modelId: string,
): boolean {
  if (status !== 400) return false;
  try {
    const payload = JSON.parse(bodyText) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail !== "string") return false;
    const expected = `The '${modelId}' model is not supported when using Codex with a ChatGPT account.`;
    return normalizeCodexUnsupportedModelDetail(detail)
      === normalizeCodexUnsupportedModelDetail(expected);
  } catch {
    return false;
  }
}

async function shouldRetryCodexPoolAccountModel400(
  response: Response,
  modelId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (response.status !== 400) return false;
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    return body.displaySafe
      && !body.truncated
      && isAllowListedCodexAccountModel400(response.status, body.text, modelId);
  } catch {
    return false;
  }
}
```

Do not use `classifyError(...)` as the predicate. Its real signature remains:

```ts
export function classifyError(status: number, type: string, message: string): OcxErrorPayload
```

That function intentionally maps presentation/error codes and broadly groups
model text. It has neither account context nor the original structured `detail`
field and cannot safely authorize cross-account dispatch.

### 3. `src/server/responses/core.ts` — rebuild and dispatch once

Before (`src/server/responses/core.ts:923-966`):

```ts
const request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders });
// ...
let upstreamResponse: Response;
try {
  upstreamResponse = await fetchWithTransientRetry(
    recovery => {
      noteAttemptSend(logCtx.activeAttempt, passthroughEstimate, recovery);
      return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
        method: request.method,
        headers: request.headers,
        body: request.body,
      }, recovery), upstream.signal, connectMs, parsed.stream, providerFetch(route.provider));
    },
    { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
  );
} catch (err) {
  // existing transport failure handling
}
const headers = sanitizePassthroughHeaders(upstreamResponse.headers);
```

After, retain the existing transport error catch but place one non-recursive
account-switch block before header sanitization. This insertion remains before
the stream-mode decision at `src/server/responses/core.ts:1023-1123`:

```ts
let request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders });
// ... existing first dispatch, assigning upstreamResponse ...

if (
  usesCodexForwardPoolAuth(authCtx, route.provider)
  && await shouldRetryCodexPoolAccountModel400(
    upstreamResponse,
    route.modelId,
    options.abortSignal,
  )
) {
  const firstAuthCtx = authCtx;
  let retryAuthCtx: CodexAuthContext | undefined;
  try {
    retryAuthCtx = await resolveCodexAuthContext(
      req.headers,
      config,
      "pool",
      { excludeAccountId: firstAuthCtx.accountId },
    );
  } catch (error) {
    if (
      !(error instanceof CodexPoolAuthenticationError)
      && !(error instanceof CodexAuthContextError)
      && !(error instanceof CodexAccountCooldownError)
    ) throw error;
  }

  if (retryAuthCtx && (retryAuthCtx.kind === "pool" || retryAuthCtx.kind === "main-pool")) {
    // Preserve 35d28a02 explicitly: first 400 is recorded through the existing
    // classifier and remains a caller/no-health-mutation outcome.
    recordCodexUpstreamOutcome(config, firstAuthCtx.accountId, 400, {
      threadId: req.headers.get("x-codex-parent-thread-id"),
    });

    const retryHeaders = headersForCodexAuthContext(req.headers, retryAuthCtx);
    const retryProvider = applyCodexAuthContextToProvider(
      stripCodexRuntimeProviderFields(route.provider),
      retryAuthCtx,
      "pool",
    );
    const retryAdapter = resolveAdapter(
      resolveWireProtocolOverride(route.providerName, route.modelId, retryProvider),
      config.cacheRetention,
    );
    request = await retryAdapter.buildRequest(parsed, { headers: retryHeaders });

    await upstreamResponse.body?.cancel().catch(() => undefined);
    authCtx = retryAuthCtx;
    options.onCodexAuthContextResolved?.(retryAuthCtx);
    selectedForwardHeaders = retryHeaders;
    route.provider = retryProvider;
    logCtx.provider = formatCodexProviderForLog(
      route.providerName,
      retryAuthCtx.accountId,
      config,
    );

    noteAttemptSend(logCtx.activeAttempt, passthroughEstimate);
    // The retry dispatch reuses the SAME transport-error boundary as the first
    // dispatch: a connect/timeout failure here surfaces through the existing
    // catch that maps transport errors to 502/504, attributed to the retry
    // account (B). No transient wrapper and no call back into the matcher: the
    // entire retry budget is spent by this one different-account HTTP dispatch.
    try {
      upstreamResponse = await fetchWithHeaderTimeout(
        request.url,
        {
          method: request.method,
          headers: request.headers,
          body: request.body,
        },
        upstream.signal,
        connectMs,
        parsed.stream,
        providerFetch(route.provider),
      );
    } catch (err) {
      // Route through the existing transport-error helper (same code path the
      // first dispatch uses at core.ts:941 region); health/log attribution is B.
      throw err; // caught by the surrounding dispatch transport boundary
    }
  }
}

const headers = sanitizePassthroughHeaders(upstreamResponse.headers);
```

Implementation audit notes for this sketch:

- Import and use existing `stripCodexRuntimeProviderFields`; otherwise the second
  adapter can retain the first account's runtime override.
- Extracting the duplicated fetch body into a private local dispatch function is
  acceptable and preferred if it keeps `handleResponses` readable. The helper
  must take the concrete request/provider and must not recurse or own selection.
- The existing catch behavior at lines 952-965 must be extracted/reused around
  the second dispatch. A second-attempt connect failure returns the existing 502
  and records against the second account; it must not retry that same account or
  select a third account.
- The first 400 response body is canceled only after alternate auth and request
  construction succeed. If no alternate exists or alternate auth cannot be
  resolved, preserve and return the original 400 unchanged.
- After the switch, all existing quota, terminal-recorder, response logging, and
  health logic must observe the final `authCtx`, provider, and response. Do not
  record success for the first account.
- `recordCodexUpstreamOutcome(config, firstAuthCtx.accountId, 400, ...)` is a
  deliberate no-op health-wise. The existing `caller` early return remains the
  policy owner; do not special-case health in the new matcher.
- A second allow-listed 400 passes directly to current response forwarding. There
  is no loop and no third `resolveCodexAuthContext` call.
- A 5xx/connect failure from B also ends the request after B's single dispatch;
  the pre-existing same-account transient helper remains confined to the initial
  dispatch so this repair's retry can never target the same account.

### 4. `src/codex/routing.ts` — explicit no-diff policy pin

The following real signatures and branches remain byte-for-byte unchanged:

```ts
export function classifyCodexUpstreamOutcome(
  outcome: CodexUpstreamOutcome,
): CodexUpstreamOutcomeClass {
  // ...
  if (outcome >= 400 && outcome < 500) return "caller";
  // ...
}

export function pickLowestUsageCodexAccount(
  config: OcxConfig,
  excludeId?: string,
  now = Date.now(),
): string | null

export function recordCodexUpstreamOutcome(
  config: OcxConfig,
  accountId: string | null,
  outcome: CodexUpstreamOutcome,
  meta: CodexUpstreamOutcomeMeta = {},
): void {
  // ...
  if (outcomeClass === "caller") return;
  // ...
}
```

`pickLowestUsageCodexAccount(config, firstAccountId)` already supplies the exact
eligibility and exclusion semantics needed by auth resolution: reauth-needed,
hard-cooldown, soft-avoided, unusable, and the excluded account are omitted.

Eligibility definition (ELIGIBLE-01, binding): "eligible" for the retry target B
means credential/health eligible ONLY — not reauth-needed, not hard-cooled,
usable credential, and not account A. There is NO per-model capability
predicate in the pool (routing.ts:246/285 have no model dimension), so whether
B supports the routed model is UNKNOWN until the single bounded probe runs; a
second allow-listed 400 from B is the expected negative outcome and is returned
directly (no third dispatch). Pool mutation between A's selection and the
retry selection is handled best-effort at selection time: the retry re-reads
the pool snapshot at the retry point; if no eligible B exists at that moment,
the original A response is returned unchanged.

Account-context republication (WS-REBIND-01, binding): the initial auth context
is published via `options.onCodexAuthContextResolved` (core.ts:744-746) and the
WebSocket layer registers the socket under that account (index.ts:594,
websocket-registry.ts:37). A successful retry MUST republish the final context
(`options.onCodexAuthContextResolved?.(retryAuthCtx)` — included in the retry
sketch above) so the registry migrates A -> B; otherwise invalidating B leaves
a stale A-bound socket and invalidating A closes a B-backed socket.

## Test plan and activation scenarios

### `tests/codex-auth-context.test.ts`

Add a second stored account fixture only inside the new cases and clear its
credential/reauth state in cleanup.

1. **Exclusion selects another eligible account.** Configure `pool-a` active and
   usable, `pool-b` usable, and deterministic quota scores. Call the real API:

   ```ts
   await resolveCodexAuthContext(headers, config, "pool", {
     excludeAccountId: "pool-a",
   });
   ```

   Assert `accountId === "pool-b"`, B's token/account header values are returned,
   and `config.activeCodexAccountId` remains `pool-a`.

2. **Exclusion fails closed with no alternate.** With only usable `pool-a`, call
   the same API excluding `pool-a`; assert `CodexPoolAuthenticationError`. It must
   not return `main`, use the inbound bearer, or retry `pool-a`.

### `tests/server-auth.test.ts`

Use `redirectCanonicalCodexTo`, two saved test credentials, deterministic quotas,
and an upstream server that records `authorization` / `chatgpt-account-id` and
returns account-specific responses. Assertions must observe the public
`/v1/responses` behavior, dispatch count/order, response fidelity, and
`getCodexUpstreamHealth`.

#### Activation A — allow-listed 400 and at least two eligible accounts

- A receives the exact payload for the requested model and returns 400.
- B returns 200.
- Assert dispatch accounts are exactly `[A, B]`; B differs from A.
- Assert the client gets B's successful response.
- Assert health for A and B is `null` (A's 400 has zero penalty; B's clean success
  creates no failure state).
- Assert the configured active account is still A (request-local selection).

#### Activation B — allow-listed 400 and only one eligible account

- A returns the exact allow-listed 400; no usable B exists.
- Assert one upstream dispatch only.
- Assert status, sanitized headers, and body equal A's original response.
- Assert A health is `null` and active account remains A.

#### Activation C — non-allow-listed malformed-input 400

- A returns `{"detail":"Invalid request: malformed tool schema"}` with B eligible.
- Assert one upstream dispatch only and B is never contacted.
- Assert the same 400 body reaches the client.
- Assert A and B health are `null` and neither is marked reauth-needed.

This scenario is mandatory and is the security regression proving broad keyword
or status matching did not turn malformed caller input into a cross-account quota
burn.

#### Activation D — second account also returns the allow-listed 400

- A and B both return the exact sentence for the requested model.
- Assert dispatch order/count is exactly `[A, B]` / 2.
- Assert B's final 400 reaches the client.
- Assert there is no third dispatch, no return to A, and both health states are
  `null`.

#### Activation E — both stream modes share the pre-response commitment boundary

Run both halves below as a table over `streamMode: "legacy-tee"` and
`streamMode: "eager-relay"`. Because the production gate consults `streamMode`
only for win32 without item-ID repair, the endpoint test must temporarily set
`process.platform` to `"win32"`, keep `responsesItemIdRepair` disabled, and restore
the original descriptor in `finally` (the repository already uses this pattern in
`tests/config.test.ts:758-830`). Do not treat setting `streamMode` on a non-Windows
test as coverage of the eager branch.

- Positive half: send `stream: true`; A returns the exact HTTP 400 before any SSE
  response and B returns a valid completed SSE stream. Assert the client receives
  only B's frames and dispatch count/order is exactly `[A, B]` under each mode.
- Negative half: A returns HTTP 200 then an SSE `response.failed` payload containing
  the same sentence. Assert dispatch count/order is `[A]` under each mode and the
  failure frames come from A. This proves neither the tee inspector nor the eager
  producer can reactivate account retry after the response/relay boundary.
- Keep the platform override serial and tightly scoped so unrelated endpoint cases
  cannot observe the synthetic platform.

### Mandatory negative activation matrix — hostile/non-authorizing bodies

Every case below uses two eligible accounts and records dispatch order. Rows 1-8
(the hostile/no-authorization bodies) share this invariant: one dispatch (`[A]`),
no request to B, client receives A's original 400 status/sanitized headers/body
bytes unchanged, and null health for both accounts. Rows 9-10 (the retry-failure
negatives) use their row-specific assertions instead: row 9 preserves A after a
failed alternate resolution (`[A]` only), row 10 dispatches `[A,B]` with the
transport failure attributed to B and no third attempt. Use
`readBoundedResponseBody`'s real timeout/truncation/oversize/display-safety
behavior; do not replace the production reader with a permissive test stub.

| Name (mandatory test) | Fixture/activation | Observable assertion |
|---|---|---|
| `oversized 400 body never authorizes a pool retry` | A returns a body larger than 64 KiB whose retained prefix resembles or contains the allow-listed JSON sentence | Reader reports unsafe oversized/truncated inspection; dispatches are `[A]`; B is untouched; the original 400 status/headers/full body are returned unchanged |
| `stalled 400 body timeout never authorizes a pool retry` | A's clone-readable body emits a partial allow-listed-looking JSON prefix, stalls beyond the configured inactivity/total deadline, then is released for client read | Timeout/display-unsafe branch executes; dispatches are `[A]`; after release the client receives A's original 400 bytes and headers unchanged |
| `aborted 400 inspection never authorizes a pool retry` | Abort the request signal while bounded clone inspection is pending on A's 400 body | Abort is caught only as matcher-false; B is untouched (no second dispatch). NOTE: the request abort also cancels A's upstream fetch (core.ts links options.abortSignal to upstream.signal and aborts the controller on request-signal fire), so the original body is NOT observable post-abort — assert the client-cancel outcome (aborted response surface), never body fidelity. If original-body fidelity must be exercised, use a matcher-local inspection signal decoupled from the request signal |
| `invalid JSON 400 never authorizes a pool retry` | A returns `{"detail":` or non-JSON text with content type JSON | JSON parse fails; dispatches are `[A]`; exact malformed bytes and original 400 metadata reach the client |
| `missing or non-string detail never authorizes a pool retry` | Table-driven A bodies: `{}`, `{"detail":null}`, `{"detail":400}`, `{"detail":{"message":"..."}}` | Every subcase dispatches once, never contacts B, and returns that exact original body/status |
| `wrong model id in exact sentence never authorizes a pool retry` | Requested route model is `gpt-5.6-sol`, but A's otherwise exact sentence names `other-model` | Model interpolation mismatch keeps dispatches at `[A]`; original 400 is unchanged |
| `normalization near-misses never authorize a pool retry` | Table-driven near misses outside the allow-list: removed terminal period, changed quote characters, extra prefix/suffix text, or punctuation removal; include one whitespace/case-only variant as the positive control | Every near miss returns A unchanged with no B dispatch; only the whitespace/case-only positive control may dispatch `[A,B]`, proving normalization is narrow |
| `valid JSON wrong top-level shape never authorizes a pool retry` | Table-driven A bodies that parse as valid JSON but are not objects: `"string"`, `42`, `true`, `null`, `["detail"]` | Non-object top-level rejection branch fires; dispatches are `[A]`; exact original bytes/status reach the client |
| `alternate account resolution failure preserves the original 400` | Allow-listed 400 from A; the retry-target credential refresh throws (auth-context.ts:126 path) or the only alternate is hard-cooled at the retry snapshot | Resolution failure is swallowed; dispatches are `[A]`; A's original 400 status/headers/body are returned unchanged; no health mutation for either account |
| `retry-dispatch transport failure records only B and never triple-dispatches` | Allow-listed 400 from A; B's dispatch throws a connect/timeout transport error through the existing boundary (core.ts:941 region) | Dispatch order is `[A,B]` with no third attempt; the transport failure surfaces through the existing transport-error path attributed to B; A's health remains untouched |

These ten named tests (eight hostile-body plus two retry-failure negatives) are
additional to Activations A–E. A shared parameterized harness is allowed, but
each class must appear by name in test output and assert response fidelity (or
its row-specific retry-failure assertion), not only dispatch count.

The three rows added after audit round 1 (wrong top-level shape, alternate
resolution failure, retry transport failure) are equally mandatory, bringing the
negative matrix to ten named tests.

Additionally mandatory (WS-REBIND-01 activation): a WebSocket-mode test in which
account A returns the allow-listed 400 and the retry succeeds on B — assert
`onCodexAuthContextResolved` fires twice (A then B) and the WebSocket account
registry ends bound to B (registry migration A -> B).

### `tests/codex-routing.test.ts` policy-preservation gate

Do not change the existing assertions at lines 217-226. Run the test and ensure
400, 404, and 422 still produce no health object and do not move future routing
away from account A. The endpoint scenarios add stronger per-account assertions;
they do not replace this test.

### Test hygiene

- Reset both A and B credentials, reauth flags, quota state, upstream health, and
  thread map after each scenario.
- Use synthetic account IDs/tokens only; never include a real email, token,
  ChatGPT account ID, or raw local path in fixtures/log snapshots.
- Do not add skips, weaken assertions, lower coverage, or introduce test-only
  production branches.

## Security-review checkpoint

This checkpoint is mandatory before merge under `MAINTAINERS.md` because the diff
changes authentication/account-selection behavior.

### Threat model

- **Assets:** pooled OAuth credentials, account quota, caller request integrity,
  thread/account routing state, and privacy-safe logs.
- **Entrypoint:** an untrusted ChatGPT backend HTTP 400 body plus the caller's
  requested model ID.
- **Trust boundary:** upstream free text authorizes one additional credentialed
  request under another account. A false positive can spend another account's
  quota; an unbounded retry can amplify cost.
- **Attacker/failure capability:** malformed caller input can induce arbitrary
  400s; an upstream/proxy can return large, stalled, invalid, or crafted bodies;
  account credentials can become unusable between selection and dispatch.
- **Controls:** exact status, exact top-level field, model-bound full-sentence
  equality, bounded clone read, one excluded-account selection, one non-recursive
  retry, existing eligibility checks, zero health penalty, no body/token logging,
  and no activation after either client relay is constructed.
- **Residual risk:** upstream wording changes cause a false negative (no retry),
  which preserves current behavior and is safer than a false-positive quota burn.

### Reviewer checklist

- [ ] A maintainer explicitly performs security review; author self-approval is
      not sufficient.
- [ ] PR targets `dev`, not `main`.
- [ ] Matcher accepts only the evidence-backed `detail` template and requested
      model; generic phrase cases are negative tests.
- [ ] Alternate selection excludes the first account and uses existing
      eligibility checks; no caller bearer fallback occurs.
- [ ] Dispatch count is bounded and cannot recurse; double rejection is exactly
      two account dispatches.
- [ ] No client-facing response/relay exists before the retry decision; both
      `legacy-tee` and `eager-relay` commitment scenarios are covered.
- [ ] `classifyCodexUpstreamOutcome` and caller-health behavior are unchanged.
- [ ] No credential, account identifier, request body, or raw upstream body is
      added to logs or error diagnostics.
- [ ] Full typecheck/test/privacy gates pass on the reviewed commit.

## Privacy notes

- The matcher reads an already-received bounded clone in memory and retains no
  new data.
- Do not log `detail`, model/account tuples, access tokens, ChatGPT account IDs,
  email addresses, request bodies, or authorization headers.
- Existing provider log labels may update to the final account through the normal
  sanitized formatter; this cycle adds no dedicated diagnostics field.
- Test fixtures use `pool-a`, `pool-b`, fake bearer values, and `.example.test`
  identities only.
- `bun run privacy:scan` is a hard completion gate.

## Docs-site sync decision

**No `docs-site/` change.** This repairs internal Pool dispatch behavior without a
new setting, command, endpoint, model catalog entry, error contract, or user action.
The upstream 400 or alternate response remains the public wire response when the
bounded retry cannot recover. Documenting exact private backend wording would also
create a brittle public contract. If a future cycle adds configurable retry policy
or diagnostics fields, that cycle must update the English docs source and verify
translations do not contradict it.

## Verification (C)

Run from repository root at the implementation commit:

```bash
bun test tests/codex-auth-context.test.ts
bun test tests/server-auth.test.ts
bun test tests/codex-routing.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

Expected result for every command: exit code 0. The focused endpoint test output
must name all activation scenarios A-E and all ten mandatory negatives (eight
hostile-body + two retry-failure). Completion evidence records command,
commit SHA, exit code, pass/fail counts, and the explicit security-review result.

## Acceptance criteria

- [ ] Exact captured `detail` from A with at least two eligible accounts dispatches
      once to B and can recover.
- [ ] The retry account is credential/health eligible (ELIGIBLE-01) and not A;
      model support on B is probed, not assumed.
- [ ] One eligible account returns the original 400 without another dispatch.
- [ ] Malformed-input/non-allow-listed 400 never contacts B.
- [ ] A successful retry republishes the auth context (WS-REBIND-01): the
      WebSocket registry migrates A -> B.
- [ ] Alternate-resolution failure and B transport failure behave per the two
      dedicated negative tests (original 400 preserved / no third dispatch).
- [ ] A then B allow-listed rejection stops at two dispatches and returns B's 400.
- [ ] Streaming requests retry only on an HTTP 400 before response/relay
      construction; HTTP 200/SSE terminal failures never retry under either
      `legacy-tee` or `eager-relay`.
- [ ] A's allow-listed 400 creates no health penalty, cooldown, soft avoid, reauth
      state, active-account mutation, or global affinity rewrite.
- [ ] `classifyCodexUpstreamOutcome` and its pinned 4xx test are unchanged and green.
- [ ] Response body/status/header fidelity is retained whenever no retry occurs.
- [ ] No secrets/PII/account IDs or raw bodies are newly logged.
- [ ] Security reviewer approves the auth-boundary refinement and the PR states
      its intentional relationship to `35d28a02`.
- [ ] Focused tests, full typecheck/test, and privacy scan all exit 0.
