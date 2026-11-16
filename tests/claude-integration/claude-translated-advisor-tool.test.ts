import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { declaredAnthropicServerTools, hasAnthropicOnlyServerTool, hasNativeOnlyTool, replayedAnthropicServerBlocks } from "../../src/claude/inbound-content-options";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { markProtocolEntry, protocolTraceForRequest } from "../../src/protocols/trace";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { RequestLogContext } from "../../src/server/request-log";
import { configureSharedSpendLedger, sharedSpendLedger, spendPolicyFromConfig } from "../../src/lib/spend-reservation-ledger";
import { setAdvisorPlanFactory } from "../../src/server/responses/advisor-plan-slot";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { handleResponses } from "../../src/server/responses/core";
import { responsesSpendTarget } from "../../src/server/responses/request-spend-target";
import type { AnthropicInstanceId } from "../../src/providers/anthropic-instance-id";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";
import { createAnthropicInstanceFixture, type AnthropicInstanceFixture } from "../helpers/anthropic-instance-fixture";
import { planAnthropicServerTools, withholdAdvisorServerTools } from "../../src/adapters/anthropic/advisor-tool";
import { webSearchPairFromItem } from "../../src/claude/outbound";

// Claude Code declares Anthropic's typed Advisor server tool (#8448). On the translated Messages
// lane it travels out of body to first-party Anthropic, or to a gateway that opts in with
// forwardAdvisorTool; its server_tool_use + advisor_tool_result come back and replay verbatim.
type Rec = Record<string, unknown>;
const MODEL = "claude-opus-5-5";
const ADVISOR = { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-8", max_uses: 2 };
const READ = { name: "Read", description: "read", input_schema: { type: "object", properties: {} } };
const BETA = "advisor-tool-2026-03-01";
const FIRST_PARTY = "https://api.anthropic.com";
const GATEWAY = "https://gateway.example.com";
const CIPHERTEXT = "EqQBCkYIBRgCIiQ5ZjE0-fixture-ciphertext";
const PLAIN = { type: "advisor_result", text: "Close the input channel first.", stop_reason: "end_turn" };
const REDACTED = { type: "advisor_redacted_result", encrypted_content: CIPHERTEXT };
const ERRORED = { type: "advisor_tool_result_error", error_code: "overloaded" };

let home: ReturnType<typeof createTempHome>;
let releaseSpend: (() => void) | undefined;
beforeAll(() => {
  home = createTempHome("ocx-advisor-server-tool-");
  releaseSpend = acquireOwnedSpendHome();
});
afterAll(() => {
  releaseSpend?.();
  home.remove();
});
// A refused child cools its combo target down; every case starts from a fresh waterfall.
beforeEach(() => {
  clearComboSelectionState(); clearComboTargetCooldowns(); clearComboRecallForTests(); clearKeyCooldowns();
});

const sse = (frames: Rec[]) => new Response(
  frames.map(f => `event: ${String(f.type)}\ndata: ${JSON.stringify(f)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } },
);
const START = { type: "message_start", message: { id: "msg_x", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } };
const text = (index: number, value: string): Rec[] => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text: value } },
  { type: "content_block_stop", index },
];
const end = (stopReason = "end_turn"): Rec[] => [
  { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];
const OK_TURN = [START, ...text(0, "ok"), ...end()];
const call = (index: number, id = "srvtoolu_adv1"): Rec[] => [
  { type: "content_block_start", index, content_block: { type: "server_tool_use", id, name: "advisor", input: {} } },
  { type: "content_block_stop", index },
];
const advisorTurn = (result: unknown): Rec[] => [
  START, ...text(0, "Let me check."), ...call(1),
  { type: "content_block_start", index: 2, content_block: { type: "advisor_tool_result", tool_use_id: "srvtoolu_adv1", content: result } },
  { type: "content_block_stop", index: 2 },
  ...text(3, "Done."), ...end(),
];

interface Wire { body: Rec; headers: Headers }
interface TurnOptions {
  baseUrl?: string; provider?: Rec; model?: string; stream?: boolean; direct?: boolean;
  messages?: unknown[]; tools?: unknown[]; frames?: Rec[]; gptFirst?: boolean; gptOnly?: boolean; nativeRollout?: boolean; requestId?: string;
  spend?: OcxConfig["spend"]; rootId?: string; policyDuringPlan?: OcxConfig["spend"]; proxyAdvisor?: boolean;
}

async function claudeTurn(options: TurnOptions = {}): Promise<{ wires: Wire[]; status: number; body: string; logCtx: RequestLogContext }> {
  const wires: Wire[] = [];
  const capture = (target: "anth" | "gpt") => (async (_input: unknown, init?: RequestInit) => {
    wires.push({ body: JSON.parse(String(init?.body)) as Rec, headers: new Headers(init?.headers) });
    if (target === "gpt") {
      return new Response(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "gpt ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    }
    return sse(options.frames ?? OK_TURN);
  }) as typeof globalThis.fetch;
  const anth = { provider: "anth", model: MODEL };
  const gpt = { provider: "gpt", model: "g" };
  const config = {
    port: 0, defaultProvider: "anth",
    spend: options.spend,
    claudeCode: { nativePassthrough: false },
    webSearchSidecar: { enabled: false },
    ...(options.direct || options.nativeRollout
      ? { protocols: { rollout: { directEncoders: options.direct === true, managedMessagesNative: options.nativeRollout === true } } } : {}),
    providers: {
      anth: { adapter: "anthropic", baseUrl: options.baseUrl ?? FIRST_PARTY, authMode: "key", apiKey: "sk-ant-fixture", models: [MODEL], fetch: capture("anth"), ...options.provider },
      gpt: { adapter: "openai-chat", baseUrl: "https://gpt.invalid/v1", authMode: "key", apiKey: "sk-fixture", models: ["g"], fetch: capture("gpt") },
    },
    combos: { waterfall: { strategy: "failover", targets: options.gptOnly ? [gpt] : options.gptFirst ? [gpt, anth] : [anth, gpt] } },
  } as unknown as OcxConfig;
  configureSharedSpendLedger(spendPolicyFromConfig(config.spend));
  if (options.proxyAdvisor || options.policyDuringPlan !== undefined) setAdvisorPlanFactory(config, async () => {
    if (options.policyDuringPlan !== undefined) {
      config.spend = options.policyDuringPlan;
      configureSharedSpendLedger(spendPolicyFromConfig(config.spend));
    }
    return options.proxyAdvisor ? {
      tool: { name: "advisor", description: "proxy advisor", parameters: { type: "object", properties: {} }, advisor: true },
      preflightInject: async () => false, attachGuard: () => {},
    } : null;
  });
  const logCtx: RequestLogContext = { model: "", provider: "" };
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": BETA,
        ...(options.rootId ? { "x-codex-parent-thread-id": options.rootId } : {}) },
      body: JSON.stringify({
        model: options.model ?? (options.direct ? `anth/${MODEL}` : "combo/waterfall"), max_tokens: 64, stream: options.stream ?? true,
        tools: options.tools ?? [READ, ADVISOR],
        messages: options.messages ?? [{ role: "user", content: "Plan the shutdown." }],
      }),
    }), config, logCtx, { requestId: options.requestId ?? `advisor-turn-${crypto.randomUUID()}`, start: Date.now() });
    return { wires, status: response.status, body: await response.text(), logCtx };
  } finally { setAdvisorPlanFactory(config, null); }
}

const toolTypes = (wire: Wire) => ((wire.body.tools ?? []) as Rec[]).map(tool => String(tool.type ?? "function"));
const betas = (wire: Wire) => (wire.headers.get("anthropic-beta") ?? "").split(",").map(value => value.trim()).filter(Boolean);
const frames = (body: string) => body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as Rec);

/** The client's content blocks, as Claude Code stores them for its next turn. */
function clientContent(body: string, stream: boolean): Rec[] {
  if (!stream) return (JSON.parse(body) as { content: Rec[] }).content;
  const blocks: Rec[] = [];
  const inputs: string[] = [];
  for (const frame of frames(body)) {
    const index = frame.index as number;
    const delta = frame.delta as Record<string, string> | undefined;
    if (frame.type === "content_block_start") blocks[index] = { ...(frame.content_block as Rec) };
    else if (delta?.type === "input_json_delta") inputs[index] = (inputs[index] ?? "") + delta.partial_json;
    else if (delta?.type === "text_delta") blocks[index]!.text = String(blocks[index]!.text) + delta.text;
  }
  return blocks.map((block, index) => inputs[index] ? { ...block, input: JSON.parse(inputs[index]!) } : block);
}

const followUp = (assistant: unknown[]) => [
  { role: "user", content: "Plan the shutdown." }, { role: "assistant", content: assistant }, { role: "user", content: "Go on." },
];

describe("hosted Advisor under the request's token spend policy", () => {
  const limit = { maxTokens: 100_000 };
  const replay = followUp([
    { type: "server_tool_use", id: "srvtoolu_adv1", name: "advisor", input: {} },
    { type: "advisor_tool_result", tool_use_id: "srvtoolu_adv1", content: REDACTED },
    { type: "text", text: "Earlier answer." },
  ]);
  for (const scope of ["root", "identity", "pool"] as const) for (const stream of [false, true]) {
    test(`${scope} ceiling withholds the optional declaration, replay and beta (stream=${stream})`, async () => {
      const rootId = `advisor-spend-${scope}-${stream}`;
      const beforePool = sharedSpendLedger().snapshot("pool", "anth")?.settled ?? 0;
      const result = await claudeTurn({ model: `anth/${MODEL}`, spend: { [scope]: limit }, rootId, stream,
        provider: { apiKey: `sk-ant-fixture-spend-${scope}-${stream}` }, messages: replay,
        tools: [READ, ADVISOR, { type: "web_search_20250305", name: "web_search" }] });
      expect(result.status, result.body).toBe(200);
      expect(result.body).toContain("ok");
      expect(result.wires).toHaveLength(1);
      const wire = result.wires[0]!;
      expect(toolTypes(wire)).toEqual(["function", "web_search_20250305"]);
      expect(betas(wire)).not.toContain(BETA);
      expect(JSON.stringify(wire.body)).not.toContain("srvtoolu_adv1");
      expect(JSON.stringify(wire.body)).not.toContain(CIPHERTEXT);
      expect(JSON.stringify(wire.body)).toContain("Earlier answer.");
      expect(protocolTraceForRequest(result.logCtx, result.logCtx.attempts)?.reasonCodes)
        .toContain("advisor-tool-withheld-by-spend-policy");
      // Read the actual provider credential identity assigned by auth; never invent a main label.
      expect(result.logCtx.accountLogLabel).toBeString();
      expect(result.logCtx.accountLogLabel).not.toBe("main");
      const id = scope === "root" ? rootId : scope === "identity" ? result.logCtx.accountLogLabel! : "anth";
      const settled = sharedSpendLedger().snapshot(scope, id);
      expect(settled).toBeDefined();
      expect(settled!.reserved).toBe(0);
      expect(settled!.unresolved).toBe(0);
      expect(settled!.settled - (scope === "pool" ? beforePool : 0)).toBe(6);
    });
  }

  for (const stream of [false, true]) test(`an identity ceiling captured before Combo account selection withholds Advisor (stream=${stream})`, async () => {
    const before = sharedSpendLedger().snapshot("pool", "anth")?.settled ?? 0;
    const result = await claudeTurn({ model: "combo/waterfall", spend: { identity: limit }, stream, messages: replay });
    expect(result.status, result.body).toBe(200);
    expect(result.body).toContain("ok");
    expect(result.wires).toHaveLength(1);
    expect(result.logCtx.accountLogLabel).toMatch(/^k[a-f0-9]{32}$/);
    expect(toolTypes(result.wires[0]!)).toEqual(["function"]);
    expect(betas(result.wires[0]!)).not.toContain(BETA);
    expect(JSON.stringify(result.wires[0]!.body)).not.toContain("srvtoolu_adv1");
    // Advisor withholding does not change the Combo's existing main-send accounting mode.
    const settled = sharedSpendLedger().snapshot("pool", "anth")!;
    expect([settled.settled - before, settled.reserved, settled.unresolved]).toEqual([6, 0, 0]);
  });

  test("an opted-in gateway's direct encoder withholds Advisor while keeping the main turn", async () => {
    const result = await claudeTurn({ baseUrl: GATEWAY, provider: { forwardAdvisorTool: true }, direct: true,
      spend: { pool: limit }, messages: replay });
    expect(result.status, result.body).toBe(200);
    expect(toolTypes(result.wires[0]!)).toEqual(["function"]);
    expect(betas(result.wires[0]!)).not.toContain(BETA);
    expect(JSON.stringify(result.wires[0]!.body)).not.toContain(CIPHERTEXT);
  });

  test("history alone cannot restore the Advisor beta under an enforced ceiling", async () => {
    const result = await claudeTurn({ model: `anth/${MODEL}`, spend: { pool: limit }, messages: replay, tools: [READ] });
    expect(result.status, result.body).toBe(200);
    expect(betas(result.wires[0]!)).not.toContain(BETA);
    expect(JSON.stringify(result.wires[0]!.body)).not.toContain("srvtoolu_adv1");
    expect(protocolTraceForRequest(result.logCtx, result.logCtx.attempts)?.reasonCodes)
      .toContain("advisor-tool-withheld-by-spend-policy");
  });

  test("a configured root ceiling without a root is not applicable", async () => {
    const result = await claudeTurn({ model: `anth/${MODEL}`, spend: { root: limit } });
    expect(result.status, result.body).toBe(200);
    expect(toolTypes(result.wires[0]!)).toContain("advisor_20260301");
    expect(betas(result.wires[0]!)).toContain(BETA);
  });

  for (const scope of ["identity", "pool"] as const) for (const initialLimited of [false, true]) for (const combo of [false, true]) {
    test(`captured ${scope} ceiling survives a live change (limited=${initialLimited}, combo=${combo})`, async () => {
      const result = await claudeTurn({ model: combo ? "combo/waterfall" : `anth/${MODEL}`,
        spend: initialLimited ? { [scope]: limit } : {}, policyDuringPlan: initialLimited ? {} : { [scope]: limit } });
      expect(result.status, result.body).toBe(200);
      expect(toolTypes(result.wires[0]!).includes("advisor_20260301")).toBe(!initialLimited);
      expect(betas(result.wires[0]!).includes(BETA)).toBe(!initialLimited);
    });
  }

  test("the independently budgeted proxy Advisor keeps its synthetic tool", async () => {
    const result = await claudeTurn({ model: `anth/${MODEL}`, spend: { pool: limit }, proxyAdvisor: true });
    expect(result.status, result.body).toBe(200);
    const advisors = (result.wires[0]!.body.tools as Rec[]).filter(tool => tool.name === "advisor");
    expect(advisors).toHaveLength(1);
    expect(advisors[0]).toHaveProperty("input_schema");
    expect(toolTypes(result.wires[0]!)).not.toContain("advisor_20260301");
    expect(betas(result.wires[0]!)).not.toContain(BETA);
  });
});

describe("advisor declarations on the translated Messages lane", () => {
  test("module: advisor is carried out of body and is not a native-only or Anthropic-only tool", () => {
    expect(declaredAnthropicServerTools({ tools: [READ, ADVISOR] })).toEqual([ADVISOR]);
    expect(hasNativeOnlyTool({ tools: [READ, ADVISOR] })).toBe(false);
    expect(hasAnthropicOnlyServerTool({ tools: [READ, ADVISOR] })).toBe(false);
    expect(hasNativeOnlyTool({ tools: [READ, { type: "bash_20250124", name: "bash" }] })).toBe(true);
  });

  // The combo judge marks children native-only only while the managed native Messages lane is on.
  test("with the native lane on, a combo whose only child is translated serves an advisor request", async () => {
    const { wires, status, body } = await claudeTurn({ nativeRollout: true, gptOnly: true });
    expect(status).toBe(200);
    expect(body).toContain("gpt ok");
    expect(wires).toHaveLength(1);
    expect(JSON.stringify(wires[0]!.body)).not.toContain("advisor");
  });

  test("with the native lane on, a refused native child falls back to its translated sibling", async () => {
    const refused = [START, { type: "error", error: { type: "overloaded_error", message: "fixture overloaded" } }];
    const { wires, status, body } = await claudeTurn({ nativeRollout: true, frames: refused });
    expect(status).toBe(200);
    expect(body).toContain("gpt ok");
    expect(wires).toHaveLength(2);
    expect(wires[0]!.body.tools).toContainEqual(ADVISOR);
    expect(JSON.stringify(wires[1]!.body)).not.toContain("advisor");
  });

  test("with the native lane off, a combo of translated children serves an advisor request", async () => {
    const { wires, status } = await claudeTurn({ baseUrl: GATEWAY });
    expect(status).toBe(200);
    expect(wires).toHaveLength(1);
  });

  test("a single translated route still serves an advisor request", async () => {
    const { wires, status } = await claudeTurn({ baseUrl: GATEWAY, direct: true });
    expect(status).toBe(200);
    expect(toolTypes(wires[0]!)).toEqual(["function"]);
  });

  test("api.anthropic.com receives advisor_20260301 as declared, with its beta", async () => {
    const { wires, status } = await claudeTurn({ tools: [READ, { ...ADVISOR, cache_control: { type: "ephemeral" } }] });
    expect(status).toBe(200);
    const tools = wires[0]!.body.tools as Rec[];
    expect(tools.map(tool => tool.name)).toEqual(["Read", "advisor"]);
    expect(tools[1]).toMatchObject(ADVISOR);
    expect(betas(wires[0]!)).toContain(BETA);
  });

  test("an Anthropic-compatible gateway does not receive it by default", async () => {
    const { wires } = await claudeTurn({ baseUrl: GATEWAY });
    expect(toolTypes(wires[0]!)).toEqual(["function"]);
    expect(betas(wires[0]!)).not.toContain(BETA);
  });

  test("forwardAdvisorTool: true opts a gateway in; false keeps it off api.anthropic.com", async () => {
    const optedIn = (await claudeTurn({ baseUrl: GATEWAY, provider: { forwardAdvisorTool: true } })).wires[0]!;
    expect(toolTypes(optedIn)).toEqual(["function", "advisor_20260301"]);
    expect(betas(optedIn)).toContain(BETA);
    const optedOut = (await claudeTurn({ provider: { forwardAdvisorTool: false } })).wires[0]!;
    expect(toolTypes(optedOut)).toEqual(["function"]);
    expect(betas(optedOut)).not.toContain(BETA);
  });

  test("a GPT leg carries no advisor declaration", async () => {
    const { wires } = await claudeTurn({ gptFirst: true });
    expect(JSON.stringify(wires[0]!.body)).not.toContain("advisor");
  });
});

describe("advisor blocks reach the Claude client and replay verbatim", () => {
  for (const [lane, options] of [["bridge stream", {}], ["bridge JSON", { stream: false }], ["direct encoder", { direct: true }]] as const) {
    test(`${lane}: server_tool_use advisor + advisor_tool_result, unchanged`, async () => {
      for (const result of [PLAIN, REDACTED, ERRORED]) {
        const { body, status } = await claudeTurn({ ...options, frames: advisorTurn(result) });
        expect(status).toBe(200);
        const blocks = clientContent(body, !("stream" in options));
        expect(blocks.map(block => block.type)).toEqual(["text", "server_tool_use", "advisor_tool_result", "text"]);
        expect(blocks[1]).toEqual({ type: "server_tool_use", id: "srvtoolu_adv1", name: "advisor", input: {} });
        expect(blocks[2]).toEqual({ type: "advisor_tool_result", tool_use_id: "srvtoolu_adv1", content: result });
        // An Advisor call is not a web search.
        const usage = "stream" in options ? (JSON.parse(body) as { usage: Rec }).usage
          : frames(body).find(frame => frame.type === "message_delta")!.usage as Rec;
        expect(usage.server_tool_use).toBeUndefined();
      }
    });
  }

  test("an advisor result without its call, or with a non-empty call input, is dropped", async () => {
    const orphan = [START, ...text(0, "Let me check."),
      { type: "content_block_start", index: 1, content_block: { type: "advisor_tool_result", tool_use_id: "srvtoolu_adv1", content: PLAIN } },
      { type: "content_block_stop", index: 1 }, ...text(2, "Done."), ...end()];
    const withInput = advisorTurn(PLAIN);
    withInput.splice(5, 0, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"q\":\"x\"}" } });
    const malformed = advisorTurn({ type: "advisor_result" });
    for (const turn of [orphan, withInput, malformed]) {
      const { body } = await claudeTurn({ frames: turn });
      // Nothing separates the two texts once the exchange is dropped, so they share one block.
      const blocks = clientContent(body, true);
      expect(blocks.every(block => block.type === "text")).toBe(true);
      expect(blocks.map(block => block.text).join("")).toBe("Let me check.Done.");
    }
  });

  for (const [label, result] of [["advisor_result", PLAIN], ["advisor_redacted_result", REDACTED], ["advisor_tool_result_error", ERRORED]] as const) {
    test(`a replayed ${label} pair reaches api.anthropic.com in place and an opted-in gateway only`, async () => {
      const turn1 = clientContent((await claudeTurn({ frames: advisorTurn(result) })).body, true);
      const replay = followUp(turn1);
      const first = (await claudeTurn({ messages: replay })).wires[0]!;
      const assistant = (first.body.messages as { content: Rec[] }[])[1]!.content;
      expect(assistant).toEqual([
        { type: "text", text: "Let me check." },
        { type: "server_tool_use", id: "srvtoolu_adv1", name: "advisor", input: {} },
        { type: "advisor_tool_result", tool_use_id: "srvtoolu_adv1", content: result },
        { type: "text", text: "Done." },
      ]);
      expect(betas(first)).toContain(BETA);
      const optedIn = JSON.stringify((await claudeTurn({ baseUrl: GATEWAY, provider: { forwardAdvisorTool: true }, messages: replay })).wires[0]!.body);
      expect(optedIn).toContain("srvtoolu_adv1");
      for (const other of [
        (await claudeTurn({ baseUrl: GATEWAY, messages: replay })).wires[0]!,
        (await claudeTurn({ gptFirst: true, messages: replay })).wires[0]!,
      ]) {
        expect(JSON.stringify(other.body)).not.toContain("srvtoolu_adv1");
        expect(JSON.stringify(other.body)).toContain("Done.");
      }
    });
  }

  test("a replayed advisor pair outside the documented shapes stays dropped", () => {
    const pair = (input: unknown, content: unknown) => ({ messages: followUp([
      { type: "server_tool_use", id: "srvtoolu_adv1", name: "advisor", input },
      { type: "advisor_tool_result", tool_use_id: "srvtoolu_adv1", content },
      { type: "text", text: "Done." },
    ]) });
    expect(replayedAnthropicServerBlocks(pair({}, PLAIN))?.get("text:Done.")).toHaveLength(2);
    for (const [input, content] of [
      [{ question: "x" }, PLAIN],
      [{}, { type: "advisor_result" }],
      [{}, { type: "advisor_result", text: 7 }],
      [{}, { type: "advisor_redacted_result" }],
      [{}, { type: "advisor_redacted_result", encrypted_content: CIPHERTEXT, extra: true }],
      [{}, { type: "advisor_result", text: "x", stop_reason: 1 }],
      [{}, { type: "advisor_tool_result_error" }],
      [{}, { type: "something_else", text: "x" }],
      [{}, [PLAIN]],
      [{}, "advice"],
    ] as const) {
      expect(replayedAnthropicServerBlocks(pair(input, content))).toBeUndefined();
    }
    // A non-srvtoolu_ id or a result before its call never replays either.
    expect(replayedAnthropicServerBlocks({ messages: followUp([
      { type: "server_tool_use", id: "toolu_adv1", name: "advisor", input: {} },
      { type: "advisor_tool_result", tool_use_id: "toolu_adv1", content: PLAIN },
      { type: "text", text: "Done." },
    ]) })).toBeUndefined();
  });

  test("the redacted ciphertext never reaches the request log", async () => {
    const requestId = `advisor-log-${crypto.randomUUID()}`;
    const { status } = await claudeTurn({ frames: advisorTurn(REDACTED), requestId });
    expect(status).toBe(200);
    const rows = getRequestLogEntries().filter(row => row.requestId === requestId);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(CIPHERTEXT);
  });
});

describe("pause_turn with a pending advisor call", () => {
  test("the resend still carries the advisor declaration and its beta", async () => {
    const paused = [START, ...text(0, "Thinking it over."), ...call(1), ...end("pause_turn")];
    const turn1 = await claudeTurn({ frames: paused });
    expect(turn1.status).toBe(200);
    expect(toolTypes(turn1.wires[0]!)).toContain("advisor_20260301");
    const resend = await claudeTurn({ messages: [
      { role: "user", content: "Plan the shutdown." },
      { role: "assistant", content: clientContent(turn1.body, true) },
    ] });
    expect(resend.status).toBe(200);
    const tools = resend.wires[0]!.body.tools as Rec[];
    expect(tools.find(tool => tool.type === "advisor_20260301")).toMatchObject(ADVISOR);
    expect(betas(resend.wires[0]!)).toContain(BETA);
  });
});

describe("the proxy Advisor owns the advisor name for its turn", () => {
  async function coreTurn(proxyAdvisor: boolean, admissionScope?: { providers: string[]; models: string[] }): Promise<{ wire: Wire; reasons: readonly string[] }> {
    const wires: Wire[] = [];
    const config = {
      port: 0, defaultProvider: "anth", webSearchSidecar: { enabled: false },
      providers: { anth: { adapter: "anthropic", baseUrl: FIRST_PARTY, authMode: "key", apiKey: "sk-ant-fixture", models: [MODEL],
        fetch: (async (_input: unknown, init?: RequestInit) => {
          wires.push({ body: JSON.parse(String(init?.body)) as Rec, headers: new Headers(init?.headers) });
          return sse(OK_TURN);
        }) as typeof globalThis.fetch } },
    } as unknown as OcxConfig;
    if (proxyAdvisor) setAdvisorPlanFactory(config, async () => ({
      tool: { name: "advisor", description: "proxy advisor", parameters: { type: "object", properties: {} }, advisor: true },
      preflightInject: async () => false,
      attachGuard: () => {},
    }));
    const logCtx: { model: string; provider: string; attempts?: Parameters<typeof protocolTraceForRequest>[1] } = { model: "", provider: "" };
    // The Messages ingress marks its lane before handing the translated body to the core.
    markProtocolEntry(logCtx, { inbound: "messages", lane: "bridge" });
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `anth/${MODEL}`, stream: true, input: "Plan the shutdown.",
          tools: [{ type: "function", name: "Read", parameters: { type: "object", properties: {} } }] }),
      }), config, logCtx, { inboundWire: "anthropic", anthropicServerTools: [ADVISOR], ...(admissionScope ? { admissionScope } : {}) });
      expect(response.status).toBe(200);
      await response.text();
    } finally { setAdvisorPlanFactory(config, null); }
    expect(wires).toHaveLength(1);
    // The same projection the request log row stores.
    return { wire: wires[0]!, reasons: protocolTraceForRequest(logCtx, logCtx.attempts)?.reasonCodes ?? [] };
  }

  test("an active proxy Advisor shadows the declared tool and records why", async () => {
    const { wire, reasons } = await coreTurn(true);
    const tools = wire.body.tools as Rec[];
    expect(tools.filter(tool => tool.name === "advisor")).toHaveLength(1);
    expect(tools.find(tool => tool.name === "advisor")).toHaveProperty("input_schema");
    expect(toolTypes(wire)).not.toContain("advisor_20260301");
    expect(betas(wire)).not.toContain(BETA);
    expect(reasons).toContain("advisor-tool-shadowed-by-proxy-advisor");
  });

  test("with the proxy Advisor off the declared tool is forwarded", async () => {
    const { wire, reasons } = await coreTurn(false);
    expect(toolTypes(wire)).toEqual(["function", "advisor_20260301"]);
    expect(betas(wire)).toContain(BETA);
    expect(reasons).not.toContain("advisor-tool-shadowed-by-proxy-advisor");
  });

  // The Advisor's model runs server-side on the same provider: a scoped key may not reach a model
  // through it that the scope does not admit (the native lane refuses the same declaration).
  test("a declaration naming a model outside the caller's scope is not forwarded", async () => {
    const denied = await coreTurn(false, { providers: [], models: [MODEL] });
    expect(toolTypes(denied.wire)).toEqual(["function"]);
    expect(betas(denied.wire)).not.toContain(BETA);
    expect(denied.reasons).toContain("advisor-tool-outside-model-scope");
    const admitted = await coreTurn(false, { providers: [], models: [MODEL, ADVISOR.model] });
    expect(toolTypes(admitted.wire)).toEqual(["function", "advisor_20260301"]);
    expect(admitted.reasons).not.toContain("advisor-tool-outside-model-scope");
  });
});

describe("a shadowed turn stays shadowed on every leg", () => {
  const provider = { adapter: "anthropic" as const, baseUrl: FIRST_PARTY, apiKey: "k" };
  const run: Rec[] = [
    { type: "server_tool_use", id: "srvtoolu_adv1", name: "advisor", input: {} },
    { type: "advisor_tool_result", tool_use_id: "srvtoolu_adv1", content: PLAIN },
  ];
  test("withholding drops the declaration and the Advisor history, so a later leg without the synthetic tool adds neither", () => {
    const parsed: { _anthropicServerTools?: Rec[]; _anthropicServerReplay?: ReadonlyMap<string, readonly Rec[]> } = {
      _anthropicServerTools: [ADVISOR, { type: "web_search_20250305", name: "web_search" }],
      _anthropicServerReplay: new Map([["text:after", run]]),
    };
    expect(withholdAdvisorServerTools(parsed)).toBe(true);
    // The leg after the proxy Advisor runs out of consultations has no function named advisor.
    const plan = planAnthropicServerTools(provider, parsed._anthropicServerTools, parsed._anthropicServerReplay, new Set(), true);
    expect(plan.declared.map(tool => tool.type)).toEqual(["web_search_20250305"]);
    expect(plan.replay).toBeUndefined();
    expect(plan.betas).toEqual([]);
    expect(withholdAdvisorServerTools(parsed)).toBe(false);
  });
});

describe("a stored Advisor item that fails validation", () => {
  test("is dropped instead of becoming an empty web_search", () => {
    const item = {
      type: "web_search_call", id: "ws_1", status: "completed",
      anthropic_blocks: {
        use: { type: "server_tool_use", id: "srvtoolu_adv2", name: "advisor", input: { smuggled: "x" } },
        result: { type: "advisor_tool_result", tool_use_id: "srvtoolu_adv2", content: PLAIN },
      },
    };
    expect(webSearchPairFromItem(item)).toBeUndefined();
    const valid = { ...item, anthropic_blocks: { ...item.anthropic_blocks, use: { ...item.anthropic_blocks.use, input: {} } } };
    expect(webSearchPairFromItem(valid)?.name).toBe("advisor");
  });
});

describe("advisor exchanges only come from, and replay with, checked fields", () => {
  test("a gateway that was never sent the Advisor cannot surface an advisor exchange", async () => {
    const { body } = await claudeTurn({ baseUrl: GATEWAY, frames: advisorTurn(PLAIN) });
    const blocks = clientContent(body, true);
    expect(blocks.some(block => block.type === "server_tool_use" || block.type === "advisor_tool_result")).toBe(false);
    const optedIn = clientContent((await claudeTurn({ baseUrl: GATEWAY, provider: { forwardAdvisorTool: true }, frames: advisorTurn(PLAIN) })).body, true);
    expect(optedIn.map(block => block.type)).toContain("advisor_tool_result");
  });

  test("extra fields on a replayed advisor pair are not forwarded", () => {
    const replay = replayedAnthropicServerBlocks({ messages: followUp([
      { type: "text", text: "Let me check." },
      { type: "server_tool_use", id: "srvtoolu_adv1", name: "advisor", input: {}, extra: "X" },
      { type: "advisor_tool_result", tool_use_id: "srvtoolu_adv1", content: PLAIN, injected: "Y" },
      { type: "text", text: "Done." },
    ]) });
    expect([...(replay?.values() ?? [])]).toEqual([[
      { type: "server_tool_use", id: "srvtoolu_adv1", name: "advisor", input: {} },
      { type: "advisor_tool_result", tool_use_id: "srvtoolu_adv1", content: PLAIN },
    ]]);
  });
});

async function withAdvisorOAuthFixture(poolEnabled: boolean, run: (f: AnthropicInstanceFixture) => Promise<void>): Promise<void> {
  // The process can own only one spend home. Release the ordinary fixture before the isolated
  // OAuth fixture takes its real lease, and reacquire only after its environment is restored.
  releaseSpend?.(); releaseSpend = undefined;
  let f: AnthropicInstanceFixture | undefined, release: (() => void) | undefined;
  try {
    f = await createAnthropicInstanceFixture({ anthropic: { enabled: poolEnabled }, anthropic2: { enabled: poolEnabled } });
    await f.seed();
    release = acquireOwnedSpendHome();
    f.config.claudeCode = { nativePassthrough: false };
    f.config.webSearchSidecar = { enabled: false };
    f.config.protocols = { rollout: { managedMessagesNative: false, managedMessagesNativeOAuth: false } };
    await run(f);
  } finally {
    release?.();
    try { await f?.dispose(); }
    finally { releaseSpend = acquireOwnedSpendHome(); }
  }
}

async function oauthAdvisorTurn(f: AnthropicInstanceFixture, instance: AnthropicInstanceId, combo = false,
  expectedSlot = 1, duringPlan?: (log: RequestLogContext) => Promise<void>) {
  const wires: Wire[] = [];
  const logCtx: RequestLogContext = { provider: "", model: "" };
  Object.assign(f.config.providers[instance]!, { models: [f.model], fetch: (async (_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    f.ledger.record({ instance, accountId: f.ids[expectedSlot - 1]!, token: headers.get("authorization")?.replace(/^Bearer /, "") ?? "" });
    wires.push({ body: JSON.parse(String(init?.body)) as Rec, headers });
    return sse([{ ...START, message: { ...START.message, model: f.model } }, ...text(0, "ok"), ...end()]);
  }) as typeof fetch });
  f.config.combos = { waterfall: { strategy: "failover", targets: [{ provider: instance, model: f.model }] } };
  configureSharedSpendLedger(spendPolicyFromConfig(f.config.spend));
  if (duringPlan) setAdvisorPlanFactory(f.config, async () => { await duringPlan(logCtx); return null; });
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "anthropic-beta": BETA },
      body: JSON.stringify({ model: combo ? "combo/waterfall" : `${instance}/${f.model}`, max_tokens: 64, stream: false,
        tools: [READ, ADVISOR], messages: followUp([
          { type: "server_tool_use", id: "srvtoolu_adv1", name: "advisor", input: {} },
          { type: "advisor_tool_result", tool_use_id: "srvtoolu_adv1", content: REDACTED },
          { type: "text", text: "Earlier answer." },
        ]) }),
    }), f.config, logCtx, { requestId: `oauth-advisor-${crypto.randomUUID()}`, start: Date.now() });
    return { status: response.status, body: await response.text(), wires, logCtx };
  } finally { setAdvisorPlanFactory(f.config, null); }
}

describe("hosted Advisor with admitted Anthropic OAuth identities", () => {
  for (const instance of ["anthropic", "anthropic2"] as const) for (const poolEnabled of [false, true])
    for (const combo of [false, true]) for (const limited of [false, true]) {
      test(`${instance}, pool=${poolEnabled}, combo=${combo}, identity ceiling=${limited}`, async () => {
        await withAdvisorOAuthFixture(poolEnabled, async f => {
          f.config.spend = limited ? { identity: { maxTokens: 100_000 } } : {};
          const result = await oauthAdvisorTurn(f, instance, combo);
          expect(result.status, result.body).toBe(200);
          expect(result.body).toContain("ok");
          expect(result.wires).toHaveLength(1);
          expect(toolTypes(result.wires[0]!).includes("advisor_20260301")).toBe(!limited);
          expect(betas(result.wires[0]!).includes(BETA)).toBe(!limited);
          expect(JSON.stringify(result.wires[0]!.body).includes("srvtoolu_adv1")).toBe(!limited);
          expect(JSON.stringify(result.wires[0]!.body)).toContain("Earlier answer.");
          expect(result.logCtx.accountLogLabel).toBeUndefined(); // Keep existing OAuth log attribution.
          f.ledger.assertNoCrossSend();
          if (limited && !combo) {
            const identity = responsesSpendTarget(result.logCtx, instance).identityId;
            expect(identity).toMatch(/^o[a-f0-9]{6}$/);
            const spent = sharedSpendLedger().snapshot("identity", identity!)!;
            expect([spent.settled, spent.reserved, spent.unresolved]).toEqual([6, 0, 0]);
          }
        });
      });
    }

  test("target identity belongs to the admitted snapshot and keeps same-ID instances separate", async () => {
    await withAdvisorOAuthFixture(false, async f => {
      f.config.spend = { identity: { maxTokens: 100_000 } };
      const first = await oauthAdvisorTurn(f, "anthropic");
      expect(first.status, first.body).toBe(200);
      const firstIdentity = responsesSpendTarget(first.logCtx, "anthropic").identityId;
      let selectedIdentity: string | undefined;
      const second = await oauthAdvisorTurn(f, "anthropic2", false, 2, async log => {
        selectedIdentity = responsesSpendTarget(log, "anthropic2").identityId;
        expect(selectedIdentity).toMatch(/^o[a-f0-9]{6}$/);
        expect(selectedIdentity).not.toBe(firstIdentity);
        await f.store.setActiveAccount("anthropic2", f.ids[1]);
        // A new ambient active account cannot impersonate this request's admitted credential.
        expect(responsesSpendTarget(log, "anthropic2").identityId).toBe(selectedIdentity);
        expect(log.accountLogLabel).toBeUndefined();
      });
      expect(second.status, second.body).toBe(200);
      expect(second.wires).toHaveLength(1);
      expect(responsesSpendTarget(second.logCtx, "anthropic2").identityId).not.toBe(selectedIdentity);
      expect(toolTypes(second.wires[0]!)).toEqual(["function"]);
      expect(f.ledger.sends.map(send => [send.instance, send.accountId]))
        .toEqual([["anthropic", f.ids[0]], ["anthropic2", f.ids[1]]]);
    });
  });
});
