import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { getDefaultConfig } from "../../src/config";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import { handleResponses } from "../../src/server/responses";
import { expandPreviousResponseInput } from "../../src/responses/state";
import { setRelayPlatformForTests } from "../../src/server/responses/passthrough-delivery";
import {
  BUFFERED_RESPONSES_TOTAL_TIMEOUT_MS,
  bufferedResponsesReadOptions,
  collectBufferedResponsesSse,
  inspectBufferedResponsesTerminal,
} from "../../src/server/responses/buffered-sse-json";
import type { HandleResponsesOptions } from "../../src/server/responses/core";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { repoPath } from "../helpers/repo-root";

const provider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: CODEX_FORWARD_BASE_URL,
  authMode: "forward",
  codexAccountMode: "direct",
  upstreamWebsocket: false,
};

const config: OcxConfig = {
  ...getDefaultConfig(),
  port: 0,
  defaultProvider: "openai",
  providers: { openai: provider },
};

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  setRelayPlatformForTests(undefined);
});

function requestBody(stream: boolean, store: boolean): Record<string, unknown> {
  return {
    model: "openai/gpt-5.6-sol",
    input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
    stream,
    store,
  };
}

const ENCRYPTED_FUNCTION_OUTPUT = `${Buffer.concat([
  Buffer.from([0x80]),
  Buffer.alloc(8),
  Buffer.alloc(16),
  Buffer.alloc(16),
  Buffer.alloc(32),
]).toString("base64url")}==`;

function encryptedFunctionOutputBody(): Record<string, unknown> {
  return {
    model: "openai/gpt-5.6-sol",
    stream: false,
    store: false,
    input: [
      { type: "function_call", call_id: "call_6162", name: "lookup", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "call_6162",
        output: [
          { type: "encrypted_content", encrypted_content: ENCRYPTED_FUNCTION_OUTPUT },
          { type: "input_text", text: "visible result" },
        ],
      },
      { role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  };
}

function call(
  body: Record<string, unknown>,
  options: HandleResponsesOptions = {},
  requestConfig: OcxConfig = config,
): Promise<Response> {
  releaseSpendHome = acquireOwnedSpendHome();
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer fixture-forward-token",
    },
    body: JSON.stringify(body),
  }), requestConfig, { model: "", provider: "" }, options);
}

function sseEvent(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

describe("canonical ChatGPT transport for non-streaming Responses callers (#6162)", () => {
  test.each([false, true])("forces upstream SSE without changing explicit store:%s", store => {
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
    const parsed = {
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: false,
      options: {},
      _rawBody: { model: "gpt-5.6-sol", input: "ping", stream: false, store },
    } as OcxParsedRequest;
    const built = adapter.buildRequest(parsed, { headers: new Headers() });
    const outbound = JSON.parse(built.body) as Record<string, unknown>;
    expect(outbound.stream).toBe(true);
    expect(outbound.store).toBe(store);
    built.releaseBodyObservation?.();
  });

  test("forces upstream SSE when the client omitted stream", () => {
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
    const built = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: false,
      options: {},
      _rawBody: { model: "gpt-5.6-sol", input: "ping", store: false },
    } as OcxParsedRequest, { headers: new Headers() });
    expect(JSON.parse(built.body)).toMatchObject({ stream: true, store: false });
    built.releaseBodyObservation?.();
  });

  test("does not coerce a noncanonical forward gateway", () => {
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter({
      ...provider,
      baseUrl: "https://forward.example.test/v1",
    }));
    const built = adapter.buildRequest({
      modelId: "routed-model",
      context: { messages: [] },
      stream: false,
      options: {},
      _rawBody: { model: "routed-model", input: "ping", stream: false, store: true },
    } as OcxParsedRequest, { headers: new Headers() });
    expect(JSON.parse(built.body)).toMatchObject({ stream: false, store: true });
    built.releaseBodyObservation?.();
  });

  test("missing Content-Type still returns complete JSON with structured output and accounting", async () => {
    const terminal = {
      id: "resp_nonstream",
      object: "response",
      created_at: 1_800_000_000,
      status: "completed",
      model: "gpt-5.6-sol",
      store: true,
      output: [
        {
          type: "reasoning", id: "rs_1", status: "completed",
          summary: [{ type: "summary_text", text: "brief rationale" }],
          content: [{ type: "reasoning_text", text: "private rationale" }],
          encrypted_content: "opaque-reasoning",
        },
        {
          type: "message", id: "msg_1", status: "completed", role: "assistant",
          content: [
            { type: "output_text", text: "answer", annotations: [{ type: "url_citation", url: "https://example.test", title: "source", start_index: 0, end_index: 6 }] },
            { type: "refusal", refusal: "declined detail" },
          ],
        },
        { type: "function_call", id: "fc_1", status: "completed", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" },
        { type: "custom_tool_call", id: "ctc_1", status: "completed", call_id: "call_2", name: "patch", input: "*** Begin Patch" },
      ],
      usage: {
        input_tokens: 17,
        output_tokens: 9,
        total_tokens: 26,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 4 },
        subscription: { window: "fixture" },
      },
    };
    let outbound: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      outbound = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(new TextEncoder().encode([
        sseEvent("response.created", { response: { ...terminal, status: "in_progress", output: [] } }),
        ...terminal.output.map((item, output_index) => sseEvent("response.output_item.done", { output_index, item })),
        // Canonical streams may leave the terminal output sparse; the shared inspector must
        // reconstruct every structured item from output_item.done without losing terminal fields.
        sseEvent("response.completed", { response: { ...terminal, output: [] } }),
        "data: [DONE]\n\n",
      ].join("")), { headers: { "x-codex-turn-id": "turn-6162" } });
    }) as typeof fetch;
    const terminals: string[] = [];
    const completedModels: string[] = [];

    const response = await call(requestBody(false, true), {
      onNativePassthroughTerminal: status => terminals.push(status),
      onResponseComplete: model => completedModels.push(model),
    });

    expect(outbound?.stream).toBe(true);
    expect(outbound?.store).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-codex-turn-id")).toBe("turn-6162");
    expect(await response.json()).toEqual(terminal);
    expect(terminals).toEqual(["completed"]);
    expect(completedModels).toEqual(["gpt-5.6-sol"]);
  });

  test("omitted stream is negotiated as JSON end-to-end while upstream receives true", async () => {
    let outbound: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      outbound = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(sseEvent("response.completed", { response: {
        id: "resp_omitted", status: "completed", model: "gpt-5.6-sol", output: [],
      } }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const body = requestBody(false, false);
    delete body.stream;

    const response = await call(body);

    expect(outbound?.stream).toBe(true);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ id: "resp_omitted", status: "completed", output: [] });
  });

  test.each([false, true])("redacts echoed pooled bearer in failed terminal for stream:%s", async stream => {
    const bearer = "fixture-pooled-bearer-123456789";
    const failed = {
      id: `resp_failed_secret_${stream}`,
      status: "failed",
      output: [{
        type: "message", id: "msg_secret_echo", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: "fixture-forward-token", annotations: [] }],
      }],
      error: { type: "server_error", code: "upstream_error", message: `upstream saw Bearer ${bearer}` },
      last_error: {
        message: `Authorization: Bearer ${bearer}`,
        detail: "raw echo fixture-forward-token",
      },
      metadata: { diagnostic: "selected fixture-forward-token" },
    };
    globalThis.fetch = (async () => new Response(`: fixture-forward-token\n${sseEvent("response.failed", {
      response: failed, detail: "outer fixture-forward-token",
    })}`, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

    const response = await call(requestBody(stream, true));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(bearer);
    expect(text).not.toContain("fixture-forward-token");
    expect(text).toContain("[REDACTED]");
    if (stream) {
      expect(text).toContain("event: response.failed");
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain(": fixture-forward-token");
    } else {
      const json = JSON.parse(text) as typeof failed;
      expect(json).toMatchObject({ id: failed.id, status: "failed", error: {
        type: "server_error", code: "upstream_error", message: "upstream saw Bearer [REDACTED]",
      } });
      expect(json.last_error.message).toContain("[REDACTED]");
    }
    const next = { model: "openai/gpt-5.6-sol", previous_response_id: failed.id, input: "retry" };
    expect(expandPreviousResponseInput(next)).toEqual(next);
  });

  test("missing Content-Type keeps canonical non-stream opaque-state recovery on the SSE path", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        return new Response(new TextEncoder().encode(sseEvent("response.failed", { response: {
          id: "resp_ciphertext_rejected",
          status: "failed",
          output: [],
          error: {
            message: "Encrypted function output content could not be decrypted or decoded.",
            type: "server_error",
            code: null,
          },
        } })));
      }
      return new Response(new TextEncoder().encode(sseEvent("response.completed", { response: {
        id: "resp_ciphertext_recovered",
        status: "completed",
        model: "gpt-5.6-sol",
        output: [],
      } })));
    }) as typeof fetch;

    const response = await call(encryptedFunctionOutputBody());
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ id: "resp_ciphertext_recovered", status: "completed" });
    expect(outbound).toHaveLength(2);
    expect(outbound.map(body => body.stream)).toEqual([true, true]);
    expect(JSON.stringify(outbound[0])).toContain("encrypted_content");
    expect(JSON.stringify(outbound[1])).not.toContain("encrypted_content");
    expect(JSON.stringify(outbound[1])).toContain("[encrypted content omitted]");
  });

  test("missing Content-Type keeps canonical non-stream pre-output reset recovery on the SSE path", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    const created = new TextEncoder().encode(sseEvent("response.created", { response: {
      id: "resp_reset_first",
      status: "in_progress",
      output: [],
    } }));
    globalThis.fetch = (async (_input, init) => {
      outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (outbound.length === 1) {
        let emitted = false;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!emitted) {
              emitted = true;
              controller.enqueue(created);
              return;
            }
            controller.error(Object.assign(new Error("fixture body reset before output"), { code: "ECONNRESET" }));
          },
        }));
      }
      return new Response(new TextEncoder().encode(sseEvent("response.completed", { response: {
        id: "resp_reset_recovered",
        status: "completed",
        model: "gpt-5.6-sol",
        output: [],
      } })));
    }) as typeof fetch;

    const resetConfig: OcxConfig = {
      ...config,
      providers: { openai: { ...provider, retryOnReset: {} } },
    };
    const response = await call(requestBody(false, false), {}, resetConfig);
    const json = await response.json() as Record<string, unknown>;

    expect(response.status, JSON.stringify(json)).toBe(200);
    expect(json).toMatchObject({ id: "resp_reset_recovered", status: "completed" });
    expect(outbound).toHaveLength(2);
    expect(outbound.map(body => body.stream)).toEqual([true, true]);
  });

  test.each([
    ["clean EOF", sseEvent("response.created", { response: { id: "resp_eof", status: "in_progress", output: [] } })],
    ["malformed payload", [
      "data: {not-json}\n\n",
      sseEvent("response.completed", { response: { id: "resp_bad", status: "completed", output: [] } }),
    ].join("")],
  ])("fails closed on %s instead of returning partial HTTP 200 JSON", async (_name, body) => {
    let outbound: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      outbound = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const terminals: string[] = [];

    const response = await call(requestBody(false, false), {
      onNativePassthroughTerminal: status => terminals.push(status),
    });
    const error = await response.json() as { error?: { type?: string; message?: string } };

    expect(outbound?.stream).toBe(true);
    expect(outbound?.store).toBe(false);
    expect(response.status).toBe(502);
    expect(error.error?.type).toBe("server_error");
    expect(error.error?.message).toContain("valid terminal response");
    expect(terminals).toEqual(["failed"]);
  });

  test("client abort returns 499 without terminal or completion effects", async () => {
    const abort = new AbortController();
    let cancelled = 0;
    globalThis.fetch = (async () => {
      setTimeout(() => abort.abort(new Error("fixture client gone")), 0);
      return new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel: () => { cancelled += 1; },
      }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const terminals: string[] = [];
    const completedModels: string[] = [];
    let nativeCancels = 0;

    const response = await call(requestBody(false, false), {
      abortSignal: abort.signal,
      onNativePassthroughTerminal: status => terminals.push(status),
      onResponseComplete: model => completedModels.push(model),
      onNativePassthroughCancel: () => { nativeCancels += 1; },
    });

    expect(response.status).toBe(499);
    expect(terminals).toEqual([]);
    expect(completedModels).toEqual([]);
    expect(nativeCancels).toBe(1);
    expect(cancelled).toBe(1);
  });

  test("client abort during deferred replay yields returns 499 without publishing completion", async () => {
    const abort = new AbortController();
    const item = {
      type: "message", id: "msg_disconnect", status: "completed", role: "assistant",
      content: [{ type: "output_text", text: "done", annotations: [] }],
    };
    const transcript = [
      ...Array.from({ length: 14_000 }, () => sseEvent("response.output_text.delta", {
        output_index: 0, item_id: "msg_disconnect", delta: "x",
      })),
      sseEvent("response.output_item.done", { output_index: 0, item }),
      sseEvent("response.completed", { response: {
        id: "resp_disconnected", status: "completed", model: "gpt-5.6-sol", output: [item],
      } }),
    ].join("");
    expect(new TextEncoder().encode(transcript).byteLength).toBeGreaterThan(1024 * 1024);
    globalThis.fetch = (async () => new Response(transcript, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
    const terminals: string[] = [];
    const completedModels: string[] = [];
    let nativeCancels = 0;
    let firstOutputs = 0;

    const response = await call(requestBody(false, true), {
      abortSignal: abort.signal,
      onFirstOutput: () => {
        firstOutputs += 1;
        abort.abort(new Error("fixture client gone"));
      },
      onNativePassthroughTerminal: status => terminals.push(status),
      onResponseComplete: model => completedModels.push(model),
      onNativePassthroughCancel: () => { nativeCancels += 1; },
    });

    expect(firstOutputs).toBe(1);
    expect(abort.signal.aborted).toBe(true);
    expect(response.status).toBe(499);
    expect(terminals).toEqual([]);
    expect(completedModels).toEqual([]);
    expect(nativeCancels).toBe(1);
  });

  test.each(["darwin", "win32"] as const)("redacts selected bearer in synthetic %s streaming failure", async platform => {
    setRelayPlatformForTests(platform);
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error("reset after fixture-forward-token")); },
    }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const response = await call(requestBody(true, false));
    const text = await response.text();
    expect(text).toContain("response.failed");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("fixture-forward-token");
  });

  test("canonical buffered serving-state commit is ordered after both validations", () => {
    const source = readFileSync(repoPath("src/server/responses/passthrough-delivery.ts"), "utf8");
    const branch = source.indexOf("if (canonicalBufferedJson) {");
    const rawValidation = source.indexOf("if (!raw.ok)", branch);
    const clientValidation = source.indexOf("if (!client.ok)", rawValidation);
    const deferredCommit = source.indexOf("commitReasoningReplayServingRoute(nativeExchange.request.headers);", clientValidation);
    const finalAbortCheck = source.lastIndexOf("if (signal.aborted) return cancelAfterValidation();", deferredCommit);
    expect(branch).toBeGreaterThan(-1);
    expect(rawValidation).toBeGreaterThan(branch);
    expect(clientValidation).toBeGreaterThan(rawValidation);
    expect(deferredCommit).toBeGreaterThan(clientValidation);
    expect(finalAbortCheck).toBeGreaterThan(source.indexOf("effectInspector.finish();", clientValidation));
    expect(deferredCommit).toBeGreaterThan(finalAbortCheck);
    expect(source.slice(branch, deferredCommit)).not.toContain("commitReasoningReplayServingRoute(");
  });

  test("leaves stream:true callers on the SSE relay", async () => {
    let outbound: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      outbound = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(sseEvent("response.completed", {
        response: { id: "resp_stream", status: "completed", model: "gpt-5.6-sol", output: [] },
      }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const response = await call(requestBody(true, false));
    expect(outbound?.stream).toBe(true);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("response.completed");
  });

  test.each([
    ["read error", () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseEvent("response.created", {
          response: { id: "resp_read", status: "in_progress", output: [] },
        })));
        controller.error(new Error("fixture reset"));
      },
    })],
    ["oversized frame", () => new Response(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(4 * 1024 * 1024) })}\n\n`,
    ).body!],
  ])("bounded collector rejects a %s before terminal publication", async (_name, source) => {
    const upstream = new AbortController();
    const result = await collectBufferedResponsesSse(source(), upstream);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe(_name === "oversized frame" ? "oversized" : "read_error");
  });

  test("bounded collector applies its first-byte deadline to a silent SSE body", async () => {
    const source = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });
    const result = await collectBufferedResponsesSse(source, new AbortController(), {
      read: { firstByteTimeoutMs: 5, inactivityTimeoutMs: 5, totalTimeoutMs: 20 },
    });
    expect(result).toMatchObject({ ok: false, kind: "timeout" });
  });

  test("disabled stall budget falls back to the independent buffered-turn ceiling", async () => {
    const startedAt = 1_000;
    expect(bufferedResponsesReadOptions(0, BUFFERED_RESPONSES_TOTAL_TIMEOUT_MS, startedAt)).toEqual({
      deadlineAt: startedAt + BUFFERED_RESPONSES_TOTAL_TIMEOUT_MS,
      firstByteTimeoutMs: BUFFERED_RESPONSES_TOTAL_TIMEOUT_MS,
      inactivityTimeoutMs: BUFFERED_RESPONSES_TOTAL_TIMEOUT_MS,
      totalTimeoutMs: BUFFERED_RESPONSES_TOTAL_TIMEOUT_MS,
    });
    expect(bufferedResponsesReadOptions(2_500, BUFFERED_RESPONSES_TOTAL_TIMEOUT_MS, startedAt)).toEqual({
      deadlineAt: startedAt + BUFFERED_RESPONSES_TOTAL_TIMEOUT_MS,
      firstByteTimeoutMs: 2_500,
      inactivityTimeoutMs: 2_500,
      totalTimeoutMs: BUFFERED_RESPONSES_TOTAL_TIMEOUT_MS,
    });

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(sseEvent("response.completed", {
            response: { id: "resp_delayed", status: "completed", output: [] },
          })));
          controller.close();
        }, 10);
      },
    });
    const result = await collectBufferedResponsesSse(body, new AbortController(), {
      read: bufferedResponsesReadOptions(0, 100),
    });
    expect(result).toMatchObject({ ok: true, terminal: { status: "completed" } });

    // A later validation pass must inherit the original absolute deadline instead of receiving
    // a fresh totalTimeoutMs window merely because it constructed a new collector.
    const expiredSharedRead = bufferedResponsesReadOptions(0, 100, Date.now() - 200);
    const expired = await collectBufferedResponsesSse(
      new Response(sseEvent("response.completed", {
        response: { id: "resp_too_late", status: "completed", output: [] },
      })).body!,
      new AbortController(),
      { read: expiredSharedRead },
    );
    expect(expired).toMatchObject({ ok: false, kind: "timeout" });
  });

  test("bare upstream refusal keeps its message, code, and non-retryable status", async () => {
    globalThis.fetch = (async () => new Response(sseEvent("error", {
      error: {
        type: "invalid_request_error",
        code: "invalid_prompt",
        message: "The upstream rejected this prompt. Please try again in 120s.",
      },
    }), { headers: { "content-type": "text/event-stream", "retry-after": "120" } })) as typeof fetch;
    const terminals: string[] = [];

    const response = await call(requestBody(false, false), {
      onNativePassthroughTerminal: status => terminals.push(status),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toEqual({
      error: {
        type: "invalid_request_error",
        code: "invalid_prompt",
        message: "The upstream rejected this prompt. Please try again in 120s.",
      },
      retryable: false,
    });
    expect(terminals).toEqual(["failed"]);
  });

  test("bare non-refusal error copy cannot relabel a transport failure or account outcome", async () => {
    globalThis.fetch = (async () => new Response(sseEvent("error", {
      error: {
        type: "upstream_error",
        code: "upstream_reset",
        message: "invalid api key while forwarding the upstream reset",
      },
    }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const terminals: string[] = [];

    const response = await call(requestBody(false, false), {
      onNativePassthroughTerminal: status => terminals.push(status),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        type: "upstream_error",
        code: "upstream_server_error",
        message: "invalid api key while forwarding the upstream reset",
      },
    });
    expect(terminals).toEqual(["failed"]);
  });

  test("bare structured rate-limit error preserves its authoritative family", async () => {
    globalThis.fetch = (async () => new Response(sseEvent("error", {
      code: "rate_limit_exceeded",
      message: "Rate limit exceeded.",
    }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const terminals: string[] = [];

    const response = await call(requestBody(false, false), {
      onNativePassthroughTerminal: status => terminals.push(status),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        message: "Rate limit exceeded.",
      },
    });
    expect(terminals).toEqual(["failed"]);
  });

  test("bare structured overload keeps its server class and 503 status", async () => {
    globalThis.fetch = (async () => new Response(sseEvent("error", {
      error: {
        type: "server_error",
        code: "server_is_overloaded",
        message: "The upstream is overloaded.",
      },
    }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;

    const response = await call(requestBody(false, false));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        type: "server_error",
        code: "server_is_overloaded",
        message: "The upstream is overloaded.",
      },
    });
  });

  test("incomplete terminals retain already-finished output items and terminal usage", () => {
    const partial = {
      type: "message", id: "msg_partial", status: "incomplete", role: "assistant",
      content: [{ type: "output_text", text: "partial", annotations: [] }],
    };
    const inspected = inspectBufferedResponsesTerminal([
      sseEvent("response.output_item.done", { output_index: 0, item: partial }),
      sseEvent("response.incomplete", { response: {
        id: "resp_partial",
        status: "incomplete",
        output: [],
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      } }),
    ].join(""));
    expect(inspected).toEqual({
      ok: true,
      terminal: {
        status: "incomplete",
        response: {
          id: "resp_partial",
          status: "incomplete",
          output: [partial],
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        },
      },
    });
  });

  test("comment-only SSE heartbeats do not taint a valid terminal", () => {
    const inspected = inspectBufferedResponsesTerminal([
      ": upstream heartbeat\n\n",
      sseEvent("response.completed", {
        response: { id: "resp_heartbeat", status: "completed", output: [] },
      }),
    ].join(""));
    expect(inspected).toEqual({
      ok: true,
      terminal: {
        status: "completed",
        response: { id: "resp_heartbeat", status: "completed", output: [] },
      },
    });
  });

  test("merges a partial nonempty terminal with later done items without loss", () => {
    const first = { type: "message", id: "msg_0", status: "completed", role: "assistant", content: [] };
    const second = { type: "function_call", id: "fc_1", status: "completed", call_id: "call_1", name: "lookup", arguments: "{}" };
    const inspected = inspectBufferedResponsesTerminal([
      sseEvent("response.output_item.done", { output_index: 1, item: second }),
      sseEvent("response.completed", { response: {
        id: "resp_merge", status: "completed", output: [first],
      } }),
    ].join(""));
    expect(inspected).toMatchObject({ ok: true, terminal: { response: { output: [first, second] } } });
  });

  test("merges an identity-matched sparse terminal item without shifting output indices", () => {
    const first = { type: "reasoning", id: "rs_0", summary: [] };
    const second = { type: "message", id: "msg_1", status: "completed", role: "assistant", content: [] };
    const inspected = inspectBufferedResponsesTerminal([
      sseEvent("response.output_item.done", { output_index: 0, item: first }),
      sseEvent("response.output_item.done", { output_index: 1, item: second }),
      sseEvent("response.completed", { response: {
        id: "resp_sparse", status: "completed", output: [second],
      } }),
    ].join(""));
    expect(inspected).toMatchObject({ ok: true, terminal: { response: { output: [first, second] } } });
  });

  test("rejects contradictory duplicate done events for one output index", () => {
    const first = { type: "message", id: "msg_a", status: "completed", role: "assistant", content: [] };
    const conflicting = { ...first, id: "msg_b" };
    expect(inspectBufferedResponsesTerminal([
      sseEvent("response.output_item.done", { output_index: 0, item: first }),
      sseEvent("response.output_item.done", { output_index: 0, item: conflicting }),
      sseEvent("response.completed", { response: { id: "resp_duplicate", status: "completed", output: [] } }),
    ].join(""))).toMatchObject({ ok: false, kind: "malformed" });
  });

  test("out-of-order done items are sorted when their indices are contiguous", () => {
    const zero = { type: "message", id: "msg_0", status: "completed", role: "assistant", content: [] };
    const one = { type: "reasoning", id: "rs_1", summary: [] };
    const inspected = inspectBufferedResponsesTerminal([
      sseEvent("response.output_item.done", { output_index: 1, item: one }),
      sseEvent("response.output_item.done", { output_index: 0, item: zero }),
      sseEvent("response.completed", { response: { id: "resp_order", status: "completed", output: [] } }),
    ].join(""));
    expect(inspected).toMatchObject({ ok: true, terminal: { response: { output: [zero, one] } } });
  });

  test.each([
    ["index gap", sseEvent("response.output_item.done", {
      output_index: 1,
      item: { type: "message", id: "msg_1", status: "completed", role: "assistant", content: [] },
    })],
    ["configured item cap", sseEvent("response.output_item.done", {
      output_index: 10_000,
      item: { type: "message", id: "msg_cap", status: "completed", role: "assistant", content: [] },
    })],
  ])("fails closed when reconstruction is tainted by %s", (_name, itemFrame) => {
    const inspected = inspectBufferedResponsesTerminal(itemFrame + sseEvent("response.completed", {
      response: { id: "resp_tainted", status: "completed", output: [] },
    }));
    expect(inspected).toMatchObject({ ok: false, kind: "malformed" });
  });

  test("rejects a terminal whose response status disagrees with its event", () => {
    expect(inspectBufferedResponsesTerminal(sseEvent("response.completed", {
      response: { id: "resp_mismatch", status: "incomplete", output: [] },
    }))).toMatchObject({ ok: false, kind: "malformed" });
  });

  test("derives a missing response status from the terminal event", () => {
    expect(inspectBufferedResponsesTerminal(sseEvent("response.failed", {
      response: { id: "resp_failed", error: { code: "tool_not_allowed", message: "blocked" } },
    }))).toMatchObject({
      ok: true,
      terminal: { status: "failed", response: { status: "failed", output: [] } },
    });
  });

  test.each(["response.output_text.delta", "response.function_call_arguments.delta"])(
    "rejects sparse completion after %s without output_item.done",
    type => {
      const delta = type === "response.output_text.delta"
        ? { output_index: 0, item_id: "msg_0", delta: "partial" }
        : { output_index: 0, item_id: "fc_0", call_id: "call_0", delta: "{\"q\":" };
      expect(inspectBufferedResponsesTerminal([
        sseEvent(type, delta),
        sseEvent("response.completed", { response: { id: "resp_open", status: "completed", output: [] } }),
      ].join(""))).toMatchObject({ ok: false, kind: "malformed" });
    },
  );

  test("an authoritative terminal item covers an index whose delta had no done event", () => {
    const item = {
      type: "message", id: "msg_terminal", status: "completed", role: "assistant",
      content: [{ type: "output_text", text: "whole", annotations: [] }],
    };
    expect(inspectBufferedResponsesTerminal([
      sseEvent("response.output_text.delta", { output_index: 0, item_id: "msg_terminal", delta: "whole" }),
      sseEvent("response.completed", { response: { id: "resp_covered", status: "completed", output: [item] } }),
    ].join(""))).toMatchObject({ ok: true, terminal: { response: { output: [item] } } });
  });

  test("aggregate input budget rejects one large multi-frame network chunk before terminal", async () => {
    const body = new Response(": keepalive\n\n".repeat(200)).body!;
    const result = await collectBufferedResponsesSse(body, new AbortController(), {
      read: { maxBytes: 1024, firstByteTimeoutMs: 100, inactivityTimeoutMs: 100, totalTimeoutMs: 100 },
    });
    expect(result).toMatchObject({ ok: false, kind: "oversized" });
  });

  test("aggregate frame budget rejects tiny-event amplification across reader chunks", async () => {
    const bytes = new TextEncoder().encode(": heartbeat\n\n".repeat(4)
      + sseEvent("response.completed", { response: { id: "resp_late", status: "completed", output: [] } }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 28));
        controller.enqueue(bytes.subarray(28));
        controller.close();
      },
    });
    const result = await collectBufferedResponsesSse(body, new AbortController(), {
      read: { maxFrames: 3, firstByteTimeoutMs: 100, inactivityTimeoutMs: 100, totalTimeoutMs: 100 },
    });
    expect(result).toMatchObject({ ok: false, kind: "oversized" });
  });
});
