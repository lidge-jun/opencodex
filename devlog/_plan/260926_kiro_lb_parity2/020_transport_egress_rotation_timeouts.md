# 020 — Kiro transport: egress, endpoint rotation, deadline, public errors

- **Layer / branch:** 020 / `codex/kiro-lb2-020-transport`.
- **Depends on:** 010 (and merged #5937, `9c7c046520`, on `dev`); rebase these hunks against 010 before building. The source anchors below are the verified `bb3f3c2d0d` tree, not a claim about the future 010 head.
- **Adopted inventory rows:** E5, E2/H, E6, E7 in `001_research_gap_inventory.md`. Reference behavior was read from AGPL kiro-lb, never copied: `kiro/proxy_chain.py:176-198`, `kiro/http_client.py:603-653`, `kiro/network_errors.py:65-145,282-336`, `kiro/exceptions.py:27-36,102-125` at `bee73b3`.
- **Architect decisions:** D020-1 (all physical sends use the provider executor), D020-2 (one canonical-host 502/503/504 move inside the send budget), D020-3 (deadline versus caller abort; fixed public 5xx text).
- **Scope:** Kiro generation transport only. No new host dialect, account-level failover, credential mutation, or live AWS probe.

Cross-layer contract: 020's alternate URL is a second host send for the **same account**, inside that request's budget. It neither reads nor writes the 010 evidence identity `kiroEvidenceIdentity(account)` (SHA-256 hex of JSON `[account.id, account.loginId ?? String(account.addedAt ?? ""), cred.accountId ?? cred.email ?? "", cred.kiro?.profileArn ?? "", cred.kiro?.clientId ?? ""]`, SD1') or the routing accessor `kiroAccountEvidence(account, now?)` (SD2'), which hydrates once and checks identity, TTL, and reset on every read (SD1/SD2). A monthly-exhausted or suspended account refusal belongs to the single `rotateGenericOAuthAccountOnRefusal` loop in 030, with 040 capacity exclusion plugged into it: retain the original upstream refusal `Response` until a replacement is admitted, and return its original status/body if none is. Proactive account ranking/initial preference runs only under effective pool enablement; configured concurrency caps and refusal-aware initial exclusion still apply, while singleton/all-excluded pools still send to the active account (SD3/SD4). 050's catalogue uses `kiroUsageContextForAccount` (post-#5937 context at `9c7c046520:src/providers/kiro-usage.ts:214-230`) and `kiroManagementHost(ctx)` for its management request, with `builderIdFallback` preventing the Builder ID service ARN from choosing the region (SD6). 070 reports `autoSelectable` with `skipReason` as automatic-selection eligibility, not a guarantee that a singleton send is blocked (SD5). No 020 change may bypass the 010 evidence checks or create a second account-rotation loop.

## Current-state reading (`bb3f3c2d0d`)

| Function / contract | Evidence and consequence |
|---|---|
| `providerFetch` dispatch → `fetchResponse` | `src/server/responses/adapter-dispatch.ts:295-313,459-485` gives the adapter an egress-aware `executor` on both initial and ordinary recovery legs. `src/adapters/base.ts:170-176` exposes it in `AdapterFetchContext`. |
| `createKiroAdapter`, `fallbackFactory`, `fetchResponse`, `formatErrorBody` | `src/adapters/kiro/adapter.ts:53-77,179-189,225-250,316-335`: the per-turn closure carries abort, budget, and send observer into the completion fallback, but not executor. Its initial fetch forwards `ctx`; its fallback builds a new context. |
| `fetchWithResetRecovery` | `src/adapters/kiro-retry.ts:158-197`: each physical send reserves a transient dispatch, reports an ordinal, and retries only resets. Its call at lines 182-187 omits the sixth `fetchWithAttemptDeadline` argument. |
| `fetchWithAttemptDeadline` / `clearableDeadline` | `src/lib/upstream-retry.ts:462-487` defaults that sixth argument to `globalThis.fetch`; `src/lib/abort.ts:81-99` composes the parent and header deadline. The shared helper passes through executor rejections, including a deadline-triggered `TypeError`; `src/adapters/google-http.ts:72-74` calls it too, so normalization belongs in Kiro's supplied executor only. |
| `createAdapterPhysicalSend` | `src/adapters/physical-send.ts:11-49` is the house sequencing pattern: pacing before admission, one permit per actual invocation, then `unpacedFetch` or the executor. Kiro's own ordinal/reset accounting must preserve this order while threading the same executor. |
| `legacyUrl`, `endpointConnectFailure`, `inspectEndpointHttpFailure`, `fetchKiroAttempt` | `src/adapters/kiro-retry.ts:122-155,200-217,256-280`: only canonical `runtime.{region}.kiro.dev/` can become `q.{region}.amazonaws.com/`; connection errors and narrow endpoint signatures rotate. Plain 502/503/504 responses do not. The fallback is one hop; the fallback's own response is returned without another host decision. |
| `fetchKiroWithRetry`, `normalizeFinalKiroHttpError`, `inspectKiroThrottle` | `src/adapters/kiro-retry.ts:220-254,282-339`: bounded 429 recovery surrounds one endpoint attempt; normal mode normalizes final HTTP errors, while raw mode leaves bodies for adapter-level handling. The catch at 335-337 currently rethrows a deadline failure, so the Responses initial dispatch reports 502 at `src/server/responses/adapter-dispatch.ts:355-367` even though `describeUpstreamConnectFailure` calls it a timeout (`src/server/responses/upstream-error.ts:10-16`). |
| `classifyKiroFailure`, `classifyKiroHttpError`, `safeKiroHttpErrorMessage` | `src/adapters/kiro-errors.ts:82-87,95-177,191-208`: a sanitized, 500-character upstream detail is appended to the message and can become public 5xx text. The classifier and its code/retryability are useful internally. |
| `parseKiroStream` completion fallback | `src/adapters/kiro/stream.ts:1064-1087,1095-1108` classifies raw fallback HTTP bodies and yields `failure.message`; unlike the initial normalized path, this bypasses `safeKiroHttpErrorMessage`. It already maps a fallback `TimeoutError` to 504. Its prior-output rule is at `src/adapters/kiro/stream.ts:385-405`. |
| `normalizeUpstreamHttpErrorResponse` | `src/adapters/upstream-http-error.ts:24-48` reads only a bounded display-safe body, strips stale content headers, and runs a supplied formatter. No shared-module change is required. |

## File change map — apply after 010

All hunks are against `bb3f3c2d0d`; these are intended edits, not AGPL-derived code. Keep Kiro's existing reset and throttle ladders and the one request-scoped `sendBudget`. The new sibling test is fully specified below. `src/lib/upstream-retry.ts`, `src/adapters/google-http.ts`, and `src/adapters/upstream-http-error.ts` are READ ONLY. The Google regression below verifies the shared helper's existing rejection contract.

### MODIFY `src/adapters/kiro-retry.ts`

Preserve Kiro's per-send budget and observer, but wait for provider pacing before admission and dispatch with its unpaced executor. A missing `ctx.executor` still uses the global fetch for direct adapter callers. `ctx.executor` is passed for the initial send, reset retries, 429 retries, and the `q.*` leg because all invoke `fetchWithResetRecovery`.

```diff
@@
   for (let attempt = 0; attempt < RESET_ATTEMPTS; attempt++) {
     if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
+    const executor = (ctx.executor ?? globalThis.fetch) as typeof globalThis.fetch & {
+      waitForPacing?: (signal?: AbortSignal) => Promise<void>;
+      unpacedFetch?: typeof globalThis.fetch;
+    };
+    await executor.waitForPacing?.(ctx.abortSignal);
+    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
@@
-      }, timeoutMs, ctx.abortSignal, ctx.stream);
+      }, timeoutMs, ctx.abortSignal, ctx.stream, async (input, init) => {
+        try {
+          return await (executor.unpacedFetch ?? executor)(input, init);
+        } catch (error) {
+          // Only Kiro translates a rejection caused by this attempt's header timer.
+          if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
+          const signal = init?.signal;
+          if (signal?.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError") {
+            throw signal.reason;
+          }
+          throw error;
+        }
+      });
@@
 async function inspectEndpointHttpFailure(
@@
   if (response.status === 404 || response.status === 405) return { response, fallback: true };
+  // A returned gateway error proves a completed HTTP attempt, before any Kiro event bytes.
+  if (response.status === 502 || response.status === 503 || response.status === 504) {
+    return { response, fallback: true };
+  }
   if (response.status !== 400 && response.status !== 403) return { response, fallback: false };
@@
   } catch (error) {
     releaseKiroThrottleProbe(probeToken);
+    if (ctx.abortSignal?.aborted) throw abortError(ctx.abortSignal);
+    if (error instanceof Error && error.name === "TimeoutError") {
+      return new Response("Kiro upstream gateway timeout", { status: 504 });
+    }
     throw error;
   }
```

The 5xx guard runs only when `legacyUrl(request.url)` exists (`src/adapters/kiro-retry.ts:262,271`); it never treats a 500/501 or an arbitrary custom host as proof of an endpoint mismatch. Only that gateway response body is cancelled before host rotation (`src/adapters/kiro-retry.ts:274-277`); an account refusal owned by 030 must remain intact through its admission decision (SD3). The alternate invokes `fetchWithResetRecovery` once and cannot recursively rotate. A budget refusal stays a `SendBudgetExhaustedError`, not a free send or a fabricated provider response. Keep 429, account 400/403, reset, and post-output behavior as they are.

### MODIFY `src/adapters/kiro/adapter.ts`

```diff
@@
   let requestAbortSignal: AbortSignal | undefined;
+  let requestExecutor: typeof globalThis.fetch | undefined;
@@
       const response = await fetchKiroWithRetry(retry.request, {
         abortSignal: requestAbortSignal,
+        ...(requestExecutor ? { executor: requestExecutor } : {}),
         returnRawErrors: true,
@@
       if (ctx?.abortSignal) requestAbortSignal = ctx.abortSignal;
+      requestExecutor = ctx?.executor;
       if (ctx?.sendBudget) requestSendBudget = ctx.sendBudget;
```

The variable lives only in the per-request adapter closure (`src/adapters/kiro/adapter.ts:53-77`), not in a persisted account. Re-assign on each `fetchResponse` call, including `undefined`, so a reused adapter cannot retain an older executor.

### MODIFY `src/adapters/kiro-errors.ts`

Keep `classifyKiroHttpError`'s classification behavior for retry and account decisions. For HTTP 5xx, neither the public formatter nor opt-in provider diagnostics may receive its free-form `message`: `src/lib/debug.ts:15-31` writes diagnostic details to both the in-memory ring and stderr, and redaction cannot recognize an unlabelled secret echoed inside upstream JSON. Emit only a closed-set HTTP status bucket and classification code. No upstream header, raw body, parsed field, token, device code, client secret, or message enters those sinks (SD7).

```diff
@@
 import { parseUpstreamJsonPayload, safeUpstreamErrorString, sanitizeUpstreamErrorText } from "./upstream-http-error";
+import { debugProviderDiagnostic } from "../lib/debug";
@@
 const DETAIL_KEYS = ["__type", "code", "error", "name", "reason", "message", "Message", "errorMessage"];
+const KIRO_5XX_DIAGNOSTIC_STATUSES = new Set([500, 502, 503, 504]);
@@
 export function safeKiroHttpErrorMessage(status: number, headers: Headers | Record<string, unknown>, payloadText: string): string {
-  return classifyKiroFailure(headers, payloadText, status).message;
+  const failure = classifyKiroFailure(headers, payloadText, status);
+  if (status >= 500) {
+    debugProviderDiagnostic("kiro", "http_error", {
+      status: KIRO_5XX_DIAGNOSTIC_STATUSES.has(status) ? status : "other_5xx",
+      code: failure.code === "server_is_overloaded" ? "server_is_overloaded" : "upstream_server_error",
+    });
+    return status === 504 ? "Kiro upstream gateway timeout" : "Kiro upstream service unavailable";
+  }
+  return failure.message;
 }
```

The code expression deliberately reduces all other classifier results to `upstream_server_error`; adding a classifier code later cannot turn upstream text into a diagnostic. `other_5xx` is a fixed bucket, not the raw status or body. The same formatter is used by the initial normalized response and the raw completion-fallback path below.

### MODIFY `src/adapters/kiro/stream.ts`

This closes the completion fallback's raw-response leak. Do not change its status, code, retryability, or prior-output rule.

```diff
@@
   classifyKiroStreamError,
   safeKiroErrorMessage,
+  safeKiroHttpErrorMessage,
   type KiroErrorClassification,
@@
       yield {
         type: "error",
-        message: failure.message,
+        message: safeKiroHttpErrorMessage(fallback.response.status, fallback.response.headers, payload),
         status: failure.status,
```

Apply the second hunk specifically at `src/adapters/kiro/stream.ts:1099-1106` (the earlier `message: failure.message` in `classifiedTerminal` must stay unchanged). The bounded reader at line 1097 still owns raw-body consumption.

### MODIFY `tests/providers/kiro/kiro-retry.test.ts`

The current test at `tests/providers/kiro/kiro-retry.test.ts:235-243` asserts canonical 503 does not rotate. Narrow its ordinary-5xx negative case to 500; the new sibling covers 502/503/504.

```diff
@@
   test("does not replay ordinary 5xx responses", async () => {
     const mock = mockFetch([
-      new Response("temporarily unavailable", { status: 503, headers: { "Retry-After": "0" } }),
+      new Response("temporarily unavailable", { status: 500, headers: { "Retry-After": "0" } }),
       new Response("ok", { status: 200 }),
     ]);
     const res = await fetchKiroWithRetry(request, { timeoutMs: 5_000 });
-    expect(res.status).toBe(503);
+    expect(res.status).toBe(500);
     expect(mock.calls).toHaveLength(1);
   });
```

### MODIFY `tests/adapters/google/google-vertex-http.test.ts`

Add this regression under `describe("vertex retry fetch", ...)` (`tests/adapters/google/google-vertex-http.test.ts:32`): Google still receives the executor's own `TypeError` after a header timeout, rather than a Kiro-normalized `TimeoutError`. No Google production path or shared helper changes. The three physical sends are the existing `TRANSIENT_RETRY_MAX_ATTEMPTS` in `src/lib/upstream-retry.ts:157`.

```diff
@@
 describe("vertex retry fetch", () => {
+  test("Google preserves the executor TypeError after its header deadline", async () => {
+    const original = new TypeError("google executor deadline rejection");
+    let sends = 0;
+    const executor = (async (_input: RequestInfo | URL, init?: RequestInit) => {
+      sends += 1;
+      return await new Promise<Response>((_resolve, reject) => {
+        const signal = init?.signal;
+        if (signal?.aborted) reject(original);
+        else signal?.addEventListener("abort", () => reject(original), { once: true });
+      });
+    }) as typeof fetch;
+    await expect(fetchVertexWithRetry(request, { executor, timeoutMs: 1 })).rejects.toBe(original);
+    expect(sends).toBe(retry.TRANSIENT_RETRY_MAX_ATTEMPTS);
+  });
```

### NEW `tests/providers/kiro/kiro-transport-parity.test.ts`

Complete test skeleton. Implement with synthetic fetch only; no Kiro account, endpoint, or secret fixture. Keep each `test` body isolated with `resetKiroThrottleStateForTests()` after it.

```ts
import { afterEach, expect, spyOn, test } from "bun:test";
import type { AdapterRequest } from "../../../src/adapters/base";
import { fetchKiroWithRetry, resetKiroThrottleStateForTests } from "../../../src/adapters/kiro-retry";
import { safeKiroHttpErrorMessage } from "../../../src/adapters/kiro-errors";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../../../src/lib/debug-log-buffer";
import { clearDebugSetting, getDebugSettings, setDebugSettings } from "../../../src/lib/debug-settings";
import { createKiroAdapter } from "../../../src/adapters/kiro";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const request: AdapterRequest = {
  url: "https://runtime.us-east-1.kiro.dev/", method: "POST", headers: {}, body: "{}",
};
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; resetKiroThrottleStateForTests(); });

async function runCompletionFallback503() {
  const provider = {
    adapter: "kiro", baseUrl: "https://127.0.0.1", authMode: "oauth", apiKey: "fixture-token",
  } as unknown as OcxProviderConfig;
  const parsed = {
    modelId: "claude-sonnet-4.5", stream: true, options: {},
    context: { messages: [{ role: "user", content: "do it" }],
      tools: [{ name: "bash", description: "Run a shell command", parameters: { type: "object" } }] },
  } as unknown as OcxParsedRequest;
  const adapter = withTestTranslatorBudget(createKiroAdapter(provider));
  const built = await adapter.buildRequest(parsed);
  const frame = encodeMessage(
    { ":message-type": "event", ":event-type": "assistantResponseEvent" },
    new TextEncoder().encode(JSON.stringify({ content: "I am checking." })),
  );
  const urls: string[] = [];
  globalThis.fetch = (async () => { throw new Error("global fetch bypassed provider egress"); }) as typeof fetch;
  const executor = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    if (urls.length === 1) return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(frame); controller.close(); },
    }), { status: 200 });
    return new Response(JSON.stringify({ message: "private fallback incident marker" }), { status: 503 });
  }) as typeof fetch;
  const first = await adapter.fetchResponse!(built, { executor, stream: true });
  const events: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(first)) events.push(event);
  return { urls, events };
}

test("Kiro sends initial, reset, and alternate attempts through the supplied executor", async () => {
  const urls: string[] = [];
  const executor = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    if (urls.length === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    if (urls.length === 2) return new Response("bad gateway", { status: 502 });
    return new Response("ok");
  }) as typeof fetch;
  const result = await fetchKiroWithRetry(request, { executor, timeoutMs: 5_000 });
  expect(result.status).toBe(200);
  expect(urls).toEqual([request.url, request.url, "https://q.us-east-1.amazonaws.com/"]);
});

test("Kiro transient 429 retry uses the supplied executor", async () => {
  let sends = 0;
  const executor = (async () => {
    sends += 1;
    return sends === 1
      ? new Response("USER_REQUEST_RATE_EXCEEDED", { status: 429, headers: { "Retry-After": "0" } })
      : new Response("ok");
  }) as typeof fetch;
  expect((await fetchKiroWithRetry(request, { executor, timeoutMs: 5_000 })).status).toBe(200);
  expect(sends).toBe(2);
});

test("Kiro pacing refusal consumes no permit or physical ordinal", async () => {
  let reservations = 0;
  let sends = 0;
  const executor = Object.assign((async () => { sends += 1; return new Response("ok"); }) as typeof fetch, {
    waitForPacing: async () => { throw new Error("pacing refused"); },
  });
  const sendBudget = { reserveDispatch: () => { reservations += 1; throw new Error("unexpected reserve"); } } as never;
  const physical: number[] = [];
  await expect(fetchKiroWithRetry(request, {
    executor, sendBudget, onPhysicalSend: send => physical.push(send.ordinal),
  })).rejects.toThrow("pacing refused");
  expect({ reservations, sends, physical }).toEqual({ reservations: 0, sends: 0, physical: [] });
});

test("Kiro budget refusal prevents alternate dispatch", async () => {
  const urls: string[] = [];
  let reservations = 0;
  const executor = (async (input: RequestInfo | URL) => {
    urls.push(String(input)); return new Response("bad gateway", { status: 503 });
  }) as typeof fetch;
  const sendBudget = { reserveDispatch: () => {
    reservations += 1;
    return reservations === 1
      ? { allowed: true, permit: { use: () => true } }
      : { allowed: false, reason: "total-exhausted" };
  } } as never;
  await expect(fetchKiroWithRetry(request, { executor, sendBudget })).rejects.toMatchObject({
    name: "SendBudgetExhaustedError",
  });
  expect(urls).toEqual([request.url]);
});

test.each([502, 503, 504])("Kiro rotates a canonical HTTP %i once before output", async status => {
  const urls: string[] = [];
  const executor = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response("opaque", { status });
  }) as typeof fetch;
  const result = await fetchKiroWithRetry(request, { executor, timeoutMs: 5_000 });
  expect(result.status).toBe(status);
  expect(urls).toEqual([request.url, "https://q.us-east-1.amazonaws.com/"]);
  expect(await result.text()).not.toContain("opaque");
});

test("Kiro leaves an unrecognised upstream status and custom host on their original target", async () => {
  const urls: string[] = [];
  const executor = (async (input: RequestInfo | URL) => {
    urls.push(String(input)); return new Response("odd upstream", { status: 521 });
  }) as typeof fetch;
  const result = await fetchKiroWithRetry(request, { executor, timeoutMs: 5_000 });
  expect(result.status).toBe(521);
  expect(urls).toEqual([request.url]);
  const custom = { ...request, url: "https://example.invalid/generate" };
  await fetchKiroWithRetry(custom, { executor, timeoutMs: 5_000 });
  expect(urls.at(-1)).toBe(custom.url);
});

test("Kiro header deadline is 504 and a caller abort dispatches no alternate", async () => {
  const urls: string[] = [];
  const executor = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(new TypeError("fetch aborted")), { once: true });
    });
  }) as typeof fetch;
  const timed = await fetchKiroWithRetry(request, { executor, timeoutMs: 1 });
  expect(timed.status).toBe(504);
  expect(await timed.text()).toBe("Kiro upstream gateway timeout");
  expect(urls).toEqual([request.url]);
  const caller = new AbortController();
  caller.abort(new DOMException("caller closed", "AbortError"));
  await expect(fetchKiroWithRetry(request, { executor, abortSignal: caller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(urls).toEqual([request.url]);
});

test("Kiro in-flight caller abort keeps its original reason when executor rejects TypeError", async () => {
  const caller = new AbortController();
  const reason = new DOMException("caller closed during send", "AbortError");
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  let sends = 0;
  const executor = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sends += 1;
    markStarted();
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new TypeError("transport abort wrapper")), { once: true });
    });
  }) as typeof fetch;
  const pending = fetchKiroWithRetry(request, { executor, abortSignal: caller.signal, timeoutMs: 5_000 });
  await started;
  caller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(sends).toBe(1);
});

test("Kiro public 5xx formatter omits all upstream details", () => {
  const raw = JSON.stringify({ message: "private upstream incident marker" });
  for (const status of [500, 502, 503, 504, 521]) {
    const text = safeKiroHttpErrorMessage(status, new Headers(), raw);
    expect(text).not.toContain("private upstream incident marker");
    expect(text).toBe(status === 504 ? "Kiro upstream gateway timeout" : "Kiro upstream service unavailable");
  }
});

test("Kiro upstream marker never reaches debug ring, stderr, or client", async () => {
  const marker = "opaque-upstream-secret-marker-020";
  const priorDebug = getDebugSettings().runtimeOverride.debug;
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  resetDebugLogBufferForTests();
  setDebugSettings({ debug: true });
  try {
    const direct = await fetchKiroWithRetry({ ...request, url: "https://example.invalid/generate" }, {
      executor: (async () => new Response(JSON.stringify({ message: marker }), { status: 521 })) as typeof fetch,
    });
    expect(await direct.text()).toBe("Kiro upstream service unavailable");
    const { events } = await runCompletionFallback503();
    expect(JSON.stringify(events)).not.toContain("private fallback incident marker");
    const debugText = getDebugLogEntries().map(entry => entry.line).join("\n");
    const stderrText = stderr.mock.calls.map(args => args.join(" ")).join("\n");
    for (const forbidden of [marker, "private fallback incident marker"]) {
      expect(debugText).not.toContain(forbidden);
      expect(stderrText).not.toContain(forbidden);
      expect(JSON.stringify(events)).not.toContain(forbidden);
    }
    expect(debugText).toContain("[ocx:kiro:http_error]");
  } finally {
    stderr.mockRestore();
    if (priorDebug === undefined) clearDebugSetting("debug");
    else setDebugSettings({ debug: priorDebug });
    resetDebugLogBufferForTests();
  }
});

test("completion fallback retains the provider executor", async () => {
  const { urls } = await runCompletionFallback503();
  expect(urls).toEqual(["https://127.0.0.1/", "https://127.0.0.1/"]);
});

test("completion fallback 503 emits fixed public text", async () => {
  const { events } = await runCompletionFallback503();
  const terminal = events.at(-1);
  expect(terminal).toMatchObject({ type: "error", status: 503,
    message: "Kiro upstream service unavailable" });
  expect(JSON.stringify(events)).not.toContain("private fallback incident marker");
  expect(events.some(event => event.type === "done")).toBe(false);
});
```

The fixture follows `tests/providers/kiro/kiro-fallback-error-body.test.ts:55-113`: an incomplete but valid first event stream starts the adapter-owned completion fallback. Recheck `built.url` after 010 before asserting the two exact URLs; if its endpoint composition differs, compare both calls to that built URL. No production account or live call is involved.

## PLAN-FIELD-CHAIN-01

No persisted field, wire field, public enum, or config value is introduced. `requestExecutor` is a per-request closure variable: creation `src/adapters/kiro/adapter.ts` `fetchResponse` → serialization **N/A** (function must never enter a request snapshot or store) → deserialization **N/A** → consumer `fallbackFactory` → `fetchKiroWithRetry` → `fetchWithResetRecovery` → `fetchWithAttemptDeadline` with a Kiro-only executor wrapper. The wrapper's input is the composed attempt signal from `src/lib/abort.ts:81-99`; it emits the signal's stable `TimeoutError` reason only when that signal won and the caller signal has not fired. The existing `ctx.executor` is created by `src/server/responses/adapter-dispatch.ts:307,479`; the existing `sendBudget` and physical-send ordinal retain their current chains. The local 504 `Response` is created in `fetchKiroWithRetry`, serialized by the existing Responses error path (`src/server/responses/adapter-dispatch.ts:1049-1138`), deserialized by the client as ordinary HTTP, and consumed as a gateway timeout; no disk deserialization applies. The HTTP diagnostic derives only the closed-set status bucket and code at `safeKiroHttpErrorMessage` and sends those fields to `debugProviderDiagnostic`, which writes the ring and stderr; no body-derived string crosses that chain.

## Conditional-path acceptance matrix

| New branch / guard | Activation → observable assertion |
|---|---|
| Supplied executor and optional pacing surface | An injected egress executor sees the initial, reset, 429, canonical alternate, and adapter completion sends; a pacing refusal causes zero physical sends and no budget charge. Test first/reset/alternate above, plus adapter-level fallback and an explicit pacing-refusal case. |
| 502/503/504 returned on canonical host | Before any Kiro event output, exactly one `q.*` attempt occurs, within the same send budget; final alternate 5xx remains final. Assert two URLs and no third send for each code. |
| Other 5xx / custom URL / unrecognised upstream shape | No new fallback, no quarantine; returned failure remains ordinary. Assert 521 and custom URL each send once. HTTP 500 remains one send. |
| Deadline wins and executor rejects with its own `TypeError` | Kiro's executor wrapper reads the composed attempt signal and throws its stable `TimeoutError`; Kiro turns it into HTTP 504, exactly one send, no host move. The shared helper and Google retain the executor's original `TypeError`; the Google regression asserts object identity and three existing retry sends. |
| Caller abort wins | Propagate original abort reason, return no synthetic 504, perform no alternate send. Test both pre-aborted and in-flight rejection with the same `TypeError` wrapper used by the deadline case. A post-header abort remains attached to the body because `clearableDeadline.clear()` only stops its timer (`src/lib/abort.ts:81-99`). |
| Final HTTP 5xx, including raw completion fallback | Client text is fixed by status (504 timeout; other 5xx service unavailable); opt-in provider debug carries only the closed-set status bucket and code. Assert an opaque upstream marker never reaches normalized client text, fallback event, debug ring, or stderr. |

## Test layout and file-size ratchet

`tests/fixtures/file-size-baseline.json:46-47` caps `kiro-adapter.test.ts` and `kiro-stream.test.ts` exactly; add zero lines there. Neither `kiro-retry.test.ts` nor the new sibling is listed in that baseline. The new file sits in `tests/providers/kiro/` and needs these exact entries, placed with the other Kiro names:

```diff
--- a/scripts/test-layout/layout.json
+++ b/scripts/test-layout/layout.json
@@
     "kiro-stream.test.ts": "providers/kiro",
+    "kiro-transport-parity.test.ts": "providers/kiro",
     "kiro-usage-quota.test.ts": "providers/kiro",
--- a/tests/fixtures/test-layout-expected.json
+++ b/tests/fixtures/test-layout-expected.json
@@
   "kiro-stream.test.ts": "providers/kiro",
+  "kiro-transport-parity.test.ts": "providers/kiro",
   "kiro-usage-quota.test.ts": "providers/kiro",
```

The existing `tests/providers/kiro/kiro-retry.test.ts:235-243` assertion (`does not replay ordinary 5xx responses`) is narrowed by the hunk above. The Kiro sibling tests timer normalization and caller abort through `fetchKiroWithRetry`; the Google regression in `tests/adapters/google/google-vertex-http.test.ts` pins the shared-helper pass-through. The Kiro sibling also covers budget denial before dispatch, failed pacing wait consuming no ordinal, and opaque-body non-disclosure to all three sinks. No test performs network I/O.

## Docs and structure ownership

- `docs-site/src/content/docs/reference/adapters.md:335-342` owns the English Kiro claim. `docs-site/src/content/docs/tr/reference/adapters.md:210-220` and `docs-site/src/content/docs/fr/reference/adapters.md:119-120` explicitly say ordinary service errors are not replayed; amend those sentences to carve out the canonical 502/503/504 host move. The Kiro sections in the `ja`, `ko`, `ru`, `zh-cn`, and `zh-tw` `reference/adapters.md` pages state only generic bounded retry/masked-error behavior and remain accurate; recheck them after editing English.

```diff
--- a/docs-site/src/content/docs/reference/adapters.md
+++ b/docs-site/src/content/docs/reference/adapters.md
@@
-  shape is eligible for one bounded fallback to `q.{region}.amazonaws.com` after an endpoint,
-  signature, DNS, or connection failure.
+  shape is eligible for one budgeted fallback to `q.{region}.amazonaws.com` after an endpoint,
+  signature, DNS, or connection failure, or HTTP 502/503/504 received before output.
@@
-  hard quota failures and ordinary service errors are not replayed.
+  hard quota failures and other service errors are not replayed. Every Kiro physical send uses
+  configured provider egress. A header deadline returns 504; caller cancellation stops the turn.
+  Final HTTP 5xx bodies use fixed public text without upstream detail.
--- a/docs-site/src/content/docs/tr/reference/adapters.md
+++ b/docs-site/src/content/docs/tr/reference/adapters.md
@@
-  bir uç nokta, imza, DNS veya bağlantı hatasından sonra
+  bir uç nokta, imza, DNS veya bağlantı hatasından ya da çıktı başlamadan alınan HTTP 502/503/504 yanıtından sonra
@@
-  hizmet hataları yeniden oynatılmaz.
+  diğer hizmet hataları yeniden oynatılmaz. Tüm Kiro gönderimleri yapılandırılmış sağlayıcı çıkışını kullanır; başlık zaman aşımı 504 döndürür, istemci iptali isteği durdurur ve son HTTP 5xx gövdeleri sabit genel metin kullanır.
--- a/docs-site/src/content/docs/fr/reference/adapters.md
+++ b/docs-site/src/content/docs/fr/reference/adapters.md
@@
-  seule cette forme canonique peut faire l’objet d’un unique repli borné vers `q.{region}.amazonaws.com` après un échec de point de terminaison, de signature, de DNS ou de connexion.
+  seule cette forme canonique peut faire l’objet d’un unique repli borné vers `q.{region}.amazonaws.com` après un échec de point de terminaison, de signature, de DNS ou de connexion, ou une réponse HTTP 502/503/504 reçue avant toute sortie.
@@
-  dépassements fermes de quota et les erreurs de service ordinaires ne sont pas rejoués.
+  dépassements fermes de quota et les autres erreurs de service ne sont pas rejoués. Tous les envois Kiro utilisent la sortie réseau configurée ; un délai d’en-tête dépassé renvoie 504, l’annulation du client arrête la requête et les erreurs HTTP 5xx finales affichent un texte public fixe.
```

- `structure/INDEX.md:111` maps `src/adapters/` to nine docs. Review each mapped doc; the changed text belongs in `structure/providers-and-adapters.md:90`, `structure/transports/inventory.md:147-155`, and `structure/providers/kiro.md:62-68`:

```diff
--- a/structure/providers-and-adapters.md
+++ b/structure/providers-and-adapters.md
@@
-| `src/adapters/kiro.ts` and `src/adapters/kiro/` | Kiro event/tool/thinking/truncation/retry handling. The original path is a facade over leaves for wire identity, reasoning, conversation state, token estimation, payload assembly, streaming, and the adapter. |
+| `src/adapters/kiro.ts` and `src/adapters/kiro/` | Kiro event/tool/thinking/truncation/retry handling, including an egress-aware completion fallback, fixed public HTTP 5xx text, and closed-set status/code diagnostics. The original path is a facade over leaves for wire identity, reasoning, conversation state, token estimation, payload assembly, streaming, and the adapter. |
--- a/structure/transports/inventory.md
+++ b/structure/transports/inventory.md
@@
 ## Per-provider egress coverage

+Kiro generation in `src/adapters/kiro-retry.ts` passes the routed provider executor to every physical send, including reset, throttle, canonical alternate-host, and completion-fallback attempts. A canonical HTTP 502/503/504 before output permits one alternate-host send from the same request budget; caller abort does not rotate.

--- a/structure/providers/kiro.md
+++ b/structure/providers/kiro.md
@@
 ## Bounded fallback HTTP errors

+`src/adapters/kiro-retry.ts` uses the configured executor for every generation send and may try the existing `q.{region}.amazonaws.com` host once after a canonical-host HTTP 502/503/504 before output, subject to the same send budget. A Kiro-local wrapper maps its header deadline to HTTP 504 without changing shared or Google fetch behavior; caller cancellation remains an abort. Final HTTP 5xx text is fixed for clients, and opt-in provider diagnostics carry only closed-set status and classification codes.
+
 When a first Kiro stream needs a completion fallback, the fallback response's non-success
```

`structure/runtime.md`, `transports/byte-accounting.md`, `transports/responses-wire-shapes.md`, `data-planes/inbound-compat.md`, `providers/cursor.md`, `providers/chat-compat.md`, and `adapters/registry.md` need accuracy review only; no generic contract or manifest change is planned. `src/lib/` is unchanged, so no shared deadline document change is needed. `src/AGENTS.md:1-23` requires same-change structure sync for the adapter files. Do not edit generated `structure/INDEX.md` unless the manifest mapping changes.

## PLAN-VERIFIER-REAL-01

Pre-build commands rerun at `bb3f3c2d0d` with dependencies installed (the target code and new tests do not exist yet):

| Command | Exit / observed result | Reads change target? |
|---|---|---|
| `bun test tests/providers/kiro/kiro-retry.test.ts tests/providers/kiro/kiro-fallback-error-body.test.ts tests/adapters/google/google-vertex-http.test.ts tests/lib/upstream-retry.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/lab/core-lab-boundary.test.ts` | 0; 169 pass, 0 fail, 1,142 assertions across seven existing files | Yes: exercises current Kiro retry/fallback, Google retry, shared helper, layout, and Lab boundary. Proposed new assertions have not run. |
| `bun run test:changed` | 0; reports ten changed files against `origin/dev` and executes 0 tests | No behavioral target was exercised; the new test does not exist yet. |
| `bun run privacy:scan` | 0; `Privacy scan passed` | Reads repository content, including the plan; does not exercise transport behavior. |
| `bun run structure:check` | 0; `structure/ SSOT checks passed` | Reads structure docs; does not exercise transport behavior. |

In B, run `bun test tests/providers/kiro/kiro-transport-parity.test.ts tests/providers/kiro/kiro-retry.test.ts tests/providers/kiro/kiro-fallback-error-body.test.ts tests/adapters/google/google-vertex-http.test.ts tests/lib/upstream-retry.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/lab/core-lab-boundary.test.ts`; `bun run typecheck`; `bun run test:changed`; `bun run privacy:scan`; `bun run structure:check`; and the docs-site frozen-install/build required by `docs-site/AGENTS.md`. `bun run typecheck` is named for B only and was not run now. Mark the layer review-ready only after the new focused tests actually execute and typecheck passes; hosted exact-head CI is the later merge gate. For SD8, `tests/server/account-pool-management-api.test.ts` is a separate pool-layer verifier that fails locally only because this checkout is under the real `~/.codex` and its test-home guard refuses removal there; treat hosted CI as its evidence, never as a local pass claim.

## Risks, rollback, out of scope

- A 502/503/504 may describe an account or request fault rather than a bad endpoint. Restrict rotation to the canonical host and one attempt, return the final alternate answer, and leave 400/403 account classification to 030. Unrecognised shapes never create account state.
- Repeating an inference after a returned HTTP gateway status is an upstream side-effect risk. The send budget and before-output restriction cap that risk; the no-third-send test is required. A caller abort and a deadline are never rotated.
- Kiro's deadline wrapper observes the composed attempt signal only for Kiro sends; a simultaneous caller abort wins the explicit parent-signal check. The Google regression guards the existing shared-helper pass-through behavior.
- Roll back this layer by reverting the 020 PR as one unit. No migration or stored state is introduced; 010's quota persistence is independent.
- Out of scope: account-level 429/monthly/suspension verdicts (030), per-account load (040), model catalog (050), device login (060), metering (070), extra Kiro hosts, live AWS validation.

## Round-1 audit fold

| Blocker | What changed in this plan |
|---|---|
| r1-4 High | HTTP 5xx diagnostic hunk emits only closed-set status bucket/code with no `detail` or upstream string (lines 100-126); the opaque-marker test checks the debug ring, stderr, and client including completion fallback (lines 373-400); acceptance and field chain name both sinks (lines 419-432). |
| r1-5 Medium | Removed the shared `fetchWithAttemptDeadline` mutation; Kiro-only executor wrapper normalizes its attempt signal (lines 24-65). New Google regression asserts the original `TypeError` object and existing retry count (lines 167-188); verification includes the Google suite (lines 517-528). |

## Round-2 audit fold

- r3-R2-3 (Medium): the cross-layer contract paragraph now names the SD1' account-based identity (with `loginId`, without `authType`) and the SD2' `kiroAccountEvidence(account, now?)` signature. 020 still neither reads nor writes either.
