import { describe, expect, test } from "bun:test";
import { resolveJevComboDecision } from "../../src/combos/jev-dispatch";
import {
  buildJevModelPrompt,
  JEV_MODEL_INSTRUCTIONS,
  JEV_MODEL_MAX_OPTIONS,
  JEV_MODEL_MAX_RESPONSE_TEXT_CHARS,
  JevModelInvokeError,
  parseJevModelChoice,
  resolveJevModelDecision,
  type JevModelInvoke,
  type JevModelInvokeRequest,
} from "../../src/combos/jev-model-backend";
import {
  buildJevState,
  JEV_API_URL,
  jevRouteOptions,
  type JevCandidate,
  type ResolveJevDecisionOptions,
} from "../../src/combos/jev";
import type { OcxConfig } from "../../src/types";

const candidates: JevCandidate[] = [
  { key: "p/large", provider: "p", model: "large", reasoningEfforts: ["medium", "high"] },
  { key: "p/small", provider: "p", model: "small", reasoningEfforts: ["low"] },
];
const fallback = { targetKey: "p/large", effort: "medium" as const };
const config: OcxConfig = {
  port: 0,
  defaultProvider: "p",
  providers: { jev: { adapter: "jev-decision", baseUrl: JEV_API_URL, apiKey: "test-key" } },
};
const body = { input: "Choose carefully." };
const base = { body, candidates, fallback, config, decisionModel: "p/router" };
const successfulInvoke: JevModelInvoke = async () => ({ text: '{"choice":"p/small:low"}' });

describe("JEV model prompt and choice parser", () => {
  test("contains bounded state and every option description without TypeSafe criteria", () => {
    const state = buildJevState(body, candidates);
    const prompt = JSON.parse(buildJevModelPrompt(state, candidates));
    expect(prompt.state).toEqual(state);
    expect(prompt.state.task).toBe(body.input);
    expect(Object.keys(prompt)).toEqual(["state", "options"]);
    for (const option of jevRouteOptions(candidates)) {
      expect(prompt.options[option.key]).toBe(option.description);
      expect(typeof prompt.options[option.key]).toBe("string");
    }
    expect(Object.keys(prompt.options)).toHaveLength(3);
    expect(prompt.criteria).toBeUndefined();
    expect(prompt.questions).toBeUndefined();
  });

  test("accepts an object, a bare JSON string, and one json or plain fence", () => {
    const allowed = new Set(["p/small:low"]);
    for (const text of [
      '  {"choice":"p/small:low"}  ',
      '"p/small:low"',
      '```json\n{"choice":"p/small:low"}\n```',
      '```\n"p/small:low"\n```',
      '<think>weighing the two options</think>\n{"choice":"p/small:low"}',
    ]) expect(parseJevModelChoice(text, allowed)).toBe("p/small:low");
  });

  test("rejects unknown keys and wrong JSON shapes as invalid", () => {
    for (const text of ['{"choice":"other"}', '"other"', '[]', '["p/small:low"]', '{}', 'null', '42', '{"choice":1}']) {
      let error: unknown;
      try { parseJevModelChoice(text, new Set(["p/small:low"])); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(JevModelInvokeError);
    }
  });

  test("rejects non-JSON, nested fences, and oversized raw text as malformed", () => {
    for (const text of ["p/small:low", "```json\n```json\n{}\n```\n```", " ".repeat(JEV_MODEL_MAX_RESPONSE_TEXT_CHARS + 1)]) {
      expect(() => parseJevModelChoice(text, new Set())).toThrow(JevModelInvokeError);
      try { parseJevModelChoice(text, new Set()); } catch (error) {
        expect(error).toMatchObject({ gate: "malformed" });
      }
    }
    const atLimit = '"p/small:low"'.padEnd(JEV_MODEL_MAX_RESPONSE_TEXT_CHARS);
    expect(parseJevModelChoice(atLimit, new Set(["p/small:low"]))).toBe("p/small:low");
  });
});

describe("JEV pure model backend", () => {
  test("invokes the selected model with fixed instructions, allowlisted prompt, and deadline signal", async () => {
    const requests: JevModelInvokeRequest[] = [];
    const decision = await resolveJevModelDecision({ ...base, invokeModel: async request => {
      requests.push(request);
      return successfulInvoke(request);
    } });
    expect(decision).toMatchObject({ backend: "model", targetKey: "p/small", effort: "low", gate: "apply" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe(base.decisionModel);
    expect(requests[0]!.instructions).toBe(JEV_MODEL_INSTRUCTIONS);
    expect(requests[0]!.input).toBe(buildJevModelPrompt(buildJevState(body, candidates), candidates));
    expect(requests[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(requests[0]!.signal.aborted).toBeFalse();
  });

  test("preserves each typed invoke failure gate and falls back", async () => {
    for (const gate of ["http", "network", "malformed", "missing_key"] as const) {
      expect(await resolveJevModelDecision({ ...base, invokeModel: async () => { throw new JevModelInvokeError(gate); } }))
        .toMatchObject({ backend: "model", ...fallback, gate });
    }
    expect(await resolveJevModelDecision({ ...base, invokeModel: async () => { throw new Error("connection failed"); } }))
      .toMatchObject({ backend: "model", ...fallback, gate: "network" });
  });

  test("maps parsing failures to malformed or invalid", async () => {
    for (const [text, gate] of [
      ["garbage", "malformed"],
      ["x".repeat(JEV_MODEL_MAX_RESPONSE_TEXT_CHARS + 1), "malformed"],
      ['{"choice":"p/unknown:high"}', "invalid"],
      ['[]', "invalid"],
    ]) {
      expect(await resolveJevModelDecision({ ...base, invokeModel: async () => ({ text: text! }) }))
        .toMatchObject({ backend: "model", ...fallback, gate });
    }
  });

  test("deadline aborts a pending signal-aware invocation and fails open", async () => {
    const invokeModel: JevModelInvoke = ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    expect(await resolveJevModelDecision({ ...base, timeoutMs: 1000, invokeModel }))
      .toMatchObject({ backend: "model", ...fallback, gate: "timeout" });
    expect(await resolveJevModelDecision({ ...base, invokeModel: async () => { throw new DOMException("deadline", "TimeoutError"); } }))
      .toMatchObject({ backend: "model", ...fallback, gate: "timeout" });
  });

  test("rethrows the caller abort reason by identity before, during, and after invocation", async () => {
    for (const timing of ["before", "during", "after"] as const) {
      const controller = new AbortController();
      const reason = { stopped: timing };
      let calls = 0;
      if (timing === "before") controller.abort(reason);
      const invokeModel: JevModelInvoke = async request => {
        calls++;
        if (timing === "during") return new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          controller.abort(reason);
        });
        controller.abort(reason);
        return successfulInvoke(request);
      };
      await expect(resolveJevModelDecision({ ...base, signal: controller.signal, invokeModel })).rejects.toBe(reason);
      expect(calls).toBe(timing === "before" ? 0 : 1);
    }
  });

  test("respects now for success and failure latency and clamps negative elapsed time", async () => {
    for (const [end, expected] of [[145, 45], [95, 0]]) {
      for (const invokeModel of [successfulInvoke, async () => { throw new JevModelInvokeError("http"); }]) {
        let calls = 0;
        const result = await resolveJevModelDecision({ ...base, invokeModel, now: () => calls++ === 0 ? 100 : end! });
        expect(result.latencyMs).toBe(expected!);
      }
    }
  });

  test("keeps only safe nonnegative token usage in either supported naming convention", async () => {
    const usage = { input_tokens: 5, output_tokens: 0, inputTokens: 7, outputTokens: 2, other: 99 };
    expect((await resolveJevModelDecision({ ...base, invokeModel: async () => ({ text: '"p/small:low"', usage }) })).usage)
      .toEqual({ input_tokens: 5, output_tokens: 0, inputTokens: 7, outputTokens: 2 });
    const invalidUsage = { input_tokens: -1, output_tokens: 1.5, inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: NaN };
    expect((await resolveJevModelDecision({ ...base, invokeModel: async () => ({ text: '"p/small:low"', usage: invalidUsage }) })).usage)
      .toBeUndefined();
  });

  test("empty choices, empty state, field bounds, and duplicate options fail before invoking", async () => {
    let calls = 0;
    const invokeModel: JevModelInvoke = async request => { calls++; return successfulInvoke(request); };
    for (const [overrides, gate] of [
      [{ candidates: [] }, "no_choices"],
      [{ body: {} }, "no_state"],
      [{ candidates: [{ ...candidates[0]!, key: "" }] }, "invalid"],
      [{ candidates: [candidates[0]!, candidates[0]!] }, "invalid"],
    ] as const) {
      expect(await resolveJevModelDecision({ ...base, ...overrides, invokeModel })).toMatchObject({ ...fallback, backend: "model", gate });
    }
    expect(calls).toBe(0);
  });

  test("accepts 64 expanded options and refuses more without invoking", async () => {
    const many: JevCandidate[] = Array.from({ length: 33 }, (_, index) => ({
      key: `p/m${index}`, provider: "p", model: `m${index}`, reasoningEfforts: ["low", "high"],
    }));
    let calls = 0;
    const invokeModel: JevModelInvoke = async () => { calls++; return { text: '"p/m0:low"' }; };
    expect(jevRouteOptions(many.slice(0, 32))).toHaveLength(JEV_MODEL_MAX_OPTIONS);
    expect(await resolveJevModelDecision({ ...base, candidates: many.slice(0, 32), invokeModel })).toMatchObject({ gate: "apply" });
    expect(await resolveJevModelDecision({ ...base, candidates: many, invokeModel })).toMatchObject({ ...fallback, gate: "invalid" });
    expect(calls).toBe(1);
  });

  test("request bounds count UTF-8 bytes rather than characters", async () => {
    const large = (character: string): JevCandidate[] => Array.from({ length: 20 }, (_, index) => ({
      key: `${character.repeat(400)}${index}`, provider: character.repeat(400), model: character.repeat(400), reasoningEfforts: [],
    }));
    let calls = 0;
    const invokeModel: JevModelInvoke = async ({ input }) => {
      calls++;
      return { text: JSON.stringify(Object.keys(JSON.parse(input).options)[0]) };
    };
    expect(await resolveJevModelDecision({ ...base, candidates: large("a"), invokeModel })).toMatchObject({ gate: "apply", effort: null });
    expect(await resolveJevModelDecision({ ...base, candidates: large("界"), invokeModel })).toMatchObject({ ...fallback, gate: "invalid" });
    expect(calls).toBe(1);
  });
});

describe("JEV combo backend dispatch", () => {
  test("a selected model requires an invoker and still propagates caller cancellation", async () => {
    expect(await resolveJevComboDecision({ ...base })).toMatchObject({ ...fallback, backend: "model", gate: "missing_key" });
    const reason = new Error("caller stopped");
    await expect(resolveJevComboDecision({ ...base, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(await resolveJevComboDecision({ ...base, invokeModel: successfulInvoke })).toMatchObject({ backend: "model", gate: "apply" });
  });

  test("no decision model preserves the System One post and TypeSafe backend", async () => {
    const calls: Array<{ name: string; url: string; body: unknown }> = [];
    const post: NonNullable<ResolveJevDecisionOptions["post"]> = async (name, _provider, url, init) => {
      calls.push({ name, url, body: init.body });
      return Response.json({ answers: { route: { choice: "p/small:low" } } });
    };
    for (const decisionModel of [undefined, "", "   "]) {
      expect(await resolveJevComboDecision({ ...base, decisionModel, post })).toMatchObject({ backend: "typesafe", targetKey: "p/small", effort: "low", gate: "apply" });
    }
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ name: "jev", url: JEV_API_URL });
    expect(JSON.parse(String(calls[0]!.body)).questions.route.criteria["p/small:low"]).toEqual({
      target: "p/small", provider: "p", model: "small", reasoning_effort: "low",
    });
    expect(calls[1]!.body).toBe(calls[0]!.body);
    expect(calls[2]!.body).toBe(calls[0]!.body);
  });
});
