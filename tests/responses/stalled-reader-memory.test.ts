import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as passthroughCompletion from "../../src/server/responses/passthrough-completion";
import * as snapshotRepair from "../../src/server/responses-snapshot-repair";
import { handleResponses } from "../../src/server/responses";
import { setRelayPlatformForTests } from "../../src/server/responses/passthrough-delivery";
import { LINK_TURN_HEADER, registerLinkTurnToken, type LinkTurnObserver } from "../../src/server/link-turn";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// #8601: a Remote Link turn, while the link WebSocket feature is on, reads its upstream body only as its client
// drains. Every other request keeps the shared pipeline's inspection read-ahead (32 MiB past the client).

const MiB = 1024 * 1024;
const encoder = new TextEncoder();
const frames = [
  ...Array.from({ length: 40 }, (_, index) => "event: response.output_text.delta\ndata: "
    + JSON.stringify({ type: "response.output_text.delta", index, delta: "x".repeat(MiB - 100) }) + "\n\n"),
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n',
];
// Every request is delivered as the upstream sent it, closed by the relay's [DONE] sentinel.
const delivered = frames.join("") + "data: [DONE]\n\n";
const config = { port: 0, defaultProvider: "fixture", providers: { fixture: {
  adapter: "openai-responses", baseUrl: "https://fixture.test/v1", authMode: "key", apiKey: "fixture-key", models: ["m"],
} } } as unknown as OcxConfig;

let releaseSpendHome: (() => void) | undefined;
const savedFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = savedFetch; releaseSpendHome?.(); releaseSpendHome = undefined; });

/** The fake upstream and every stream stage advance on promise jobs alone, so one event-loop turn settles them. */
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function upstream(upstreamFrames: readonly string[] = frames): { pulls: number } {
  const state = { pulls: 0 };
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulls >= upstreamFrames.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(upstreamFrames[state.pulls++]!));
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  return state;
}

const observer = (paced: boolean): LinkTurnObserver => ({ expanded() {}, expansionFailed() {}, terminal() {}, ...(paced ? { pacedReads: true } : {}) });
const request = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1/v1/responses", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "fixture/m", stream: true, input: "ping" }),
});

/** Pulls the upstream saw before the client read, and after each of its first reads; then the rest of the body. */
async function stalledThenDrained(run: () => Promise<Response>, upstreamFrames: readonly string[] = frames) {
  releaseSpendHome = acquireOwnedSpendHome();
  const state = upstream(upstreamFrames);
  const response = await run();
  await settle();
  const pulls = [state.pulls];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let read = 0; read < 3; read++) {
    const next = await reader.read();
    text += decoder.decode(next.value, { stream: true });
    await settle();
    pulls.push(state.pulls);
  }
  for (;;) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value, { stream: true }); }
  return { pulls, text: text + decoder.decode() };
}

describe("upstream read-ahead under a stalled reader (#8601)", () => {
  test("a local request keeps the inspection read-ahead and its bytes", async () => {
    const run = await stalledThenDrained(() => handleResponses(request(), config, { model: "", provider: "" }));
    expect(run.pulls[0]).toBeGreaterThanOrEqual(32);
    expect(run.text).toBe(delivered);
  });

  test("a link turn with the feature off keeps the inspection read-ahead", async () => {
    const token = registerLinkTurnToken(observer(false));
    const run = await stalledThenDrained(() => handleResponses(request({ [LINK_TURN_HEADER]: token }), config, { model: "", provider: "" }));
    expect(run.pulls[0]).toBeGreaterThanOrEqual(32);
    expect(run.text).toBe(delivered);
  });

  test("a relayed link turn with the feature on reads the upstream only as its client drains", async () => {
    const token = registerLinkTurnToken(observer(true));
    const run = await stalledThenDrained(() => handleResponses(request({ [LINK_TURN_HEADER]: token }), config, { model: "", provider: "" }));
    // One upstream chunk ahead of what the client has read, never the 32 MiB inspection allowance.
    run.pulls.forEach((pulls, reads) => expect(pulls).toBeLessThanOrEqual(reads + 1));
    expect(run.text).toBe(delivered);
  });

  test("a link socket turn with the feature on reads the upstream only as its client drains", async () => {
    const run = await stalledThenDrained(() => handleResponses(request(), config, { model: "", provider: "" }, { linkTurn: observer(true) }));
    run.pulls.forEach((pulls, reads) => expect(pulls).toBeLessThanOrEqual(reads + 1));
    expect(run.text).toBe(delivered);
  });
  test("with upstream chunks smaller than a slice, no relay stage queues one ahead of the client", async () => {
    // A stage that lost the paced mark would queue one more of these whole chunks, which the bound below catches.
    const small = [
      ...Array.from({ length: 64 }, (_, index) => "event: response.output_text.delta\ndata: "
        + JSON.stringify({ type: "response.output_text.delta", index, delta: "y".repeat(16 * 1024) }) + "\n\n"),
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n',
    ];
    const run = await stalledThenDrained(() => handleResponses(request(), config, { model: "", provider: "" }, { linkTurn: observer(true) }), small);
    // The client's chunk plus the one chunk the inspection branch may read ahead of it.
    run.pulls.forEach((pulls, reads) => expect(pulls).toBeLessThanOrEqual(reads + 2));
    expect(run.text).toBe(small.join("") + "data: [DONE]\n\n");
  });
});


describe("the eager relay under a stalled reader (#8601)", () => {
  // Windows takes the eager single-reader relay; its queue holds 8 MiB for a client by default.
  beforeEach(() => setRelayPlatformForTests("win32"));
  afterEach(() => setRelayPlatformForTests(undefined));

  test("a local request keeps the eager relay's queue", async () => {
    const run = await stalledThenDrained(() => handleResponses(request(), config, { model: "", provider: "" }));
    // The eager queue (8 MiB), not the tee's 32 MiB allowance: the platform seam chose the eager relay.
    expect(run.pulls[0]).toBeGreaterThanOrEqual(8);
    expect(run.pulls[0]).toBeLessThan(32);
    expect(run.text).toBe(delivered);
  });

  test("a link socket turn with the feature on reads the upstream only as its client drains", async () => {
    const run = await stalledThenDrained(() => handleResponses(request(), config, { model: "", provider: "" }, { linkTurn: observer(true) }));
    run.pulls.forEach((pulls, reads) => expect(pulls).toBeLessThanOrEqual(reads + 1));
    expect(run.text).toBe(delivered);
  });
});


describe("request copies under a stalled reader (#8601)", () => {
  // A provider whose readers need the outbound body after it was built: snapshot repair reads its tool defaults.
  const repairing = { port: 0, defaultProvider: "fixture", providers: { fixture: {
    adapter: "openai-responses", baseUrl: "https://fixture.test/v1", authMode: "key", apiKey: "fixture-key", models: ["m"], responsesSnapshotRepair: true,
  } } } as unknown as OcxConfig;
  const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }];
  const toolsItem = { type: "additional_tools", tools: [{ type: "function", name: "later", parameters: { type: "object", properties: {} } }] };
  const body = (stream: boolean) => JSON.stringify({ model: "fixture/m", stream, tool_choice: "auto", tools, input: [{ role: "user", content: "ping" }, toolsItem] });

  test("readers get the outbound body's tool scope, never its input, from one parse per build", async () => {
    const parse = spyOn(passthroughCompletion, "parseOutboundRequestBody");
    const rewrite = spyOn(snapshotRepair, "createResponsesSnapshotBlockRewrite");
    releaseSpendHome = acquireOwnedSpendHome();
    upstream();
    try {
      const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: body(true) }),
        repairing, { model: "", provider: "" });
      const reader = response.body!.getReader();
      await reader.read();
      await settle();
      expect(rewrite).toHaveBeenCalledTimes(1);
      // The tool scope only: the catalog, the selection and the input items that declare tools.
      expect(rewrite.mock.calls[0]![0]).toEqual({ tool_choice: "auto", tools, input: [toolsItem] });
      expect(parse).toHaveBeenCalledTimes(1);
      await reader.cancel();
    } finally { parse.mockRestore(); rewrite.mockRestore(); }
  });

  test("a non-streaming answer is repaired from the same single parse", async () => {
    const parse = spyOn(passthroughCompletion, "parseOutboundRequestBody");
    releaseSpendHome = acquireOwnedSpendHome();
    globalThis.fetch = (async () => Response.json({ id: "r", object: "response", status: "completed", output: [] })) as unknown as typeof fetch;
    try {
      const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: body(false) }),
        repairing, { model: "", provider: "" });
      // Snapshot repair filled the request's defaults into the answer.
      expect(await response.json()).toMatchObject({ status: "completed", tool_choice: "auto", tools });
      expect(parse).toHaveBeenCalledTimes(1);
    } finally { parse.mockRestore(); }
  });
});
