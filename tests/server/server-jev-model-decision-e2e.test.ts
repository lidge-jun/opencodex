import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import { handleResponses } from "../../src/server/responses/core";
import type { ResponsesDispatchers } from "../../src/server/responses/core-options";
import { jevDecisionReasoningEffort } from "../../src/server/responses/jev-model-invoke";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

beforeEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
});
afterEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
});

function modelProvider(model: string): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: `https://${model}.example.test/v1`,
    authMode: "key",
    apiKey: `key-${model}`,
    liveModels: false,
    models: [model],
    modelReasoningEfforts: { [model]: ["low", "high"] },
  };
}

function makeConfig(decisionModel = "judge/judge-small"): OcxConfig {
  return {
    port: 0,
    defaultProvider: "astra",
    providers: {
      astra: modelProvider("gpt-6-astra"),
      luna: modelProvider("gpt-5.6-luna"),
      judge: modelProvider("judge-small"),
    },
    combos: {
      auto: {
        alias: "jev-auto",
        strategy: "jev",
        decisionModel,
        targets: [{ provider: "astra", model: "gpt-6-astra" }, { provider: "luna", model: "gpt-5.6-luna" }],
      },
    },
  } as OcxConfig;
}

type Seen = { body: Record<string, unknown>; headers: Headers; options: Parameters<ResponsesDispatchers["handleResponses"]>[3] };

function sse(events: unknown[]): Response {
  const text = events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

function completed(text: string): Response {
  return sse([
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.completed",
      response: {
        id: "resp_judge",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 40, output_tokens: 6 },
      },
    },
  ]);
}

function targetOk(model: string): Response {
  return Response.json({ id: "resp_target", object: "response", status: "completed", model, output: [] });
}

async function run(config: OcxConfig, decisionReply: (seen: Seen) => Response, parentLog: RequestLogContext = { model: "", provider: "" }) {
  const decisions: Seen[] = [];
  const targets: Array<Record<string, unknown>> = [];
  const dispatchers: ResponsesDispatchers = {
    async handleResponses(request, _config, _logCtx, options) {
      const body = await request.json() as Record<string, unknown>;
      if (options?.internalDecisionCall) {
        const seen = { body, headers: request.headers, options };
        decisions.push(seen);
        return decisionReply(seen);
      }
      targets.push(body);
      return targetOk(String(body.model));
    },
    async handleComboResponses() { throw new Error("nested combo dispatch is not expected"); },
  };
  const body = {
    model: "jev-auto",
    stream: false,
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
    input: [
      { role: "user", content: [{ type: "input_text", text: "Refactor the parser and keep tests green." }] },
    ],
  };
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer parent-caller-secret",
      "chatgpt-account-id": "acct-parent",
      "x-codex-parent-thread-id": "thread-parent",
    },
    body: JSON.stringify(body),
  });
  const budget = createTranslatorBudget();
  try {
    const response = await executeComboResponses(request, body, "auto", config, parentLog, { translatorBudget: budget }, dispatchers);
    return { response, decisions, targets };
  } finally {
    budget.dispose();
  }
}

describe("JEV model decision backend through the combo runtime", () => {
  test("asks the decision model with a headerless, tool-free prompt and routes to its choice", async () => {
    const parentLog: RequestLogContext = { model: "", provider: "" };
    const { response, decisions, targets } = await run(makeConfig(), () => completed('{"choice":"luna/gpt-5.6-luna:high"}'), parentLog);

    expect(response.status).toBe(200);
    expect(decisions).toHaveLength(1);
    const decision = decisions[0]!;
    expect(decision.body.model).toBe("judge/judge-small");
    expect(decision.body.stream).toBe(true);
    expect(decision.body.store).toBe(false);
    expect(decision.body.tools).toEqual([]);
    // A bounded answer: the decision turn never inherits an unbounded output budget.
    expect(decision.body.max_output_tokens).toBe(1024);
    // ...and a reasoning model cannot spend that ceiling thinking before it answers.
    expect(decision.body.reasoning).toEqual({ effort: "low" });
    expect(JSON.stringify(decision.body)).toContain("luna/gpt-5.6-luna:high");
    expect(JSON.stringify(decision.body)).toContain("Refactor the parser");
    expect(JSON.stringify(decision.body)).not.toContain("exec_command");
    // No caller credential or conversation identity crosses into the decision turn.
    expect(decision.headers.get("authorization")).toBeNull();
    expect(decision.headers.get("chatgpt-account-id")).toBeNull();
    expect(decision.headers.get("x-codex-parent-thread-id")).toBeNull();
    expect(decision.options?.callerDirectAuth).toBeNull();
    expect(decision.options?.openAiSidecarAuth).toBeNull();
    expect(decision.options?.nativeCallerAuth).toBeNull();
    expect(decision.options?.turnAdmissionLease).toBeDefined();
    expect(decision.options?.sendBudget).toBeDefined();

    expect(targets).toHaveLength(1);
    expect(targets[0]!.model).toBe("luna/gpt-5.6-luna");
    expect((targets[0]!.reasoning as { effort?: string } | undefined)?.effort).toBe("high");
    expect(parentLog.jevDecision).toMatchObject({
      backend: "model",
      gate: "apply",
      selected: { provider: "luna", model: "gpt-5.6-luna", effort: "high" },
      usage: { inputTokens: 40, outputTokens: 6, totalTokens: 46 },
    });
  });

  test("an answer outside the allowlist fails open to the first eligible target", async () => {
    const parentLog: RequestLogContext = { model: "", provider: "" };
    const { response, targets } = await run(makeConfig(), () => completed('{"choice":"evil/model:max"}'), parentLog);
    expect(response.status).toBe(200);
    expect(targets[0]!.model).toBe("astra/gpt-6-astra");
    expect(parentLog.jevDecision).toMatchObject({ backend: "model", gate: "invalid" });
  });

  test("a failing decision model fails open with the http gate and the target still serves", async () => {
    const parentLog: RequestLogContext = { model: "", provider: "" };
    const { response, targets } = await run(makeConfig(), () => Response.json({ error: { message: "nope" } }, { status: 500 }), parentLog);
    expect(response.status).toBe(200);
    expect(targets).toHaveLength(1);
    expect(parentLog.jevDecision).toMatchObject({ backend: "model", gate: "http" });
  });

  test("an oversized decision response is rejected as malformed", async () => {
    const parentLog: RequestLogContext = { model: "", provider: "" };
    await run(makeConfig(), () => completed("x".repeat(70_000)), parentLog);
    expect(parentLog.jevDecision).toMatchObject({ backend: "model", gate: "malformed" });
  });
});

describe("decision-model turn guard in request preparation", () => {
  test("the decision effort is the declared floor, and omitted when no ladder is known", () => {
    const config = makeConfig();
    expect(jevDecisionReasoningEffort(config, "judge/judge-small")).toBe("low");
    config.providers.judge!.modelReasoningEfforts = { "judge-small": ["medium", "high"] };
    expect(jevDecisionReasoningEffort(config, "judge/judge-small")).toBe("medium");
    delete config.providers.judge!.modelReasoningEfforts;
    expect(jevDecisionReasoningEffort(config, "judge/judge-small")).toBeUndefined();
    expect(jevDecisionReasoningEffort(config, "nowhere/unknown")).toBeUndefined();
  });

  test("an internal decision call that names a JEV combo is refused before dispatch", async () => {
    const config = makeConfig();
    const request = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "jev-auto", stream: true, input: "x" }),
    });
    const response = await handleResponses(request, config, { model: "", provider: "" }, {
      internalDecisionCall: true,
      callerDirectAuth: null,
      openAiSidecarAuth: null,
      nativeCallerAuth: null,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("cannot be a JEV combo");
  });
});
