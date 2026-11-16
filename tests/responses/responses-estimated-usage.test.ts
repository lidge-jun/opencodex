import { afterEach, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import { ESTIMATED_USAGE_HEADER, estimatedUsageJson, withEstimatedUsage } from "../../src/server/responses/estimated-usage";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// #7427: a per-provider opt-in adds estimated usage when the provider omits it. The estimate is
// marked by a response header and never reaches the request log, spend or quota accounting.
const originalFetch = globalThis.fetch;
let release: (() => void) | undefined;
afterEach(() => { globalThis.fetch = originalFetch; release?.(); release = undefined; });

const answer = "The capital of France is Paris, and it has been for a long time.";
const completed = (usage?: Record<string, number>) => ({
  id: "resp_fixture", object: "response", status: "completed", model: "probe",
  output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: answer, annotations: [] }] }],
  ...(usage ? { usage } : {}),
});

function config(estimateMissingUsage?: boolean): OcxConfig {
  return {
    port: 0, defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-responses", authMode: "key", apiKey: "fixture-key",
      baseUrl: "https://gateway.example/v1", models: ["probe"],
      ...(estimateMissingUsage === undefined ? {} : { estimateMissingUsage }) } },
  } as unknown as OcxConfig;
}

function sse(body: Record<string, unknown>): Response {
  const events = [
    { type: "response.created", response: { ...body, status: "in_progress", output: [], usage: undefined } },
    { type: "response.completed", response: body },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

async function send(cfg: OcxConfig, stream: boolean, upstream: Response) {
  release = acquireOwnedSpendHome();
  globalThis.fetch = (async () => upstream) as unknown as typeof fetch;
  const log = { model: "", provider: "" } as RequestLogContext;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/probe", input: "What is the capital of France?", stream, store: false }),
  }), cfg, log);
  const text = await response.text();
  const terminal = stream
    ? JSON.parse(text.split("\n").find(line => line.startsWith("data: ") && line.includes('"response.completed"'))!.slice(6)).response
    : JSON.parse(text);
  return { response, terminal, log };
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
  const { response, terminal } = await send(config(true), false, Response.json(completed(usage)));
  expect(response.headers.get(ESTIMATED_USAGE_HEADER)).toBeNull();
  expect(terminal.usage).toEqual(usage);
});
