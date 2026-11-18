import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleClaudeMessages } from "../../src/server/claude-messages";
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
    ...blocks.flatMap((content_block, index) => [
      { type: "content_block_start", index, content_block },
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

test.each(["hosted exchange", "ordinary tool call"])("translated Messages keeps the hosted Advisor selection with a worker %s", async workerReply => {
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-hosted-advisor-choice-"));
  process.env.OPENCODEX_HOME = home;
  const release = acquireOwnedSpendHome();
  const sends: { body: { tools?: Record<string, unknown>[]; tool_choice?: unknown }; beta: string | null }[] = [];
  const hostedCall = { type: "server_tool_use", id: "srvtoolu_fixture", name: "advisor", input: {} };
  const hostedResult = { type: "advisor_tool_result", tool_use_id: hostedCall.id,
    content: { type: "advisor_result", text: "Hosted advice.", stop_reason: "end_turn" } };
  const config: OcxConfig = {
    defaultProvider: "worker",
    cacheRetention: "none",
    claudeCode: { nativePassthrough: false },
    protocols: { rollout: { managedMessagesNative: false } },
    webSearchSidecar: { enabled: false },
    providers: { worker: { adapter: "anthropic", authMode: "key", apiKey: "fixture",
      baseUrl: "https://api.anthropic.com", models: [MODEL], liveModels: false,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as (typeof sends)[number]["body"];
        sends.push({ body, beta: new Headers(init?.headers).get("anthropic-beta") });
        if (sends.length > 1) return workerStream([{ type: "text", text: "Done." }], "end_turn");
        if (workerReply === "hosted exchange" && body.tools?.some(tool => tool.type === HOSTED_ADVISOR.type)) {
          return workerStream([hostedCall, hostedResult, { type: "text", text: "Done." }], "end_turn");
        }
        return workerStream([{ type: "tool_use", id: "toolu_fixture", name: "advisor", input: { question: "Fixture?" } }], "tool_use");
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
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": BETA },
      body: JSON.stringify({ model: `worker/${MODEL}`, max_tokens: 64, stream: false,
        tools: [HOSTED_ADVISOR], tool_choice: CHOICE, messages: [{ role: "user", content: "Fixture." }] }),
    }), config, { model: "", provider: "" });
    const body = await response.json() as { content?: unknown[] };
    expect({
      advisorTools: sends[0]?.body.tools,
      choice: sends[0]?.body.tool_choice,
      hostedBeta: sends[0]?.beta?.split(",").some(beta => beta.trim() === BETA) ?? false,
      consultations,
      preflightRuns,
      workerSends: sends.length,
    }).toEqual({ advisorTools: [HOSTED_ADVISOR], choice: CHOICE, hostedBeta: true, consultations: 0, preflightRuns: 0, workerSends: 1 });
    if (workerReply === "hosted exchange") {
      expect(response.status).toBe(200);
      expect(body.content).toContainEqual(hostedResult);
    } else {
      expect(response.status).toBe(502);
      expect(JSON.stringify(body)).not.toContain("toolu_fixture");
    }
  } finally {
    setAdvisorPlanFactory(config, null);
    release();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
});
