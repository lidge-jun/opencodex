import { expect, test } from "bun:test";
import { declaredAnthropicServerTools, hostedAdvisorSelection } from "../../src/claude/inbound-content-options";
import { clearComboTargetCooldowns } from "../../src/combos";
import { apiKeyAccountLogLabel } from "../../src/codex/account-label";
import { validateConfigCandidate } from "../../src/config/diagnostics";
import { messagesToResponsesTranslation } from "../../src/protocols/codecs/messages";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { protocolTraceForRequest } from "../../src/protocols/trace";
import type { RequestLogContext } from "../../src/server/request-log";
import { setAdvisorPlanFactory } from "../../src/server/responses/advisor-plan-slot";
import { createAdvisorGuard } from "../../src/server/responses/advisor-slot";
import { handleResponses as runResponsesCore } from "../../src/server/responses/core";
import { handleResponsesWithPolicyFallback } from "../../src/server/responses/policy-fallback";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { configureSharedSpendLedger, sharedSpendLedger, spendPolicyFromConfig } from "../../src/lib/spend-reservation-ledger";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";

const MODEL = "claude-opus-5";
const HOSTED_ADVISOR = { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-8", max_uses: 2 };
const CHOICE = { type: "tool", name: "advisor", disable_parallel_tool_use: true };
const BETA = "advisor-tool-2026-03-01";

function workerStream(blocks: Record<string, unknown>[], stopReason: string): Response {
  const events = [
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", content: [], model: MODEL,
      stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    ...blocks.flatMap((block, index) => {
      const toolUse = block.type === "tool_use";
      return [
        { type: "content_block_start", index, content_block: toolUse ? { ...block, input: {} } : block },
        ...(toolUse ? [{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }] : []),
        { type: "content_block_stop", index },
      ];
    }),
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

async function verifyHostedAdvisorChoice(scenario: string, route: "direct" | "combo" | "policy", countPreparation = false) {
  const sends: { provider: string; body: { tools?: Record<string, unknown>[]; tool_choice?: unknown }; beta: string | null }[] = [];
  const hostedCall = { type: "server_tool_use", id: "srvtoolu_fixture", name: "advisor", input: {} };
  const hostedResult = { type: "advisor_tool_result", tool_use_id: hostedCall.id,
    content: { type: "advisor_result", text: "Hosted advice.", stop_reason: "end_turn" } };
  const none = scenario === "direct encoder tool_choice none";
  const direct = scenario === "direct encoder refusal" || none;
  const scoped = scenario === "out of model scope";
  const optedOut = scenario === "forwarding disabled";
  const ambiguous = scenario === "ambiguous catalog";
  const capped = scenario === "first candidate capped" || scenario === "all candidates capped";
  const allCapped = scenario === "all candidates capped";
  const tools = [...(none ? [] : [HOSTED_ADVISOR]), ...(scoped || optedOut || ambiguous || none
    ? [{ name: ambiguous ? "advisor" : "read_file", input_schema: { type: "object" } }] : [])];
  const targets = ["blocked", "worker"].map(provider => ({ provider, model: MODEL }));
  const capture = (provider: string) => (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as (typeof sends)[number]["body"];
    sends.push({ provider, body, beta: new Headers(init?.headers).get("anthropic-beta") });
    if (sends.length > 1) return workerStream([{ type: "text", text: "Done." }], "end_turn");
    if ((scenario === "hosted exchange" || capped) && body.tools?.some(tool => tool.type === HOSTED_ADVISOR.type)) {
      return workerStream([hostedCall, hostedResult, { type: "text", text: "Done." }], "end_turn");
    }
    return workerStream([{ type: "tool_use", id: "toolu_fixture", name: "advisor", input: { question: "fixture_private_question" } }], "tool_use");
  }) as typeof fetch;
  const worker = { adapter: "anthropic" as const, authMode: "key" as const, apiKey: "fixture",
    baseUrl: "https://api.anthropic.com", models: [MODEL], liveModels: false, fetch: capture("worker") };
  const blockedApiKey = "fixture-first-candidate-key";
  const blockedIdentity = apiKeyAccountLogLabel("blocked", { reference: blockedApiKey });
  const workerIdentity = apiKeyAccountLogLabel("worker", { reference: worker.apiKey });
  const config: OcxConfig = {
    defaultProvider: "worker",
    cacheRetention: "none",
    claudeCode: { nativePassthrough: false },
    protocols: { rollout: { managedMessagesNative: false, directEncoders: direct } },
    ...(scoped ? { apiKeys: [{ id: "scoped", name: "Scoped fixture", key: "fixture",
      createdAt: "2026-01-01T00:00:00.000Z", allowedModels: [MODEL] }] } : {}),
    webSearchSidecar: { enabled: false },
    providers: {
      worker: { ...worker, ...(optedOut ? { forwardAdvisorTool: false } : {}),
        ...(capped ? { authMode: "local" as const, forwardAdvisorTool: true } : {}) },
      ...(route !== "direct" ? { blocked: { ...worker, apiKey: blockedApiKey, forwardAdvisorTool: capped, fetch: capture("blocked") } } : {}),
    },
    ...(route === "combo" ? { combos: { waterfall: { strategy: "failover", targets } } } : {}),
    ...(route === "policy" ? { routingProfiles: { waterfall: { candidates: targets } } } : {}),
  };
  let consultations = 0;
  let preflightRuns = 0;
  const plan = {
    consult: async () => {
      consultations++;
      return { content: "Fixture advice.", isError: false };
    },
    formatUnavailable: () => "Unavailable",
  };
  setAdvisorPlanFactory(config, async () => ({
    ...plan,
    tool: { name: "advisor", description: "Proxy Advisor", parameters: { type: "object", properties: {} }, advisor: true },
    preflightInject: async () => { preflightRuns++; return false; },
    attachGuard: parsed => { parsed._advisorGuard = createAdvisorGuard(plan); },
  }));
  try {
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const requestBody = { model: route === "direct" ? `worker/${MODEL}` : `${route}/waterfall`,
      max_tokens: 64, stream: direct, thinking: { type: "disabled" }, tools,
      tool_choice: none ? { type: "none" } : CHOICE, messages: [{ role: "user", content: "Fixture." }] };
    if (countPreparation || capped) {
      const preparations: string[] = [];
      const request = new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json", "anthropic-beta": BETA },
        body: JSON.stringify({ ...messagesToResponsesTranslation(requestBody).body, stream: true }),
      });
      const options = {
        inboundWire: "anthropic" as const,
        anthropicServerTools: declaredAnthropicServerTools(requestBody),
        anthropicHostedAdvisorSelection: hostedAdvisorSelection(requestBody),
        ...(capped ? { sendBudget: createRequestExecutionBudget(undefined, undefined, {
          hasCapturedSpendCeiling: target => target?.identityId === blockedIdentity
            || (allCapped && target?.identityId === workerIdentity),
          charge: () => true, refund: () => {},
        }) } : {}),
      };
      const response = route === "combo" ? await runResponsesCore(request, config, logCtx, options)
        : await handleResponsesWithPolicyFallback(request, config, logCtx, options, {
          runCore: (req, candidateConfig, context, options) => {
            preparations.push(options?.policyFallbackCandidate?.provider ?? "initial");
            return runResponsesCore(req, candidateConfig, context, options);
          },
        });
      const body = await response.text();
      if (route === "policy") {
        expect(preparations).toEqual(ambiguous ? ["initial"] : ["initial", "worker"]);
        expect(logCtx.routeDecision?.selected.provider).toBe("blocked");
      }
      expect(sends.map(send => send.provider)).toEqual(ambiguous || allCapped ? [] : ["worker"]);
      expect(response.status, body).toBe(ambiguous || allCapped ? 400 : 200);
      if (ambiguous) expect(body).toContain("ambiguous");
      if (allCapped) expect(body).toContain("token spend ceiling");
      if (capped && !allCapped) expect(sends[0]?.body).toMatchObject({ tools: [HOSTED_ADVISOR], tool_choice: CHOICE });
      expect(consultations).toBe(0);
      expect(preflightRuns).toBe(0);
      return;
    }
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": BETA },
      body: JSON.stringify(requestBody),
    }), config, logCtx, scoped ? { requestId: crypto.randomUUID(), start: Date.now(),
      admission: { kind: "configured", keyId: "scoped", source: "bearer" } } : undefined);
    const body = await response.text();
    if (route === "policy") expect(logCtx.routeDecision?.selected.provider).toBe("blocked");
    if (route === "combo") {
      expect(logCtx.attempts?.map(attempt => attempt.provider)).toEqual(
        ambiguous ? ["blocked"] : ["blocked", "worker"],
      );
    }
    expect(consultations).toBe(0);
    if (!none) expect(preflightRuns).toBe(0);
    if (scoped || optedOut || ambiguous) {
      expect(response.status, body).toBe(400);
      expect(sends).toHaveLength(0);
      expect(JSON.parse(body)).toMatchObject({ type: "error", error: { type: "invalid_request_error",
        message: expect.stringContaining(ambiguous ? "ambiguous" : "unavailable") } });
      return;
    }
    expect(sends.map(send => send.provider)).toEqual(["worker"]);
    if (!none) {
      expect(sends[0]?.body).toMatchObject({ tools: [HOSTED_ADVISOR], tool_choice: CHOICE });
      expect(sends[0]?.beta?.split(",").map(beta => beta.trim())).toContain(BETA);
    }
    if (scenario === "hosted exchange") {
      expect(response.status).toBe(200);
      const blocks = JSON.parse(body).content;
      const resultIndex = blocks.findIndex((block: { type: string }) => block.type === "advisor_tool_result");
      expect(resultIndex).toBeGreaterThan(0);
      expect(blocks[resultIndex]).toEqual(hostedResult);
      expect(blocks[resultIndex - 1]).toMatchObject({ ...hostedCall, id: blocks[resultIndex].tool_use_id });
    } else {
      const error = { type: "error", error: { type: "api_error", code: "undeclared_tool_call" } };
      expect(response.status).toBe(direct ? 200 : 502);
      if (direct) {
        expect(protocolTraceForRequest(logCtx, logCtx.attempts)?.responsePath).toEqual(["messages", "ir", "messages"]);
        expect(body).toContain("event: error\n");
        expect(body).not.toContain("event: message_stop\n");
        const frames = body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
        expect(frames.at(-1)).toMatchObject(error);
        expect(frames.some(frame => frame.content_block?.type === "tool_use" && frame.content_block.name === "advisor")).toBe(false);
      } else {
        expect(JSON.parse(body)).toMatchObject(error);
      }
      expect(body).not.toContain("toolu_fixture");
      expect(body).not.toContain("fixture_private_question");
    }
  } finally {
    setAdvisorPlanFactory(config, null);
  }
}

test.each([
  ...([
    ["hosted exchange", "direct"], ["ordinary tool call", "direct"], ["direct encoder refusal", "direct"],
    ["direct encoder tool_choice none", "direct"], ["out of model scope", "direct"],
    ["forwarding disabled", "direct"], ["ambiguous catalog", "direct"],
    ["hosted exchange", "combo"], ["forwarding disabled", "combo"], ["ambiguous catalog", "combo"],
    ["hosted exchange", "policy"], ["forwarding disabled", "policy"], ["ambiguous catalog", "policy"],
  ] as const).map(([scenario, route]) => [scenario, route, "Messages"] as const),
  ["ambiguous catalog", "policy", "counted core"], ["hosted exchange", "policy", "counted core"],
  ["first candidate capped", "combo", "counted core"], ["all candidates capped", "combo", "counted core"],
  ["first candidate capped", "policy", "counted core"], ["all candidates capped", "policy", "counted core"],
] as const)(
  "translated Messages handles Advisor with %s (route=%s, entry=%s)", (scenario, route, entry) =>
    withHostedAdvisorSpendHome(() => verifyHostedAdvisorChoice(scenario, route, entry === "counted core")));

async function withHostedAdvisorSpendHome(run: () => Promise<void>): Promise<void> {
  const home = createTempHome("ocx-hosted-advisor-choice-");
  try {
    const release = acquireOwnedSpendHome();
    try { await run(); }
    finally { release(); }
  } finally { home.remove(); }
}

test.each([
  ["explicit", "capped key"], ["optional", "capped key"],
  ["explicit", "extra credential"], ["optional", "extra credential"],
  ["explicit", "ordinary header"], ["optional", "ordinary header"],
] as const)("local-mode Anthropic gateway honors %s hosted Advisor admission (%s)", (mode, scenario) =>
  withHostedAdvisorSpendHome(async () => {
    const apiKey = "fixture-local-gateway-key";
    const headers: Record<string, string> | undefined = scenario === "extra credential" ? { "Api-Key": "fixture-extra-key" }
      : scenario === "ordinary header" ? { "x-gateway-region": "fixture-region" } : undefined;
    const sends: { body: Record<string, unknown>; headers: Headers }[] = [];
    const config: OcxConfig = {
      port: 0, defaultProvider: "gateway", spend: scenario === "capped key" ? { identity: { maxTokens: 1 } } : {},
      claudeCode: { nativePassthrough: false }, protocols: { rollout: { managedMessagesNative: false } },
      providers: { gateway: { adapter: "anthropic", authMode: "local", apiKey, baseUrl: "https://gateway.invalid",
        forwardAdvisorTool: true, models: [MODEL], liveModels: false, headers,
        fetch: (async (_url: unknown, init?: RequestInit) => {
          sends.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
          return workerStream([{ type: "text", text: "Done." }], "end_turn");
        }) as typeof fetch,
      } },
    };
    expect(validateConfigCandidate(config).ok).toBe(true);
    configureSharedSpendLedger(spendPolicyFromConfig(config.spend));
    const log: RequestLogContext = { model: "", provider: "" };
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "anthropic-beta": BETA },
      body: JSON.stringify({ model: `gateway/${MODEL}`, max_tokens: 64, tools: [HOSTED_ADVISOR],
        tool_choice: mode === "explicit" ? CHOICE : undefined, messages: [{ role: "user", content: "Fixture." }] }),
    }), config, log, { requestId: crypto.randomUUID(), start: Date.now() });
    const body = await response.text();
    const withheld = scenario !== "ordinary header";
    if (mode === "explicit" && withheld) {
      expect(response.status, body).toBe(400);
      expect(body).toContain(scenario === "capped key" ? "token spend ceiling" : "ambiguous upstream credentials");
      expect(sends).toHaveLength(0);
    } else {
      expect(response.status, body).toBe(200);
      expect(sends).toHaveLength(1);
      expect(sends[0]!.headers.get("x-api-key")).toBe(apiKey);
      if (withheld) {
        expect(sends[0]!.body.tools ?? []).not.toContainEqual(expect.objectContaining(HOSTED_ADVISOR));
        expect(sends[0]!.headers.get("anthropic-beta") ?? "").not.toContain(BETA);
        if (scenario === "extra credential") expect(sends[0]!.headers.get("api-key")).toBe("fixture-extra-key");
      } else {
        expect(sends[0]!.body.tools).toContainEqual(expect.objectContaining(HOSTED_ADVISOR));
        expect(sends[0]!.headers.get("anthropic-beta")).toContain(BETA);
        expect(sends[0]!.headers.get("x-gateway-region")).toBe("fixture-region");
      }
      expect(log.accountLogLabel).toBeUndefined();
    }
  }));

test.each(["default", "inherited"] as const)("translated preflight honors the %s budget's captured pool policy", budget =>
  withHostedAdvisorSpendHome(async () => {
    const unlimited = spendPolicyFromConfig({}, undefined, ["worker"]);
    const limited = spendPolicyFromConfig({ pool: { maxTokens: 1 } }, undefined, ["worker"]);
    configureSharedSpendLedger(unlimited);
    const ledger = sharedSpendLedger();
    expect(ledger.reserve({ sendId: "fixture-prior-send", scopes: { poolId: "worker" },
      inputTokens: 2, outputCeilingTokens: 0, alreadySent: true }).reserved).toBe(true);
    expect(ledger.settle("fixture-prior-send", { inputTokens: 2, outputTokens: 0 })).toBe(true);
    const requestBody = { model: `worker/${MODEL}`, max_tokens: 64, tools: [HOSTED_ADVISOR],
      tool_choice: CHOICE, messages: [{ role: "user", content: "Fixture." }] };
    const toolsAtWire: unknown[] = [];
    const config: OcxConfig = { port: 0, defaultProvider: "worker", cacheRetention: "none", providers: { worker: {
      adapter: "anthropic", authMode: "key", apiKey: "fixture-worker-key", baseUrl: "https://api.anthropic.com",
      models: [MODEL], liveModels: false, fetch: (async (_url: unknown, init?: RequestInit) => {
        toolsAtWire.push(JSON.parse(String(init?.body)).tools);
        return workerStream([{ type: "text", text: "Done." }], "end_turn");
      }) as typeof fetch,
    } } };
    const response = await runResponsesCore(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", "anthropic-beta": BETA },
      body: JSON.stringify({ ...messagesToResponsesTranslation(requestBody).body, stream: true }),
    }), config, { model: "", provider: "" }, {
      inboundWire: "anthropic", anthropicServerTools: declaredAnthropicServerTools(requestBody),
      anthropicHostedAdvisorSelection: hostedAdvisorSelection(requestBody),
      ...(budget === "inherited" ? { sendBudget: createRequestExecutionBudget(undefined, undefined, {
        spendAdmissionPolicy: limited, hasCapturedSpendCeiling: () => false,
        charge: () => true, refund: () => {},
      }) } : {}),
      onRequestBodyParsed: () => {
        if (budget === "default") configureSharedSpendLedger(limited);
        expect(ledger.exhausted("pool", "worker")).toBe(budget === "default");
      },
    });
    expect(response.status, await response.text()).toBe(budget === "default" ? 200 : 429);
    expect(toolsAtWire).toEqual(budget === "default" ? [[HOSTED_ADVISOR]] : []);
  }));

test.each([
  ["policy", "key", "optional"], ["policy", "local", "optional"], ["policy", "local", "explicit"],
  ["policy", "key", "snapshot only"], ["combo", "local", "optional"], ["combo", "local", "explicit"],
] as const)("default Messages %s fallback to %s preserves hosted Advisor admission (%s)", (route, nextAuth, mode) =>
  withHostedAdvisorSpendHome(async () => {
    clearComboTargetCooldowns();
    const explicit = mode === "explicit";
    const sends: { provider: string; body: Record<string, unknown>; headers: Headers }[] = [];
    const provider = (name: string, authMode: "key" | "local") => ({
      adapter: "anthropic" as const, authMode, apiKey: `fixture-${name}-key`,
      baseUrl: `https://${name}.invalid`, models: [MODEL], liveModels: false,
      forwardAdvisorTool: name === "worker" || mode !== "snapshot only",
      fetch: (async (_url: unknown, init?: RequestInit) => {
        sends.push({ provider: name, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
        if (name === "worker") return workerStream([{ type: "text", text: "Done." }], "end_turn");
        // Reload after the first candidate's request has already been serialized and sent.
        configureSharedSpendLedger(spendPolicyFromConfig({}));
        return Response.json({ type: "error", error: { type: "rate_limit_error", message: "Fixture throttled" } }, { status: 429 });
      }) as typeof fetch,
    });
    const targets = ["capped", "worker"].map(name => ({ provider: name, model: MODEL }));
    const config: OcxConfig = {
      port: 0, defaultProvider: "capped", spend: { identity: { maxTokens: 100_000 } },
      claudeCode: { nativePassthrough: false }, protocols: { rollout: { managedMessagesNative: false } },
      webSearchSidecar: { enabled: false }, providers: { capped: provider("capped", "key"), worker: provider("worker", nextAuth) },
      ...(route === "policy" ? { routingProfiles: { waterfall: { candidates: targets } } }
        : { combos: { waterfall: { strategy: "failover", targets } } }),
    };
    configureSharedSpendLedger(spendPolicyFromConfig(config.spend));
    const ciphertext = "EqQBCkYIBRgCIiQ5ZjE0-fixture-ciphertext";
    const messages = [
      { role: "user", content: "Fixture." },
      { role: "assistant", content: [
        { type: "server_tool_use", id: "srvtoolu_fixture", name: "advisor", input: {} },
        { type: "advisor_tool_result", tool_use_id: "srvtoolu_fixture",
          content: { type: "advisor_redacted_result", encrypted_content: ciphertext } },
        { type: "text", text: "Earlier answer." },
      ] },
      { role: "user", content: "Continue." },
    ];
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "anthropic-beta": BETA },
      body: JSON.stringify({ model: `${route}/waterfall`, max_tokens: 64, stream: false, tools: [{ name: "Read", input_schema: { type: "object" } }, HOSTED_ADVISOR],
        tool_choice: explicit ? CHOICE : undefined, messages }),
    }), config, logCtx, { requestId: crypto.randomUUID(), start: Date.now() });
    const body = await response.text();
    expect(response.status, body).toBe(explicit ? 400 : 200);
    expect(logCtx.attempts?.map(attempt => attempt.provider)).toEqual(["capped", "worker"]);
    if (explicit) expect(body).toContain("token spend ceiling");
    expect(sends.map(send => send.provider)).toEqual(explicit ? [] : ["capped", "worker"]);
    for (const wire of sends) {
      const tools = wire.body.tools as { type?: string }[];
      expect(tools.map(tool => tool.type ?? "function"), wire.provider).toEqual(["function"]);
      expect(wire.headers.get("anthropic-beta") ?? "").not.toContain(BETA);
      expect(JSON.stringify(wire.body)).not.toContain(ciphertext);
    }
  }));
