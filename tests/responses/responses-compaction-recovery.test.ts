import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { getDefaultConfig } from "../../src/config";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { runWithCompactionRecovery } from "../../src/server/responses/compaction-recovery";
import { decodeCompactionSummary } from "../../src/responses/compaction";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { jsonUtf8Bytes } from "../../src/lib/json-byte-size";
import type { AdapterEvent, OcxConfig, OcxParsedRequest } from "../../src/types";
import type { RequestLogContext } from "../../src/server/request-log";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const originalFetch = globalThis.fetch;
const sourceError: AdapterEvent = { type: "error", status: 400, code: "invalid_argument", message: "Source rejected compact fixture" };
let sourceEvents: AdapterEvent[];
let fallbackEvents: AdapterEvent[];
let calls: Array<{ model: string; parsed: OcxParsedRequest; headers: Headers }>;
let releaseSpend: (() => void) | undefined;
let restoreFactory: (() => void) | undefined;
let restoreChatFactory: (() => void) | undefined;
let abortOnSource: AbortController | undefined;

function settings(): OcxConfig {
  return {
    ...getDefaultConfig(), defaultProvider: "source",
    providers: {
      source: { adapter: "devin", authMode: "key", apiKey: "fixture-only", baseUrl: "https://source.example" },
      emergency: { adapter: "devin", authMode: "key", apiKey: "fixture-only", baseUrl: "https://emergency.example" },
    },
    compactionRecovery: { enabled: true, model: "emergency/rescue", allowDevinInvalidArgument: true },
  };
}

function body(stream = false, compact = true): Record<string, unknown> {
  return {
    model: "source/swe-2", stream, store: false, max_output_tokens: 512,
    input: [
      { type: "message", role: "user", content: "Remember marker ALPHA-729." },
      { type: "message", role: "assistant", content: "Recorded." },
      { type: "message", role: "user", content: "Latest goal: finish the report, preserve the marker." },
      ...(compact ? [{ type: "compaction_trigger" }] : []),
    ],
  };
}

function request(payload = body(), path = "responses", signal?: AbortSignal): Request {
  return new Request(`http://localhost/v1/${path}`, {
    method: "POST", headers: {
      "content-type": "application/json", session_id: "recovery-fixture",
      authorization: "Bearer inbound-fixture", "chatgpt-account-id": "inbound-account-fixture",
    },
    body: JSON.stringify(payload), signal,
  });
}

beforeEach(() => {
  releaseSpend = acquireOwnedSpendHome();
  calls = [];
  sourceEvents = [sourceError];
  fallbackEvents = [
    { type: "thinking_delta", thinking: "Prepare the handoff." },
    { type: "text_delta", text: "Work is pending; resume the report." },
    { type: "done", usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } },
  ];
  abortOnSource = undefined;
  globalThis.fetch = (async () => { throw new Error("Unexpected network request in recovery fixture"); }) as typeof fetch;
  const factory = spyOn(ADAPTER_REGISTRY.devin, "create").mockImplementation((_provider, context) => ({
    name: "devin",
    reportsPhysicalSends: true,
    buildRequest() { throw new Error("runTurn fixture must not build HTTP requests"); },
    async *parseStream() { throw new Error("runTurn fixture must not parse HTTP responses"); },
    async runTurn(parsed, incoming, emit) {
      const send = incoming.sendBudget?.reserveDispatch({ sendClass: "initial", targetKey: `${context.providerId}/${parsed.modelId}` });
      if (send && (!send.allowed || !send.permit.use())) {
        emit({ type: "error", status: 429, code: "request_send_budget_exhausted", message: "Fixture shared send allowance exhausted" });
        return;
      }
      incoming.onPhysicalSend?.({ ordinal: 1 });
      calls.push({ model: parsed.modelId, parsed: structuredClone(parsed), headers: new Headers(incoming.headers) });
      const isSource = context.providerId === "source";
      for (const event of isSource ? sourceEvents : fallbackEvents) emit(event);
      if (isSource) abortOnSource?.abort();
    },
  }));
  restoreFactory = () => factory.mockRestore();
});

afterEach(() => {
  releaseSpend?.();
  releaseSpend = undefined;
  restoreFactory?.();
  restoreFactory = undefined;
  restoreChatFactory?.();
  restoreChatFactory = undefined;
  globalThis.fetch = originalFetch;
});

describe("routed compaction emergency integration", () => {
  test("source success and ordinary requests never use the emergency model", async () => {
    sourceEvents = [{ type: "text_delta", text: "Source summary" }, { type: "done" }];
    for (const compact of [true, false]) {
      const response = await handleResponses(request(body(false, compact)), settings(), { model: "", provider: "" });
      expect((await response.json()).status).toBe("completed");
    }
    expect(calls.map(call => call.model)).toEqual(["swe-2", "swe-2"]);
  });

  test.each([false, true])("v2 failed terminal recovers once and retains user goals (stream=%s)", async stream => {
    const config = settings();
    const before = structuredClone(config);
    const completed: string[] = [];
    const log: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request(body(stream)), config, log, { onResponseComplete: model => completed.push(model) });
    let summary: string | null;
    if (stream) {
      const text = await response.text();
      expect(text).not.toContain("Source rejected compact fixture");
      const terminal = text.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6))).find(event => event.type === "response.completed");
      summary = decodeCompactionSummary(terminal.response.output.find((item: { type: string }) => item.type === "compaction").encrypted_content);
      expect(terminal.response.usage.total_tokens).toBe(10);
    } else {
      const json = await response.json();
      expect(json.status).toBe("completed");
      summary = decodeCompactionSummary(json.output.find((item: { type: string }) => item.type === "compaction").encrypted_content);
    }
    expect(summary).toContain("ALPHA-729");
    expect(summary).toContain("Latest goal: finish the report");
    expect(calls.map(call => call.model)).toEqual(["swe-2", "rescue"]);
    expect(calls[1]!.headers.has("authorization")).toBe(false);
    expect(calls[1]!.headers.has("chatgpt-account-id")).toBe(false);
    expect(calls[1]!.parsed.options.maxOutputTokens).toBe(512);
    expect(calls[1]!.parsed.context.tools).toBeUndefined();
    expect(completed).toEqual(["source/swe-2"]);
    expect(log.provider).toBe("emergency");
    expect(config).toEqual(before);
  });

  test("routed v1 returns replacement history retaining original user text once", async () => {
    const response = await handleResponsesCompact(request(body(false, false), "responses/compact"), settings(), { model: "", provider: "" });
    expect(response.status).toBe(200);
    const json = await response.json();
    const output = JSON.stringify(json.output);
    expect(output).toContain("ALPHA-729");
    expect(output).toContain("Latest goal: finish the report");
    // Retained messages belong to v1 output items; embedding them in the summary duplicates the text.
    expect(output).not.toContain("Retained original user messages");
    expect(output.split("ALPHA-729").length - 1).toBe(1);
    expect(calls.map(call => call.model)).toEqual(["swe-2", "rescue"]);
  });

  test("the actual fallback Request strips inbound auth and account headers", async () => {
    const original = request();
    let fallbackHeaders: Headers | undefined;
    const response = await runWithCompactionRecovery(
      original, settings(), { model: "", provider: "" },
      { translatorBudget: createTranslatorBudget(), sendBudget: createRequestExecutionBudget() },
      async (sent, config, log, options) => {
        if (sent !== original) fallbackHeaders = new Headers(sent.headers);
        return handleResponses(sent, config, log, { ...options, compactionRecoveryAttempted: true });
      },
    );
    expect((await response.json()).status).toBe("completed");
    expect(calls.map(call => call.model)).toEqual(["swe-2", "rescue"]);
    expect(fallbackHeaders).toBeDefined();
    expect(fallbackHeaders!.has("authorization")).toBe(false);
    expect(fallbackHeaders!.has("chatgpt-account-id")).toBe(false);
  });

  test("a failed fallback returns and logs the original failure", async () => {
    fallbackEvents = [{ type: "error", status: 503, code: "server_is_overloaded", message: "Emergency overloaded fixture" }];
    const log: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request(body(false)), settings(), log);
    expect(response.status).toBe(400);
    expect(calls.map(call => call.model)).toEqual(["swe-2", "rescue"]);
    // The returned failure is the source's, so the log must describe it too — not the fallback's.
    expect(log.provider).toBe("source");
    expect(log.model).toBe("swe-2");
    expect(log.requestedAlias).toBe("source/swe-2");
    expect(log.activeAttempt).toBeUndefined();
    // The fallback's own failed attempt stays recorded; its wire status was a failed 200 terminal.
    expect(log.attempts?.map(attempt => attempt.status)).toEqual([400, 200]);
  });

  test("an existing unconditional override keeps its original logical model on recovery", async () => {
    const config = settings();
    config.compactionRouting = { model: "source/swe-2" };
    const payload = { ...body(), model: "source/normal", client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", compaction: { trigger: "manual" } }),
    } };
    const completed: string[] = [];
    const response = await handleResponses(request(payload), config, { model: "", provider: "" }, { onResponseComplete: model => completed.push(model) });
    expect((await response.json()).model).toBe("source/normal");
    expect(calls.map(call => call.model)).toEqual(["swe-2", "rescue"]);
    expect(completed).toEqual(["source/normal"]);
  });

  test.each([false, true])("fetch adapter hidden text then failure cannot replay (stream=%s)", async stream => {
    const config = settings();
    config.providers.source = { adapter: "openai-chat", authMode: "key", apiKey: "fixture-only", baseUrl: "https://source.example/v1" };
    const events: AdapterEvent[] = [{ type: "text_delta", text: "Private partial compact text" }, { type: "error", status: 500, errorType: "upstream_error", message: "Source failed after partial text" }];
    const factory = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation(() => ({
      name: "openai-chat", buildRequest() { return { url: "https://source.example/v1/chat/completions", method: "POST", headers: {}, body: "{}" }; },
      async *parseStream() { yield* events; }, async parseResponse() { return events; },
    }));
    restoreChatFactory = () => factory.mockRestore();
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; return Response.json({ fixture: true }); }) as typeof fetch;
    const response = await handleResponses(request(body(stream)), config, { model: "", provider: "" });
    expect(await response.text()).toContain("Source failed after partial text");
    expect(fetches).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test("fetch HTTP 500 authentication type survives client formatting and forbids recovery", async () => {
    const config = settings();
    config.providers.source = { adapter: "openai-chat", authMode: "key", apiKey: "fixture-only", baseUrl: "https://source.example/v1" };
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return Response.json({ error: { type: "authentication_error", message: "denied" } }, { status: 500 });
    }) as typeof fetch;
    const response = await handleResponses(request(), config, { model: "", provider: "" });
    expect(response.status).toBe(500);
    await response.text();
    expect(fetches).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test.each([[1, false], [2, false], [2, true]] as const)("fetch source and fetch emergency share cap=%s transient=%s", async (cap, transient) => {
    const config = settings();
    config.providers.source = { adapter: "openai-chat", authMode: "key", apiKey: "fixture-only", baseUrl: "https://source.example/v1" };
    config.providers.emergency = { adapter: "openai-chat", authMode: "key", apiKey: "fixture-only", baseUrl: "https://emergency.example/v1", ...(transient ? { transientRetryOn5xx: { attempts: 3 } } : {}) };
    const requests: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      requests.push(url);
      return url.includes("source.example")
        ? Response.json({ error: { type: "invalid_request_error", code: "context_length_exceeded", message: "Source input context is full" } }, { status: 400 })
        : Response.json({ choices: [{ message: { role: "assistant", content: "Resume the report." }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } });
    }) as typeof fetch;
    const budget = createRequestExecutionBudget({ maxTotalModelSends: cap, baseSendAllowance: cap, finalRecoveryAllowance: 0, maxAlternateTargetSends: 1, maxTargetTransitions: 1 });
    const response = await handleResponses(request(), config, { model: "", provider: "" }, { sendBudget: budget });
    const json = await response.json();
    expect(requests).toHaveLength(cap);
    expect(budget.used).toBe(cap);
    if (cap === 2) {
      expect(json.status).toBe("completed");
      expect(decodeCompactionSummary(json.output.find((item: { type: string }) => item.type === "compaction").encrypted_content)).toContain("ALPHA-729");
    } else expect(json.error.code).toBe("context_length_exceeded");
  });

  test.each([false, true])("externally booked source settles once (transient=%s)", async transient => {
    const config = settings();
    config.providers.source = { adapter: "openai-chat", authMode: "key", apiKey: "fixture-only", baseUrl: "https://source.example/v1", ...(transient ? { transientRetryOn5xx: { attempts: 3 } } : {}) };
    let sourceRequests = 0;
    globalThis.fetch = (async () => {
      sourceRequests++;
      return Response.json({ error: { code: "context_length_exceeded", message: "Source context is full" } }, { status: 400 });
    }) as typeof fetch;
    const budget = createRequestExecutionBudget({ maxTotalModelSends: 2, baseSendAllowance: 2, finalRecoveryAllowance: 0, maxAlternateTargetSends: 1, maxTargetTransitions: 1 });
    const reservation = budget.reserveDispatch({ sendClass: "initial", targetKey: "source/swe-2", countedExternally: true });
    expect(reservation.allowed).toBe(true);
    const response = await handleResponses(request(), config, { model: "", provider: "" }, { sendBudget: budget });
    expect((await response.json()).status).toBe("completed");
    expect(sourceRequests).toBe(1);
    expect(calls.map(call => call.model)).toEqual(["rescue"]);
    expect(budget.used).toBe(2);
  });

  test("runTurn emergency consumes its prepaid permit once rather than taking another send", async () => {
    const budget = createRequestExecutionBudget({ maxTotalModelSends: 2, baseSendAllowance: 2, finalRecoveryAllowance: 0, maxAlternateTargetSends: 1, maxTargetTransitions: 1 });
    const response = await handleResponses(request(), settings(), { model: "", provider: "" }, { sendBudget: budget });
    expect((await response.json()).status).toBe("completed");
    expect(calls.map(call => call.model)).toEqual(["swe-2", "rescue"]);
    expect(budget.used).toBe(2);
  });

  test("emergency transient 5xx retry cannot exceed the shared cap", async () => {
    const config = settings();
    config.providers.emergency = { adapter: "openai-chat", authMode: "key", apiKey: "fixture-only", baseUrl: "https://emergency.example/v1", transientRetryOn5xx: { attempts: 3 } };
    let emergencyRequests = 0;
    globalThis.fetch = (async () => {
      emergencyRequests++;
      return Response.json({ error: { code: "server_error", message: "Emergency unavailable" } }, { status: 500 });
    }) as typeof fetch;
    const budget = createRequestExecutionBudget({ maxTotalModelSends: 4, baseSendAllowance: 4, finalRecoveryAllowance: 0, maxAlternateTargetSends: 1, maxTargetTransitions: 1 });
    const response = await handleResponses(request(), config, { model: "", provider: "" }, { sendBudget: budget });
    expect(await response.text()).toContain("Source rejected compact fixture");
    expect(emergencyRequests).toBe(3);
    expect(1 + emergencyRequests).toBeLessThanOrEqual(4);
    expect(budget.used).toBe(1 + emergencyRequests);
  });

  test("an emergency rejected before sending refunds the unused reservation", async () => {
    const config = settings();
    config.providers.emergency = { adapter: "openai-chat", authMode: "key", baseUrl: "https://emergency.example/v1" };
    const budget = createRequestExecutionBudget();
    const response = await handleResponses(request(), config, { model: "", provider: "" }, { sendBudget: budget });
    expect(await response.text()).toContain("Source rejected compact fixture");
    expect(calls.map(call => call.model)).toEqual(["swe-2"]);
    expect(budget.used).toBe(1);
    expect(budget.alternateTargetSends).toBe(0);
  });

  test.each(["disabled", "generic-400", "policy", "auth", "partial", "side-effect", "same-model", "opaque", "continuation"])("keeps source failure: %s", async variant => {
    const config = settings();
    const payload = body(true);
    if (variant === "disabled") config.compactionRecovery!.allowDevinInvalidArgument = false;
    if (variant === "generic-400") sourceEvents = [{ ...sourceError, code: "invalid_request_error" } as AdapterEvent];
    if (variant === "policy") sourceEvents = [{ ...sourceError, code: "cyber_policy" } as AdapterEvent];
    if (variant === "auth") sourceEvents = [{ ...sourceError, status: 403, code: "permission_denied" } as AdapterEvent];
    if (variant === "partial") sourceEvents = [{ type: "text_delta", text: "Partial source text" }, sourceError];
    if (variant === "side-effect") sourceEvents = [{ type: "heartbeat", replayUnsafe: true }, sourceError];
    if (variant === "same-model") config.compactionRecovery!.model = "source/swe-2";
    if (variant === "opaque") (payload.input as unknown[]).unshift({ type: "compaction", encrypted_content: "native-opaque-fixture" });
    if (variant === "continuation") payload.previous_response_id = "missing-fixture";
    const response = await handleResponses(request(payload), config, { model: "", provider: "" });
    await response.text();
    expect(calls.filter(call => call.model === "rescue")).toHaveLength(0);
    if (variant !== "continuation") expect(calls.map(call => call.model)).toEqual(["swe-2"]);
  });

  test.each(["error", "empty", "truncated"])("failed emergency %s preserves the source error without recursive recovery", async outcome => {
    fallbackEvents = outcome === "error" ? [{ ...sourceError, message: "Different emergency failure" } as AdapterEvent]
      : outcome === "empty" ? [{ type: "done" }]
      : [{ type: "text_delta", text: "Truncated summary" }, { type: "done", stopReason: "max_tokens" }];
    const response = await handleResponses(request(), settings(), { model: "", provider: "" });
    const text = await response.text();
    expect(text).toContain("Source rejected compact fixture");
    expect(text).not.toContain("Different emergency failure");
    expect(calls.map(call => call.model)).toEqual(["swe-2", "rescue"]);
  });

  test("cancellation after source error does not dispatch emergency", async () => {
    abortOnSource = new AbortController();
    const response = await handleResponses(request(body(), "responses", abortOnSource.signal), settings(), { model: "", provider: "" });
    await response.text();
    expect(calls.map(call => call.model)).toEqual(["swe-2"]);
  });

  test("one shared send budget blocks emergency when the source consumes the allowance", async () => {
    const sendBudget = createRequestExecutionBudget({ maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 });
    const translatorBudget = createTranslatorBudget();
    try {
      const response = await handleResponses(request(), settings(), { model: "", provider: "" }, { sendBudget, translatorBudget });
      await response.text();
      expect(calls.map(call => call.model)).toEqual(["swe-2"]);
      expect(sendBudget.used).toBe(1);
      // The ingress-owned body observation remains until its caller disposes the shared budget;
      // the additional recovery snapshot has already released its separate retained charge.
      expect(translatorBudget.snapshot().currentBytes).toBe(jsonUtf8Bytes(body()));
    } finally { translatorBudget.dispose(); }
    expect(translatorBudget.snapshot().currentBytes).toBe(0);
  });

  test("canonical native v1 stays on its existing compact path and never invokes routed recovery", async () => {
    const config = settings();
    config.providers["openai-apikey"] = { adapter: "openai-responses", authMode: "key", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-only" };
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      return Response.json({ error: { code: "invalid_argument", message: "Native compact fixture failure" } }, { status: 400 });
    }) as typeof fetch;
    const response = await handleResponsesCompact(request({ ...body(false, false), model: "openai-apikey/gpt-4.1" }, "responses/compact"), config, { model: "", provider: "" });
    expect(response.status).toBe(400);
    await response.text();
    expect(urls).toEqual(["https://api.openai.com/v1/responses/compact"]);
    expect(calls).toHaveLength(0);
  });
});
