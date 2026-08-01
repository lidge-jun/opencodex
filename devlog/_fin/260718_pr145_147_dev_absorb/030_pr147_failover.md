# 030 — PR #147 execution slice on `dev`: isolated per-target failover

## 1. Scope and dependency

This slice lands on the green 020 tip and rebuilds PR #147's runtime failover while
closing the Sol P0/P1 execution findings. The target is local `dev`, **not `main`**.
The immutable contributor source is
`6824e7bc56f5d0b1fc6fbb6089797a951ecb4eda`; reviewed behavior is at `a4abda10`.

The central decision is **fresh concrete request re-entry**: the outer combo request
selects a target, clones the original client JSON, rewrites only `model` and a missing
combo default effort, and calls the existing `handleResponses` pipeline for that
concrete `provider/model`. A failed pre-commit response is classified, cooled, and the
next target re-enters from another fresh clone.

This avoids carrying mutable `route`, OAuth snapshots, adapters, image-stripped parsed
state, or effort-clamped parsed state across providers. It also preserves current
provider-local recovery (transient passthrough retry, key-pool 429 rotation, xAI 401
refresh, Anthropic 413 image tightening) inside each target before combo failover.

Attribution follows `000_plan.md`:

- only source-faithful cooldown storage/expiry/reset plumbing reconstructed from PR #147:
  author `Wibias <37517432+Wibias@users.noreply.github.com>`, maintainer committer;
- the narrowed hop/stop policy (which intentionally differs from the source PR's
  generic-other-4xx hop), recursive isolation, bounded failure-body handling,
  all-adapter coverage, runTurn preflight, post-hop safety, and OAuth leak repair:
  maintainer author
  `bitkyc08-arch <bitkyc08@gmail.com>` plus
  `Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>`;
- every commit body cites PR #147, source head `6824e7bc...`, and reviewed head
  `a4abda10` for repaired behavior.

### Exclusions and failover boundary

- 040 owns catalog capability derivation and durable per-attempt usage attribution. 030
  owns all failure-body consumption, sanitized Retry-After handoff, and the internal
  consumed-failure callback; 040 may only add the optional usage snapshot captured during
  those same bounded reads.
- Failover is allowed only before a response is committed to the client. A 2xx SSE
  whose first meaningful event has been accepted is never replayed after later stream
  failure; retrying could duplicate tool calls or output.
- No hedging or parallel requests. Targets remain serial and bounded by target count.
- No automatic retry for client-shape/context/origin errors.
- No GUI, release, push, GitHub write, or source-ref rewrite.

## 2. Current-`dev` and PR-head evidence

Required inspection:

```bash
git diff dev...codex/source-pr147-6824e7bc -- \
  src/server/responses.ts src/router.ts src/combos \
  tests/combos.test.ts tests/server-combo-failover-e2e.test.ts
git show codex/source-pr147-6824e7bc:src/server/responses.ts | nl -ba | \
  sed -n '620,1220p'
nl -ba src/server/responses.ts | sed -n '422,1176p'
```

Current `dev` has four mutually exclusive execution exits before the ordinary HTTP
recovery loop:

- passthrough: `src/server/responses.ts:732-896`;
- `adapter.runTurn`: `src/server/responses.ts:898-954`;
- routed web-search loop: `src/server/responses.ts:956-1002`;
- ordinary HTTP adapter: `src/server/responses.ts:1004-1175`.

PR #147 inserts combo hop logic only into the fourth branch after provider-local
recovery. Its first target determines `isXaiOAuthRequest` at PR-head `responses.ts:639`;
the hop mutates route/provider/adapter at `:1119-1132` but not that boolean. A backup
401 therefore enters the first target's xAI refresh branch at `:1031-1060` and can
install a refreshed xAI bearer into the backup route. The same in-place hop retains
first-target vision/effort mutations and reaches the final parse branch using an
adapter shape that may differ from the adapter which produced the response, causing
the observed openai-chat → openai-responses HTTP 500.

Current `dev` additionally maps every ordinary fetch rejection, including caller abort,
to 502 at `src/server/responses.ts:1022-1028`, before any PR combo recovery location.
The final ordinary failure is consumed with unbounded `.text()` at `:1135-1140`, while
passthrough JSON consumes first at `:875-887`. Input usage is captured once at
`:1008-1011`; 040 will attach it to each target and refresh it on provider-local rebuilds.

## 3. Runtime contract

### 3.1 Attempt ordering and existence-gated interception

1. Read the outer JSON once and detect a literal `combo/<id>` before previous-response
   expansion or any parsed-body mutation, but intercept only when
   `Object.hasOwn(config.combos ?? {}, id)` is true. Unknown combo IDs and the landed
   backward-compatible physical provider named `combo` when no combos exist continue
   through `routeModel` unchanged.
2. Select through 020. For each target, `structuredClone` the untouched outer JSON,
   rewrite `model` to `<provider>/<model>`, and apply combo `defaultEffort` only when
   `reasoning` is absent or is an object that does not own `effort`. `reasoning:null`
   and owned string values are preserved and therefore suppress combo default injection.
3. Re-enter `handleResponses` with an internal `comboAttempt: true` guard. The concrete
   invocation performs the current full parse, previous-response expansion, virtual
   model handling, target effort policy, target vision policy, target auth/OAuth,
   transport resolution, adapter selection, sidecars, and provider-local recovery.
4. A 2xx response commits the selected target and calls `noteComboSuccess`.
5. A pre-commit connection error or retryable non-2xx response is secret-redacted,
   cooled, and advanced. 030 performs the 64 KiB/5 s bounded read at every original-body
   owner, publishes one `ConsumedComboFailure`, and carries only validated Retry-After
   into cooldown calculation. 040 may enrich that object with usage captured during the
   same read; it does not own consumption or add a second read.
6. A stop-class failure or exhausted target set returns the last sanitized failure.

Provider-local recovery always precedes cross-provider recovery because it occurs
inside the concrete child invocation. A xAI 401 refresh, same-provider key-pool 429
rotation, or Anthropic image-tier 413 retry can succeed without moving the combo.

### 3.2 Failure classification

`hop`:

- synthetic connection/timeout 502;
- 401/403 permission/auth gate (another provider may have valid entitlement/key);
- 404 model missing on one provider;
- 408, 429, and any 5xx;
- classified `permission_denied`, `subscription_required`, `invalid_api_key`,
  `insufficient_quota`, `rate_limit_exceeded`, `server_is_overloaded`, or
  `upstream_server_error`.

`stop`:

- `origin_rejected`, `context_length_exceeded`, or `invalid_request_error`;
- 400, 409, 413 after provider-local image retry is exhausted, and unclassified
  4xx other than 401/403/404/408/429;
- cancellation/499. Caller cancellation is first-wins: it returns a deterministic 499
  envelope without cooling the current target or attempting another target.

A hopped target receives a cooldown. Numeric/date `Retry-After` is clamped to
`1..600000 ms`; missing/invalid values use 60 s. Stop failures do not poison target
health. Attempt exclusions guarantee each normalized `provider/model` appears at most
once in one outer request, even if cooldown state changes concurrently.

### 3.3 Commit and callback-publication boundary by adapter path

| Path | Pre-commit failure eligible for hop | Commit point |
|---|---|---|
| ordinary HTTP | thrown connect/timeout or final non-2xx after local recovery | final 2xx headers |
| passthrough (including Azure) | thrown connect/timeout or non-2xx headers after transient retry | 2xx headers before relay; only the selected child's buffered terminal/cancel callbacks become publishable |
| runTurn | first non-heartbeat event is `error`, or stream closes before meaningful event | first non-heartbeat non-error event; non-stream completes without leading error |
| web-search loop | eager first iteration returns non-2xx | returned 2xx SSE response |

After commit, later stream `response.failed` is logged but never causes a new target.
A failed child's passthrough inspection callbacks are discarded even if its content type
claims SSE; they can neither finalize the parent request log nor race the selected child.

### 3.4 `defaultEffort` malformed/ignored-value compatibility

030 does not harden the current Responses parser. Current `dev` accepts
`reasoning:null` and arbitrary string efforts (`src/responses/schema.ts:125-128,143`),
then maps an empty/unknown string to no effective `parsed.options.reasoning`
(`src/responses/parser.ts:553-556`). The combo layer preserves those client-owned raw
values and does not replace them with the combo default:

| Raw client value | Combo clone | Current parser result |
|---|---|---|
| no `reasoning` | inject `{ effort: <default> }` | effective default |
| `{ summary:"concise" }` | preserve summary and inject effort | effective default |
| `reasoning:null` | preserve `null` | no effective effort; no 400 |
| `{ effort:"" }` | preserve empty string | no effective effort; no 400 |
| `{ effort:"banana" }` | preserve unknown string | no effective effort; no 400 |
| `{ effort:null }` | preserve owned null | existing schema rejects with 400 |

Tests lock both layers: `tests/combos.test.ts` asserts clone ownership/preservation, and
`tests/responses-parser.test.ts` asserts null/empty/unknown strings are ignored while a
non-string owned effort remains the existing schema error. Native passthrough treatment
of the preserved raw body remains the current non-combo contract; this slice adds no
parser or passthrough rewrite.

## 4. Diff-level implementation

### 4.1 `src/combos/failover.ts` — NEW — bounded cooldown plus maintainer failure policy

Reconstruct the source PR's cooldown mechanics, then add the maintainer-owned explicit
stop classes below. The source PR's final generic `status >= 400 && status < 500` hop is
not attributed as contributor behavior in the rebuilt history because it is not the
landed policy:

```ts
import { classifyError } from "../lib/errors";
import type { OcxComboTarget } from "../types";
import { targetKey } from "./types";

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;
const cooldowns = new Map<string, number>();

function mapKey(comboId: string, target: Pick<OcxComboTarget, "provider" | "model">): string {
  return `${comboId}\0${targetKey(target)}`;
}

export function isComboTargetInCooldown(comboId: string, target: OcxComboTarget, now = Date.now()): boolean {
  const key = mapKey(comboId, target);
  const until = cooldowns.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  cooldowns.delete(key);
  return false;
}

export function coolComboTarget(
  comboId: string,
  target: OcxComboTarget,
  options: { retryAfter?: string | null; now?: number; cooldownMs?: number } = {},
): void {
  const now = options.now ?? Date.now();
  const delay = options.cooldownMs ?? parseRetryAfterMs(options.retryAfter, now) ?? DEFAULT_COOLDOWN_MS;
  cooldowns.set(mapKey(comboId, target), now + Math.min(Math.max(1, delay), MAX_COOLDOWN_MS));
}

export type ComboFailureDecision = "hop" | "stop";

export function comboFailureDecision(status: number, message: string): ComboFailureDecision {
  if (status === 499) return "stop";
  const error = classifyError(status, "upstream_error", message);
  if (["origin_rejected", "context_length_exceeded", "invalid_request_error"].includes(error.code ?? "")) return "stop";
  if ([401, 403, 404, 408, 429].includes(status) || status >= 500) return "hop";
  if ([
    "permission_denied", "subscription_required", "invalid_api_key",
    "insufficient_quota", "rate_limit_exceeded", "server_is_overloaded",
    "upstream_server_error",
  ].includes(error.code ?? "")) return "hop";
  return "stop";
}
```

Add `clearComboTargetCooldowns(comboId?)` and a pure exported
`parseRetryAfterMs(value, now)` for focused numeric/date/expired/malformed/clamp tests.

### 4.2 `src/combos/resolve.ts` — MODIFY — failure advancement without random state

Add:

```ts
export function noteComboFailure(comboId: string, target: OcxComboTarget): void {
  const state = selectionState.get(comboId);
  if (state?.activeKey === targetKey(target)) {
    delete state.activeKey;
    state.successes = 0;
  }
}

export function advanceComboAfterFailure(
  config: OcxConfig,
  pick: ComboPick,
  options: { retryAfter?: string | null; now?: number } = {},
): ComboPick | null {
  noteComboFailure(pick.comboId, pick.target);
  coolComboTarget(pick.comboId, pick.target, options);
  return pickComboTarget(config, pick.comboId, {
    exclude: pick.attempted,
    eligible: target => !isComboTargetInCooldown(pick.comboId, target, options.now),
  });
}
```

When `pickComboTarget` returns a new pick, its `attempted` array must preserve the prior
ordered keys and append exactly one new key. Do not rebuild it from a Set whose order
is incidental.

### 4.3 `src/combos/request.ts` — NEW — immutable raw request cloning/default effort

This file folds the safe half of PR commit `6824e7bc` into execution:

```ts
import type { OcxComboDefaultEffort, OcxComboTarget } from "../types";

export function comboIdFromRawBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const model = (body as { model?: unknown }).model;
  if (typeof model !== "string") return null;
  return parseComboModelId(model);
}

export function concreteComboRequestBody(
  body: unknown,
  target: Pick<OcxComboTarget, "provider" | "model">,
  defaultEffort: OcxComboDefaultEffort | null,
): Record<string, unknown> {
  const clone = structuredClone(body) as Record<string, unknown>;
  clone.model = `${target.provider}/${target.model}`;
  if (!defaultEffort) return clone;
  const reasoning = clone.reasoning;
  if (reasoning === undefined) {
    clone.reasoning = { effort: defaultEffort };
  } else if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)
    && !Object.prototype.hasOwnProperty.call(reasoning, "effort")) {
    clone.reasoning = { ...reasoning as Record<string, unknown>, effort: defaultEffort };
  }
  return clone;
}
```

Import `parseComboModelId` explicitly. If the client owns `effort` with null, empty, or
another invalid value, preserve it and let the ordinary parser/policy handle it; do not
silently reinterpret client-owned input as omitted. Per §3.4, `reasoning:null` and
unknown/empty strings are currently accepted and ignored, while a non-string
`reasoning.effort` is rejected by the existing schema. Do not claim a universal 400.

Add exact compatibility tests:

```ts
test("combo default respects client-owned ignored reasoning values", () => {
  expect(concreteComboRequestBody({ model: "combo/x", reasoning: null }, target, "high").reasoning).toBeNull();
  expect(concreteComboRequestBody(
    { model: "combo/x", reasoning: { effort: "banana" } }, target, "high",
  ).reasoning).toEqual({ effort: "banana" });
  expect(concreteComboRequestBody(
    { model: "combo/x", reasoning: { summary: "concise" } }, target, "high",
  ).reasoning).toEqual({ summary: "concise", effort: "high" });
});

test("current parser ignores null empty and unknown string efforts", () => {
  expect(parseRequest({ model: "p/m", input: "hi", reasoning: null }).options.reasoning).toBeUndefined();
  expect(parseRequest({ model: "p/m", input: "hi", reasoning: { effort: "" } }).options.reasoning).toBeUndefined();
  expect(parseRequest({ model: "p/m", input: "hi", reasoning: { effort: "banana" } }).options.reasoning).toBeUndefined();
  expect(() => parseRequest({ model: "p/m", input: "hi", reasoning: { effort: null } })).toThrow();
});
```

### 4.4 `src/combos/index.ts` — MODIFY — export 030 runtime functions

Add exports for `advanceComboAfterFailure`, `noteComboFailure`, cooldown helpers,
decision types, `comboIdFromRawBody`, and `concreteComboRequestBody`. Keep 020 exports
stable.

### 4.5 `src/server/management-api.ts` — MODIFY — reset cooldowns on combo mutation

020 PUT/DELETE already reset SWRR selection state. Extend both dynamic imports and both
post-save reset blocks; do not clear cooldowns on rejected requests. Apply these exact
before/after edits against the landed single-line imports and unchanged
validation/mutation/save bodies:

PUT before:

```ts
const { comboConfigError, normalizeComboConfig, comboModelId, clearComboSelectionState } = await import("../combos");
// ... validate, normalize, mutate, save ...
clearComboSelectionState(id);
```

PUT after:

```ts
const { comboConfigError, normalizeComboConfig, comboModelId, clearComboSelectionState, clearComboTargetCooldowns } = await import("../combos");
// ... validate, normalize, mutate, save ...
clearComboSelectionState(id);
clearComboTargetCooldowns(id);
```

DELETE before:

```ts
const { clearComboSelectionState } = await import("../combos");
// ... delete, collapse empty map, save ...
clearComboSelectionState(id);
```

DELETE after:

```ts
const { clearComboSelectionState, clearComboTargetCooldowns } = await import("../combos");
// ... delete, collapse empty map, save ...
clearComboSelectionState(id);
clearComboTargetCooldowns(id);
```

Modify `tests/combos.test.ts` with an API-level activation test: cool target
A for combo `free`, prove `isComboTargetInCooldown("free", A)` is true, then PUT-update
`free` and prove false; cool it again, DELETE `free`, and prove false again. Also cool a
target in combo `other` and prove both operations leave `other`'s cooldown intact. The
test must call `handleManagementAPI`, not the clear helper directly.

### 4.6 `src/adapters/run-turn-queue.ts` — MODIFY — combo-only first-event preflight primitive

Before, the public queue contract has only `push`, `close`, `stream`, and `collect`, and
`createAdapterEventQueue()` returns those four members (`src/adapters/run-turn-queue.ts:5-10,57`).
There is no way to inspect and replay the first semantic event.

Add a pure helper that consumes enough of an `AsyncIterable<AdapterEvent>` to decide
whether runTurn failed before commit while replaying every buffered event in order:

```ts
export interface AdapterEventPreflight {
  stream: AsyncIterable<AdapterEvent>;
  error?: Extract<AdapterEvent, { type: "error" }>;
  empty: boolean;
}

async function* replay(
  buffered: readonly AdapterEvent[],
  iterator: AsyncIterator<AdapterEvent>,
): AsyncGenerator<AdapterEvent> {
  try {
    for (const event of buffered) yield event;
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await iterator.return?.();
  }
}

export async function preflightAdapterEvents(source: AsyncIterable<AdapterEvent>): Promise<AdapterEventPreflight> {
  const iterator = source[Symbol.asyncIterator]();
  const buffered: AdapterEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return { stream: replay(buffered, iterator), empty: true };
    buffered.push(next.value);
    if (next.value.type === "heartbeat") continue;
    if (next.value.type === "error") {
      await iterator.return?.();
      return { stream: replay(buffered, iterator), error: next.value, empty: false };
    }
    return { stream: replay(buffered, iterator), empty: false };
  }
}
```

`replay` yields buffered events then the remaining iterator exactly once. An empty
source after only heartbeats is treated as pre-commit failure by the combo caller; the
helper itself does not synthesize HTTP responses.

### 4.7 `src/server/responses.ts` — MODIFY — outer combo loop plus guarded runTurn preflight

#### A. Extract and extend only the internal options shape

Move the current inline `options` object type into a module-local
`HandleResponsesOptions` interface without changing existing fields, then add:

```ts
    /** Internal recursion guard; callers outside this module must not set it. */
    comboAttempt?: boolean;
    /** 030-owned handoff when a child consumed the original failure under bounds. */
    onConsumedComboFailure?: (failure: ConsumedComboFailure) => void;
```

Change the function parameter to `options: HandleResponsesOptions = {}` and type the
helper below with the same interface. Do not expose a public header/query flag. The
option exists only on in-process calls.

#### B. Detect only configured combos immediately after JSON read

Current code reads JSON at `src/server/responses.ts:436-441`, then immediately expands
previous-response state at `:442-445`. Insert between those blocks:

Before:

```ts
  const originalBody = body;
  body = expandPreviousResponseInput(body);
```

After:

```ts
  const comboId = !options.comboAttempt ? comboIdFromRawBody(body) : null;
  if (comboId && Object.hasOwn(config.combos ?? {}, comboId)) {
    return handleComboResponses(req, body, comboId, config, logCtx, options);
  }
  const originalBody = body;
  body = expandPreviousResponseInput(body);
```

Detection must happen before `expandPreviousResponseInput`, encrypted-content rewrite,
parse, effort mutation, or image mutation, but the own-property check is mandatory.
`combo/unknown` falls through to the existing `routeModel` error contract, and
`combo/model` with a physical provider named `combo` and no configured combos falls
through to that physical provider. Every configured combo child performs the mutations
once from the same untouched outer body.

#### C. Own bounded original-body consumption and Retry-After handoff in 030

Required shape:

```ts
import { readBoundedResponseBody } from "../lib/bounded-body";

interface ConsumedComboFailure {
  response: Response;
  classificationText: string;
  /** Valid numeric/date value used only for cooldown calculation. */
  retryAfter?: string;
}

// REUSE the module-local comboUnavailableResponse() already defined in this file
// at src/server/responses.ts:423-430. Do not import it from src/combos and do not
// export or redefine it. Its direct envelope avoids formatErrorResponse/
// classifyError rewriting 503 to "server_is_overloaded".
// Activation (post-030): PATCH-disable-all members → full engine request →
// response JSON asserts error.code === "combo_unavailable" (not
// server_is_overloaded), status 503, zero default/member/backup hits.

function sanitizedRetryAfter(value: string | null, now: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  // parseRetryAfterMs returns number | undefined (source-faithful), not null:
  return parseRetryAfterMs(trimmed, now) !== undefined ? trimmed : undefined;
}

async function consumeComboFailure(
  response: Response,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<ConsumedComboFailure> {
  const fallback = `Provider error ${response.status}`;
  let classificationText = fallback;
  try {
    const body = await readBoundedResponseBody(response, { signal });
    if (body.displaySafe) {
      const safeText = redactSecretString(body.text).slice(0, 500);
      if (safeText) classificationText = safeText;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    classificationText = fallback;
  }
  const message = classificationText === fallback
    ? fallback
    : `${fallback}: ${classificationText}`;
  const retryAfter = sanitizedRetryAfter(response.headers.get("retry-after"), now);
  return {
    response: formatErrorResponse(response.status, "upstream_error", message),
    classificationText,
    ...(retryAfter ? { retryAfter } : {}),
  };
}

// At passthrough JSON, before the existing upstreamResponse.text() at current :875:
if (!upstreamResponse.ok && options.comboAttempt) {
  const failure = await consumeComboFailure(upstreamResponse, options.abortSignal);
  options.onConsumedComboFailure?.(failure);
  return failure.response;
}
const text = await upstreamResponse.text(); // unchanged success/non-combo behavior

// At the ordinary final failure, replacing the current unbounded combo read at :1135:
if (!upstreamResponse.ok && options.comboAttempt) {
  const failure = await consumeComboFailure(upstreamResponse, options.abortSignal)
    .finally(cleanupUpstreamAbort);
  options.onConsumedComboFailure?.(failure);
  return failure.response;
}
// Existing non-combo upstreamResponse.text(), cleanup, and error mapping stay unchanged.

async function handleComboResponses(
  req: Request,
  rawBody: unknown,
  comboId: string,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions,
): Promise<Response> {
  Object.assign(logCtx, {
    requestedModel: `combo/${comboId}`,
    model: `combo/${comboId}`,
    provider: "combo",
  });
  const combo = getCombo(config, comboId);
  if (!combo) return formatErrorResponse(404, "invalid_request_error", `Unknown combo: ${comboId}`);

  const initialNow = Date.now();
  let pick = pickComboTarget(config, comboId, {
    eligible: target => !isComboTargetInCooldown(comboId, target, initialNow),
  });
  if (!pick) {
    return comboUnavailableResponse(`No available targets for combo: ${comboId}`);
  }
  let lastFailure: Response | null = null;
  while (pick) {
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    const childLog: RequestLogContext = { model: pick.target.model, provider: pick.target.provider };
    const childBody = concreteComboRequestBody(rawBody, pick.target, comboDefaultEffort(config, comboId));
    const childHeaders = new Headers(req.headers);
    childHeaders.delete("content-length");
    const childRequest = new Request(req.url, {
      method: req.method,
      headers: childHeaders,
      body: JSON.stringify(childBody),
    });
    let resolvedAuth: CodexAuthContext | undefined;
    let terminalRecorder: ((status: ResponsesTerminalStatus) => void) | undefined;
    const started = Date.now();
    let consumedChildFailure: ConsumedComboFailure | undefined;
    const callbackGate = createChildPassthroughCallbackGate(options);
    let response: Response;
    try {
      response = await handleResponses(childRequest, config, childLog, {
        ...options,
        comboAttempt: true,
        onCodexAuthContextResolved: value => { resolvedAuth = value; },
        setTerminalOutcomeRecorder: value => { terminalRecorder = value; },
        onConsumedComboFailure: value => { consumedChildFailure = value; },
        onNativePassthroughTerminal: callbackGate.onTerminal,
        onNativePassthroughCancel: callbackGate.onCancel,
      });
    } catch (error) {
      callbackGate.discard();
      if (options.abortSignal?.aborted) return clientCancelledResponse();
      throw error;
    }

    // Abort check FIRST — before the success branch. An adapter that does not
    // promptly honor cancellation can still resolve 2xx after the client
    // aborted; committing it would run noteComboSuccess / publish callbacks
    // against a dead request. First-wins: cancelled beats success.
    if (options.abortSignal?.aborted) {
      callbackGate.discard();
      return clientCancelledResponse();
    }

    if (response.ok) {
      noteComboSuccess(comboId, combo, pick.target);
      Object.assign(logCtx, childLog, { requestedModel: `combo/${comboId}` });
      options.onCodexAuthContextResolved?.(resolvedAuth);
      options.setTerminalOutcomeRecorder?.(terminalRecorder);
      callbackGate.commit();
      return response;
    }

    callbackGate.discard();
    if (response.status === 499) {
      return clientCancelledResponse();
    }
    let failure: ConsumedComboFailure;
    try {
      failure = consumedChildFailure
        ?? await consumeComboFailure(response, options.abortSignal);
    } catch (error) {
      if (options.abortSignal?.aborted) return clientCancelledResponse();
      throw error;
    }
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    lastFailure = failure.response;
    if (comboFailureDecision(response.status, failure.classificationText) === "stop") {
      Object.assign(logCtx, childLog, { requestedModel: `combo/${comboId}` });
      return lastFailure;
    }
    console.warn(`[combo] ${comboId}: ${targetKey(pick.target)} failed with ${response.status} after ${Date.now() - started}ms`);
    pick = advanceComboAfterFailure(config, pick, {
      retryAfter: failure.retryAfter,
      now: Date.now(),
    });
  }
  return lastFailure!;
}
```

The existing module-local `comboUnavailableResponse(message)` is the sole wire mapper for
selection unavailability. Import only `NoAvailableComboTargetsError`; the landed
route-error boundary already calls the local helper when
`err instanceof NoAvailableComboTargetsError`, and direct 030 interception calls it when
its initial `pickComboTarget` returns null. Both therefore produce status 503 with
`error.type === "server_error"` and `error.code === "combo_unavailable"`.
Neither branch may use `upstream_error`, enter normal model fallback, or synthesize a
physical target. `lastFailure!` is safe after the explicit initial-null return: loop
exhaustion after at least one real attempt returns that last sanitized upstream failure.

The existing route boundary becomes:

```ts
  try {
    route = routeModel(config, parsed.modelId);
  } catch (err) {
    if (err instanceof NoAvailableComboTargetsError) {
      return comboUnavailableResponse(err.message);
    }
    return formatErrorResponse(
      404,
      "invalid_request_error",
      err instanceof Error ? err.message : String(err),
    );
  }
```

030 invokes the bounded consumer at both original-body sites before either can call
unbounded `.text()`, populates `ConsumedComboFailure`, and publishes it through the
internal-only callback. The outer fallback calls the same consumer only for a
still-untouched body; no path reads a reconstructed response after the callback fires.
The default helper limits are the required 64 KiB and 5 s. A complete bounded body is
redacted and capped to 500 display characters; stalled, oversized, or otherwise unsafe
content returns the status-only sanitized envelope and is canceled.

Retry-After is parsed and sanitized once at original-response ownership and carried on
`failure.retryAfter` only for cooldown calculation. It is never recovered from the
sanitized wrapper and never forwarded as an arbitrary client header. 040 may add
`usage?: OcxUsage`, pass `logCtx` into this same bounded helper, and inspect only its
retained text; it must not restore `.text()`, move read ownership, or add another reader.

Do not publish a failed child's auth context, terminal recorder, or native passthrough
callbacks to the outer caller. 040 extends the failure object with usage/attempt records;
it does not pre-invent a second body reader or log format.

#### D. Buffer native passthrough callbacks until the child commits

The current passthrough SSE branch at `src/server/responses.ts:837-859` can inspect a
non-2xx response whose content type claims SSE and invoke terminal/cancel callbacks. The
top-level callbacks finalize the one request log at `src/server/index.ts:400-417`, so
passing them through lets failed A finalize the parent before B succeeds.

Add an invocation-local child gate with three states: `pending`, `committed`, and
`discarded`. While pending, record at most the first terminal/cancel outcome without
calling the parent callback. On selected `response.ok`, `commit()` publishes that buffered
outcome once and delegates future selected-stream outcomes; on any failed child,
`discard()` drops buffered state and makes future calls no-ops. Always override both
callback fields after `...options`, as shown in §4.7C, so a child cannot inherit parent
callbacks accidentally. Required first-wins shape:

```ts
function createChildPassthroughCallbackGate(options: HandleResponsesOptions) {
  type Pending =
    | { kind: "terminal"; status: ResponsesTerminalStatus }
    | { kind: "cancel" };
  let state: "pending" | "committed" | "discarded" = "pending";
  let pending: Pending | undefined;
  let accepted = false;
  const publish = (value: Pending): void => {
    if (value.kind === "terminal") options.onNativePassthroughTerminal?.(value.status);
    else options.onNativePassthroughCancel?.();
  };
  const receive = (value: Pending): void => {
    if (state === "discarded" || accepted) return;
    accepted = true;
    if (state === "committed") return publish(value);
    pending ??= value;
  };
  return {
    onTerminal: (status: ResponsesTerminalStatus) => receive({ kind: "terminal", status }),
    onCancel: () => receive({ kind: "cancel" }),
    commit: () => {
      if (state !== "pending") return;
      state = "committed";
      if (pending) publish(pending);
      pending = undefined;
    },
    discard: () => { state = "discarded"; pending = undefined; },
  };
}
```

Also require `upstreamResponse.ok` before entering the
passthrough SSE inspection/relay branch. A non-2xx SSE-shaped body remains an untouched
failure for bounded consumption rather than a terminal stream.

#### E. Make client cancellation a first-wins 499 stop

Add a module-local `clientCancelledResponse()` that returns
`formatErrorResponse(499, "client_cancelled", "Client cancelled request")`. In both the
passthrough fetch catch (`src/server/responses.ts:774-781`) and ordinary fetch/rebuild
catches (`:1022-1028`, `:1052-1058`), check the caller signal before mapping the error:
`options.abortSignal?.aborted` returns the deterministic 499; a provider timeout or
connection error remains 502.

At the outer loop, check the signal before each child, immediately after each child
returns, and after bounded body consumption. If `readBoundedResponseBody` rethrows the
caller abort reason, catch it at this boundary and return the same 499 envelope. These
checks precede failure classification, `noteComboFailure`, cooldown mutation, warning
emission, and `advanceComboAfterFailure`. Therefore cancellation during A's connect or
failed-body read leaves B hit count at zero and does not poison A's health. A timeout
owned by the bounded reader is not a client abort: it produces the safe status-only
failure and may advance normally.

#### F. Preflight `runTurn` only for concrete combo attempts

Before current streaming return at `src/server/responses.ts:920-940`:

```ts
    if (parsed.stream) {
      void runTurn();
      let eventSource: AsyncIterable<AdapterEvent> = queue.stream();
      if (options.comboAttempt) {
        const preflight = await preflightAdapterEvents(eventSource);
        if (preflight.error || preflight.empty) {
          runTurnAbort.abort();
          queue.close();
          const message = preflight.error?.message ?? "Adapter ended before producing a response";
          return formatErrorResponse(502, "upstream_error", redactSecretString(message));
        }
        eventSource = preflight.stream;
      }
      const sseStream = bridgeToResponsesSSE(
        eventSource, parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
        () => {
          runTurnAbort.abort();
          queue.close();
        }, 2_000,
        {
          ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
          stallTimeoutSec: config.stallTimeoutSec,
          hideThinkingSummary: parsed.options.hideThinkingSummary,
          ...(routedCompaction ? { compaction: true } : {}),
          ...(routedCompaction ? {} : {
            onCompletedResponse: (completed: Record<string, unknown>) =>
              rememberResponseState(parsed._rawBody, completed, parsed._cursorConversationId),
          }),
        },
      );
```

For non-streaming `runTurn`, after collect and before `buildResponseJSON`, if
`options.comboAttempt` and the first non-heartbeat event is `error` (or none exists),
return sanitized 502. Once any text/thinking/tool/done event precedes an error, preserve
current response behavior and do not hop.

#### G. Leave target-local auth and recovery structurally local

Do not transplant PR's `applyComboRoute` or mutable hop block into the ordinary HTTP
recovery loop. Current variables at `src/server/responses.ts:610-675`, especially
`isXaiOAuthRequest` and `sentOAuthSnapshot`, remain invocation-local. Current provider
key rotation and image retry at `:1031-1141` remain unchanged except 040's later usage
instrumentation. Provider-owned connection/timeout catches continue returning 502;
caller aborts are the new 499 stop and never reach target advancement.

This is the P0 invariant:

```ts
const isXaiOAuthRequest = route.providerName === "xai" && route.provider.authMode === "oauth";
```

It is recomputed inside each concrete child and never updated or reused by another
target. `forceRefreshOAuthAccessSnapshot` can only receive a snapshot created in the
same child whose current route is still xAI.

### 4.8 `tests/run-turn-queue.test.ts` — MODIFY — exact preflight/replay behavior

Cover heartbeat→error (preflight error, no duplicate events), heartbeat→text→done
(success and full replay order), heartbeat→text→error (committed replay contains each
event exactly once), immediate done (commit), empty close (empty failure), and iterator
cancellation after leading error.

### 4.9 `tests/combos.test.ts` — MODIFY — cooldown/failure/advance branches

Add exact tests for numeric/date/invalid/expired/clamped Retry-After; cooldown expiry;
stop/hop matrix; failure clears sticky without counting a success; advancement preserves
ordered attempted keys; every target attempted once; exhausted returns null; state and
cooldown resets are independent.

### 4.10 `tests/server-combo-failover-e2e.test.ts` — NEW/RE-DERIVE — fault matrix

The PR's one openai-chat 403→openai-chat 200 case is insufficient. Build isolated
`OPENCODEX_HOME` fixtures and call either the real server or `handleResponses` directly.
Use `Bun.serve` for HTTP adapters and a scoped `globalThis.fetch` stub only where the
built-in xAI URL/refresh endpoint must be intercepted. Restore every stub/server in
`afterEach`.

Required scenarios:

1. ordinary openai-chat A 503 → B 200, non-stream and stream;
2. A throws `TypeError("connect refused")` → B 200; assert B hit once and final 200;
3. Azure/openai-responses passthrough A 403 → openai-chat B 200;
4. openai-chat A 503 → key-auth openai-responses B 200; assert exact raw Responses JSON
   and no `Non-streaming not supported` 500;
5. Cursor/runTurn A with missing credential emits first-event error → openai-chat B 200;
6. web-search-enabled routed A eager iteration 503 → B 200; assert the request included
   hosted web_search so `planWebSearch` was non-null and A's loop path, not ordinary path,
   returned the failure;
7. context-length 400 A → stop; assert B hit count zero;
8. A 429 with `Retry-After: 120` → B 200; at controlled `t0 + 60 s` a second outer
   request still skips A (proving the value was not dropped in favor of the 60 s
   default), while at `t0 + 120 s` A is eligible again;
9. first target text-only/no sidecar A receives no raw image and returns 503; vision B
   receives the original image and returns 200;
10. first target effort ladder `["low"]` receives clamped low and returns 503; B ladder
    `["high"]` receives high from combo default; a client-owned low remains low on both;
11. backup `noReasoningModels` receives no reasoning field after A fails;
12. xAI same-attempt 401 refreshes once and then succeeds (positive control);
13. **leak regression**: xAI OAuth A returns 503, ordinary key-auth B returns 401. The
    fake xAI token endpoint records zero refresh calls, B's Authorization is exactly
    `Bearer key-b`, neither request contains the refreshed xAI token, and final status is
    401. Add C 200 in a companion case to prove B 401 can hop without leaking.
14. **committed stream no replay**: runTurn A emits `heartbeat`, one
    `{type:"text_delta",text:"once"}`, then `{type:"error",message:"late failure"}`.
    Fully consume the outer SSE and assert A hit once, B hit zero, exactly one
    `response.output_text.delta` carrying `once`, exactly one `response.failed`, and no
    `response.completed`. This is the executable post-commit boundary proof; the queue
    unit alone is insufficient.
15. **post-030 all-disabled activation**: create combo A/B through the management API,
    PATCH-disable A and B while enabled default provider C remains configured, reload
    the file-backed config, then request literal `combo/free` through the full 030
    `handleResponses` engine. Assert status 503 with `error.type === "server_error"` and
    `error.code === "combo_unavailable"`, with zero A/B upstream hits, zero backup hits, and zero C
    default-provider hits. This must exercise 030's outer interception, not `routeModel`
    or `pickComboTarget` directly.
16. **existence-gate regressions**: with `config.combos` absent and a physical provider
    named `combo`, request `combo/model` through full `handleResponses` and assert the
    physical upstream receives model `model` and returns 200. Separately request an
    unknown `combo/missing` while another combo exists and assert the unchanged
    `routeModel` 404 contract with zero configured-member/default-provider hits.
17. **failed-child callback isolation**: passthrough A returns non-2xx SSE-shaped content
    containing a terminal frame, then passthrough B returns a successful terminal stream.
    Exercise the top-level terminal/cancel callbacks used by `src/server/index.ts` and
    assert exactly one finalization, sourced from B; A's terminal/cancel callbacks remain
    unpublished before and after the hop.
18. **connect cancellation first-wins**: A's fetch waits on its signal; abort the client
    while A is connecting. Assert status 499 with `error.code === "client_cancelled"`, B
    hit zero, no warning/cooldown/advance for A, and one `client_cancel` finalization.
19. **failure-body cancellation first-wins**: A returns retryable headers then stalls its
    error body; abort while 030's bounded reader owns the body. Assert the same 499
    envelope, B hit zero, and no cooldown/advance.
20. **bounded original-body owners**: ordinary A returns an error body larger than
    64 KiB and passthrough-JSON A returns a body that does not finish within 5 s. In both
    cases assert the original body is canceled at the bound, the client sees only the
    status-only sanitized error (no retained hostile prefix), and the combo can advance
    once to B. Include read/cancel counters so a second read of a reconstructed wrapper
    would fail the test.

For scenario 13 seed a non-expired xAI credential through `saveCredential("xai", ...)`,
intercept inference by requested URL/header, and make any refresh-endpoint call increment
`refreshHits` before returning a sentinel `xai-refreshed-secret`. Assertions must search
all captured backup headers/bodies for that sentinel, not only count refresh calls.

The committed-stream scenario must include assertions equivalent to:

```ts
const response = await postCombo("combo/free", { stream: true });
const frames = await collectSse(response);
expect(aHits).toBe(1);
expect(bHits).toBe(0);
expect(frames.filter(frame => frame.event === "response.output_text.delta"))
  .toEqual([expect.objectContaining({ data: expect.objectContaining({ delta: "once" }) })]);
expect(frames.filter(frame => frame.event === "response.failed")).toHaveLength(1);
expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
```

## 5. Conditional-path activation matrix

| Conditional path | Fault injection | Observable proving it fired |
|---|---|---|
| configured combo interception | raw model `combo/free`, own config entry present | concrete upstream bodies contain target models; no literal combo reaches upstream |
| combo existence gate | no combos + physical provider `combo`; unknown ID while another combo exists | physical `combo/model` reaches provider and returns 200; unknown ID keeps routeModel 404 with no member/default hit |
| recursion guard | child model `a/m` with `comboAttempt` | one child call per target; no recursive combo loop |
| default effort omitted | no raw reasoning | target body receives normalized default |
| client effort owns field | `low`, `reasoning:null`, empty/unknown string, non-string effort | low preserved; null/empty/unknown ignored by current parser; non-string gets existing 400; never overwritten |
| provider-local recovery wins | xAI 401→refresh→200 / key 429→next key | same target succeeds; backup hit zero |
| ordinary non-2xx hop | A 503 | A then B hit order, final 200 |
| connection exception hop | A fetch throws | child 502 then B 200; backup hit one |
| passthrough hop | Azure A 403 | passthrough A then ordinary B |
| runTurn precommit hop | Cursor first event error | child 502 and B 200 |
| runTurn committed stream | heartbeat→text→error | no B hit; one response stream with terminal failure |
| web-search eager failure | hosted web_search, first model iteration 503 | loop-path marker/A hit then B 200 |
| cross-adapter success | chat A 503, Responses B 200 | exact B response, no 500 |
| hop classification | 401/403/404/408/429/5xx | backup hit |
| stop classification | context 400/origin/499/413 | backup hit zero |
| client abort during connect/body read | abort A before commit | deterministic 499 `client_cancelled`; B hit zero; no cooldown/advance |
| Retry-After numeric/date | fixed `now`, including 429 `Retry-After: 120` | A still cooling at +60 s and eligible at +120 s; exact boundary, not default 60 s |
| malformed/expired Retry-After | bad/past value | default 60 s |
| target exhaustion | all retryable failures | each key once; final sanitized last status |
| initial target unavailable at 030 tip | PATCH-disable all members, reload, full `handleResponses` request | 503 `combo_unavailable`; no member/default/backup hit |
| target-specific vision | A noVision, B vision | A body image-free; B body contains original image |
| target-specific effort | A low ladder, B high ladder | captured wire efforts low then high |
| backup no reasoning | B in noReasoning list | B body omits effort |
| xAI refresh positive | xAI child 401 | refresh exactly once, same provider gets new bearer |
| xAI leak negative (P0) | xAI A 503, key B 401 | refresh zero, backup bearer remains key-b, sentinel absent |
| auth callback publication | failed A auth context, successful B context | outer callback sees B only |
| passthrough callback publication | failed SSE-shaped A then successful B | one parent finalization from B; A terminal/cancel discarded |
| bounded original-body owners | ordinary >64 KiB and passthrough JSON stalled >5 s | one read/cancel at each real owner; status-only safe error; no untrusted prefix leaked |
| combo PUT/DELETE cooldown reset | cool `free`, invoke management API PUT then DELETE | `free` cleared after each; `other` unchanged |
| post-commit stream failure | A heartbeat→text `once`→error | A hit1, B hit0, one text delta, one `response.failed`, no replay/completed |

## 6. Commit plan and attribution

Estimated commit count: **3**.

1. `feat(combos): reconstruct target cooldown plumbing`
   - Author `Wibias <37517432+Wibias@users.noreply.github.com>`; maintainer committer.
   - Source-faithful cooldown map, Retry-After parsing/clamp, clear helper, combo
     PUT/DELETE clear wiring, barrel exports, and pure/API reset tests only.
   - Explicitly excludes `comboFailureDecision`, resolver failure semantics, and the
     source PR's generic-other-4xx hop policy.
2. `fix(combos): isolate every provider attempt through the full response pipeline`
   - Author `bitkyc08-arch <bitkyc08@gmail.com>` + exact Wibias co-author trailer above.
   - Maintainer-owned narrowed hop/stop policy, resolver failure semantics, raw-body
     cloning, outer combo recursion, bounded errors, runTurn preflight, all adapter
     paths, target-specific safety, and P0 OAuth isolation.
3. `test(combos): fault-inject failover auth adapter and safety paths`
   - Author `bitkyc08-arch <bitkyc08@gmail.com>` + exact Wibias co-author trailer above.
   - runTurn queue tests and full e2e matrix.

No commit may introduce the PR's mutable `applyComboRoute` pattern even temporarily.

## 7. Verification gates

Focused runtime/security:

```bash
bun test --isolate \
  tests/combos.test.ts \
  tests/run-turn-queue.test.ts \
  tests/server-combo-failover-e2e.test.ts \
  tests/responses-parser.test.ts \
  tests/oauth-refresh.test.ts \
  tests/key-failover.test.ts \
  tests/anthropic-image-retry-e2e.test.ts \
  tests/vision-fail-closed.test.ts \
  tests/vision-sidecar-e2e.test.ts \
  tests/web-search.test.ts \
  tests/web-search-timeout-plan.test.ts
bun run typecheck
```

Full 030 tip:

```bash
bun test --isolate ./tests/
bun run privacy:scan
git diff --check
```

Structural assertions:

```bash
rg -n "applyComboRoute|let isXaiOAuthRequest|Math\.random" src/server/responses.ts src/combos
rg -n "comboAttempt|handleComboResponses|preflightAdapterEvents|readBoundedResponseBody|onConsumedComboFailure|clientCancelledResponse" \
  src/server/responses.ts src/adapters/run-turn-queue.ts
rg -n "upstreamResponse\.text\(\)" src/server/responses.ts
git diff --name-only HEAD~3..HEAD
```

The first command has no matches. `isXaiOAuthRequest` remains `const` in the concrete
pipeline. The changed-file list is limited to §4 files.

## 8. Rollback

Revert commits in reverse order. Remove 030 exports/helpers and restore the single
current `handleResponses` entry path; leave 020 domain/config/API intact. Existing combo
models then resolve only their initially selected target and have no cross-provider
recovery, which is a coherent 020-only rollback state. Clear in-memory combo state by
restarting the process; no persisted migration or credential rewrite is required.

If the leak regression ever fails, stop before 040: do not ship a partial mitigation,
disable combo execution or revert all of 030. Never delete OAuth credentials as rollback.

## 9. Findings closure

| Finding | Closure in 030 | Proof |
|---|---|---|
| P0 xAI OAuth token leaks to backup after hop | each target is a new `handleResponses` invocation; route, snapshot, auth, adapter are lexical child state; failed auth callbacks not published | xAI 503→backup 401 sentinel test plus xAI 401 positive control |
| P1 passthrough/runTurn/web-search return before combo recovery | outer wrapper sees every child pre-commit Response; combo-only runTurn first-event preflight | path-specific passthrough, Cursor, web-search tests |
| P1 connection exception returns 502 before recovery | child retains current 502; outer classifies 502 and advances | unreachable A→B 200 with backup hit |
| P1 cross-adapter hop uses wrong parse path | each target builds and returns through its own full adapter branch | chat 503→Responses 200, no non-streaming 500 |
| P1 post-hop vision/effort not recomputed | every child starts from untouched raw clone and runs target policies | captured A/B image and effort wire bodies |
| literal `combo/*` interception breaks physical provider compatibility | outer interception requires an own `config.combos` entry; all other IDs fall through to `routeModel` | no-combo physical-provider 200 plus unknown-ID unchanged 404 rows |
| original failures are consumed unbounded and lose Retry-After before the outer reader | 030 bounded-reads both ordinary and passthrough JSON original sites, publishes `ConsumedComboFailure`, and carries sanitized Retry-After directly | 429 remains cool through +60 s; oversized/stalled one-read activation at both owners |
| failed passthrough A can finalize the parent before B | per-child terminal/cancel gate publishes only after selected-response commit | SSE-shaped failed A → B success, exactly one B finalization |
| caller abort is mapped to retryable 502 | child catches and outer body-read boundary return first-wins 499 before health mutation/advance | abort during A connect and A body read: B hit0, no cooldown |
| post-review defaultEffort application | raw own-property-aware injection once per fresh target; current parser's ignored-value semantics preserved; target clamp follows only effective efforts | omitted/custom/client-owned null/empty/unknown/non-string and incompatible-target cases |
| cooldown reset promised by 020 | combo PUT/DELETE clear only that combo's cooldown state after successful save | management-API activation test with `free` and untouched `other` |
| committed-stream no replay | post-commit error stays inside selected stream and never re-enters outer target loop | A heartbeat→text→error E2E: B hit0, one delta, one terminal failure |
| 020 `combo_unavailable` lost at 030 interception | the existing module-local `responses.ts` mapper handles both typed route failure and initial direct-pick null; no `src/combos` import/export | post-030 PATCH-disable-all E2E: 503 `combo_unavailable`, no default/member/backup hit |

## 10. 030 done gate

030 is complete only when all four adapter paths demonstrate a pre-commit hop, connection
failure reaches a backup, cross-adapter responses return through the correct branch,
vision/effort wire captures prove fresh target state, xAI positive refresh still works,
the P0 negative test proves zero cross-provider token movement, committed streams never
replay, interception preserves physical-provider/unknown-ID compatibility, both original
failure owners are bounded and retain valid Retry-After, failed-child callbacks cannot
finalize the parent, connect/body-read cancellation returns first-wins 499 with no backup
hit, the full 030 engine preserves `combo_unavailable` for an initial all-disabled or
all-cooling target set without any fallback hit, and focused/full/typecheck/privacy gates
are green at the 030 tip.

## Audit fold-back 2026-07-18

- Blocker 1: made 030's per-adapter commit-boundary `noteComboSuccess` the explicit
  production activation point for the intentionally pinned 020-tip selector.
- Blocker 3: added the concrete management-API MODIFY and an API-level PUT/DELETE
  cooldown-reset activation test with cross-combo isolation.
- Blocker 4: replaced the false universal-400 claim with current parser compatibility:
  null/empty/unknown strings are ignored, non-string effort is the existing schema 400;
  no parser hardening is planned.
- Blocker 5: added a fully consumed heartbeat→text→error E2E asserting zero backup hits,
  one output delta, one terminal failure, and no replay/completion.
- Blocker 6: supplied executable `replay` and bounded failure-consumption bodies.
- Blocker 7: limited the Wibias-authored commit to source-faithful cooldown/reset
  plumbing; the changed failure policy and response architecture are maintainer-authored
  with the Wibias co-author trailer.
- Rebuttal: none; the audit blockers were accepted as stated.

### Round 3

- R3 (HIGH): preserved 020's fail-closed selection contract across 030's earlier combo
  interception. Both `NoAvailableComboTargetsError` at the route boundary and an
  initial null from direct `pickComboTarget` now use
  `comboUnavailableResponse(message)` and return 503 `combo_unavailable`; added the
  PATCH-disable-all full-engine activation with no member, backup, or default-provider
  hit.
- Cross-doc interface sync for 040 (HIGH): additively extended
  `ConsumedComboFailure` with `usage?: OcxUsage` and added the internal-only
  `HandleResponsesOptions.onConsumedComboFailure` callback. The pre-build round-4 fold
  below supersedes its original ownership split: 030 now creates and publishes the base
  failure at both bounded original-body sites, while 040 adds only optional usage.

## Round 4 changelog (2026-07-18, main agent)

- Blocker 1 (round-4): `comboUnavailableResponse` no longer routes through
  `formatErrorResponse`/`classifyError` (which rewrites 503 to
  `server_is_overloaded`, src/lib/errors.ts:58); the mapper constructs the
  `combo_unavailable` envelope directly and the post-030 activation asserts
  `error.code === "combo_unavailable"`. Rebuttal: none.
- Landed-owner correction: `comboUnavailableResponse` is module-local at
  `src/server/responses.ts:423-430`, not exported from `src/combos`; every 030 call site
  reuses that local function directly.

### Pre-build fold-back round 4 (2026-07-18)

- Blocker 1 (HIGH), §§3.1, 4.7B, 4.10, and §5: made interception own-property gated
  with `Object.hasOwn(config.combos ?? {}, comboId)`. Unknown IDs and the zero-combo
  physical provider named `combo` fall through to `routeModel`; both have explicit
  full-engine regression rows.
- Blocker 2 (HIGH), §§1, 3.1, and 4.7C: moved bounded 64 KiB/5 s consumption and
  sanitized Retry-After ownership fully into 030 at both original-body sites. 030 now
  creates/publishes `ConsumedComboFailure` with `retryAfter`; 040 may add only optional
  usage from the same bounded read. Activation proves `Retry-After: 120` survives beyond
  the 60 s default and oversized/stalled bodies stop at the bound without a second read.
- Blocker 3 (HIGH), §§3.3, 4.7D, 4.10, and §5: added a pending/committed/discarded
  per-child passthrough callback gate and an upstream-ok SSE guard. Failed A callbacks
  are discarded; failed-A→successful-B proves exactly one parent finalization from B.
- Blocker 4 (HIGH), §§3.2, 4.7E, 4.10, and §5: caller abort now wins before
  classification, cooldown, or advancement and returns deterministic 499
  `client_cancelled`. Connect-abort and failed-body-abort cases both require B hit zero.
- Blocker 5 (MEDIUM), §§4.5, 4.7C, 4.8, and §7: corrected the local
  `comboUnavailableResponse` ownership, aligned PUT/DELETE snippets to landed
  `management-api.ts`, moved management tests to `tests/combos.test.ts`, and marked the
  existing `tests/run-turn-queue.test.ts` as MODIFY.
- Rebuttal: none; all five pre-build blockers were accepted.

## Pre-build fold-back round 5 (2026-07-18, main agent)

- Blocker (High, round-5): post-child abort check moved BEFORE the success
  branch in §4.7 engine snippet — an adapter resolving 2xx after client abort
  now discards the callback gate and returns 499 (no noteComboSuccess, no
  publication). Regression added to matrix: A resolves 200 after its signal
  aborted -> 499, zero success accounting, zero callback publication.
- Correction: sanitizedRetryAfter sentinel fixed to `!== undefined` matching
  source-faithful parseRetryAfterMs return type. Rebuttal: none.
