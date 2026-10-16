import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxParsedRequest, OcxUsage } from "../../src/types";
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

const cases = [true, false, undefined].flatMap(terminalRefusalAsFailed =>
  ["direct", "hidden", "rotated"].map(path => ({ terminalRefusalAsFailed, path })));
test.each(cases)("a refused image_gen iteration stops and meters usage: %j", async ({ terminalRefusalAsFailed, path }) => {
  const hasPrior = path !== "direct";
  const reported: (OcxUsage | undefined)[] = [];
  const rotated: OcxUsage[] = [];
  home = mkdtempSync(join(tmpdir(), "ocx-image-refusal-"));
  process.env.OPENCODEX_HOME = home;
  let mediaFetches = 0;
  globalThis.fetch = (async () => { mediaFetches++; return new Response("unavailable", { status: 503 }); }) as typeof fetch;
  let routedRequests = 0;
  const adapter: ProviderAdapter = {
    name: "mock-refusal",
    buildRequest: async () => {
      return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
    },
    fetchResponse: async () => {
      routedRequests++;
      return new Response("ok", { status: path === "rotated" && routedRequests === 2 ? 429 : 200 });
    },
    async *parseStream() {
      yield { type: "tool_call_start", id: "call_1", name: "image_gen" } satisfies AdapterEvent;
      // Missing prompt gives the prior round a local tool error without sending a media request.
      yield { type: "tool_call_delta", arguments: hasPrior && routedRequests === 1 ? "{}" : '{"prompt":"a cat"}' } satisfies AdapterEvent;
      yield { type: "tool_call_end" } satisfies AdapterEvent;
      if (hasPrior && routedRequests === 1) {
        yield { type: "done", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } satisfies AdapterEvent;
        return;
      }
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
    on429: async () => ({ adapter, recoveryKind: "oauth-account-429" }),
    onRotatedUsage: usage => { rotated.push(usage); return true; },
    onUsage: usage => reported.push(usage),
  });
  const text = await response.text();

  expect(routedRequests).toBe(path === "rotated" ? 3 : hasPrior ? 2 : 1);
  expect(mediaFetches).toBe(0);
  expect(reported).toEqual([expect.objectContaining({
    inputTokens: path === "hidden" ? 110 : 10, outputTokens: path === "hidden" ? 23 : 3,
  })]);
  expect(rotated).toEqual(path === "rotated" ? [expect.objectContaining({ inputTokens: 100, outputTokens: 20 })] : []);
  const terminal = text.split("\n").filter(line => line.startsWith("data: {"))
    .map(line => JSON.parse(line.slice(6))).find(frame => frame.type === `response.${terminalRefusalAsFailed ? "failed" : "incomplete"}`);
  expect(terminal.response.usage).toMatchObject({
    input_tokens: hasPrior ? 110 : 10, output_tokens: hasPrior ? 23 : 3, total_tokens: hasPrior ? 133 : 13,
  });
  expect(text).toContain(`event: response.${terminalRefusalAsFailed ? "failed" : "incomplete"}`);
  if (terminalRefusalAsFailed) expect(text).toContain('"code":"invalid_prompt"');
  else expect(text).toContain('"reason":"content_filter"');
  expect(text).not.toContain("event: response.completed");
});
