import { describe, expect, test } from "bun:test";
import {
  buildJevRouteQuestion,
  buildJevState,
  JEV_API_URL,
  JEV_MODEL,
  parseJevDecision,
  probeJevDecisionProvider,
  resolveJevDecision,
  type JevCandidate,
  type ResolveJevDecisionOptions,
} from "../../src/combos/jev";
import { anthropicToResponsesBody } from "../../src/claude/inbound";
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

  test.each(["string", "blocks"])("extracts the real first Claude Code task from %s content", shape => {
    const task = "Fix the parser and add a regression test.";
    const reminders = [
      `<system-reminder>Project CLAUDE.md guidance\n${"Follow project conventions.\n".repeat(200)}</system-reminder>`,
      "<system-reminder>User context and attribution guidance.</system-reminder>",
    ];
    const content = shape === "string"
      ? [...reminders, task].join("\n\n")
      : [...reminders, task].map(text => ({ type: "text", text }));
    const body = anthropicToResponsesBody({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content }],
    });
    const original = JSON.stringify(body);

    expect(original).toContain("<system-reminder>");
    expect(buildJevState(body)).toEqual({
      task,
      signals: { has_image: false, tool_history: false },
      step: { type: "user_turn" },
    });
    expect(JSON.stringify(body)).toBe(original);
  });

  test("strips reminders from the latest task and preserves head/tail clipping", () => {
    const task = `${"h".repeat(380)}${"t".repeat(380)}`;
    const body = anthropicToResponsesBody({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "An older request." },
        { role: "assistant", content: "Ready for the next request." },
        {
          role: "user",
          content: `<system-reminder>${"context".repeat(40_000)}</system-reminder>\n${task}`,
        },
      ],
    });

    expect(buildJevState(body)).toEqual({
      task: `${"h".repeat(320)}\n[...]\n${"t".repeat(173)}`,
      signals: { has_image: false, tool_history: false },
      step: { type: "user_turn" },
      previous_assistant: "Ready for the next request.",
    });
  });

  test("uses protected nesting semantics without salvaging reminder contents as a Codex goal", () => {
    const reminder = '<system-reminder><codex_internal_context source="goal">Quoted goal</codex_internal_context></system-reminder>';
    expect(buildJevState({ input: reminder })).toMatchObject({ task: "" });
    expect(buildJevState({
      input: `<codex_internal_context source="goal">Active goal${reminder}</codex_internal_context>`,
    })).toMatchObject({ task: "Active goal" });
    expect(buildJevState({
      input: "<system-reminder>Outer<system-reminder>Inner</system-reminder>Outer</system-reminder>Real task",
    })).toMatchObject({ task: "Real task" });
    expect(buildJevState({
      input: "Visible task<system-reminder>Unclosed context",
    })).toMatchObject({ task: "Visible task" });
    expect(buildJevState({ input: "<system-reminder>Unclosed context" })).toMatchObject({ task: "" });
    expect(buildJevState({ input: "Before<system-reminder>Context</system-reminder>after" }))
      .toMatchObject({ task: "Before\nafter" });
  });

  test("removes Claude Code reminders from converted assistant and tool-result tails", () => {
    const reminder = `<system-reminder>${"Context only. ".repeat(200)}</system-reminder>`;
    const body = anthropicToResponsesBody({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "Continue the investigation." },
        {
          role: "assistant",
          content: [
            { type: "text", text: `Visible plan${reminder}visible follow-up${reminder}` },
            { type: "tool_use", id: "call-1", name: "Read", input: { file: "example.ts" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: `Visible result${reminder}` }],
        },
      ],
    });

    expect(buildJevState(body)).toEqual({
      task: "Continue the investigation.",
      signals: { has_image: false, tool_history: true },
      step: { type: "tool_step", last_tool_output_tail: "Visible result", tool_call: { name: "Read" } },
      previous_assistant: "Visible plan\nvisible follow-up",
    });
  });

  test("keeps reminder-free states byte-identical to the pre-reminder behavior", () => {
    const task = `  ${"h".repeat(380)}<example>ordinary markup</example>${"t".repeat(380)}  `;
    const body = anthropicToResponsesBody({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: task },
        {
          role: "assistant",
          content: [
            { type: "text", text: `  ${"a".repeat(300)}<example>plan</example>  ` },
            { type: "tool_use", id: "call-1", name: "Read", input: { file: "example.ts" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: `  ${"z".repeat(600)}  ` }],
        },
      ],
    });
    const expected = {
      task: `${"h".repeat(320)}\n[...]\n${"t".repeat(173)}`,
      signals: { has_image: false, tool_history: true },
      step: { type: "tool_step", last_tool_output_tail: "z".repeat(520), tool_call: { name: "Read" } },
      previous_assistant: `${"a".repeat(217)}<example>plan</example>`,
    };

    expect(JSON.stringify(buildJevState(body))).toBe(JSON.stringify(expected));
    expect(JSON.stringify(buildJevState({ input: task }))).toBe(JSON.stringify({
      task: expected.task,
      signals: { has_image: false, tool_history: false },
      step: { type: "user_turn" },
    }));
    expect(buildJevState({ input: "<environment_context>Context</environment_context>Codex task" }))
      .toMatchObject({ task: "Codex task" });
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
      backend: "typesafe",
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

  test("transmits only the selected candidate note without changing built-in profiles or choices", async () => {
    const bodies: Record<string, unknown>[] = [];
    const post = (async (_name, _provider, _url, init) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json(validPayload);
    }) as JevPost;
    const noted = [
      { ...candidates[0]!, modelProfile: "  Subscription allowance for Astra.  " },
      candidates[1]!,
    ];
    await resolveJevDecision({ body: decisionBody, candidates: noted, fallback, config: jevConfig("secret"), post });
    await resolveJevDecision({ body: decisionBody, candidates, fallback, config: jevConfig("secret"), post });
    await resolveJevDecision({ body: decisionBody, candidates: [candidates[1]!], fallback, config: jevConfig("secret"), post });

    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.state).toEqual({
      ...buildJevState(decisionBody),
      operator_notes: { "openai/gpt-6-astra": "Subscription allowance for Astra." },
    });
    expect(bodies[1]?.state).toEqual(buildJevState(decisionBody));
    expect(bodies[2]?.state).toEqual(buildJevState(decisionBody));
    expect((bodies[0]?.questions as Record<string, unknown>)).toEqual(buildJevRouteQuestion(candidates));
    expect((bodies[2]?.questions as Record<string, unknown>)).toEqual(buildJevRouteQuestion([candidates[1]!]));
    expect(JSON.stringify(bodies[2])).not.toContain("Astra");
  });

  test("rejects an oversized note before an outbound decision", async () => {
    let calls = 0;
    const post = (async () => { calls++; return Response.json(validPayload); }) as JevPost;
    const decision = await resolveJevDecision({
      body: decisionBody,
      candidates: [{ ...candidates[0]!, modelProfile: "x".repeat(513) }],
      fallback,
      config: jevConfig("secret"),
      post,
    });
    expect(decision.gate).toBe("invalid");
    expect(calls).toBe(0);
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
      })).toMatchObject({ backend: "typesafe", ...fallback, gate: "missing_key" });
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

describe("JEV configurable decision provider", () => {
  type Call = { name: string; provider: unknown; url: string; init: RequestInit; dependencies: Parameters<JevPost>[4] };
  const recordingPost = (calls: Call[], response: () => Response = () => Response.json(validPayload)): JevPost =>
    (async (name, provider, url, init, dependencies) => {
      calls.push({ name, provider, url, init, dependencies });
      return response();
    }) as JevPost;
  const selfHosted = (overrides: Partial<OcxConfig["providers"][string]> = {}): OcxConfig => {
    const config = jevConfig("typesafe-row-secret");
    config.providers["ollama-tev1"] = {
      adapter: "jev-decision",
      baseUrl: "http://127.0.0.1:11434/v1/systemone/",
      allowPrivateNetwork: true,
      defaultModel: " tev1:4b ",
      liveModels: false,
      ...overrides,
    };
    return config;
  };
  const withEnvKeys = async (run: () => Promise<void>): Promise<void> => {
    const previousTypesafe = process.env.TYPESAFE_API_KEY;
    const previousJev = process.env.JEV_API_KEY;
    process.env.TYPESAFE_API_KEY = "env-typesafe-secret";
    process.env.JEV_API_KEY = "env-jev-secret";
    try {
      await run();
    } finally {
      if (previousTypesafe === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousTypesafe;
      if (previousJev === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = previousJev;
    }
  };

  test("omitted and explicit jev send the identical canonical request with structured criteria", async () => {
    const calls: Call[] = [];
    const config = selfHosted();
    await resolveJevDecision({ body: decisionBody, candidates, fallback, config, post: recordingPost(calls) });
    await resolveJevDecision({
      body: decisionBody, candidates, fallback, config, decisionProvider: "jev", post: recordingPost(calls),
    });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.name).toBe("jev");
      expect(call.url).toBe(JEV_API_URL);
      expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer typesafe-row-secret");
      expect(call.dependencies?.isCanonicalUrl?.("jev", JEV_API_URL)).toBeTrue();
    }
    expect(calls[1]!.init.body).toBe(calls[0]!.init.body);
    const sent = JSON.parse(String(calls[0]!.init.body)) as { model: string; questions: unknown };
    expect(sent.model).toBe(JEV_MODEL);
    expect(sent.questions).toEqual(buildJevRouteQuestion(candidates));
    const criteria = (sent.questions as { route: { criteria: Record<string, unknown> } }).route.criteria;
    expect(Object.values(criteria).every(value => typeof value === "object" && value !== null)).toBeTrue();
  });

  test("a canonical jev row's defaultModel and models never change the TypeSafe request", async () => {
    const calls: Call[] = [];
    const plain = jevConfig("typesafe-row-secret");
    const decorated = jevConfig("typesafe-row-secret");
    decorated.providers.jev!.defaultModel = "jev-2026-09";
    decorated.providers.jev!.models = ["jev-other"];
    for (const config of [plain, decorated]) {
      await resolveJevDecision({ body: decisionBody, candidates, fallback, config, post: recordingPost(calls) });
    }

    expect(calls.map(call => call.url)).toEqual([JEV_API_URL, JEV_API_URL]);
    expect(JSON.parse(String(calls[1]!.init.body)).model).toBe(JEV_MODEL);
    expect(calls[1]!.init.body).toBe(calls[0]!.init.body);
  });

  test("a retargeted jev row stays pinned to TypeSafe and never receives a credential", async () => {
    await withEnvKeys(async () => {
      const calls: Call[] = [];
      const config = jevConfig("row-secret");
      config.providers.jev!.baseUrl = "https://decider.example/v1/systemone";
      config.providers.jev!.defaultModel = "attacker-model";
      await resolveJevDecision({
        body: decisionBody, candidates, fallback, config, decisionProvider: "jev", post: recordingPost(calls),
      });

      expect(calls[0]!.url).toBe(JEV_API_URL);
      expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer env-typesafe-secret");
      expect(JSON.parse(String(calls[0]!.init.body)).model).toBe(JEV_MODEL);
      expect(JSON.stringify(calls)).not.toContain("row-secret");
      expect(JSON.stringify(calls)).not.toContain("decider.example");
    });
  });

  test("a self-hosted row posts keyless to its own endpoint with its model and description criteria", async () => {
    const calls: Call[] = [];
    const config = selfHosted();
    const decision = await resolveJevDecision({
      body: decisionBody, candidates, fallback, config, decisionProvider: "ollama-tev1", post: recordingPost(calls),
    });

    expect(decision).toMatchObject({ backend: "systemone", targetKey: "openai/gpt-5.6-sol", effort: "low", gate: "apply" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.name).toBe("ollama-tev1");
    // The row itself governs destination policy, so loopback needs its own allowPrivateNetwork.
    expect(call.provider).toBe(config.providers["ollama-tev1"]);
    expect(call.url).toBe("http://127.0.0.1:11434/v1/systemone");
    expect(call.dependencies?.isCanonicalUrl?.(call.name, call.url)).toBeFalse();
    expect(call.dependencies?.allowLocalCleartextPost).toBeTrue();
    const headers = new Headers(call.init.headers);
    expect(headers.has("authorization")).toBeFalse();
    expect(headers.get("content-type")).toBe("application/json");
    const sent = JSON.parse(String(call.init.body)) as {
      model: string;
      state: unknown;
      questions: { route: { instructions: unknown; criteria: Record<string, unknown> } };
    };
    expect(sent.model).toBe("tev1:4b");
    expect(sent.state).toEqual(buildJevState(decisionBody));
    expect(sent.questions).toEqual(buildJevRouteQuestion(candidates, { descriptiveCriteria: true }));
    expect(sent.questions.route.instructions)
      .toEqual((buildJevRouteQuestion(candidates) as typeof sent.questions).route.instructions);
    expect(sent.questions.route.criteria).toEqual({
      "openai/gpt-6-astra:medium": "Target openai/gpt-6-astra (provider openai, model gpt-6-astra) with medium reasoning effort.",
      "openai/gpt-6-astra:high": "Target openai/gpt-6-astra (provider openai, model gpt-6-astra) with high reasoning effort.",
      "openai/gpt-5.6-sol:low": "Target openai/gpt-5.6-sol (provider openai, model gpt-5.6-sol) with low reasoning effort.",
    });
    const noEffort = buildJevRouteQuestion([{ ...candidates[1]!, reasoningEfforts: [] }], { descriptiveCriteria: true });
    expect((noEffort as typeof sent.questions).route.criteria).toEqual({
      "openai/gpt-5.6-sol:none": "Target openai/gpt-5.6-sol (provider openai, model gpt-5.6-sol) with no reasoning-effort control.",
    });
  });

  test("a self-hosted row uses models[0] after defaultModel and is unusable without either", async () => {
    const calls: Call[] = [];
    const post = recordingPost(calls);
    await resolveJevDecision({
      body: decisionBody,
      candidates,
      fallback,
      config: selfHosted({ defaultModel: undefined, models: ["tev1:0.8b", "tev1:4b"] }),
      decisionProvider: "ollama-tev1",
      post,
    });
    expect(calls.map(call => JSON.parse(String(call.init.body)).model)).toEqual(["tev1:0.8b"]);

    // TypeSafe's `jev-latest` is never sent to a self-hosted host.
    for (const bare of [selfHosted({ defaultModel: undefined }), selfHosted({ defaultModel: "  ", models: [] })]) {
      expect(await resolveJevDecision({
        body: decisionBody, candidates, fallback, config: bare, decisionProvider: "ollama-tev1", post,
      })).toMatchObject({ ...fallback, gate: "missing_key" });
    }
    expect(calls).toHaveLength(1);
  });

  test("a self-hosted endpoint must be a /systemone path", async () => {
    const calls: Call[] = [];
    const post = recordingPost(calls);
    for (const baseUrl of ["http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1/systemone-proxy", "not a url"]) {
      expect(await resolveJevDecision({
        body: decisionBody, candidates, fallback, config: selfHosted({ baseUrl }), decisionProvider: "ollama-tev1", post,
      })).toMatchObject({ ...fallback, gate: "missing_key" });
    }
    expect(calls).toHaveLength(0);
    await resolveJevDecision({
      body: decisionBody,
      candidates,
      fallback,
      config: selfHosted({ baseUrl: "https://decider.example/api/v1/systemone//" }),
      decisionProvider: "ollama-tev1",
      post,
    });
    expect(calls.map(call => call.url)).toEqual(["https://decider.example/api/v1/systemone"]);
  });

  test("a self-hosted row refuses TypeSafe environment references and foreign keychain entries", async () => {
    await withEnvKeys(async () => {
      const calls: Call[] = [];
      const post = recordingPost(calls);
      for (const apiKey of ["${TYPESAFE_API_KEY}", "$TYPESAFE_API_KEY", "${JEV_API_KEY}", "$JEV_API_KEY", "keychain:jev"]) {
        expect(await resolveJevDecision({
          body: decisionBody, candidates, fallback, config: selfHosted({ apiKey }), decisionProvider: "ollama-tev1", post,
        })).toMatchObject({ ...fallback, gate: "missing_key" });
      }
      expect(calls).toHaveLength(0);

      const previousOwn = process.env.OLLAMA_TEV1_KEY;
      process.env.OLLAMA_TEV1_KEY = "own-env-secret";
      try {
        await resolveJevDecision({
          body: decisionBody,
          candidates,
          fallback,
          config: selfHosted({ apiKey: "${OLLAMA_TEV1_KEY}" }),
          decisionProvider: "ollama-tev1",
          post,
        });
      } finally {
        if (previousOwn === undefined) delete process.env.OLLAMA_TEV1_KEY;
        else process.env.OLLAMA_TEV1_KEY = previousOwn;
      }
      expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer own-env-secret");
    });
  });

  test("self-hosted option counts outside 2..26 fail open without a request", async () => {
    const calls: Call[] = [];
    const post = recordingPost(calls);
    const single: JevCandidate[] = [{ ...candidates[1]!, reasoningEfforts: ["low"] }];
    const many: JevCandidate[] = Array.from({ length: 9 }, (_, index) => ({
      key: `p/m-${index}`,
      provider: "p",
      model: `m-${index}`,
      reasoningEfforts: ["low", "medium", "high"],
    }));
    const edge = many.slice(0, 8).concat([{ ...many[8]!, reasoningEfforts: ["low", "medium"] }]);
    const manyFallback = { targetKey: many[0]!.key, effort: "low" as const };
    const singleFallback = { targetKey: single[0]!.key, effort: "low" as const };

    expect(await resolveJevDecision({
      body: decisionBody, candidates: single, fallback: singleFallback, config: selfHosted(), decisionProvider: "ollama-tev1", post,
    })).toMatchObject({ ...singleFallback, gate: "no_choices" });
    expect(await resolveJevDecision({
      body: decisionBody, candidates: many, fallback: manyFallback, config: selfHosted(), decisionProvider: "ollama-tev1", post,
    })).toMatchObject({ ...manyFallback, gate: "invalid" });
    expect(calls).toHaveLength(0);

    // 26 options is the ceiling and still goes out; the canonical service keeps no local count limit.
    await resolveJevDecision({
      body: decisionBody, candidates: edge, fallback: manyFallback, config: selfHosted(), decisionProvider: "ollama-tev1", post,
    });
    await resolveJevDecision({ body: decisionBody, candidates: single, fallback: singleFallback, config: jevConfig("secret"), post });
    await resolveJevDecision({ body: decisionBody, candidates: many, fallback: manyFallback, config: jevConfig("secret"), post });
    expect(calls.map(call => call.url)).toEqual(["http://127.0.0.1:11434/v1/systemone", JEV_API_URL, JEV_API_URL]);
    expect(Object.keys((JSON.parse(String(calls[0]!.init.body)) as {
      questions: { route: { criteria: object } };
    }).questions.route.criteria)).toHaveLength(26);
  });

  test("a self-hosted row sends only its own key and never a TypeSafe credential", async () => {
    await withEnvKeys(async () => {
      const calls: Call[] = [];
      const post = recordingPost(calls);
      await resolveJevDecision({
        body: decisionBody, candidates, fallback, config: selfHosted(), decisionProvider: "ollama-tev1", post,
      });
      await resolveJevDecision({
        body: decisionBody,
        candidates,
        fallback,
        config: selfHosted({ apiKey: "self-hosted-secret" }),
        decisionProvider: "ollama-tev1",
        post,
      });

      expect(calls).toHaveLength(2);
      expect(new Headers(calls[0]!.init.headers).has("authorization")).toBeFalse();
      expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe("Bearer self-hosted-secret");
      const wire = JSON.stringify(calls.map(call => [call.url, [...new Headers(call.init.headers)], call.init.body]));
      for (const secret of ["env-typesafe-secret", "env-jev-secret", "typesafe-row-secret"]) {
        expect(wire).not.toContain(secret);
      }
    });
  });

  test("disabled, missing, and non-decision rows fail open without a request", async () => {
    const calls: Call[] = [];
    const post = recordingPost(calls);
    const wrongAdapter = selfHosted();
    wrongAdapter.providers["ollama-tev1"]!.adapter = "openai-chat";
    const cases: Array<{ config: OcxConfig; decisionProvider: string }> = [
      { config: selfHosted({ disabled: true }), decisionProvider: "ollama-tev1" },
      { config: selfHosted(), decisionProvider: "not-configured" },
      { config: selfHosted(), decisionProvider: "openai" },
      { config: wrongAdapter, decisionProvider: "ollama-tev1" },
    ];
    for (const { config, decisionProvider } of cases) {
      expect(await resolveJevDecision({
        body: decisionBody, candidates, fallback, config, decisionProvider, post,
      })).toMatchObject({ ...fallback, gate: "missing_key" });
    }
    expect(calls).toHaveLength(0);
  });

  test("a self-hosted redirect fails closed against the self-hosted URL", async () => {
    const calls: Call[] = [];
    const decision = await resolveJevDecision({
      body: decisionBody,
      candidates,
      fallback,
      config: selfHosted(),
      decisionProvider: "ollama-tev1",
      post: recordingPost(calls, () => new Response(null, { status: 307, headers: { location: JEV_API_URL } })),
    });
    expect(decision).toMatchObject({ ...fallback, gate: "redirect" });
    expect(calls).toHaveLength(1);
  });

  test("an in-range decision timeout replaces the four-second default", async () => {
    const originalTimeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")!;
    const deadlines: number[] = [];
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value(ms: number) {
        deadlines.push(ms);
        return new AbortController().signal;
      },
    });
    const calls: Call[] = [];
    try {
      for (const timeoutMs of [60_000, 999, 120_001, 1_500.5, undefined]) {
        await resolveJevDecision({
          body: decisionBody,
          candidates,
          fallback,
          config: selfHosted(),
          decisionProvider: "ollama-tev1",
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          post: recordingPost(calls),
        });
      }
    } finally {
      Object.defineProperty(AbortSignal, "timeout", originalTimeoutDescriptor);
    }
    expect(deadlines).toEqual([60_000, 4_000, 4_000, 4_000, 4_000]);
  });

  test("the connection probe keeps TypeSafe wording and gives self-hosted rows two choices", async () => {
    const calls: Call[] = [];
    const probeAnswer = (choice: string) => () => Response.json({ answers: { route: { choice } } });
    expect(await probeJevDecisionProvider(jevConfig("secret"), "jev", {
      post: recordingPost(calls, probeAnswer("jev/probe:none")),
    })).toEqual({ ok: true, latencyMs: expect.any(Number), message: "Connected. TypeSafe JEV answered a decision probe." });
    expect(await probeJevDecisionProvider(selfHosted(), "ollama-tev1", {
      post: recordingPost(calls, probeAnswer("jev/probe:high")),
    })).toEqual({ ok: true, latencyMs: expect.any(Number), message: "Connected. JEV decision service answered a decision probe." });
    expect(calls.map(call => call.url)).toEqual([JEV_API_URL, "http://127.0.0.1:11434/v1/systemone"]);
    const criteriaKeys = calls.map(call => Object.keys(
      (JSON.parse(String(call.init.body)) as { questions: { route: { criteria: object } } }).questions.route.criteria,
    ));
    expect(criteriaKeys).toEqual([["jev/probe:none"], ["jev/probe:low", "jev/probe:high"]]);

    const previousTypesafe = process.env.TYPESAFE_API_KEY;
    const previousJev = process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.JEV_API_KEY;
    try {
      expect((await probeJevDecisionProvider(jevConfig(), "jev", { post: recordingPost(calls) })))
        .toMatchObject({ ok: false, error: "TypeSafe JEV API key is not configured" });
    } finally {
      if (previousTypesafe !== undefined) process.env.TYPESAFE_API_KEY = previousTypesafe;
      if (previousJev !== undefined) process.env.JEV_API_KEY = previousJev;
    }
    expect(await probeJevDecisionProvider(selfHosted(), "ollama-tev1", {
      post: recordingPost(calls, () => new Response("down", { status: 500 })),
    })).toMatchObject({ ok: false, error: "JEV decision service probe failed (http)" });
    const probed = calls.length;
    expect(await probeJevDecisionProvider(selfHosted({ disabled: true }), "ollama-tev1", {
      post: recordingPost(calls),
    })).toMatchObject({ ok: false, error: "JEV decision service is disabled or not configured" });
    expect(calls).toHaveLength(probed);
    expect(await probeJevDecisionProvider(jevConfig("secret"), "jev", {
      post: recordingPost(calls, () => new Response("down", { status: 500 })),
    })).toMatchObject({ ok: false, error: "TypeSafe JEV decision probe failed (http)" });
  });
});
