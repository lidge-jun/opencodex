import { describe, expect, test } from "bun:test";
import {
  buildJevRouteQuestion,
  buildJevState,
  JEV_API_URL,
  JEV_MODEL,
  parseJevDecision,
  resolveJevDecision,
  type JevCandidate,
  type ResolveJevDecisionOptions,
} from "../../src/combos/jev";
import type { OcxConfig } from "../../src/types";

const candidates: JevCandidate[] = [
  {
    key: "openai/gpt-6-astra",
    provider: "openai",
    model: "gpt-6-astra",
    reasoningEfforts: ["medium", "high"],
  },
  {
    key: "openai/gpt-5.6-sol",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEfforts: ["low"],
  },
];

describe("JEV bounded decision state", () => {
  test("keeps a 500-character head/tail ask after removing machine envelopes", () => {
    const ask = `${"h".repeat(380)}<environment_context>private machine state</environment_context>${"t".repeat(380)}`;
    const state = buildJevState({ input: ask }) as {
      task: string;
      signals: Record<string, unknown>;
      step: Record<string, unknown>;
    };

    expect(state.task).toHaveLength(500);
    expect(state.task.startsWith("h".repeat(320))).toBeTrue();
    expect(state.task).toContain("\n[...]\n");
    expect(state.task.endsWith("t".repeat(171))).toBeTrue();
    expect(JSON.stringify(state)).not.toContain("private machine state");
    expect(state.signals).toEqual({ has_image: false, tool_history: false });
    expect(state.step).toEqual({ type: "user_turn" });
  });

  test("removes a protected envelope whose closing tag falls outside the bounded task sample", () => {
    const privateEnvelope = `<environment_context>PRIVATE_MACHINE_STATE${"x".repeat(250_000)}</environment_context>`;
    const state = buildJevState({ input: `${privateEnvelope}${"u".repeat(250_000)}` }) as {
      task: string;
    };

    expect(state.task).toHaveLength(500);
    expect(state.task.startsWith("u".repeat(320))).toBeTrue();
    expect(state.task.endsWith("u".repeat(171))).toBeTrue();
    expect(state.task).not.toContain("PRIVATE_MACHINE_STATE");
    expect(state.task).not.toContain("environment_context");
  });

  test("samples a large task containing harmless markup without per-character scanning", () => {
    const input = `${"x".repeat(10_000_000)}<${"x".repeat(10_000_000)}`;

    const state = buildJevState({ input }) as { task: string };

    expect(state.task).toHaveLength(500);
    expect(state.task.startsWith("x".repeat(320))).toBeTrue();
    expect(state.task.endsWith("x".repeat(173))).toBeTrue();
  });

  test("captures only bounded recent assistant and tool evidence without arguments or image data", () => {
    const state = buildJevState({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Please continue from the tool result." },
            { type: "input_image", image_url: "data:image/png;base64,TOP_SECRET_IMAGE" },
          ],
        },
        { role: "assistant", content: [{ type: "output_text", text: `old-${"a".repeat(300)}` }] },
        {
          type: "function_call",
          call_id: "call-1",
          name: `shell_${"n".repeat(200)}`,
          arguments: "TOP_SECRET_ARGUMENTS",
        },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: `discard-${"x".repeat(200)}-${"z".repeat(600)}`,
        },
      ],
    }) as {
      task: string;
      previous_assistant: string;
      signals: Record<string, unknown>;
      step: {
        type: string;
        last_tool_output_tail: string;
        tool_call: { name: string };
      };
    };

    expect(state.task).toBe("Please continue from the tool result.");
    expect(state.previous_assistant).toHaveLength(240);
    expect(state.previous_assistant).toBe("a".repeat(240));
    expect(state.signals).toEqual({ has_image: true, tool_history: true });
    expect(state.step.type).toBe("tool_step");
    expect(state.step.last_tool_output_tail).toHaveLength(520);
    expect(state.step.last_tool_output_tail).toBe("z".repeat(520));
    expect(state.step.tool_call.name).toHaveLength(160);
    expect(JSON.stringify(state)).not.toContain("TOP_SECRET_ARGUMENTS");
    expect(JSON.stringify(state)).not.toContain("TOP_SECRET_IMAGE");
  });

  test("removes protected machine envelopes from assistant and tool-output tails", () => {
    const state = buildJevState({
      input: [
        { role: "user", content: "Continue from the latest result." },
        {
          role: "assistant",
          content: "Visible before<environment_context>ASSISTANT_MACHINE_SECRET</environment_context>visible after",
        },
        {
          type: "custom_tool_call_output",
          output: "Tool before<permissions instructions>TOOL_MACHINE_SECRET</permissions instructions>tool after",
        },
      ],
    }) as {
      previous_assistant: string;
      step: { last_tool_output_tail: string };
    };

    expect(state.previous_assistant).toBe("Visible before\nvisible after");
    expect(state.step.last_tool_output_tail).toBe("Tool before\ntool after");
    expect(JSON.stringify(state)).not.toContain("ASSISTANT_MACHINE_SECRET");
    expect(JSON.stringify(state)).not.toContain("TOOL_MACHINE_SECRET");
  });

  test("salvages an envelope-only active goal but drops catalog-only envelopes", () => {
    expect(buildJevState({
      input: '<codex_internal_context source="goal">Keep implementing JEV.</codex_internal_context>',
    })).toMatchObject({ task: "Keep implementing JEV." });
    expect(buildJevState({
      input: "<recommended_plugins>plugin catalog</recommended_plugins>",
    })).toMatchObject({ task: "" });
  });
});

describe("JEV route question", () => {
  test("constructs literal joint target-effort choices with known and neutral profiles", () => {
    const question = buildJevRouteQuestion([
      ...candidates,
      {
        key: "custom/other-model",
        provider: "custom",
        model: "other-model",
        reasoningEfforts: [],
      },
      {
        key: "openai/gpt-5.6-luna",
        provider: "openai",
        model: "gpt-5.6-luna",
        reasoningEfforts: ["medium"],
      },
    ]) as {
      route: {
        type: string;
        instructions: { model_profiles: Record<string, string> };
        criteria: Record<string, unknown>;
      };
    };

    expect(question.route.type).toBe("choice");
    expect(question.route.criteria).toEqual({
      "openai/gpt-6-astra:medium": {
        target: "openai/gpt-6-astra", provider: "openai", model: "gpt-6-astra", reasoning_effort: "medium",
      },
      "openai/gpt-6-astra:high": {
        target: "openai/gpt-6-astra", provider: "openai", model: "gpt-6-astra", reasoning_effort: "high",
      },
      "openai/gpt-5.6-sol:low": {
        target: "openai/gpt-5.6-sol", provider: "openai", model: "gpt-5.6-sol", reasoning_effort: "low",
      },
      "custom/other-model:none": {
        target: "custom/other-model", provider: "custom", model: "other-model", reasoning_effort: null,
      },
      "openai/gpt-5.6-luna:medium": {
        target: "openai/gpt-5.6-luna", provider: "openai", model: "gpt-5.6-luna", reasoning_effort: "medium",
      },
    });
    expect(question.route.instructions.model_profiles["openai/gpt-6-astra"]).toContain("Most capable");
    expect(question.route.instructions.model_profiles["openai/gpt-5.6-sol"]).toContain("Higher-capacity");
    expect(question.route.instructions.model_profiles["openai/gpt-5.6-luna"]).toContain("cost-optimized");
    expect(question.route.instructions.model_profiles["custom/other-model"]).toContain("unspecified");
  });
});

describe("JEV decision parser", () => {
  test("accepts a valid complete distribution and extracts numeric diagnostics only", () => {
    const payload = {
      answers: {
        route: {
          choice: "openai/gpt-6-astra:high",
          confidence: 0.83,
          probabilities: {
            "openai/gpt-6-astra:medium": 0.1,
            "openai/gpt-6-astra:high": 0.7,
            "openai/gpt-5.6-sol:low": 0.2,
          },
        },
      },
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        inputTokens: 0,
        secret: "not copied",
        cached: true,
        nested: { tokens: 99 },
        bad: Number.POSITIVE_INFINITY,
      },
    };

    expect(parseJevDecision(payload, candidates)).toEqual({
      targetKey: "openai/gpt-6-astra",
      effort: "high",
      confidence: 0.83,
      chosenProbability: 0.7,
      usage: { input_tokens: 12, output_tokens: 3, inputTokens: 0 },
    });
  });

  test("treats malformed confidence as absent without weakening the route choice", () => {
    expect(parseJevDecision({
      answers: { route: { choice: "openai/gpt-5.6-sol:low", confidence: 2 } },
    }, candidates)).toEqual({
      targetKey: "openai/gpt-5.6-sol",
      effort: "low",
    });
  });

  test("rejects out-of-allowlist choices and every inconsistent probability shape", () => {
    const complete = {
      "openai/gpt-6-astra:medium": 0.1,
      "openai/gpt-6-astra:high": 0.7,
      "openai/gpt-5.6-sol:low": 0.2,
    };
    const answer = (choice: string, probabilities?: Record<string, unknown>) => ({
      answers: { route: { choice, ...(probabilities ? { probabilities } : {}) } },
    });

    expect(() => parseJevDecision(answer("attacker/model:high"), candidates)).toThrow();
    expect(() => parseJevDecision(answer("openai/gpt-6-astra:high", {
      "openai/gpt-6-astra:high": 1,
    }), candidates)).toThrow();
    expect(() => parseJevDecision(answer("openai/gpt-6-astra:high", {
      ...complete, "openai/gpt-6-astra:medium": -0.1,
    }), candidates)).toThrow();
    expect(() => parseJevDecision(answer("openai/gpt-6-astra:high", {
      ...complete, "openai/gpt-6-astra:high": 0.4,
    }), candidates)).toThrow();
    expect(() => parseJevDecision(answer("openai/gpt-5.6-sol:low", complete), candidates)).toThrow();
    expect(() => parseJevDecision({ answers: null }, candidates)).toThrow();
  });
});

type JevPost = NonNullable<ResolveJevDecisionOptions["post"]>;

function jevConfig(apiKey?: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
      jev: {
        adapter: "jev-decision",
        baseUrl: JEV_API_URL,
        authMode: "key",
        liveModels: false,
        ...(apiKey ? { apiKey } : {}),
      },
    },
  };
}

const fallback = { targetKey: candidates[0]!.key, effort: "medium" as const };
const decisionBody = { input: "Choose carefully." };
const validPayload = {
  answers: { route: { choice: "openai/gpt-5.6-sol:low", confidence: 0.75 } },
  usage: { input_tokens: 4, output_tokens: 1, secret: "drop" },
};

describe("JEV decision client", () => {
  test("posts one bounded decision request with the configured credential", async () => {
    const calls: Array<{
      name: string;
      provider: unknown;
      url: string;
      init: RequestInit;
      dependencies: Parameters<JevPost>[4];
    }> = [];
    const post = (async (name, provider, url, init, dependencies) => {
      calls.push({ name, provider, url, init, dependencies });
      return Response.json(validPayload);
    }) as JevPost;
    const ticks = [100, 127];

    const decision = await resolveJevDecision({
      body: { input: "Choose carefully." },
      candidates,
      fallback,
      config: jevConfig("typesafe-secret"),
      post,
      now: () => ticks.shift()!,
    });

    expect(decision).toEqual({
      targetKey: "openai/gpt-5.6-sol",
      effort: "low",
      gate: "apply",
      latencyMs: 27,
      confidence: 0.75,
      usage: { input_tokens: 4, output_tokens: 1 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("jev");
    expect(calls[0]!.url).toBe(JEV_API_URL);
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer typesafe-secret");
    expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe("application/json");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.dependencies?.isCanonicalUrl?.("jev", JEV_API_URL)).toBeTrue();
    expect(calls[0]!.dependencies?.isCanonicalUrl?.("jev", "https://other.example/")).toBeFalse();
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: JEV_MODEL,
      state: buildJevState({ input: "Choose carefully." }),
      questions: buildJevRouteQuestion(candidates),
    });
  });

  test("resolves environment references and supports TypeSafe and provider-derived key fallbacks", async () => {
    const previousTypesafe = process.env.TYPESAFE_API_KEY;
    const previousJev = process.env.JEV_API_KEY;
    process.env.TYPESAFE_API_KEY = "environment-secret";
    delete process.env.JEV_API_KEY;
    const observed: string[] = [];
    const post = (async (_name, _provider, _url, init) => {
      observed.push(new Headers(init.headers).get("authorization") ?? "");
      return Response.json(validPayload);
    }) as JevPost;
    try {
      await resolveJevDecision({
        body: decisionBody, candidates, fallback, config: jevConfig("${TYPESAFE_API_KEY}"), post,
      });
      const config = jevConfig();
      delete config.providers.jev;
      await resolveJevDecision({ body: decisionBody, candidates, fallback, config, post });
      delete process.env.TYPESAFE_API_KEY;
      process.env.JEV_API_KEY = "provider-derived-secret";
      await resolveJevDecision({ body: decisionBody, candidates, fallback, config, post });
    } finally {
      if (previousTypesafe === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousTypesafe;
      if (previousJev === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = previousJev;
    }
    expect(observed).toEqual([
      "Bearer environment-secret",
      "Bearer environment-secret",
      "Bearer provider-derived-secret",
    ]);
  });

  test("fails open without a key or usable choices and never calls TypeSafe", async () => {
    const previousTypesafe = process.env.TYPESAFE_API_KEY;
    const previousJev = process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.JEV_API_KEY;
    let calls = 0;
    const post = (async () => {
      calls += 1;
      return Response.json(validPayload);
    }) as JevPost;
    try {
      expect(await resolveJevDecision({
        body: {}, candidates, fallback, config: jevConfig(), post,
      })).toMatchObject({ ...fallback, gate: "missing_key" });
      expect(await resolveJevDecision({
        body: {}, candidates: [], fallback, config: jevConfig("secret"), post,
      })).toMatchObject({ ...fallback, gate: "no_choices" });
    } finally {
      if (previousTypesafe === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousTypesafe;
      if (previousJev === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = previousJev;
    }
    expect(calls).toBe(0);
  });

  test("fails open without calling TypeSafe when no safe decision state remains", async () => {
    let calls = 0;
    const post = (async () => {
      calls += 1;
      return Response.json(validPayload);
    }) as JevPost;

    const decision = await resolveJevDecision({
      body: { input: "<recommended_plugins>plugin catalog</recommended_plugins>" },
      candidates,
      fallback,
      config: jevConfig("secret"),
      post,
    });

    expect(decision).toMatchObject({ ...fallback, gate: "no_state" });
    expect(calls).toBe(0);
  });

  test("fails open before TypeSafe when the serialized decision request is too large", async () => {
    const largeCandidates: JevCandidate[] = Array.from({ length: 24 }, (_, index) => {
      const provider = `provider-${index}-${"p".repeat(110)}`;
      const model = `model-${index}-${"m".repeat(110)}`;
      return {
        key: `${provider}/${model}`,
        provider,
        model,
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      };
    });
    const largeFallback = { targetKey: largeCandidates[0]!.key, effort: "medium" as const };
    let calls = 0;
    const post = (async () => {
      calls += 1;
      return Response.json(validPayload);
    }) as JevPost;

    const decision = await resolveJevDecision({
      body: decisionBody,
      candidates: largeCandidates,
      fallback: largeFallback,
      config: jevConfig("secret"),
      post,
    });

    expect(decision).toMatchObject({ ...largeFallback, gate: "invalid" });
    expect(calls).toBe(0);
  });

  test("bounds candidate count and identifier length before building a decision request", async () => {
    const tooMany: JevCandidate[] = Array.from({ length: 65 }, (_, index) => ({
      key: `p/m-${index}`,
      provider: "p",
      model: `m-${index}`,
      reasoningEfforts: ["low"],
    }));
    const longModel = "m".repeat(513);
    const tooLong: JevCandidate[] = [{
      key: `p/${longModel}`,
      provider: "p",
      model: longModel,
      reasoningEfforts: ["low"],
    }];
    let calls = 0;
    const post = (async () => {
      calls += 1;
      return Response.json(validPayload);
    }) as JevPost;

    for (const boundedCandidates of [tooMany, tooLong]) {
      const boundedFallback = { targetKey: boundedCandidates[0]!.key, effort: "low" as const };
      const decision = await resolveJevDecision({
        body: decisionBody,
        candidates: boundedCandidates,
        fallback: boundedFallback,
        config: jevConfig("secret"),
        post,
      });
      expect(decision).toMatchObject({ ...boundedFallback, gate: "invalid" });
    }
    expect(calls).toBe(0);
  });

  test("classifies redirects, HTTP errors, oversized bodies, invalid JSON, invalid choices, and network failures", async () => {
    const oversized = "x".repeat(70_000);
    const cases: Array<{ gate: string; post: JevPost }> = [
      {
        gate: "redirect",
        post: (async () => new Response(null, { status: 302, headers: { location: "https://other.example/" } })) as JevPost,
      },
      { gate: "http", post: (async () => new Response("private upstream detail", { status: 402 })) as JevPost },
      { gate: "malformed", post: (async () => new Response(oversized)) as JevPost },
      { gate: "malformed", post: (async () => new Response("not-json")) as JevPost },
      {
        gate: "invalid",
        post: (async () => Response.json({ answers: { route: { choice: "attacker/model:max" } } })) as JevPost,
      },
      { gate: "network", post: (async () => { throw new TypeError("private network detail"); }) as JevPost },
    ];

    for (const fixture of cases) {
      const decision = await resolveJevDecision({
        body: decisionBody, candidates, fallback, config: jevConfig("secret"), post: fixture.post,
      });
      expect(decision).toMatchObject({ ...fallback, gate: fixture.gate });
      expect(JSON.stringify(decision)).not.toContain("private");
    }
  });

  test("uses a four-second timeout and preserves caller cancellation by identity", async () => {
    const originalTimeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")!;
    const timeoutReasons: number[] = [];
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value(ms: number) {
        timeoutReasons.push(ms);
        const controller = new AbortController();
        controller.abort(new DOMException("deadline", "TimeoutError"));
        return controller.signal;
      },
    });
    const abortingPost = (async (_name, _provider, _url, init) => {
      throw init.signal?.reason;
    }) as JevPost;
    try {
      expect(await resolveJevDecision({
        body: decisionBody, candidates, fallback, config: jevConfig("secret"), post: abortingPost,
      })).toMatchObject({ ...fallback, gate: "timeout" });
    } finally {
      Object.defineProperty(AbortSignal, "timeout", originalTimeoutDescriptor);
    }
    expect(timeoutReasons).toEqual([4_000]);

    const controller = new AbortController();
    const reason = new DOMException("caller stopped", "AbortError");
    const callerPost = (async (_name, _provider, _url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      controller.abort(reason);
    })) as JevPost;
    await expect(resolveJevDecision({
      body: decisionBody, candidates, fallback, config: jevConfig("secret"), post: callerPost, signal: controller.signal,
    })).rejects.toBe(reason);
  });
});
