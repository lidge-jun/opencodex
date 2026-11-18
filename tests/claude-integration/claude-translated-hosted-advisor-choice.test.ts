import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { protocolTraceForRequest } from "../../src/protocols/trace";
import type { RequestLogContext } from "../../src/server/request-log";
import { setAdvisorPlanFactory } from "../../src/server/responses/advisor-plan-slot";
import { createAdvisorGuard } from "../../src/server/responses/advisor-slot";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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

async function verifyForcedHostedAdvisorChoice(scenario: string) {
  const sends: { body: { tools?: Record<string, unknown>[]; tool_choice?: unknown }; beta: string | null }[] = [];
  const hostedCall = { type: "server_tool_use", id: "srvtoolu_fixture", name: "advisor", input: {} };
  const hostedResult = { type: "advisor_tool_result", tool_use_id: hostedCall.id,
    content: { type: "advisor_result", text: "Hosted advice.", stop_reason: "end_turn" } };
  const direct = scenario === "direct encoder refusal";
  const scoped = scenario === "out of model scope";
  const optedOut = scenario === "forwarding disabled";
  const ambiguous = scenario === "ambiguous catalog";
  const tools = [HOSTED_ADVISOR, ...(scoped || optedOut || ambiguous
    ? [{ name: ambiguous ? "advisor" : "read_file", input_schema: { type: "object" } }] : [])];
  const config: OcxConfig = {
    defaultProvider: "worker",
    cacheRetention: "none",
    claudeCode: { nativePassthrough: false },
    protocols: { rollout: { managedMessagesNative: false, directEncoders: direct } },
    ...(scoped ? { apiKeys: [{ id: "scoped", name: "Scoped fixture", key: "fixture",
      createdAt: "2026-01-01T00:00:00.000Z", allowedModels: [MODEL] }] } : {}),
    webSearchSidecar: { enabled: false },
    providers: { worker: { adapter: "anthropic", authMode: "key", apiKey: "fixture",
      baseUrl: "https://api.anthropic.com", models: [MODEL], liveModels: false,
      ...(optedOut ? { forwardAdvisorTool: false } : {}),
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as (typeof sends)[number]["body"];
        sends.push({ body, beta: new Headers(init?.headers).get("anthropic-beta") });
        if (sends.length > 1) return workerStream([{ type: "text", text: "Done." }], "end_turn");
        if (scenario === "hosted exchange" && body.tools?.some(tool => tool.type === HOSTED_ADVISOR.type)) {
          return workerStream([hostedCall, hostedResult, { type: "text", text: "Done." }], "end_turn");
        }
        return workerStream([{ type: "tool_use", id: "toolu_fixture", name: "advisor", input: { question: "fixture_private_question" } }], "tool_use");
      }) as typeof fetch } },
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
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": BETA },
      body: JSON.stringify({ model: `worker/${MODEL}`, max_tokens: 64, stream: direct,
        tools, tool_choice: CHOICE, messages: [{ role: "user", content: "Fixture." }] }),
    }), config, logCtx, scoped ? { requestId: crypto.randomUUID(), start: Date.now(),
      admission: { kind: "configured", keyId: "scoped", source: "bearer" } } : undefined);
    const body = await response.text();
    if (scoped || optedOut || ambiguous) {
      expect({ status: response.status, workerSends: sends.length, consultations, preflightRuns })
        .toEqual({ status: 400, workerSends: 0, consultations: 0, preflightRuns: 0 });
      expect(JSON.parse(body)).toMatchObject({ type: "error", error: { type: "invalid_request_error",
        message: expect.stringContaining(ambiguous ? "ambiguous" : "unavailable") } });
      return;
    }
    expect({
      advisorTools: sends[0]?.body.tools,
      choice: sends[0]?.body.tool_choice,
      hostedBeta: sends[0]?.beta?.split(",").some(beta => beta.trim() === BETA) ?? false,
      consultations,
      preflightRuns,
      workerSends: sends.length,
    }).toEqual({ advisorTools: [HOSTED_ADVISOR], choice: CHOICE, hostedBeta: true, consultations: 0, preflightRuns: 0, workerSends: 1 });
    if (scenario === "hosted exchange") {
      expect(response.status).toBe(200);
      expect(JSON.parse(body).content).toContainEqual(hostedResult);
    } else {
      const error = { type: "error", error: { type: "api_error", code: "undeclared_tool_call" } };
      expect(response.status).toBe(direct ? 200 : 502);
      if (direct) {
        expect(protocolTraceForRequest(logCtx, logCtx.attempts)?.responsePath).toEqual(["messages", "ir", "messages"]);
        expect(body).toContain("event: error\n");
        expect(body).not.toContain("event: message_stop\n");
        const frames = body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
        expect(frames.at(-1)).toMatchObject(error);
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

test.each(["hosted exchange", "ordinary tool call", "direct encoder refusal", "out of model scope", "forwarding disabled", "ambiguous catalog"])(
  "translated Messages handles a forced hosted Advisor choice with %s", async scenario => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-hosted-advisor-choice-"));
    try {
      process.env.OPENCODEX_HOME = home;
      const release = acquireOwnedSpendHome();
      try {
        await verifyForcedHostedAdvisorChoice(scenario);
      } finally {
        release();
      }
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });
