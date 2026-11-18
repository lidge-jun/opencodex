import { afterEach, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import type { HandleResponsesOptions } from "../../src/server/responses/core-options";
import { setRelayPlatformForTests } from "../../src/server/responses/passthrough-delivery";
import { isEagerRelaySseResponse, responseWithDeferredRequestLog } from "../../src/server/relay";
import { ESTIMATED_USAGE_HEADER, estimatedUsageJson, withEstimatedUsage } from "../../src/server/responses/estimated-usage";
import type { RequestLogContext } from "../../src/server/request-log";
import { spendLedgerOwnerSnapshot } from "../../src/lib/spend-ledger-owner";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// #7427: a per-provider opt-in adds estimated usage when the provider omits it. The estimate is
// marked by a response header and never reaches the request log, spend or quota accounting.
const originalFetch = globalThis.fetch;
let release: (() => void) | undefined;
afterEach(() => {
  globalThis.fetch = originalFetch; release?.(); release = undefined;
  setRelayPlatformForTests(undefined);
  // Every request in a case shares one lease; a second acquisition would keep the journal held.
  expect(spendLedgerOwnerSnapshot().ownership).toBe("unheld");
});

const answer = "The capital of France is Paris, and it has been for a long time.";
const completed = (usage?: Record<string, number>) => ({
  id: "resp_fixture", object: "response", status: "completed", model: "probe",
  output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: answer, annotations: [] }] }],
  ...(usage ? { usage } : {}),
});

function config(estimateMissingUsage?: boolean, streamMode?: OcxConfig["streamMode"]): OcxConfig {
  return {
    port: 0, defaultProvider: "fixture", ...(streamMode ? { streamMode } : {}),
    providers: { fixture: { adapter: "openai-responses", authMode: "key", apiKey: "fixture-key",
      baseUrl: "https://gateway.example/v1", models: ["probe"],
      ...(estimateMissingUsage === undefined ? {} : { estimateMissingUsage }) } },
  } as unknown as OcxConfig;
}

function sse(body: Record<string, unknown>, terminal = "response.completed"): Response {
  const events = [
    { type: "response.created", response: { ...body, status: "in_progress", output: [], usage: undefined } },
    // A delta whose text mentions a terminal type must not be mistaken for one.
    { type: "response.output_text.delta", delta: "response.completed", item_id: "msg_1", output_index: 0, content_index: 0 },
    { type: terminal, response: body },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

async function send(cfg: OcxConfig, stream: boolean, upstream: Response, options: HandleResponsesOptions = {}) {
  release ??= acquireOwnedSpendHome();
  globalThis.fetch = (async () => upstream) as unknown as typeof fetch;
  const log = { model: "", provider: "" } as RequestLogContext;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/probe", input: "What is the capital of France?", stream, store: false }),
  }), cfg, log, options);
  // Read the body through the request-log finalizer the server wraps every response in, so the
  // log assertions below see what request history records.
  const text = await responseWithDeferredRequestLog(response, "ocx-test-estimate", Date.now(), log, () => {}).text();
  const terminal = stream
    ? JSON.parse(text.split("\n").find(line => line.startsWith("data: {\"type\":\"response.completed\"")
      || line.startsWith("data: {\"type\":\"response.incomplete\""))!.slice(6)).response
    : JSON.parse(text);
  return { response, terminal, log, text };
}

test("estimates count the request input and the response output, and leave usage the provider sent", () => {
  const estimated = withEstimatedUsage(completed(), 12, "probe");
  expect(estimated?.usage).toEqual({ input_tokens: 12, output_tokens: expect.any(Number), total_tokens: expect.any(Number) });
  const usage = estimated!.usage as { output_tokens: number; total_tokens: number };
  expect(usage.output_tokens).toBeGreaterThan(0);
  expect(usage.total_tokens).toBe(12 + usage.output_tokens);
  expect(withEstimatedUsage(completed({ input_tokens: 5, output_tokens: 6, total_tokens: 11 }), 12, "probe")).toBeUndefined();
  // An error body is not a response and stays untouched.
  expect(estimatedUsageJson(JSON.stringify({ error: { message: "nope" } }), 12, "probe")).toBeUndefined();
});

test("streaming: opted in, a missing usage is estimated and the stream is marked", async () => {
  const { response, terminal, log } = await send(config(true), true, sse(completed()));
  expect(response.headers.get(ESTIMATED_USAGE_HEADER)).toBe("when-missing");
  expect(terminal.usage).toEqual({ input_tokens: expect.any(Number), output_tokens: expect.any(Number), total_tokens: expect.any(Number) });
  expect(terminal.usage.input_tokens).toBeGreaterThan(0);
  expect(terminal.usage.output_tokens).toBeGreaterThan(0);
  // Accounting reads the provider's body: no usage was reported, so none is logged.
  expect(log.usage).toBeUndefined();
});

test("streaming: provider usage passes through unchanged even when opted in", async () => {
  const usage = { input_tokens: 5, output_tokens: 6, total_tokens: 11 };
  const { terminal, log } = await send(config(true), true, sse(completed(usage)));
  expect(terminal.usage).toEqual(usage);
  expect(log.usage).toMatchObject({ inputTokens: 5, outputTokens: 6 });
});

test("streaming: off by default, nothing is added or marked", async () => {
  const { response, terminal } = await send(config(), true, sse(completed()));
  expect(response.headers.get(ESTIMATED_USAGE_HEADER)).toBeNull();
  expect(terminal.usage).toBeUndefined();
});

test("JSON: opted in, a missing usage is estimated, marked true, and kept out of the log", async () => {
  const { response, terminal, log } = await send(config(true), false, Response.json(completed()));
  expect(response.headers.get(ESTIMATED_USAGE_HEADER)).toBe("true");
  expect(terminal.usage.output_tokens).toBeGreaterThan(0);
  expect(log.usage).toBeUndefined();
});

test("JSON: provider usage is not marked as estimated", async () => {
  const usage = { input_tokens: 5, output_tokens: 6, total_tokens: 11 };
  const { response, terminal, log } = await send(config(true), false, Response.json(completed(usage)));
  expect(response.headers.get(ESTIMATED_USAGE_HEADER)).toBeNull();
  expect(terminal.usage).toEqual(usage);
  expect(log.usage).toMatchObject({ inputTokens: 5, outputTokens: 6 });
});

// A 200 body is not a finished turn: a failed or still-running response keeps its missing usage.
for (const [label, body] of [
  ["failed", { ...completed(), status: "failed", error: { code: "server_error", message: "failed" }, output: [] }],
  ["in-progress", { ...completed(), status: "in_progress" }],
] as const) {
  test(`JSON: a ${label} response with HTTP 200 gets no estimate and no marker`, async () => {
    const { response, terminal, log } = await send(config(true), false, Response.json({ ...body, usage: null }));
    expect(response.headers.get(ESTIMATED_USAGE_HEADER)).toBeNull();
    expect(terminal.usage).toBeNull();
    expect(log.usage).toBeUndefined();
  });
}

test("streaming: a response.incomplete terminal without usage is estimated too", async () => {
  const body = { ...completed(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
  const { response, terminal, log } = await send(config(true), true, sse(body, "response.incomplete"));
  expect(response.headers.get(ESTIMATED_USAGE_HEADER)).toBe("when-missing");
  expect(terminal.status).toBe("incomplete");
  expect(terminal.usage.output_tokens).toBeGreaterThan(0);
  expect(log.usage).toBeUndefined();
});

test("usage: null counts as omitted and is estimated, in a stream and in JSON", async () => {
  const body = { ...completed(), usage: null };
  const streamed = await send(config(true), true, sse(body));
  expect(streamed.terminal.usage.input_tokens).toBeGreaterThan(0);
  expect(streamed.log.usage).toBeUndefined();
  const json = await send(config(true), false, Response.json(body));
  expect(json.response.headers.get(ESTIMATED_USAGE_HEADER)).toBe("true");
  expect(json.terminal.usage.output_tokens).toBeGreaterThan(0);
  expect(json.log.usage).toBeUndefined();
});

test("a delta that merely mentions a terminal type is forwarded byte for byte", async () => {
  const { text } = await send(config(true), true, sse(completed()));
  expect(text).toContain('"delta":"response.completed"');
});

// Some providers stream each item in response.output_item.done and close with an empty output list.
test("streaming: a terminal with an empty output is estimated from the items streamed before it", async () => {
  const full = completed();
  const item = full.output[0]!;
  const events = [
    { type: "response.created", response: { ...full, status: "in_progress", output: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...full, output: [] } },
  ];
  const upstream = new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
  const sparse = await send(config(true), true, upstream);
  const whole = await send(config(true), true, sse(completed()));
  expect(sparse.terminal.output).toEqual([]);
  expect(sparse.terminal.usage.output_tokens).toBe(whole.terminal.usage.output_tokens);
  expect(sparse.terminal.usage.output_tokens).toBeGreaterThan(0);
  expect(sparse.log.usage).toBeUndefined();
});

for (const [name, platform, streamMode, eager] of [
  ["tee", "linux", "legacy-tee", false],
  ["eager relay", "darwin", "eager-relay", true],
] as const) {
  test(`streaming over the ${name}: the client sees the estimate, the log sees the provider's body`, async () => {
    setRelayPlatformForTests(platform);
    const estimated = await send(config(true, streamMode), true, sse(completed()));
    expect(isEagerRelaySseResponse(estimated.response)).toBe(eager);
    expect(estimated.response.headers.get(ESTIMATED_USAGE_HEADER)).toBe("when-missing");
    expect(estimated.terminal.usage.output_tokens).toBeGreaterThan(0);
    expect(estimated.log.usage).toBeUndefined();
    const usage = { input_tokens: 5, output_tokens: 6, total_tokens: 11 };
    const reported = await send(config(true, streamMode), true, sse(completed(usage)));
    expect(isEagerRelaySseResponse(reported.response)).toBe(eager);
    expect(reported.terminal.usage).toEqual(usage);
    expect(reported.log.usage).toMatchObject({ inputTokens: 5, outputTokens: 6 });
  });
}

// The Chat Completions and Claude Messages bridges and the WebSocket ingress rebuild their own usage
// fields from the response and would forward an estimate without the marker; an internal decision
// call settles spend from the body. None of them is estimated.
for (const [name, options] of [
  ["Chat Completions bridge", { inboundWire: "chat" }],
  ["Claude Messages bridge", { inboundWire: "anthropic" }],
  ["WebSocket ingress", { inboundTransport: "websocket" }],
  ["internal decision call", { internalDecisionCall: true }],
] as const satisfies ReadonlyArray<readonly [string, HandleResponsesOptions]>) {
  for (const stream of [true, false]) {
    test(`${name} (${stream ? "stream" : "JSON"}): no estimate and no marker even when opted in`, async () => {
      const { response, terminal } = await send(config(true), stream, stream ? sse(completed()) : Response.json(completed()), options);
      expect(response.headers.get(ESTIMATED_USAGE_HEADER)).toBeNull();
      expect(terminal.usage).toBeUndefined();
    });
  }
}

