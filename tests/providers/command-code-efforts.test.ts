import { afterEach, expect, test } from "bun:test";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";
import { commandCodeReasoningEfforts, refreshCommandCodeReasoningEfforts, resetCommandCodeReasoningEffortsForTest } from "../../src/providers/command-code-efforts";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import type { OcxParsedRequest } from "../../src/types";

// Issue #5096: measured accepted ladders, including the narrower exceptions.
const measured: Array<[string, string[]]> = [
  ["deepseek/deepseek-v4.1-flash", ["low", "medium", "high", "xhigh", "max"]],
  ["deepseek/deepseek-v4-flash", ["low", "medium", "high", "xhigh", "max"]],
  ["deepseek/deepseek-v4-flash-vision-exp", ["low", "medium", "high", "xhigh", "max"]],
  ["z-ai/glm-5.3-flash", ["low", "medium", "high", "xhigh", "max"]],
  ["zai-org/GLM-5.3", ["low", "medium", "high", "xhigh", "max"]],
  ["Qwen/Qwen3.8-Flash", ["low", "medium", "high", "xhigh", "max"]],
  ["google/gemini-3.7-flash", ["low", "medium", "high", "xhigh", "max"]],
  ["moonshotai/Kimi-K3", ["low", "medium", "high", "xhigh", "max"]],
  ["MiniMaxAI/MiniMax-M3", ["low", "medium", "high", "xhigh", "max"]],
  ["xiaomi/mimo-v2.5", ["low", "medium", "high", "xhigh", "max"]],
  ["xai/grok-4.5", ["low", "medium", "high", "xhigh", "max"]],
  ["xai/grok-4.6", ["low", "medium", "high", "xhigh", "max"]],
  ["tencent/hy3-paid", ["low", "medium", "high", "xhigh", "max"]],
  ["tencent/hy4-preview", ["low", "medium", "high", "xhigh", "max"]],
  ["stepfun/Step-3.7-Flash", ["low", "medium", "high", "xhigh", "max"]],
  ["Qwen/Qwen3.8-Max", ["low", "medium", "high", "xhigh", "max"]],
  ["Qwen/Qwen3.8-27B", ["low", "medium", "high", "xhigh", "max"]],
  ["meta/muse-spark-1.2-contributor", ["low", "medium", "high", "xhigh", "max"]],
  ["meta/muse-spark-1.3-contributor", ["low", "medium", "high", "xhigh", "max"]],
  ["nvidia/nemotron-3-ultra-550b-a55b", ["low", "medium", "high", "xhigh", "max"]],
  ["meituan/LongCat-2.0:free", ["low", "medium", "high", "xhigh", "max"]],
  ["inclusionai/ling-3.0-flash-sante:free", ["low", "medium", "high", "xhigh", "max"]],
  ["thinkingmachines/inkling-small", ["low", "medium", "high", "xhigh", "max"]],
  ["moonshotai/Kimi-K2.7-Code", ["low", "medium", "high", "xhigh"]],
  ["moonshotai/Kimi-K2.7-Code-Highspeed", ["low", "high", "xhigh", "max"]],
  ["xiaomi/mimo-v2.5-pro", ["low", "medium", "high"]],
  ["Qwen/Qwen3.7-32B", ["low", "medium", "high", "xhigh"]],
  ["Qwen/Qwen3.7-72B", ["low", "medium", "high", "xhigh"]],
  ["Qwen/Qwen3.6-35B-A22B", ["low", "medium", "high", "xhigh"]],
  ["poolside/laguna-s-2.1-free", ["medium"]],
  ["google/gemini-3.8-flash", ["low", "medium", "high"]],
];

const adapter = createCommandCodeAdapter({ adapter: "command-code", baseUrl: "https://api.commandcode.ai", apiKey: "synthetic-command-key" });
function request(modelId: string, reasoning: string): OcxParsedRequest {
  return { modelId, stream: true, context: { systemPrompt: [], messages: [], tools: [] },
    options: { reasoning, maxOutputTokens: 100 } };
}
afterEach(() => resetCommandCodeReasoningEffortsForTest());

test.each(measured)("%s exposes and forwards every measured effort", async (modelId, ladder) => {
  expect(commandCodeReasoningEfforts(modelId)).toEqual(ladder);
  expect(commandCodeReasoningEfforts(modelId.toUpperCase())).toEqual(ladder);
  for (const id of ["command-code", "commandcode"]) {
    expect(PROVIDER_REGISTRY.find(entry => entry.id === id)?.modelReasoningEfforts?.[modelId]).toEqual(ladder);
  }
  for (const effort of ladder) {
    const built = await adapter.buildRequest(request(modelId, effort));
    expect(JSON.parse(built.body).params.reasoning_effort).toBe(effort);
  }
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    if (ladder.includes(effort)) continue;
    const built = await adapter.buildRequest(request(modelId, effort));
    expect(JSON.parse(built.body).params).not.toHaveProperty("reasoning_effort");
  }
});

test("a measured row without a profile remembers rejections without guessing a URL", async () => {
  const model = "moonshotai/Kimi-K3";
  let calls = 0;
  const fetch = async () => { calls++; return new Response("", { status: 404 }); };
  expect(await refreshCommandCodeReasoningEfforts(model, fetch, "max")).toEqual(["low", "medium", "high", "xhigh"]);
  expect(calls).toBe(0);
  expect(commandCodeReasoningEfforts(model)).toEqual(["low", "medium", "high", "xhigh"]);
  const built = await adapter.buildRequest(request(model, "max"));
  expect(JSON.parse(built.body).params).not.toHaveProperty("reasoning_effort");
});

test("the first rejected send for a measured row retries without its effort", async () => {
  const sends: Array<{ url: string; body: string }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sends.push({ url, body: String(init?.body ?? "") });
    return sends.length === 1
      ? new Response(JSON.stringify({ error: "unsupported reasoning_effort" }), { status: 400 })
      : new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  const sendingAdapter = createCommandCodeAdapter({ adapter: "command-code", baseUrl: "https://api.commandcode.ai",
    apiKey: "synthetic-command-key", fetch } as Parameters<typeof createCommandCodeAdapter>[0] & { fetch: typeof globalThis.fetch });
  const built = await sendingAdapter.buildRequest(request("moonshotai/Kimi-K3", "max"));
  expect(JSON.parse(built.body).params.reasoning_effort).toBe("max");
  const response = await sendingAdapter.fetchResponse(built);
  expect(response.status).toBe(200);
  expect(sends).toHaveLength(2);
  expect(sends.every(send => send.url.endsWith("/alpha/generate"))).toBe(true);
  expect(JSON.parse(sends[1]!.body).params).not.toHaveProperty("reasoning_effort");
  expect(commandCodeReasoningEfforts("moonshotai/Kimi-K3")).toEqual(["low", "medium", "high", "xhigh"]);
});
