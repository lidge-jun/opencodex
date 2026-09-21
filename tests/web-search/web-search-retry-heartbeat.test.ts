import { afterEach, describe, expect, test } from "bun:test";

import { parseRequest } from "../../src/responses/parser";
import { runWithWebSearch as runWithWebSearchProduction, type WebSearchLoopDeps } from "../../src/web-search/loop";
import type { OcxProviderConfig } from "../../src/types";
import type { ProviderAdapter } from "../../src/adapters/base";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { phaseTimer } from "../helpers/phase-timing";

/**
 * Moved out of `web-search.test.ts` for issue #4997, unchanged.
 *
 * That file sits at exactly its recorded cap in `tests/fixtures/file-size-baseline.json`, and caps
 * only move downward, so instrumenting this case in place was not available: a sibling file is the
 * remedy AGENTS.md names for precisely this situation. Nothing about the case itself changed here.
 *
 * The case overran its own 5s bound at 6233ms in the first completed unsharded `macos control`
 * run while passing in every sharded lane. Its intrinsic wait is a 1.5s backoff, so roughly 4.7s
 * is unaccounted for, and a single duration cannot say whether that went to setup, to the wait
 * being served late by a loaded event loop, or to teardown. The phase record answers that.
 */

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/v1",
  authMode: "forward",
};

/** Run the web-search loop with a default test translator budget. */
function runWithWebSearch(
  deps: Omit<WebSearchLoopDeps, "incomingMeta"> & { incomingMeta?: WebSearchLoopDeps["incomingMeta"] },
): Promise<Response> {
  return runWithWebSearchProduction({
    ...deps,
    incomingMeta: deps.incomingMeta ?? {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    },
  });
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("web-search same-target 429 retry", () => {
  test("retry wait longer than the stall budget still succeeds (heartbeats feed the watchdog)", async () => {
    // `sends` is the only externally visible progress this case makes, so it is what separates a
    // backoff being served late by a loaded event loop from a loop that stopped advancing.
    let sends = 0;
    const timing = phaseTimer("web-search heartbeat retry", () => sends);
    timing.split("prepare");
    globalThis.fetch = (() => Promise.resolve(new Response(
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    ))) as typeof fetch;

    const retryingAdapter: ProviderAdapter = {
      name: "mock-retry429",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => {
        sends += 1;
        if (sends === 1) {
          return new Response("rate limited", { status: 429, headers: { "retry-after": "30" } });
        }
        return new Response("{}", { status: 200 });
      },
      async *parseStream() {
        yield { type: "text_delta", text: "answer after long backoff" };
        yield { type: "done" };
      },
      async parseResponse() { throw new Error("parseResponse must be unreachable"); },
    };

    // `phase` closes its segment through its own finally, so a throw inside the measured window
    // still produces a closing line rather than a record that just stops.
    timing.end();
    const frames = await timing.phase("execute", async () => {
      const response = await runWithWebSearch({
        parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
        adapter: retryingAdapter,
        forwardProvider,
        hostedTool: { type: "web_search" },
        selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
        settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
        maxSearches: 1,
        stallTimeoutSec: 1,
        retryOn429Policy: { enabled: true, attempts: 1, intervalMs: 1_500, maxIntervalMs: 60_000, respectRetryAfter: false },
      });
      return collectSse(response.body!);
    });
    // A 1.5s backoff under a 1s stall budget must not trip upstream_stall_timeout.
    expect(sends).toBe(2);
    expect(frames.find(f => f.event === "response.completed")).toBeDefined();
    expect(frames.find(f => f.event === "response.failed")).toBeUndefined();
  }, 5_000);
});
