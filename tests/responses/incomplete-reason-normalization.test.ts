import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { rewriteResponsesIncompleteReasonJson } from "../../src/responses/incomplete-reason";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { normalizeResponsesWsRelayEvent } from "../../src/server/responses/codex-ws-wire";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const aliases = [
  ["length", "max_output_tokens"], [" MAX_TOKENS ", "max_output_tokens"],
  ["model_context_window_exceeded", "max_output_tokens"], ["safety", "content_filter"],
  ["refusal", "content_filter"], ["content-filter", "content_filter"],
  ["max_output_tokens", "max_output_tokens"], ["content_filter", "content_filter"],
  ["max_messages", "max_messages"], ["steered", "steered"],
  ["adapter_eof", "adapter_eof"], ["vendor-limit", "vendor-limit"],
] as const;
const snapshot = (reason: string) => ({
  id: "resp_incomplete", object: "response", model: "test-model", status: "incomplete",
  incomplete_details: { reason, message: "partial turn", retryable: false, vendor: 7 },
  output: [{ id: "msg_partial", type: "message", role: "assistant", status: "incomplete",
    content: [{ type: "output_text", text: "partial answer", annotations: [] }] }],
  usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
});
const frame = (response: unknown) => `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response })}\n\n`;

describe("Responses incomplete reasons at transport boundaries", () => {
  test.each([
    "not json", "[DONE]", "null", "[]", '{ "status": "completed" }',
    '{ "status": "incomplete", "incomplete_details": { "reason": 7 } }',
    '{ "status": "incomplete", "incomplete_details": { "reason": "steered" } }',
    '{ "output": [{ "incomplete_details": { "reason": "length" } }] }',
  ])("unchanged or malformed metadata remains byte-identical: %s", json => {
    expect(rewriteResponsesIncompleteReasonJson(json)).toBe(json);
  });
  test("nested user output stays opaque and the input object stays unchanged", () => {
    const response = { ...snapshot("length"), output: [{ incomplete_details: { reason: "length" } }] };
    const json = JSON.stringify(response);
    expect(JSON.parse(rewriteResponsesIncompleteReasonJson(json))).toEqual({ ...response,
      incomplete_details: { ...response.incomplete_details, reason: "max_output_tokens" } });
    expect(response.incomplete_details.reason).toBe("length");
  });
  for (const [reason, canonical] of aliases) {
    for (const type of ["response.incomplete", "response.done"]) {
      test(`WebSocket ${type}: ${reason}`, () => {
        const response = snapshot(reason);
        const result = normalizeResponsesWsRelayEvent(JSON.stringify({ type, response, sequence_number: 9 }));
        expect(result?.type).toBe("response.incomplete");
        expect(JSON.parse(result!.text)).toEqual({ type: "response.incomplete", sequence_number: 9,
          response: { ...response, incomplete_details: { ...response.incomplete_details, reason: canonical } } });
        expect(result?.payload).toEqual(JSON.parse(result!.text));
      });
    }
    for (const stream of [false, true]) {
      test(`compaction adapter ${stream ? "SSE" : "JSON"}: ${reason}`, async () => {
        const adapter = createResponsesPassthroughAdapter({ adapter: "openai-responses", baseUrl: "https://example.invalid/v1", authMode: "key" });
        const budget = createTranslatorBudget();
        try {
          const response = snapshot(reason);
          const upstream = stream ? new Response(frame(response)) : Response.json(response);
          const events = stream ? await Array.fromAsync(adapter.parseStream(upstream, budget))
            : await adapter.parseResponse!(upstream, budget);
          expect(events.find(event => event.type === "incomplete")).toMatchObject({ type: "incomplete", reason: canonical });
        } finally { budget.dispose(); }
      });
    }
  }
});

let testDir = "";
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  codexHome = installIsolatedCodexHome("ocx-incomplete-reason-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-incomplete-reason-"));
  process.env.OPENCODEX_HOME = testDir;
});
afterEach(() => {
  resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  codexHome?.restore();
  removeTreeWithRetry(testDir);
});

describe("Responses native passthrough delivery", () => {
  for (const [reason, canonical] of aliases) {
    for (const stream of [false, true]) {
      test(`${stream ? "SSE" : "JSON"}: ${reason}`, async () => {
        const response = snapshot(reason);
        let sends = 0;
        const upstream = Bun.serve({ port: 0, fetch() {
          sends++;
          return stream ? new Response(frame(response), { headers: { "content-type": "text/event-stream" } })
            : Response.json(response);
        } });
        saveConfig({ port: 0, defaultProvider: "mock", providers: { mock: {
          adapter: "openai-responses", apiKey: "mock-key", authMode: "key", allowPrivateNetwork: true,
          baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
        } } });
        const proxy = startServer(0);
        try {
          const result = await fetch(new URL("/v1/responses", proxy.url), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "mock/test-model", input: "hello", stream }),
          });
          expect(result.status).toBe(200);
          const text = await result.text();
          const terminal = stream ? text.split("\n").filter(line => line.startsWith("data: {"))
            .map(line => JSON.parse(line.slice(6))).find(event => event.type === "response.incomplete").response
            : JSON.parse(text);
          expect(terminal).toEqual({ ...response, incomplete_details: { ...response.incomplete_details, reason: canonical } });
          expect(sends).toBe(1);
        } finally { await proxy.stop(true); await upstream.stop(true); }
      });
    }
  }
});
