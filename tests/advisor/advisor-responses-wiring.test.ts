/**
 * End-to-end advisor wiring through handleResponses — the PR1 acceptance proof:
 *
 * A routed worker (openai-chat provider "worker") runs with the advisor enabled. The loopback
 * expert call is intercepted in-process and forwarded to handleChatCompletions, which routes it
 * to a DIFFERENT provider ("expert") — proving Worker and Advisor can come from different
 * providers through the routing authority.
 *
 * The critical test: with policy=preflight, the worker NEVER calls the advisor tool, yet the
 * expert is consulted exactly once and the advice reaches the worker's next upstream request.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses/core";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { collectSse } from "../helpers/responses-conformance";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;
afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
});

const logCtx = { model: "", provider: "" };

const ADVISOR_ADVICE = "Sequence the fix: token store first, then the refresh window.";

function sse(frames: unknown[]): Response {
  const body = frames.map(frame => `data: ${JSON.stringify(frame)}`).join("\n\n") + "\n\ndata: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function chatCompletion(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
  }), { headers: { "Content-Type": "application/json" } });
}

/** Worker leg 1: the model calls `advisor`. Worker leg 2+: plain text. */
function workerProviderFetch(legs: unknown[][], captured: string[]) {
  let leg = 0;
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured.push(String(init?.body));
    const events = legs[Math.min(leg, legs.length - 1)]!;
    leg += 1;
    return sse(events);
  }) as typeof fetch;
}

function advisorConfig(advisor: OcxConfig["advisor"], workerFetch: typeof fetch): OcxConfig {
  return {
    port: 10100,
    providers: {
      worker: {
        adapter: "openai-chat",
        baseUrl: "https://worker.test/v1",
        apiKey: "worker-key",
        models: ["deepseek-v4"],
        fetch: workerFetch,
      },
      expert: {
        adapter: "openai-chat",
        baseUrl: "https://expert.test/v1",
        apiKey: "expert-key",
        models: ["gpt-6-astra"],
        fetch: (async () => chatCompletion(ADVISOR_ADVICE)) as typeof fetch,
      },
    },
    ...(advisor ? { advisor } : {}),
  } as OcxConfig;
}

const advisorCallFrames = [
  { choices: [{ delta: { content: "Let me consult the expert." }, finish_reason: null }] },
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_adv_1",
          type: "function",
          function: { name: "advisor", arguments: JSON.stringify({ question: "Where do I start?" }) },
        }],
      },
      finish_reason: null,
    }],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];

const plainFrames = (text: string) => [
  { choices: [{ delta: { content: text }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
];

/**
 * The advisor's loopback consultation re-enters through /v1/chat/completions on 127.0.0.1 —
 * serve it in-process through the real chat handler so the fence header, routing, and provider
 * isolation all execute for real.
 */
function loopbackInterceptor(config: OcxConfig, recorder: { chatRequests: string[] }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/chat/completions")) {
      recorder.chatRequests.push(String(init?.body));
      const req = new Request(url, init);
      return await handleChatCompletions(req, config, { model: "", provider: "" });
    }
    throw new Error(`unexpected external fetch during advisor test: ${url}`);
  }) as typeof fetch;
}

function workerRequest(input: unknown) {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "acct-advisor" })}`,
      "chatgpt-account-id": "acct-advisor",
    },
    body: JSON.stringify({ model: "worker/deepseek-v4", input, stream: true }),
  });
}

describe("advisor responses wiring (end-to-end)", () => {
  test("manual: worker calls advisor() — the call is intercepted, the expert consulted cross-provider, advice reinjected", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const chatRequests: string[] = [];
    const workerFetch = workerProviderFetch([
      advisorCallFrames,
      plainFrames("Following the advice: token store first."),
    ], workerBodies);
    const config = advisorConfig(
      { enabled: true, model: "expert/gpt-6-astra", effort: "high", policy: "manual" },
      workerFetch,
    );
    loopbackInterceptor(config, { chatRequests });

    const response = await handleResponses(workerRequest("Fix the failing auth tests"), config, logCtx);
    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);

    // 1. The worker WAS consulted-through: the loopback expert call happened exactly once.
    expect(chatRequests).toHaveLength(1);
    // 2. The expert call went to the EXPERT provider (different provider than the worker).
    const expertBody = JSON.parse(chatRequests[0]!) as { model: string; messages: unknown[] };
    expect(expertBody.model).toBe("expert/gpt-6-astra");
    // 3. The synthetic advisor tool was declared to the worker upstream...
    expect(workerBodies[0]!).toContain('"advisor"');
    // 4. ...but the Codex client NEVER sees an advisor function_call item.
    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain('"advisor"');
    expect(serialized).not.toContain("call_adv_1");
    // 5. The advice reached the worker's continuation leg.
    expect(workerBodies[1]!).toContain(ADVISOR_ADVICE);
    // 6. The worker continued and produced its own final answer.
    expect(frames.some(frame => frame.event === "response.completed")).toBe(true);
    expect(serialized).toContain("Following the advice");
  });

  test("preflight: worker NEVER calls the advisor — OpenCodex consults the expert anyway, exactly once", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const chatRequests: string[] = [];
    const workerFetch = workerProviderFetch([
      plainFrames("Read the failing tests first."),
      plainFrames("Now fixing the token store."),
    ], workerBodies);
    const config = advisorConfig(
      { enabled: true, model: "expert/gpt-6-astra", effort: "max", policy: "preflight" },
      workerFetch,
    );
    loopbackInterceptor(config, { chatRequests });

    // Turn 1: bare task — orientation, no tool evidence → NO consultation yet.
    const first = await handleResponses(workerRequest("Fix the failing auth tests"), config, logCtx);
    expect(first.status).toBe(200);
    await collectSse(first.body!);
    expect(chatRequests).toHaveLength(0);

    // Turn 2: full-history stateless request carrying tool evidence of orientation.
    const second = await handleResponses(workerRequest([
      { role: "user", content: "Preflight task: repair the token store" },
      { type: "function_call", call_id: "c1", name: "shell", arguments: JSON.stringify({ command: ["bun", "test"] }) },
      { type: "function_call_output", call_id: "c1", output: "3 tests failed: stale expiry" },
    ]), config, logCtx);
    expect(second.status).toBe(200);
    const secondFrames = await collectSse(second.body!);

    // THE acceptance criterion: the expert was consulted even though the worker never called advisor().
    expect(chatRequests).toHaveLength(1);
    const expertBody = JSON.parse(chatRequests[0]!) as { model: string };
    expect(expertBody.model).toBe("expert/gpt-6-astra");
    // The advice was injected into the worker's dispatch BEFORE the worker's next reasoning.
    expect(workerBodies[1] ?? workerBodies[0]).toContain(ADVISOR_ADVICE);
    // The client stream stays clean of the advisor machinery.
    expect(JSON.stringify(secondFrames)).not.toContain("opencodex_advisor");
  });

  test("preflight fires only once per task across turns", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const chatRequests: string[] = [];
    const workerFetch = workerProviderFetch([
      plainFrames("working"), plainFrames("working"), plainFrames("done"),
    ], workerBodies);
    const config = advisorConfig(
      { enabled: true, model: "expert/gpt-6-astra", policy: "preflight" },
      workerFetch,
    );
    loopbackInterceptor(config, { chatRequests });

    const orientedInput = [
      { role: "user", content: "Once-per-task: audit the retry loop" },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "failed" },
    ];
    for (let turn = 0; turn < 3; turn += 1) {
      const response = await handleResponses(workerRequest(orientedInput), config, logCtx);
      expect(response.status).toBe(200);
      await collectSse(response.body!);
    }
    expect(chatRequests).toHaveLength(1);
  });

  test("disabled: the worker request path carries no advisor machinery", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const chatRequests: string[] = [];
    const workerFetch = workerProviderFetch([
      plainFrames("plain answer"), plainFrames("plain answer 2"),
    ], workerBodies);
    const config = advisorConfig(
      { enabled: true, model: "expert/gpt-6-astra", policy: "preflight" },
      workerFetch,
    );
    // Disabled advisor: no plan, no consultation — even for an oriented conversation.
    const disabled = { ...config, advisor: { ...config.advisor, enabled: false } } as OcxConfig;
    loopbackInterceptor(disabled, chatRequests);

    const response = await handleResponses(workerRequest([
      { role: "user", content: "Fix the failing auth tests" },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "3 tests failed" },
    ]), disabled, logCtx);
    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);
    expect(chatRequests).toHaveLength(0);
    expect(JSON.stringify(frames)).not.toContain("advisor");
  });

  test("recursion fence: the expert's own loopback request never carries the advisor tool", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const chatRequests: string[] = [];
    const workerFetch = workerProviderFetch([
      advisorCallFrames,
      plainFrames("Done with the advice."),
    ], workerBodies);
    const config = advisorConfig(
      { enabled: true, model: "expert/gpt-6-astra", policy: "manual" },
      workerFetch,
    );
    loopbackInterceptor(config, { chatRequests });

    const response = await handleResponses(workerRequest("Fix the failing auth tests"), config, logCtx);
    expect(response.status).toBe(200);
    await collectSse(response.body!);

    // The expert's chat completion request: no advisor tool, no worker-model contamination.
    const expertBody = JSON.parse(chatRequests[0]!) as { model: string; tools?: unknown[] };
    expect(expertBody.model).toBe("expert/gpt-6-astra");
    expect(expertBody.tools ?? []).toHaveLength(0);
  });
});
