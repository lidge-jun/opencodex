/**
 * #7298: a combo that re-picks its target in the middle of a tool loop handed DeepSeek a bare
 * `function_call` (issued by a GPT turn that left no reasoning item), and DeepSeek's thinking mode
 * refused every such request with HTTP 400. Two layers now cover it:
 *  - a tool-output continuation stays on the lane's previous target while it is selectable;
 *  - when a switch is unavoidable (failover), each strict serializer makes the foreign history
 *    acceptable: a plaintext reasoning placeholder on the DeepSeek Responses and Chat wires,
 *    an intact tool_use/tool_result pair with no fabricated thinking for Anthropic.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import {
  clearResponseStateForTests,
  flushResponseState,
  responseStatePersistPendingForTests,
} from "../../src/responses/state";
import { handleResponses } from "../../src/server/responses";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { COMBO_TOOL_LOOP_PIN_REASON, isToolLoopContinuation } from "../../src/server/responses/combo-tool-loop-pin";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type Item = Record<string, unknown>;

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
let releaseSpendHome: (() => void) | undefined;

function resetState(): void {
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearReasoningReplayCacheForTests();
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-combo-tool-loop-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-combo-tool-loop-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  resetState();
  clearResponseStateForTests();
});

afterEach(async () => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  let responseStatePending = true;
  try {
    for (const server of servers.splice(0)) await server.stop(true);
    await flushResponseState();
    responseStatePending = responseStatePersistPendingForTests();
  } finally {
    clearResponseStateForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) removeTreeWithRetry(testDir);
    resetState();
  }
  expect(responseStatePending).toBe(false);
});

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
}

const baseUrl = (server: ReturnType<typeof Bun.serve>, suffix = "/v1"): string =>
  `${server.url.toString().replace(/\/$/, "")}${suffix}`;

function provider(adapter: string, url: string, extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter, baseUrl: url, allowPrivateNetwork: true, authMode: "key", apiKey: `key-${adapter}`, ...extra };
}

const strictResponses = (url: string): OcxProviderConfig => provider("openai-responses", url, {
  preserveResponsesReasoningContent: true,
  requiresAdjacentResponsesToolResults: true,
  statelessResponses: true,
});

const DEEPSEEK_REFUSAL = "The `reasoning_text` in the thinking mode must be passed back to the API.";

/** DeepSeek's thinking-mode rule: every assistant tool-call turn carries readable reasoning. */
function deepSeekRefusal(input: Item[]): Response | undefined {
  let turnHasReasoning = false;
  for (const item of input) {
    const assistant = item.type === "reasoning" || item.type === "function_call"
      || (item.type === "message" && item.role === "assistant");
    if (!assistant) { turnHasReasoning = false; continue; }
    if (item.type === "reasoning") {
      const content = item.content as Array<{ type?: string; text?: string }> | undefined;
      turnHasReasoning = !!content?.some(part => part.type === "reasoning_text" && !!part.text);
    }
    if (item.type === "function_call" && !turnHasReasoning) {
      return Response.json({ error: { message: DEEPSEEK_REFUSAL, type: "invalid_request_error", code: "invalid_request_error" } }, { status: 400 });
    }
  }
  return undefined;
}

function responsesBody(model: string, output: Item[]): Item {
  return {
    id: `resp-${model}-${crypto.randomUUID()}`,
    object: "response",
    status: "completed",
    model,
    output,
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  };
}

const answer = (text: string): Item => ({
  id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const issuedCall: Item = { id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "get_weather", arguments: "{}" };
const busy = () => Response.json({ error: { type: "server_error", code: "upstream_server_error", message: "busy" } }, { status: 500 });

const tools = [{ type: "function", name: "get_weather", description: "Get weather", parameters: { type: "object", properties: {} } }];
const userMessage = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
/** The #7298 continuation: a GPT turn's bare call (no reasoning item) and its result. */
const bareContinuation: Item[] = [
  userMessage("weather in Seoul?"),
  { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
  { type: "function_call_output", call_id: "call_1", output: "rain" },
];

function combo(providers: OcxConfig["providers"], targets: Array<{ provider: string; model: string }>, extra: Record<string, unknown> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: Object.keys(providers)[0]!,
    providers,
    combos: { auto: { strategy: "failover", targets, ...extra } },
  } as OcxConfig;
}

async function post(config: OcxConfig, input: unknown, headers: Record<string, string> = {}, logCtx: RequestLogContext = { model: "", provider: "" }): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "combo/auto", input, tools, stream: false, store: false }),
  }), config, logCtx);
}

describe("isToolLoopContinuation", () => {
  test("only a request that ends in a tool output resumes a turn", () => {
    expect(isToolLoopContinuation({ input: bareContinuation })).toBe(true);
    expect(isToolLoopContinuation({ input: [...bareContinuation, userMessage("thanks")] })).toBe(false);
    expect(isToolLoopContinuation({ input: [{ type: "custom_tool_call_output", call_id: "p", output: "ok" }] })).toBe(true);
    expect(isToolLoopContinuation({ input: "hello" })).toBe(false);
    expect(isToolLoopContinuation({ messages: [{ role: "user", content: "x" }, { role: "tool", content: "y" }] })).toBe(true);
  });
});

describe("combo tool-loop continuation safety (#7298)", () => {
  test("a Sol-issued bare tool call that fails over to DeepSeek Responses is accepted, not 400", async () => {
    const sol = serve(busy);
    const deepseekBodies: Item[] = [];
    const deepseek = serve(async request => {
      const body = await request.json() as Item;
      deepseekBodies.push(body);
      return deepSeekRefusal(body.input as Item[])
        ?? Response.json(responsesBody("deepseek-flash", [answer("It is raining.")]));
    });
    const config = combo({
      primary: provider("openai-responses", baseUrl(sol)),
      strict: strictResponses(baseUrl(deepseek)),
    }, [{ provider: "primary", model: "gpt-6.1-sol" }, { provider: "strict", model: "deepseek-flash" }]);

    const response = await post(config, bareContinuation);

    expect(await response.text()).toContain("It is raining.");
    expect(response.status).toBe(200);
    const wire = deepseekBodies[0]!.input as Item[];
    expect(wire.map(item => item.type)).toEqual(["message", "reasoning", "function_call", "function_call_output"]);
    expect(wire[1]!.content).toEqual([{ type: "reasoning_text", text: " " }]);
  });

  test("a tool-output continuation stays on the target that issued the call; the next user turn re-picks", async () => {
    let solHits = 0;
    const sol = serve(async request => {
      solHits += 1;
      const body = await request.json() as Item;
      const input = body.input as Item[];
      return Response.json(responsesBody("gpt-6.1-sol", input.at(-1)?.type === "function_call_output" ? [answer("Rain today.")] : [issuedCall]));
    });
    let deepseekHits = 0;
    const deepseek = serve(async request => {
      deepseekHits += 1;
      const body = await request.json() as Item;
      return deepSeekRefusal(body.input as Item[])
        ?? Response.json(responsesBody("deepseek-flash", [answer("You're welcome.")]));
    });
    // Round-robin with stickyLimit 1 moves to the other target after every success, which is
    // exactly the re-pick that broke #7298.
    const config = combo({
      primary: provider("openai-responses", baseUrl(sol)),
      strict: strictResponses(baseUrl(deepseek)),
    }, [{ provider: "primary", model: "gpt-6.1-sol" }, { provider: "strict", model: "deepseek-flash" }], { strategy: "round-robin", stickyLimit: 1 });
    const lane = { "thread-id": "thread-7298" };

    const first = await post(config, [userMessage("weather in Seoul?")], lane);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("get_weather");

    const continuationLog: RequestLogContext = { model: "", provider: "" };
    const continuation = await post(config, bareContinuation, lane, continuationLog);
    expect(continuation.status).toBe(200);
    expect(await continuation.text()).toContain("Rain today.");
    expect(solHits).toBe(2);
    expect(deepseekHits).toBe(0);
    expect(continuationLog.routeDecision?.selected?.reason).toBe(COMBO_TOOL_LOOP_PIN_REASON);

    // A new user turn is not pinned; the strict target accepts the foreign history it inherits.
    const nextTurn = await post(config, [
      ...bareContinuation,
      answer("Rain today."),
      userMessage("thanks"),
    ], lane);
    expect(nextTurn.status).toBe(200);
    expect(await nextTurn.text()).toContain("You're welcome.");
    expect(deepseekHits).toBe(1);
  });

  test("a continuation on another lane is not pinned to this lane's target", async () => {
    let solHits = 0;
    const sol = serve(() => {
      solHits += 1;
      return Response.json(responsesBody("gpt-6.1-sol", [issuedCall]));
    });
    let deepseekHits = 0;
    const deepseek = serve(async request => {
      deepseekHits += 1;
      const body = await request.json() as Item;
      return deepSeekRefusal(body.input as Item[]) ?? Response.json(responsesBody("deepseek-flash", [answer("ok")]));
    });
    const config = combo({
      primary: provider("openai-responses", baseUrl(sol)),
      strict: strictResponses(baseUrl(deepseek)),
    }, [{ provider: "primary", model: "gpt-6.1-sol" }, { provider: "strict", model: "deepseek-flash" }], { strategy: "round-robin", stickyLimit: 1 });

    await (await post(config, [userMessage("go")], { "thread-id": "lane-a" })).text();
    const other = await post(config, bareContinuation, { "thread-id": "lane-b" });

    expect(other.status).toBe(200);
    expect(solHits).toBe(1);
    expect(deepseekHits).toBe(1);
  });

  test("a pinned target that fails mid-loop fails over, and the strict target gets replayable history", async () => {
    let solFails = false;
    const sol = serve(() => solFails ? busy() : Response.json(responsesBody("gpt-6.1-sol", [issuedCall])));
    const deepseek = serve(async request => {
      const body = await request.json() as Item;
      return deepSeekRefusal(body.input as Item[]) ?? Response.json(responsesBody("deepseek-flash", [answer("Failover answer.")]));
    });
    const config = combo({
      primary: provider("openai-responses", baseUrl(sol)),
      strict: strictResponses(baseUrl(deepseek)),
    }, [{ provider: "primary", model: "gpt-6.1-sol" }, { provider: "strict", model: "deepseek-flash" }]);
    const lane = { "thread-id": "thread-failover" };

    await (await post(config, [userMessage("weather?")], lane)).text();
    solFails = true;
    const continuation = await post(config, bareContinuation, lane);

    expect(continuation.status).toBe(200);
    expect(await continuation.text()).toContain("Failover answer.");
  });

  test("DeepSeek on the Chat wire receives the reasoning_content placeholder for a foreign call", async () => {
    const sol = serve(busy);
    let chatBody: { messages?: Item[] } | undefined;
    const deepseek = serve(async request => {
      chatBody = await request.json() as { messages?: Item[] };
      return Response.json({
        id: "chatcmpl-1", object: "chat.completion", model: "deepseek-v4-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "Chat answer." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    });
    const config = combo({
      primary: provider("openai-responses", baseUrl(sol)),
      strict: provider("openai-chat", baseUrl(deepseek)),
    }, [{ provider: "primary", model: "gpt-6.1-sol" }, { provider: "strict", model: "deepseek-v4-flash" }]);

    const response = await post(config, bareContinuation);

    expect(response.status).toBe(200);
    const assistant = chatBody?.messages?.find(message => message.role === "assistant" && Array.isArray(message.tool_calls));
    expect(assistant?.reasoning_content).toBe(" ");
  });

  test("Anthropic receives the foreign call as an intact tool_use/tool_result pair with no fabricated thinking", async () => {
    const sol = serve(busy);
    let anthropicBody: { messages?: Array<{ role: string; content: unknown }> } | undefined;
    const anthropic = serve(async request => {
      anthropicBody = await request.json() as typeof anthropicBody;
      return Response.json({
        id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "Claude answer." }], stop_reason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 3 },
      });
    });
    const config = combo({
      primary: provider("openai-responses", baseUrl(sol)),
      claudex: provider("anthropic", baseUrl(anthropic, ""), { proxy: "direct" }),
    }, [{ provider: "primary", model: "gpt-6.1-sol" }, { provider: "claudex", model: "claude-sonnet-4-5" }]);

    const response = await post(config, bareContinuation);

    expect(response.status).toBe(200);
    const messages = anthropicBody?.messages ?? [];
    const assistant = messages.find(message => message.role === "assistant");
    const blocks = assistant?.content as Array<{ type: string; id?: string }>;
    expect(blocks.map(block => block.type)).toEqual(["tool_use"]);
    const toolResult = messages.at(-1)?.content as Array<{ type: string; tool_use_id?: string }>;
    expect(toolResult[0]).toMatchObject({ type: "tool_result", tool_use_id: blocks[0]!.id });
  });
});

