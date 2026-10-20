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
import { activateAdvisor } from "../../src/lib/advisor-activation";
import { setAdvisorPlanFactory } from "../../src/server/responses/advisor-plan-slot";
import type { TranslatorBudget } from "../../src/lib/translator-budget";
import { handleResponses } from "../../src/server/responses/core";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { collectSse } from "../helpers/responses-conformance";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { internalCallCapability } from "../../src/lib/local-internal-call-capability";
import type { OcxConfig } from "../../src/types";
import { advisorActivityStore } from "../../src/advisor/activity";

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
    recordHeaders(providerSeenHeaders.worker, init);
    const events = legs[Math.min(leg, legs.length - 1)]!;
    leg += 1;
    return sse(events);
  }) as typeof fetch;
}

/** Headers each provider actually received, so forwarding can be asserted. */
const providerSeenHeaders: { worker: Record<string, string>[]; expert: Record<string, string>[] } = { worker: [], expert: [] };

function recordHeaders(bucket: Record<string, string>[], init?: RequestInit): void {
  bucket.push(Object.fromEntries(new Headers(init?.headers).entries()));
}

function advisorConfig(advisor: OcxConfig["advisor"], workerFetch: typeof fetch): OcxConfig {
  const config = {
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
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          recordHeaders(providerSeenHeaders.expert, init);
          return chatCompletion(ADVISOR_ADVICE);
        }) as typeof fetch,
      },
    },
    ...(advisor ? { advisor } : {}),
  } as OcxConfig;
  activateAdvisor(config);
  return config;
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

function workerRequest(input: unknown, threadId?: string, stream = true, tools?: unknown[]) {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "acct-advisor" })}`,
      "chatgpt-account-id": "acct-advisor",
      // Codex sends `thread-id`; it is the ledger's conversation identity.
      ...(threadId ? { "thread-id": threadId } : {}),
    },
    body: JSON.stringify({ model: "worker/deepseek-v4", input, stream, ...(tools ? { tools } : {}) }),
  });
}

describe("advisor responses wiring (end-to-end)", () => {
  test.each([true, false])("delivery and empty-completion retry pass the same request budget (stream=%s)", async stream => {
    releaseSpendHome = acquireOwnedSpendHome();
    let sends = 0;
    const seen: (TranslatorBudget | undefined)[] = [];
    const workerFetch = (async () => {
      const text = sends++ === 0 ? "" : "retry answer";
      return stream ? sse(plainFrames(text)) : chatCompletion(text);
    }) as typeof fetch;
    const config = advisorConfig(undefined, workerFetch);
    config.emptyCompletionRetry = true;
    setAdvisorPlanFactory(config, async () => ({
      tool: { name: "advisor", description: "fixture", parameters: {}, advisor: true },
      preflightInject: async () => false,
      attachGuard: parsed => {
        parsed._advisorGuard = async function* (options) {
          seen.push(options.translatorBudget);
          yield* options.firstEvents;
        };
      },
    }));
    try {
      const response = await handleResponses(workerRequest("budget wiring", undefined, stream), config, { model: "", provider: "" });
      const body = await response.text();
      expect(body).toContain("retry answer");
      expect(sends).toBe(2);
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBeDefined();
      expect(seen[1]).toBe(seen[0]);
    } finally { setAdvisorPlanFactory(config, null); }
  });

  test("adaptive failed-repair advice uses the real routing, authority, effort and task-budget boundaries", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = []; const chatRequests: string[] = []; const expertBodies: Record<string, unknown>[] = [];
    const config = advisorConfig({ enabled: true, model: "expert/gpt-6-astra", contextSharingConsent: "v1", effort: "high", policy: "adaptive", maxConsultationsPerTask: 2 },
      workerProviderFetch([plainFrames("Continuing the repair.")], workerBodies));
    config.providers.expert!.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      expertBodies.push(JSON.parse(String(init?.body)));
      return chatCompletion(ADVISOR_ADVICE);
    }) as typeof fetch;
    loopbackInterceptor(config, { chatRequests });
    const thread = `adaptive-wiring-${crypto.randomUUID()}`;
    const run = async (input: unknown) => {
      const response = await handleResponses(workerRequest(input, thread), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      expect(response.headers.has("x-opencodex-advisor-reasoning")).toBe(false);
      await collectSse(response.body!);
    };
    const task = { role: "user", content: "Adaptive wiring: repair the failing validation" };
    const validation = (id: string) => [
      { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd: "bun test" }) },
      { type: "function_call_output", call_id: id, output: "Process exit code: 1\nExpected 2, got 1" },
    ];
    await run([task, ...validation("first")]);
    const repaired = [task, ...validation("first"),
      { type: "function_call", call_id: "edit", name: "apply_patch", arguments: "{}" },
      { type: "function_call_output", call_id: "edit", output: "Success. Updated files" }, ...validation("retry")];
    await run(repaired);
    await run(repaired);
    expect(chatRequests).toHaveLength(2);
    expect(chatRequests[1]).toContain("Repeated validation failure");
    const worker = JSON.parse(workerBodies[1]!);
    expect(worker.messages.find((message: { content: unknown }) => JSON.stringify(message.content).includes(ADVISOR_ADVICE)).role).toBe("user");
    const activity = advisorActivityStore(config).snapshot();
    expect(activity[0]!.trigger).toBe("repair_failure");
    expect(activity[0]!.effectiveEffort).toBe(expertBodies[1]!.reasoning_effort as string ?? null);
    await run([task, ...validation("new-first"),
      { type: "function_call", call_id: "new-edit", name: "apply_patch", arguments: "{}" },
      { type: "function_call_output", call_id: "new-edit", output: "Success. Updated files" }, ...validation("new-retry")]);
    expect(chatRequests).toHaveLength(2);
    expect(advisorActivityStore(config).snapshot()[0]!.status).toBe("blocked");
  });
  for (const delivery of ["buffered", "bridge", "direct"] as const) {
    for (const retry of [false, true]) for (const catalog of ["empty", "omitted", "partial"] as const) {
      for (const finalTool of [false, true]) {
        test(`advisor with ${catalog} client catalog: ${delivery}, empty retry=${retry}, final tool=${finalTool}`, async () => {
          releaseSpendHome = acquireOwnedSpendHome();
          const workerBodies: string[] = [];
          const chatRequests: string[] = [];
          const workerFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            const request = JSON.parse(String(init?.body)) as { stream?: boolean };
            workerBodies.push(String(init?.body));
            const first = workerBodies.length === 1;
            const toolName = first ? "advisor" : finalTool ? "Write" : undefined;
            const callId = first ? "call_adv_1" : "call_write";
            if (request.stream) return sse(toolName ? [
              { choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: "function",
                function: { name: toolName, arguments: "{}" } }] }, finish_reason: null }] },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            ] : plainFrames("worker final answer"));
            return Response.json({ id: "worker", object: "chat.completion", model: "deepseek-v4", choices: [{
              index: 0, message: { role: "assistant", content: toolName ? null : "worker final answer",
                ...(toolName ? { tool_calls: [{ id: callId, type: "function",
                  function: { name: toolName, arguments: "{}" } }] } : {}) },
              finish_reason: toolName ? "tool_calls" : "stop",
            }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
          }) as typeof fetch;
          const config = advisorConfig({ enabled: true, model: "expert/gpt-6-astra",
            contextSharingConsent: "v1", policy: "manual" }, workerFetch);
          config.emptyCompletionRetry = retry;
          loopbackInterceptor(config, { chatRequests });
          const stream = delivery !== "buffered";
          const tools = catalog === "empty" ? [] : catalog === "partial"
            ? [{ type: "function", name: "Read", parameters: { type: "object", properties: {} } }] : undefined;
          // Exercise the translated Chat ingress contract, including direct client delivery.
          const response = await handleResponses(workerRequest("fixture task", undefined, stream, tools),
            config, { model: "", provider: "" }, { inboundWire: "chat",
              ...(delivery === "direct" ? { clientEncoder: { protocol: "chat", stream,
                model: "worker/deepseek-v4" } } : {}) });
          const text = await response.text();
          expect(response.status).toBe(200);
          expect(chatRequests).toHaveLength(1);
          expect(workerBodies).toHaveLength(2);
          expect(workerBodies[0]).toContain('"advisor"');
          expect(workerBodies[1]).toContain(ADVISOR_ADVICE);
          expect(text).not.toContain("call_adv_1");
          if (catalog === "empty" && finalTool) {
            expect(text).toContain("undeclared_tool_call");
            expect(text).not.toContain("call_write");
            expect(text).not.toContain("response.completed");
          } else {
            expect(text).not.toContain("undeclared_tool_call");
            expect(text).toContain(finalTool ? "call_write" : "worker final answer");
          }
        });
      }
    }
  }
  test.each([true, false])("a real OpenAI Chat worker that always calls advisor stops after bounded redispatches (stream=%s)", async stream => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const chatRequests: string[] = [];
    const workerFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      workerBodies.push(String(init?.body));
      if (workerBodies.length > 5) throw new Error("unbounded hidden worker calls");
      if (stream) return sse(advisorCallFrames);
      return Response.json({ id: "repeat", object: "chat.completion", model: "deepseek-v4", choices: [{
        index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_adv_1", type: "function",
          function: { name: "advisor", arguments: "{}" } }] }, finish_reason: "tool_calls",
      }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
    }) as typeof fetch;
    const config = advisorConfig({ enabled: true, model: "expert/gpt-6-astra", contextSharingConsent: "v1", policy: "manual" }, workerFetch);
    loopbackInterceptor(config, { chatRequests });
    const response = await handleResponses(workerRequest("Repeated advisor task", "thread-repeat", stream), config, { model: "", provider: "" });
    const body = await response.text();
    expect(body).toContain("advisor_continuation_limit");
    expect(workerBodies).toHaveLength(5); // initial worker call plus four bounded continuations
    expect(chatRequests.length).toBeLessThanOrEqual(3);
    for (const request of workerBodies.slice(3)) {
      const tools = (JSON.parse(request) as { tools?: { function?: { name: string } }[] }).tools ?? [];
      expect(tools.some(tool => tool.function?.name === "advisor")).toBe(false);
    }
  });
  test("manual: worker calls advisor() — the call is intercepted, the expert consulted cross-provider, advice reinjected", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const chatRequests: string[] = [];
    const workerFetch = workerProviderFetch([
      advisorCallFrames,
      plainFrames("Following the advice: token store first."),
    ], workerBodies);
    const config = advisorConfig(
      { enabled: true, model: "expert/gpt-6-astra", contextSharingConsent: "v1", effort: "high", policy: "manual" },
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
      { enabled: true, model: "expert/gpt-6-astra", contextSharingConsent: "v1", effort: "max", policy: "preflight" },
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
    ], "thread-preflight-main"), config, logCtx);
    expect(second.status).toBe(200);
    const secondFrames = await collectSse(second.body!);

    // THE acceptance criterion: the expert was consulted even though the worker never called advisor().
    expect(chatRequests).toHaveLength(1);
    const expertBody = JSON.parse(chatRequests[0]!) as { model: string };
    expect(expertBody.model).toBe("expert/gpt-6-astra");
    // The advice was injected into the worker's dispatch BEFORE the worker's next reasoning.
    expect(workerBodies[1] ?? workerBodies[0]).toContain(ADVISOR_ADVICE);
    const dispatched = JSON.parse(workerBodies[1] ?? workerBodies[0]!) as { messages: { role: string; content: unknown }[] };
    const advisory = dispatched.messages.find(message => JSON.stringify(message.content).includes(ADVISOR_ADVICE));
    expect(advisory?.role).toBe("user");
    expect(dispatched.messages.filter(message => message.role === "system" || message.role === "developer")
      .some(message => JSON.stringify(message.content).includes(ADVISOR_ADVICE))).toBe(false);
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
      { enabled: true, model: "expert/gpt-6-astra", contextSharingConsent: "v1", policy: "preflight" },
      workerFetch,
    );
    loopbackInterceptor(config, { chatRequests });

    const orientedInput = [
      { role: "user", content: "Once-per-task: audit the retry loop" },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "failed" },
    ];
    for (let turn = 0; turn < 3; turn += 1) {
      const response = await handleResponses(workerRequest(orientedInput, "thread-once-per-task"), config, logCtx);
      expect(response.status).toBe(200);
      await collectSse(response.body!);
    }
    expect(chatRequests).toHaveLength(1);
  });

  test("an identity-less client fails open: each request may attempt once, and no ledger entry is created", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const chatRequests: string[] = [];
    const workerFetch = workerProviderFetch([
      plainFrames("working"), plainFrames("working"), plainFrames("working"),
    ], workerBodies);
    const config = advisorConfig(
      { enabled: true, model: "expert/gpt-6-astra", contextSharingConsent: "v1", policy: "preflight" },
      workerFetch,
    );
    loopbackInterceptor(config, { chatRequests });

    const orientedInput = [
      { role: "user", content: "Identity-less: inspect the retry loop" },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "failed" },
    ];
    // No thread-id: the client has no stable identity, so the runtime deliberately stays out of
    // the process-global ledger rather than risk suppressing a DIFFERENT conversation that opens
    // with the same prompt. Each request may therefore attempt once (documented fail-open).
    for (let turn = 0; turn < 3; turn += 1) {
      const response = await handleResponses(workerRequest(orientedInput), config, logCtx);
      expect(response.status).toBe(200);
      await collectSse(response.body!);
    }
    expect(chatRequests).toHaveLength(3);
  });

  test("disabled: the worker request path carries no advisor machinery", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const chatRequests: string[] = [];
    const workerFetch = workerProviderFetch([
      plainFrames("plain answer"), plainFrames("plain answer 2"),
    ], workerBodies);
    const config = advisorConfig(
      { enabled: true, model: "expert/gpt-6-astra", contextSharingConsent: "v1", policy: "preflight" },
      workerFetch,
    );
    // Disabled advisor: no plan, no consultation — even for an oriented conversation.
    const disabled = { ...config, advisor: { ...config.advisor, enabled: false } } as OcxConfig;
    loopbackInterceptor(disabled, { chatRequests });

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
      { enabled: true, model: "expert/gpt-6-astra", contextSharingConsent: "v1", policy: "manual" },
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

  test("the internal capability never reaches an upstream provider", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    providerSeenHeaders.worker.length = 0;
    providerSeenHeaders.expert.length = 0;
    const workerBodies: string[] = [];
    const chatRequests: string[] = [];
    const workerFetch = workerProviderFetch([
      advisorCallFrames,
      plainFrames("done with advice"),
    ], workerBodies);
    const config = advisorConfig(
      { enabled: true, model: "expert/gpt-6-astra", contextSharingConsent: "v1", policy: "manual" },
      workerFetch,
    );
    loopbackInterceptor(config, { chatRequests });

    const response = await handleResponses(workerRequest("Fix the failing auth tests"), config, logCtx);
    expect(response.status).toBe(200);
    await collectSse(response.body!);

    // The advisor really ran (its loopback carry the capability), and neither the worker nor the
    // expert provider ever saw it: the fence value is an internal header, not a forwarded one.
    expect(chatRequests).toHaveLength(1);
    const capability = internalCallCapability();
    for (const headers of [...providerSeenHeaders.worker, ...providerSeenHeaders.expert]) {
      expect(headers["x-opencodex-advisor-internal"]).toBeUndefined();
      for (const value of Object.values(headers)) expect(value).not.toContain(capability);
    }
  });
});
