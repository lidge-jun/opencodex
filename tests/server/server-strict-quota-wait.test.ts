import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { OcxConfig } from "../../src/types";
import { handleResponsesWithPolicyFallback, type PolicyFallbackDeps } from "../../src/server/responses/policy-fallback";
import { markStrictQuotaWaitResponse } from "../../src/server/responses/strict-quota-response";
import { beginRequestAttempt, type RequestLogContext } from "../../src/server/request-log";
import { abortAndReleaseAllTurns, getActiveTurnCount, tryAdmitTurn } from "../../src/server/lifecycle";
import { notifyCodexQuotaChanges } from "../../src/codex/quota-events";
import { strictCodexQuotaWaiterCount } from "../../src/codex/strict-quota-refresh";
import { responseWithDeferredRequestLog } from "../../src/server/relay";
import { sendResponseToWebSocket, type WsData } from "../../src/server/ws-bridge";

const config = { providers: {}, codexAccounts: [], codexAccountStrictQuota: true } as OcxConfig;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const completed = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"real-response","status":"completed","output":[]}}\n\n';
function rejection(): Response {
  return markStrictQuotaWaitResponse(Response.json({ error: { message: "quota unavailable" } }, { status: 429 }));
}
function request(stream = false, signal?: AbortSignal, extra: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST", signal, headers: { "content-type": "application/json", "session-id": "root-session" },
    body: JSON.stringify({ model: "openai/gpt-test", input: [{ role: "user", content: "original" }], stream, ...extra }),
  });
}
function log(): RequestLogContext { return { model: "unknown", provider: "unknown" }; }
function attempt(ctx: RequestLogContext): void {
  const row = beginRequestAttempt((ctx.attempts?.length ?? 0) + 1, "openai/pool", "gpt-test", "test");
  row.sendCount = 1;
  (ctx.attempts ??= []).push(row);
  ctx.activeAttempt = row;
  ctx.activeAttemptStartedAt = Date.now();
}
function waitGate() {
  const listeners = new Set<() => void>();
  return {
    count: () => listeners.size,
    wake: () => { for (const wake of [...listeners]) wake(); },
    waitForChange: (_config: OcxConfig, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
      const cleanup = () => { listeners.delete(done); signal?.removeEventListener("abort", abort); };
      const done = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
      if (signal?.aborted) { abort(); return; }
      listeners.add(done); signal?.addEventListener("abort", abort, { once: true });
    }),
  };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(2);
  expect(predicate()).toBe(true);
}

let precedingTurns = 0;
beforeEach(() => { precedingTurns = getActiveTurnCount(); });
afterEach(() => {
  // Other server suites share this process; assert this test returns its own admission.
  expect(getActiveTurnCount()).toBe(precedingTurns);
  expect(strictCodexQuotaWaiterCount()).toBe(0);
});

describe("strict quota request wait", () => {
  test("non-streaming resumes the exact input after quota wakeup and preserves attempts", async () => {
    const gate = waitGate(); const ctx = log(); const seen: unknown[] = [];
    const runCore: NonNullable<PolicyFallbackDeps["runCore"]> = async (req, _config, logCtx, options) => {
      seen.push(await req.json());
      expect(req.headers.get("session-id")).toBe("root-session");
      attempt(logCtx); options?.onRequestBodyRead?.();
      return seen.length === 1 ? rejection() : Response.json({ id: "real-response", status: "completed" });
    };
    let bodyReads = 0;
    const pending = handleResponsesWithPolicyFallback(request(false, undefined, { previous_response_id: "prior-local-id" }), config, ctx,
      { onRequestBodyRead: () => { bodyReads++; } }, { runCore, quotaWait: gate });
    await until(() => gate.count() === 1);
    expect(seen).toHaveLength(1);
    gate.wake();
    const response = await pending;
    expect(await response.json()).toEqual({ id: "real-response", status: "completed" });
    expect(seen).toHaveLength(2); expect(seen[1]).toEqual(seen[0]);
    expect(bodyReads).toBe(1); expect(gate.count()).toBe(0);
    expect(ctx.attempts).toHaveLength(2); expect(ctx.attempts?.[0]?.status).toBe(429);
  });

  test("non-streaming cancellation releases the admitted pending request", async () => {
    const ac = new AbortController(); const gate = waitGate(); const lease = tryAdmitTurn()!;
    const pending = handleResponsesWithPolicyFallback(request(false), config, log(), { abortSignal: ac.signal, turnAdmissionLease: lease }, {
      runCore: async () => rejection(), quotaWait: gate,
    });
    await until(() => gate.count() === 1);
    ac.abort(new Error("request cancelled"));
    await expect(pending).rejects.toThrow("request cancelled"); expect(gate.count()).toBe(0);
  });

  test("forged upstream wait headers cannot authorize replay", async () => {
    let sends = 0; const gate = waitGate();
    const response = await handleResponsesWithPolicyFallback(request(), config, log(), {}, {
      runCore: async () => { sends++; return Response.json({}, { status: 429, headers: { "x-opencodex-quota-wait": "1" } }); }, quotaWait: gate,
    });
    expect(response.status).toBe(429); expect(sends).toBe(1); expect(gate.count()).toBe(0);
  });

  test("stored 401 replay budget forbids waiting or another account cycle", async () => {
    let sends = 0; const gate = waitGate();
    const response = await handleResponsesWithPolicyFallback(request(), config, log(), {}, {
      runCore: async (_req, _config, _log, options) => { sends++; options?.onStoredPool401ReplayDispatched?.(); return rejection(); }, quotaWait: gate,
    });
    expect(response.status).toBe(429); expect(sends).toBe(1); expect(gate.count()).toBe(0);
  });

  test("typed SSE heartbeats keep waiting alive and only real resumed events complete the turn", async () => {
    const gate = waitGate(); let sends = 0;
    const response = await handleResponsesWithPolicyFallback(request(true), config, log(), {}, {
      runCore: async () => ++sends === 1 ? rejection() : new Response(completed, { headers: { "content-type": "text/event-stream" } }),
      quotaWait: { ...gate, heartbeatMs: 5 },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(decoder.decode((await reader.read()).value)).toContain('"type":"response.heartbeat"');
    expect(decoder.decode((await reader.read()).value)).toContain('"type":"response.heartbeat"');
    expect(sends).toBe(1);
    gate.wake();
    let output = "";
    while (true) { const next = await reader.read(); if (next.done) break; output += decoder.decode(next.value); }
    expect(output).toContain('"id":"real-response"'); expect(output.match(/event: response.completed/g)).toHaveLength(1);
    expect(sends).toBe(2); expect(gate.count()).toBe(0);
  });

  test.each(["request", "websocket"] as const)("%s abort cancels a pending wait without dispatch", async kind => {
    const ac = new AbortController(); const gate = waitGate(); let sends = 0;
    const lease = tryAdmitTurn()!;
    const response = await handleResponsesWithPolicyFallback(request(true, kind === "request" ? ac.signal : undefined), config, log(),
      { turnAdmissionLease: lease, ...(kind === "websocket" ? { abortSignal: ac.signal } : {}) }, {
        runCore: async () => { sends++; return rejection(); }, quotaWait: gate,
      });
    const reader = response.body!.getReader(); await reader.read();
    expect(getActiveTurnCount()).toBe(precedingTurns + 1);
    ac.abort(new Error("client cancelled"));
    await expect(reader.read()).rejects.toThrow("client cancelled");
    expect(sends).toBe(1); expect(gate.count()).toBe(0);
  });

  test("service drain aborts the admitted wait and releases its subscription", async () => {
    const gate = waitGate(); const lease = tryAdmitTurn()!;
    const response = await handleResponsesWithPolicyFallback(request(true), config, log(), { turnAdmissionLease: lease }, {
      runCore: async () => rejection(), quotaWait: gate,
    });
    const reader = response.body!.getReader(); await reader.read();
    abortAndReleaseAllTurns(new Error("server shutdown"));
    precedingTurns = 0;
    await expect(reader.read()).rejects.toThrow("server shutdown"); expect(gate.count()).toBe(0);
  });

  test("response cancellation cleans up before any client pull", async () => {
    const gate = waitGate(); const lease = tryAdmitTurn()!;
    const response = await handleResponsesWithPolicyFallback(request(true), config, log(), { turnAdmissionLease: lease }, {
      runCore: async () => rejection(), quotaWait: { ...gate, heartbeatMs: 5 },
    });
    await response.body!.cancel(); expect(gate.count()).toBe(0);
  });

  test("quota updates wake the production waiter with no idle subscription left", async () => {
    let sends = 0;
    const pending = handleResponsesWithPolicyFallback(request(), config, log(), {}, {
      runCore: async () => ++sends === 1 ? rejection() : Response.json({ id: "real-response" }),
    });
    await until(() => strictCodexQuotaWaiterCount() === 1);
    notifyCodexQuotaChanges();
    expect(await (await pending).json()).toEqual({ id: "real-response" }); expect(sends).toBe(2);
  });

  test("a quota reset between core admission and wait subscription is not lost", async () => {
    let sends = 0;
    const response = await handleResponsesWithPolicyFallback(request(), config, log(), {}, {
      runCore: async () => {
        sends++;
        if (sends === 1) { notifyCodexQuotaChanges(); return rejection(); }
        return Response.json({ id: "already-reset" });
      },
    });
    expect(await response.json()).toEqual({ id: "already-reset" }); expect(sends).toBe(2);
  });

  test("a terminal non-quota rejection after waiting becomes a real failed SSE terminal", async () => {
    let sends = 0; const gate = waitGate(); const ctx = log();
    const response = await handleResponsesWithPolicyFallback(request(true), config, ctx, {}, {
      runCore: async () => ++sends === 1 ? rejection() : Response.json({ error: { code: "upstream_error", message: "provider unavailable" } }, { status: 503 }),
      quotaWait: gate,
    });
    gate.wake(); const body = await response.text();
    expect(body).toContain("response.failed"); expect(body).toContain("provider unavailable"); expect(body).not.toContain("response.completed");
    expect(ctx.terminalHttpStatus).toBe(503); expect(sends).toBe(2);
  });

  test("a resumed stored 401 consumes the same logical budget and cannot wait again", async () => {
    const gate = waitGate(); let sends = 0;
    const response = await handleResponsesWithPolicyFallback(request(true), config, log(), {}, {
      runCore: async (_req, _config, _log, options) => {
        if (++sends > 1) options?.onStoredPool401ReplayDispatched?.();
        return rejection();
      }, quotaWait: gate,
    });
    gate.wake(); const body = await response.text();
    expect(body).toContain("response.failed"); expect(sends).toBe(2); expect(gate.count()).toBe(0);
  });

  test("resumed native SSE uses exactly one outer request-log owner", async () => {
    const gate = waitGate(); const ctx = log(); let sends = 0; let nativeFinalized = 0; let logged = 0;
    const response = await handleResponsesWithPolicyFallback(request(true), config, ctx, {
      onNativePassthroughTerminal: () => { nativeFinalized++; },
    }, {
      runCore: async (_req, _config, logCtx, options) => {
        attempt(logCtx);
        if (++sends === 1) return rejection();
        options?.onNativePassthroughTerminal?.("completed");
        return new Response(completed, { headers: { "content-type": "text/event-stream" } });
      }, quotaWait: gate,
    });
    const loggedResponse = responseWithDeferredRequestLog(response, "quota-wait-log", Date.now(), ctx, () => { logged++; });
    gate.wake(); await loggedResponse.text();
    expect(nativeFinalized).toBe(0); expect(logged).toBe(1); expect(ctx.attempts).toHaveLength(2);
  });

  test("WS bridge relays typed heartbeat and the real recovered terminal", async () => {
    const gate = waitGate(); let sends = 0; const frames: Array<{ type: string }> = [];
    const response = await handleResponsesWithPolicyFallback(request(true), config, log(), {}, {
      runCore: async () => ++sends === 1 ? rejection() : new Response(completed, { headers: { "content-type": "text/event-stream" } }), quotaWait: gate,
    });
    const ws = { readyState: 1, data: {}, send: (text: string) => { frames.push(JSON.parse(text)); return text.length; } } as unknown as ServerWebSocket<WsData>;
    const pump = sendResponseToWebSocket(ws, response, () => true);
    await until(() => frames.some(frame => frame.type === "response.heartbeat"));
    gate.wake(); await pump;
    expect(frames.filter(frame => frame.type === "response.completed")).toHaveLength(1); expect(gate.count()).toBe(0);
  });

  test("slow readers do not accumulate heartbeat frames or eagerly drain recovered output", async () => {
    const gate = waitGate(); let sends = 0; let pulls = 0;
    const response = await handleResponsesWithPolicyFallback(request(true), config, log(), {}, {
      runCore: async () => ++sends === 1 ? rejection() : new Response(new ReadableStream<Uint8Array>({
        pull(controller) { pulls++; controller.enqueue(encoder.encode(completed)); if (pulls === 5) controller.close(); },
      }), { headers: { "content-type": "text/event-stream" } }), quotaWait: { ...gate, heartbeatMs: 2 },
    });
    await Bun.sleep(25); gate.wake(); await Bun.sleep(25);
    expect(pulls).toBeLessThanOrEqual(1);
    const text = await response.text();
    expect(text.match(/event: response.heartbeat/g)?.length).toBeLessThanOrEqual(2);
    expect(pulls).toBe(5);
  });
});
