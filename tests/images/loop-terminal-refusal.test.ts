import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import type { ImageBridgePlan } from "../../src/images/types";
import { runWithImageBridge } from "../../src/images/loop";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #7148: a refusal that ends an iteration carrying a complete image_gen call must end the turn.
 * Fulfilling the call and re-asking would send the refused context back to the model.
 */
const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home = "";
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
});

test.each([true, false, undefined])("a refused image_gen iteration stops with terminalRefusalAsFailed=%s", async terminalRefusalAsFailed => {
  home = mkdtempSync(join(tmpdir(), "ocx-image-refusal-"));
  process.env.OPENCODEX_HOME = home;
  let mediaFetches = 0;
  globalThis.fetch = (async () => { mediaFetches++; return new Response("unavailable", { status: 503 }); }) as typeof fetch;
  let routedRequests = 0;
  const adapter: ProviderAdapter = {
    name: "mock-refusal",
    buildRequest: async () => {
      routedRequests++;
      return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
    },
    fetchResponse: async () => new Response("ok", { status: 200 }),
    async *parseStream() {
      yield { type: "tool_call_start", id: "call_1", name: "image_gen" } satisfies AdapterEvent;
      yield { type: "tool_call_delta", arguments: '{"prompt":"a cat"}' } satisfies AdapterEvent;
      yield { type: "tool_call_end" } satisfies AdapterEvent;
      yield {
        type: "incomplete", reason: "content_filter", retryable: false,
        message: 'upstream ended the turn with stop_reason "refusal"',
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      } satisfies AdapterEvent;
    },
    async parseResponse() { throw new Error("parseResponse must be unreachable"); },
  };
  const plan = {
    provider: {} as never,
    auth: { baseUrl: "https://api.x.ai", token: "test-token" },
    model: "grok-imagine-image-quality",
    toolNames: new Set(["image_gen"]),
  } as ImageBridgePlan;

  const response = await runWithImageBridge({
    parsed: { modelId: "test-model", context: { messages: [], tools: [] }, stream: true, options: {} } as OcxParsedRequest,
    adapter,
    plan,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    terminalRefusalAsFailed,
  });
  const text = await response.text();

  expect(routedRequests).toBe(1);
  expect(mediaFetches).toBe(0);
  expect(text).toContain(`event: response.${terminalRefusalAsFailed ? "failed" : "incomplete"}`);
  if (terminalRefusalAsFailed) expect(text).toContain('"code":"invalid_prompt"');
  else expect(text).toContain('"reason":"content_filter"');
  expect(text).not.toContain("event: response.completed");
});
