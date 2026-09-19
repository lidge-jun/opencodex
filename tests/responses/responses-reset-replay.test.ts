/**
 * `retryOnReset` through the public Responses dispatch: a native `openai-responses` provider
 * whose upstream closes the connection before any response byte. The counted quantity is the
 * number of physical sends, read back from the request log the same way
 * `responses-send-budget-counts.test.ts` does, because the whole contract is "one more send,
 * and only for a request the proxy can judge self-contained".
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { handleResponses } from "../../src/server/responses/core";
import { selfContainedResponsesBody } from "../../src/server/responses/reset-replay";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
const warnSpies: Array<ReturnType<typeof spyOn>> = [];

beforeEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  warnSpies.push(spyOn(console, "warn").mockImplementation(() => {}));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const spy of warnSpies.splice(0)) spy.mockRestore();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
});

function responsesProvider(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    adapter: "openai-responses",
    baseUrl: `https://${name}.example/v1`,
    authMode: "key",
    apiKey: `sk-${name}`,
    models: [`model-${name}`],
    ...extra,
  };
}

function singleProvider(extra: Record<string, unknown> = {}): OcxConfig {
  return {
    defaultProvider: "t0",
    providers: { t0: responsesProvider("t0", extra) },
  } as unknown as OcxConfig;
}

function comboOverTwo(extra: Record<string, unknown> = {}): OcxConfig {
  return {
    defaultProvider: "t0",
    providers: { t0: responsesProvider("t0", extra), t1: responsesProvider("t1", extra) },
    combos: { fan: { strategy: "failover", targets: [
      { provider: "t0", model: "model-t0" }, { provider: "t1", model: "model-t1" },
    ] } },
  } as unknown as OcxConfig;
}

/** A self-contained turn: nothing stored, complete input, one client tool. */
function selfContained(model: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model, stream: false, store: false, input: "hello",
    tools: [{ type: "function", name: "read_fixture", parameters: { type: "object", properties: {} } }],
    ...fields,
  };
}

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function reset(): Error {
  return Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" });
}

function completed(id: string): Response {
  return Response.json({
    id, object: "response", status: "completed", model: "model-t0", output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
}

interface Wire { sends: Array<{ authorization: string; connection: string | null; keepalive: unknown; body: string }> }

/** Fake upstream that answers each send in order; the last entry repeats. */
function upstream(answers: Array<Response | Error>): Wire {
  const wire: Wire = { sends: [] };
  let index = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    wire.sends.push({
      authorization: headers.get("authorization") ?? "",
      connection: headers.get("connection"),
      keepalive: (init as { keepalive?: unknown } | undefined)?.keepalive,
      body: typeof init?.body === "string" ? init.body : "",
    });
    const answer = answers[index] ?? answers[answers.length - 1]!;
    index += 1;
    if (answer instanceof Error) throw answer;
    return answer.clone();
  }) as typeof fetch;
  return wire;
}

const totalSends = (logCtx: RequestLogContext): number =>
  (logCtx.attempts ?? []).reduce((sum, attempt) => sum + attempt.sendCount, 0);

describe("selfContainedResponsesBody", () => {
  const base = selfContained("m");

  test("accepts a stored-nothing turn with complete input and client tools", () => {
    expect(selfContainedResponsesBody(base)).toBe(true);
    expect(selfContainedResponsesBody({ ...base, tools: undefined })).toBe(true);
    expect(selfContainedResponsesBody({ ...base, input: [
      { role: "user", content: "hi" },
      { type: "message", role: "assistant", content: [] },
      { type: "reasoning", summary: [] },
      { type: "function_call", call_id: "c", name: "read_fixture", arguments: "{}" },
      { type: "function_call_output", call_id: "c", output: "ok" },
      { type: "custom_tool_call", call_id: "d", name: "x", input: "" },
      { type: "custom_tool_call_output", call_id: "d", output: "" },
      { type: "compaction", encrypted_content: "..." },
      { type: "tool_search_call", id: "s" },
    ] })).toBe(true);
    expect(selfContainedResponsesBody({ ...base, tools: [
      { type: "custom", name: "fixture" },
      { type: "tool_search", execution: "client" },
      { type: "namespace", name: "group", tools: [{ type: "function", name: "inner" }] },
    ] })).toBe(true);
    expect(selfContainedResponsesBody({ ...base, input: [
      { role: "user", content: "hi" },
      { type: "additional_tools", tools: [{ type: "function", name: "late" }] },
      { type: "tool_search_output", tools: [{ type: "namespace", name: "n", tools: [{ type: "custom", name: "c" }] }] },
    ] })).toBe(true);
  });

  test("refuses anything stored, continued, backgrounded or server-owned", () => {
    for (const fields of [
      { store: true }, { store: undefined }, { background: true },
      { previous_response_id: "resp_prior" }, { conversation: "conv_1" }, { stream_id: "lane" },
      { input: undefined }, { input: null }, { input: 5 },
    ]) {
      expect(selfContainedResponsesBody({ ...base, ...fields })).toBe(false);
    }
    expect(selfContainedResponsesBody("not an object")).toBe(false);
    expect(selfContainedResponsesBody(null)).toBe(false);
  });

  test("refuses hosted, server-executed and unknown tools wherever they are declared", () => {
    for (const tool of [
      { type: "web_search" }, { type: "mcp", server_url: "https://example.test" },
      { type: "code_interpreter" }, { type: "file_search" }, { type: "image_generation" },
      { type: "tool_search", execution: "server" }, { type: "future_unknown" },
      { type: "namespace", name: "mixed", tools: [{ type: "function", name: "ok" }, { type: "mcp" }] },
      { type: "namespace", tools: [{ type: "function", name: "unnamed-group" }] },
      "not-an-object",
    ]) {
      expect(selfContainedResponsesBody({ ...base, tools: [tool] })).toBe(false);
      expect(selfContainedResponsesBody({ ...base, input: [{ type: "additional_tools", tools: [tool] }] })).toBe(false);
      expect(selfContainedResponsesBody({ ...base, input: [{ type: "tool_search_output", tools: [tool] }] })).toBe(false);
    }
    expect(selfContainedResponsesBody({ ...base, tools: {} })).toBe(false);
  });

  test("refuses input items the client does not own or the proxy does not know", () => {
    for (const item of [
      { type: "item_reference", id: "stored" },
      { type: "mcp_approval_response", approval_request_id: "a", approve: true },
      { type: "computer_call_output", call_id: "c", output: {} },
      { type: "future_unknown_state" },
      { role: "tool", content: "x" },
      { content: "no role, no type" },
      "not-an-object",
    ]) {
      expect(selfContainedResponsesBody({ ...base, input: [{ role: "user", content: "hi" }, item] })).toBe(false);
    }
  });

  test("catalog traversal is bounded", () => {
    let tool: unknown = { type: "function", name: "leaf" };
    for (let i = 0; i < 6; i++) tool = { type: "namespace", name: "deep", tools: [tool] };
    expect(selfContainedResponsesBody({ ...base, tools: [tool] })).toBe(false);
    expect(selfContainedResponsesBody({ ...base, tools: Array(4097).fill({ type: "function", name: "many" }) })).toBe(false);
  });
});

describe("retryOnReset through native Responses dispatch", () => {
  test("a self-contained turn is sent again on a fresh connection and completes", async () => {
    const wire = upstream([reset(), completed("resp_replayed")]);
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request(selfContained("model-t0")), singleProvider({ retryOnReset: {} }), logCtx);
    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe("resp_replayed");
    expect(wire.sends).toHaveLength(2);
    expect(wire.sends.map(send => send.authorization)).toEqual(["Bearer sk-t0", "Bearer sk-t0"]);
    // The replay is byte-identical and leaves Bun's keep-alive pool behind.
    expect(wire.sends[1]!.body).toBe(wire.sends[0]!.body);
    expect(wire.sends[1]!.connection).toBe("close");
    expect(wire.sends[1]!.keepalive).toBe(false);
    expect(totalSends(logCtx)).toBe(2);
  });

  test("a spent ceiling is the same refusal the request would get without the policy", async () => {
    const wire = upstream([reset(), reset(), completed("resp_never")]);
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request(selfContained("model-t0")), singleProvider({ retryOnReset: {} }), logCtx);
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
    expect(wire.sends).toHaveLength(2);
    expect(totalSends(logCtx)).toBe(2);
  });

  test("attempts raises the ceiling to the leg's own budget and no further", async () => {
    const wire = upstream([reset(), reset(), reset(), completed("resp_never")]);
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(
      request(selfContained("model-t0")), singleProvider({ retryOnReset: { attempts: 3 } }), logCtx,
    );
    expect(response.status).toBe(429);
    expect(wire.sends).toHaveLength(3);
    expect(totalSends(logCtx)).toBe(3);
  });

  test("a request the proxy cannot judge self-contained keeps the refusal after one send", async () => {
    for (const fields of [
      { store: undefined }, { previous_response_id: "resp_prior" },
      { tools: [{ type: "web_search" }] }, { input: [{ type: "item_reference", id: "stored" }] },
    ]) {
      const wire = upstream([reset(), completed("resp_never")]);
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(
        request(selfContained("model-t0", fields)), singleProvider({ retryOnReset: {} }), logCtx,
      );
      expect(response.status).toBe(429);
      expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
      expect(wire.sends).toHaveLength(1);
      expect(totalSends(logCtx)).toBe(1);
    }
  });

  test("without the policy nothing changes: one send, then the refusal", async () => {
    for (const extra of [{}, { retryOnReset: { enabled: false } }]) {
      const wire = upstream([reset(), completed("resp_never")]);
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(request(selfContained("model-t0")), singleProvider(extra), logCtx);
      expect(response.status).toBe(429);
      expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
      expect(wire.sends).toHaveLength(1);
    }
  });

  test("a spent replay cannot reach a combo sibling", async () => {
    const wire = upstream([reset(), reset(), completed("resp_never")]);
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request(selfContained("combo/fan")), comboOverTwo({ retryOnReset: {} }), logCtx);
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
    expect(wire.sends.map(send => send.authorization)).toEqual(["Bearer sk-t0", "Bearer sk-t0"]);
    expect(totalSends(logCtx)).toBe(2);
  });

  test("a streaming turn replays the same way", async () => {
    const sse = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_s"}}\n\n'
      + 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_s","status":"completed","output":[]}}\n\n';
    const wire = upstream([reset(), new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })]);
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(
      request(selfContained("model-t0", { stream: true })), singleProvider({ retryOnReset: {} }), logCtx,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("response.completed");
    expect(wire.sends).toHaveLength(2);
    expect(wire.sends[1]!.connection).toBe("close");
  });
});
