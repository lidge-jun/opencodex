/**
 * #7298: a combo that re-picks its target in the middle of a tool loop handed DeepSeek a bare
 * `function_call` (issued by a GPT turn that left no reasoning item), and DeepSeek's thinking mode
 * refused every such request with HTTP 400. Two layers now cover it:
 *  - a tool-output continuation stays on the lane's previous target while it is selectable;
 *  - when a switch is unavoidable (failover), each strict serializer makes the foreign history
 *    acceptable: a plaintext reasoning placeholder on the DeepSeek Responses and Chat wires,
 *    an intact tool_use/tool_result pair with no fabricated thinking for Anthropic.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearCachedProviderQuotas, setCachedProviderQuotaForTests } from "../../src/providers/quota-routing-cache";
import type { ProviderQuota } from "../../src/providers/quota-types";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import {
  clearResponseStateForTests,
  flushResponseState,
  responseStatePersistPendingForTests,
} from "../../src/responses/state";
import { handleResponses } from "../../src/server/responses";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import {
  COMBO_TOOL_LOOP_PIN_REASON, comboToolLoopLane, comboToolLoopRouteIdentity, isToolLoopContinuation,
} from "../../src/server/responses/combo-tool-loop-pin";
import { rememberComboForLane } from "../../src/server/responses/combo-session-recall";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { saveConfig } from "../../src/config";
import type { RouteResult } from "../../src/router";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { noteSubagentModelFailure, resetSubagentModelFallbackStateForTests } from "../../src/codex/subagent-model-fallback";
import * as requestPacing from "../../src/providers/request-pacing";
import * as coreAuth from "../../src/server/responses/core-auth";
import * as requestPrepare from "../../src/server/responses/request-prepare";
import { handleManagementAPI } from "../../src/server/management-api";
import { setLiveStateStoreConfig } from "../../src/lib/state-store-registrations";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { ManagementRequest } from "../helpers/management-auth";

type Item = Record<string, unknown>;

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
let releaseSpendHome: (() => void) | undefined;
let releaseHeldPacing: (() => void) | undefined;

function resetState(): void {
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearCachedProviderQuotas();
  clearReasoningReplayCacheForTests();
  resetSubagentModelFallbackStateForTests();
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
  releaseHeldPacing?.();
  releaseHeldPacing = undefined;
  mock.restore();
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
  }), config, logCtx, { admission: { kind: "loopback", source: "loopback" } });
}

/**
 * A subagent whose own model failed falls back to a quota-only Combo alias, which the router collapses
 * to one target. Its first turn runs while the primary target's quota is spent, so the backup target
 * issues the tool call. `firstModel` is the subagent model of that first turn, and `beforeFirstTurn`
 * runs once the config exists. Later calls to `subagent` request `home/m0` unless they name a model.
 */
async function collapsedSubagentTurn(lane: string, setup: {
  alias?: string;
  firstModel?: string;
  beforeFirstTurn?: (cfg: OcxConfig) => void;
} = {}) {
  const { alias = "auto-model", firstModel = "home/m0" } = setup;
  const sent: string[] = [];
  const home = serve(() => { sent.push("home"); return Response.json(responsesBody("m0", [answer("wrong target")])); });
  const primary = serve(() => { sent.push("primary"); return Response.json(responsesBody("m1", [answer("wrong target")])); });
  const backup = serve(async request => {
    sent.push("backup");
    const body = await request.json() as { input: Item[] };
    return Response.json(responsesBody("m2", [
      body.input.at(-1)?.type === "function_call_output" ? answer("Rain today.") : issuedCall,
    ]));
  });
  const cfg = combo({
    home: provider("openai-responses", baseUrl(home)),
    primary: provider("openai-responses", baseUrl(primary)),
    backup: provider("openai-responses", baseUrl(backup)),
  }, [{ provider: "primary", model: "m1" }, { provider: "backup", model: "m2" }],
  { quotaOnlyFallback: true, allowMeteredTargets: true, alias });
  cfg.subagentModelFallback = [alias];
  noteSubagentModelFailure(firstModel, "429", cfg);
  const subagent = (input: unknown, model = "home/m0") => handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-openai-subagent": "collab_spawn", "thread-id": lane },
    body: JSON.stringify({ model, input, tools, stream: false, store: false }),
  }), cfg, { model: "", provider: "" }, { admission: { kind: "loopback", source: "loopback" } });
  setup.beforeFirstTurn?.(cfg);
  setCachedProviderQuotaForTests("primary", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
  expect(await (await subagent([userMessage("weather?")], firstModel)).text()).toContain("get_weather");
  clearCachedProviderQuotas();
  return { cfg, sent, subagent };
}

/** A quota-only Combo whose only target, backup/m2, issues a tool call and answers its result. */
function singleTargetQuotaOnlyCombo() {
  const sent: string[] = [];
  const backup = serve(async request => {
    sent.push("backup");
    const body = await request.json() as { input: Item[] };
    return Response.json(responsesBody("m2", [
      body.input.at(-1)?.type === "function_call_output" ? answer("Rain today.") : issuedCall,
    ]));
  });
  const cfg = combo({ backup: provider("openai-responses", baseUrl(backup)) }, [{ provider: "backup", model: "m2" }],
    { quotaOnlyFallback: true, allowMeteredTargets: true });
  return { cfg, sent };
}

/**
 * Redirects backup/m2 to another provider only while a Combo child prepares, so the child settles on that
 * provider while the parent and the send-time checks see backup/m2 again.
 */
function redirectWhileChildPrepares(cfg: OcxConfig, to: string): void {
  const prepare = requestPrepare.prepareResponsesRequest;
  spyOn(requestPrepare, "prepareResponsesRequest").mockImplementation(async (...args) => {
    if (!args[0].options.comboAttempt) return prepare(...args);
    cfg.blockedModelRedirects = { "backup/m2": to };
    try {
      return await prepare(...args);
    } finally {
      delete cfg.blockedModelRedirects;
    }
  });
}

/**
 * Holds every pacing wait of `provider` until `release` runs. `held` resolves once a send waits there,
 * and fails when the pending request settles first.
 */
function holdPacingWaits(provider: string) {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  releaseHeldPacing = release;
  let reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const wait = requestPacing.waitForProviderRequestSlot;
  spyOn(requestPacing, "waitForProviderRequestSlot").mockImplementation(async (...args) => {
    if (args[0] === provider) {
      reached();
      await released;
    }
    return wait(...args);
  });
  const held = async (waiting: Promise<Response>): Promise<void> => {
    const first = await Promise.race([entered.then(() => undefined), waiting]);
    if (first) throw new Error(`request settled before pacing: ${first.status}`);
  };
  return { held, release };
}

/** Deletes a Combo through `DELETE /api/combos`, which reconciles live state as on a running server. */
async function deleteComboThroughManagement(cfg: OcxConfig, id: string): Promise<void> {
  const url = `http://localhost/api/combos?id=${id}`;
  const deleted = await handleManagementAPI(new ManagementRequest(url, { method: "DELETE" }), new URL(url), cfg, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
  expect(deleted?.status).toBe(200);
}

describe("isToolLoopContinuation", () => {
  test("only a request that ends in a tool output resumes a turn", () => {
    expect(isToolLoopContinuation({ input: bareContinuation })).toBe(true);
    expect(isToolLoopContinuation({ input: [...bareContinuation, userMessage("thanks")] })).toBe(false);
    expect(isToolLoopContinuation({ input: [{ type: "custom_tool_call_output", call_id: "p", output: "ok" }] })).toBe(true);
    expect(isToolLoopContinuation({ input: "hello" })).toBe(false);
    expect(isToolLoopContinuation({ messages: [{ role: "user", content: "x" }, { role: "tool", content: "y" }] })).toBe(true);
  });

  test("developer items after the tool results still resume the turn", () => {
    const developer = { type: "message", role: "developer", content: [{ type: "input_text", text: "context" }] };
    expect(isToolLoopContinuation({ input: [...bareContinuation, developer, developer] })).toBe(true);
    expect(isToolLoopContinuation({ input: [userMessage("hi"), developer] })).toBe(false);
    expect(isToolLoopContinuation({ input: [developer] })).toBe(false);
    expect(isToolLoopContinuation({ messages: [{ role: "tool", content: "y" }, { role: "developer", content: "z" }] })).toBe(true);
  });

  test("the pinned route identity follows the Codex account and account mode the route resolves to", () => {
    const route = { providerName: "openai", modelId: "gpt-5", provider: { adapter: "openai-responses", baseUrl: "https://api.example/v1" } } as RouteResult;
    expect(comboToolLoopRouteIdentity({ ...route, codexAccountId: "account-a" }))
      .toBe(comboToolLoopRouteIdentity({ ...route, codexAccountId: "account-a" }));
    expect(comboToolLoopRouteIdentity({ ...route, codexAccountId: "account-a" }))
      .not.toBe(comboToolLoopRouteIdentity({ ...route, codexAccountId: "account-b" }));
    expect(comboToolLoopRouteIdentity({ ...route, codexAccountMode: "direct" }))
      .not.toBe(comboToolLoopRouteIdentity({ ...route, codexAccountMode: "pool" }));
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

  test("quota-only failover keeps a tool continuation on its serving target after the primary recovers", async () => {
    let primaryExhausted = true;
    let backupExhausted = false;
    const sent: string[] = [];
    const exhausted = () => Response.json({
      error: { code: "insufficient_quota", message: "Quota exhausted" },
    }, { status: 429 });
    const primary = serve(() => {
      sent.push("primary");
      return primaryExhausted ? exhausted() : Response.json(responsesBody("m1", [answer("wrong target")]));
    });
    const backup = serve(async request => {
      sent.push("backup");
      const body = await request.json() as { input: Item[] };
      return backupExhausted ? exhausted() : Response.json(responsesBody("m2", [
        body.input.at(-1)?.type === "function_call_output" ? answer("Rain today.") : issuedCall,
      ]));
    });
    const config = combo({
      primary: provider("openai-responses", baseUrl(primary)),
      backup: provider("openai-responses", baseUrl(backup)),
    }, [{ provider: "primary", model: "m1" }, { provider: "backup", model: "m2" }], { quotaOnlyFallback: true, allowMeteredTargets: true });
    const lane = { "thread-id": "quota-tool-continuation" };
    expect(await (await post(config, [userMessage("weather?")], lane)).text()).toContain("get_weather");
    primaryExhausted = false;
    clearComboTargetCooldowns("auto");
    expect(await (await post(config, bareContinuation, lane)).text()).toContain("Rain today.");
    backupExhausted = true;
    const stopped = await post(config, bareContinuation, lane);
    expect(stopped.status).toBe(429);
    await stopped.text();
    const retried = await post(config, bareContinuation, lane);
    expect(retried.status).toBe(429);
    expect(await retried.json()).toMatchObject({ error: { code: "combo_tool_target_quota_exhausted" } });
    expect(sent).toEqual(["primary", "backup", "backup", "backup"]);
  });

  test("a quota-only continuation without its serving lane makes no upstream send", async () => {
    const sent: string[] = [];
    const primary = serve(() => {
      sent.push("primary");
      return Response.json(responsesBody("m1", [issuedCall]));
    });
    const backup = serve(() => {
      sent.push("backup");
      return Response.json(responsesBody("m2", [answer("Wrong turn")]));
    });
    const cfg = combo({
      primary: provider("openai-responses", baseUrl(primary)),
      backup: provider("openai-responses", baseUrl(backup)),
    }, [{ provider: "primary", model: "m1" }, { provider: "backup", model: "m2" }],
    { quotaOnlyFallback: true, allowMeteredTargets: true });
    expect(await (await post(cfg, [userMessage("weather?")], { "thread-id": "lost-lane" })).text()).toContain("get_weather");
    const result = await post(cfg, bareContinuation);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
    const redirected = { ...cfg, blockedModelRedirects: { "primary/m1": "backup/m2" } };
    const rerouted = await post(redirected, bareContinuation, { "thread-id": "lost-lane" });
    expect(rerouted.status).toBe(409);
    await rerouted.text();
    expect(sent).toEqual(["primary"]);
  });

  for (const [label, backupProvider] of [
    ["", (url: string) => provider("openai-responses", url)],
    [" through a per-model adapter", (url: string) => provider("openai-chat", url, { modelAdapters: { m2: "openai-responses" } })],
  ] as const) test(`a router-collapsed quota-only continuation stays on the target that issued the call${label}`, async () => {
    const sent: string[] = [];
    const home = serve(() => {
      sent.push("home");
      return Response.json(responsesBody("m0", [answer("wrong target")]));
    });
    const primary = serve(() => {
      sent.push("primary");
      return Response.json(responsesBody("m1", [answer("wrong target")]));
    });
    const backup = serve(async request => {
      sent.push("backup");
      const body = await request.json() as { input: Item[] };
      return Response.json(responsesBody("m2", [
        body.input.at(-1)?.type === "function_call_output" ? answer("Rain today.") : issuedCall,
      ]));
    });
    const cfg = combo({
      home: provider("openai-responses", baseUrl(home)),
      primary: provider("openai-responses", baseUrl(primary)),
      backup: backupProvider(baseUrl(backup)),
    }, [{ provider: "primary", model: "m1" }, { provider: "backup", model: "m2" }],
    { quotaOnlyFallback: true, allowMeteredTargets: true, alias: "auto-model" });
    cfg.subagentModelFallback = ["auto-model"];
    noteSubagentModelFailure("home/m0", "429", cfg);
    const subagent = (input: unknown, lane: string) => handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "x-openai-subagent": "collab_spawn", "thread-id": lane },
      body: JSON.stringify({ model: "home/m0", input, tools, stream: false, store: false }),
    }), cfg, { model: "", provider: "" }, { admission: { kind: "loopback", source: "loopback" } });

    setCachedProviderQuotaForTests("primary", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
    expect(await (await subagent([userMessage("weather?")], "collapsed-lane")).text()).toContain("get_weather");
    clearCachedProviderQuotas();
    expect(await (await subagent(bareContinuation, "collapsed-lane")).text()).toContain("Rain today.");
    const lost = await subagent(bareContinuation, "unknown-lane");
    expect(lost.status).toBe(409);
    expect(await lost.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
    expect(sent).toEqual(["backup", "backup"]);
  });

  for (const [label, change] of [
    ["an earlier target is disabled", (cfg: OcxConfig) => { cfg.providers.primary!.disabled = true; }],
    ["the model lock is on", (cfg: OcxConfig) => { cfg.combos!.auto!.preserveFallbackModel = true; }],
  ] as const) test(`a router-collapsed quota-only continuation reaches the target that issued the call when ${label}`, async () => {
    const { cfg, sent, subagent } = await collapsedSubagentTurn(`collapsed-${label}`);
    change(cfg);
    const resumed = await subagent(bareContinuation);
    expect(await resumed.text()).toContain("Rain today.");
    expect(sent).toEqual(["backup", "backup"]);
  });

  test("a pinned subagent continuation passes the scoped fallback policy of the subagent rewrite", async () => {
    const { cfg, sent, subagent } = await collapsedSubagentTurn("pinned-policy");
    cfg.providers.primary!.disabled = true;
    // The operator now forbids provider hops away from the subagent's own model.
    cfg.fallback = { routes: { "home/m0": { provider: false } } };
    const refused = await subagent(bareContinuation);
    expect(await refused.json()).toMatchObject({ error: { code: "fallback_refused" } });
    expect(sent).toEqual(["backup"]);
  });

  test("a pinned subagent continuation refuses once its serving target is disabled, even after the subagent model recovers", async () => {
    const { cfg, sent, subagent } = await collapsedSubagentTurn("pinned-disabled");
    resetSubagentModelFallbackStateForTests();
    cfg.providers.backup!.disabled = true;
    for (const attempt of ["first", "retry"]) {
      const refused = await subagent(bareContinuation);
      expect(refused.status, attempt).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
    }
    expect(sent).toEqual(["backup"]);
  });

  test("a pinned subagent continuation refuses when its serving row changes while the send waits for pacing", async () => {
    const { cfg, sent, subagent } = await collapsedSubagentTurn("pinned-row-change");
    const elsewhere = serve(() => { sent.push("elsewhere"); return Response.json(responsesBody("m2", [answer("wrong endpoint")])); });
    const pacing = holdPacingWaits("backup");
    const waiting = subagent(bareContinuation);
    await pacing.held(waiting);
    // Same provider name, model, scope and consent, but a different endpoint.
    cfg.providers.backup = { ...cfg.providers.backup!, baseUrl: baseUrl(elsewhere) };
    pacing.release();
    const refused = await waiting;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
    expect(sent).toEqual(["backup"]);
  });

  test("a quota-only continuation refuses when its serving row changes while the Combo child waits for pacing", async () => {
    const { cfg, sent } = singleTargetQuotaOnlyCombo();
    const elsewhere = serve(() => { sent.push("elsewhere"); return Response.json(responsesBody("m2", [answer("wrong endpoint")])); });
    const lane = { "thread-id": "child-row-change" };
    expect(await (await post(cfg, [userMessage("weather?")], lane)).text()).toContain("get_weather");
    const pacing = holdPacingWaits("backup");
    const waiting = post(cfg, bareContinuation, lane);
    await pacing.held(waiting);
    // Same provider name, model, scope and consent, but a different endpoint.
    cfg.providers.backup = { ...cfg.providers.backup!, baseUrl: baseUrl(elsewhere) };
    pacing.release();
    const refused = await waiting;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
    expect(sent).toEqual(["backup"]);
  });

  test("a quota-only continuation refuses when its Combo child settled on another provider", async () => {
    const { cfg, sent } = singleTargetQuotaOnlyCombo();
    const elsewhere = serve(() => { sent.push("elsewhere"); return Response.json(responsesBody("m2", [answer("wrong endpoint")])); });
    cfg.providers.elsewhere = provider("openai-responses", baseUrl(elsewhere));
    const lane = { "thread-id": "child-row-aba" };
    expect(await (await post(cfg, [userMessage("weather?")], lane)).text()).toContain("get_weather");
    redirectWhileChildPrepares(cfg, "elsewhere/m2");
    const refused = await post(cfg, bareContinuation, lane);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
    expect(sent).toEqual(["backup"]);
  });

  test("a quota-only turn whose Combo child sent to another provider records it, so its continuation is refused", async () => {
    const { cfg, sent } = singleTargetQuotaOnlyCombo();
    const elsewhere = serve(() => { sent.push("elsewhere"); return Response.json(responsesBody("m2", [issuedCall])); });
    cfg.providers.elsewhere = provider("openai-responses", baseUrl(elsewhere));
    const lane = { "thread-id": "turn-row-aba" };
    redirectWhileChildPrepares(cfg, "elsewhere/m2");
    expect(await (await post(cfg, [userMessage("weather?")], lane)).text()).toContain("get_weather");
    mock.restore();
    // backup/m2 resolves to the target that did not issue the call.
    const refused = await post(cfg, bareContinuation, lane);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
    expect(sent).toEqual(["elsewhere"]);
  });

  test("a quota-only continuation through an unchanged virtual model target resumes on it", async () => {
    const sent: string[] = [];
    // The built-in OpenAI API row keeps its canonical endpoint, so its fetch stands in for the upstream.
    const virtualRow = provider("openai-responses", "https://api.openai.com/v1", {
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { input: Item[]; model: string };
        sent.push(body.model);
        return Response.json(responsesBody(body.model, [
          body.input.at(-1)?.type === "function_call_output" ? answer("Rain today.") : issuedCall,
        ]));
      }) as typeof fetch,
    });
    const cfg = combo({ "openai-apikey": virtualRow },
      [{ provider: "openai-apikey", model: "gpt-5.6-sol-pro" }], { quotaOnlyFallback: true, allowMeteredTargets: true });
    const lane = { "thread-id": "virtual-model-loop" };
    expect(await (await post(cfg, [userMessage("weather?")], lane)).text()).toContain("get_weather");
    expect(await (await post(cfg, bareContinuation, lane)).text()).toContain("Rain today.");
    expect(sent).toHaveLength(2);
  });

  for (const [label, to, refused] of [
    ["another model", "elsewhere/m3", true],
    ["the same model on another provider", "elsewhere/m2", false],
  ] as const) test(`the model lock checks a Combo child that settles on ${label}`, async () => {
    const { cfg, sent } = singleTargetQuotaOnlyCombo();
    const elsewhere = serve(async request => {
      const body = await request.json() as { model: string };
      sent.push(`elsewhere ${body.model}`);
      return Response.json(responsesBody(body.model, [answer("Rain today.")]));
    });
    cfg.providers.elsewhere = provider("openai-responses", baseUrl(elsewhere));
    cfg.combos!.auto!.preserveFallbackModel = true;
    redirectWhileChildPrepares(cfg, to);
    const response = await post(cfg, [userMessage("weather?")], { "thread-id": `child-model-${label}` });
    if (refused) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "combo_model_change_refused" } });
      expect(sent).toEqual([]);
    } else {
      expect(await response.text()).toContain("Rain today.");
      expect(sent).toEqual(["elsewhere m2"]);
    }
  });

  test("a quota refusal from a Combo child that settled on another provider does not cool the planned target", async () => {
    const { cfg, sent } = singleTargetQuotaOnlyCombo();
    const exhausted = serve(() => {
      sent.push("elsewhere");
      return Response.json({ error: { code: "insufficient_quota", message: "Quota exhausted" } }, { status: 429 });
    });
    cfg.providers.elsewhere = provider("openai-responses", baseUrl(exhausted));
    redirectWhileChildPrepares(cfg, "elsewhere/m2");
    const refused = await post(cfg, [userMessage("weather?")], { "thread-id": "redirected-quota" });
    expect(refused.status).toBe(429);
    await refused.text();
    mock.restore();
    // backup/m2 itself never refused, so the next turn still reaches it.
    expect(await (await post(cfg, [userMessage("weather?")], { "thread-id": "after-redirected-quota" })).text()).toContain("get_weather");
    expect(sent).toEqual(["elsewhere", "backup"]);
  });

  for (const [label, change] of [
    ["its target leaves the Combo", (cfg: OcxConfig) => { cfg.combos!.auto!.targets = [{ provider: "other", model: "m9" }]; }],
    ["its Combo is deleted", (cfg: OcxConfig) => { delete cfg.combos!.auto; }],
  ] as const) {
    test(`a pinned continuation in the Combo loop refuses when ${label} while it waits for pacing`, async () => {
      const { cfg, sent } = singleTargetQuotaOnlyCombo();
      const lane = { "thread-id": `combo-membership-${label}` };
      expect(await (await post(cfg, [userMessage("weather?")], lane)).text()).toContain("get_weather");
      const pacing = holdPacingWaits("backup");
      const waiting = post(cfg, bareContinuation, lane);
      await pacing.held(waiting);
      change(cfg);
      pacing.release();
      const refused = await waiting;
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
      expect(sent).toEqual(["backup"]);
    });

    test(`a pinned subagent continuation refuses when ${label} while it waits for pacing`, async () => {
      const { cfg, sent, subagent } = await collapsedSubagentTurn(`collapsed-membership-${label}`);
      const pacing = holdPacingWaits("backup");
      const waiting = subagent(bareContinuation);
      await pacing.held(waiting);
      change(cfg);
      pacing.release();
      const refused = await waiting;
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
      expect(sent).toEqual(["backup"]);
    });
  }

  for (const [label, redirected] of [["an unchanged route", false], ["a redirect to another model", true]] as const) {
    test(`the model lock keeps a collapsed turn's serving model after the quota-only rule is turned off (${label})`, async () => {
      const { cfg, sent } = await collapsedSubagentTurn(`collapsed-lock-${label}`);
      const elsewhere = serve(() => { sent.push("elsewhere"); return Response.json(responsesBody("m3", [answer("wrong model")])); });
      cfg.providers.elsewhere = provider("openai-responses", baseUrl(elsewhere));
      cfg.combos!.auto!.quotaOnlyFallback = false;
      cfg.combos!.auto!.preserveFallbackModel = true;
      if (redirected) cfg.blockedModelRedirects = { "backup/m2": "elsewhere/m3" };
      const resumed = await post(cfg, bareContinuation, { "thread-id": `collapsed-lock-${label}` });
      if (redirected) {
        expect(resumed.status).toBe(409);
        expect(await resumed.json()).toMatchObject({ error: { code: "combo_model_change_refused" } });
        expect(sent).toEqual(["backup"]);
      } else {
        expect(await resumed.text()).toContain("Rain today.");
        expect(sent).toEqual(["backup", "backup"]);
      }
    });
  }

  test("a quota-only turn records its pin when an unrelated Combo is deleted while it is in flight", async () => {
    const { cfg, sent } = singleTargetQuotaOnlyCombo();
    cfg.combos!.other = { strategy: "failover", targets: [{ provider: "backup", model: "m9" }] };
    setLiveStateStoreConfig(cfg);
    const lane = { "thread-id": "unrelated-delete" };
    const pacing = holdPacingWaits("backup");
    const firstTurn = post(cfg, [userMessage("weather?")], lane);
    await pacing.held(firstTurn);
    await deleteComboThroughManagement(cfg, "other");
    pacing.release();
    expect(await (await firstTurn).text()).toContain("get_weather");
    expect(await (await post(cfg, bareContinuation, lane)).text()).toContain("Rain today.");
    expect(sent).toEqual(["backup", "backup"]);
  });

  test("a pinned subagent continuation stays refused after the management API deletes its Combo", async () => {
    const { cfg, sent, subagent } = await collapsedSubagentTurn("pinned-managed-delete");
    // The deletion reconciles live state, as on a running server.
    setLiveStateStoreConfig(cfg);
    await deleteComboThroughManagement(cfg, "auto");
    resetSubagentModelFallbackStateForTests();
    for (const attempt of ["first", "retry"]) {
      const refused = await subagent(bareContinuation);
      expect(refused.status, attempt).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
    }
    expect(sent).toEqual(["backup"]);
  });

  test("a pinned subagent retry stays refused after a recreated Combo refuses a direct continuation", async () => {
    const { cfg, sent, subagent } = await collapsedSubagentTurn("recreated-combo");
    setLiveStateStoreConfig(cfg);
    const auto = cfg.combos!.auto!;
    await deleteComboThroughManagement(cfg, "auto");
    // Recreated under the same ID, with the quota-only rule on.
    cfg.combos = { ...cfg.combos, auto };
    const direct = await post(cfg, bareContinuation, { "thread-id": "recreated-combo" });
    expect(direct.status).toBe(409);
    await direct.text();
    resetSubagentModelFallbackStateForTests();
    const retried = await subagent(bareContinuation);
    expect(retried.status).toBe(409);
    expect(await retried.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
    expect(sent).toEqual(["backup"]);
  });

  test("an exact-account subagent continuation on a quota-only lane refuses once its fallback chain is cleared", async () => {
    const sent: string[] = [];
    const backup = serve(() => { sent.push("backup"); return Response.json(responsesBody("m2", [answer("wrong target")])); });
    const cfg = {
      port: 0,
      defaultProvider: "openai",
      activeCodexAccountId: "pool-a",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" },
        backup: provider("openai-responses", baseUrl(backup)),
      },
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "pool_acc" },
      ],
      codexAccountNamespaces: { team: "pool-a" },
      combos: { auto: { strategy: "failover", alias: "auto-model", quotaOnlyFallback: true, allowMeteredTargets: true,
        targets: [{ provider: "backup", model: "m2" }] } },
    } as OcxConfig;
    const headers = { "content-type": "application/json", "x-openai-subagent": "collab_spawn", "thread-id": "exact-account-lane" };
    // An earlier turn on this lane fell back to the quota-only Combo, and the fallback chain was cleared since.
    rememberComboForLane(comboToolLoopLane(new Headers(headers), true), "auto", { provider: "backup", model: "m2" }, "m2",
      captureConfigGeneration(), undefined, "recorded-route");
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "team/gpt-5.6-sol", input: bareContinuation, tools, stream: false, store: false }),
    }), cfg, { model: "", provider: "" }, { admission: { kind: "loopback", source: "loopback" } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
    expect(sent).toEqual([]);
  });

  test("a refused direct continuation keeps the lane, so a pinned subagent retry is refused too", async () => {
    const { cfg, sent, subagent } = await collapsedSubagentTurn("refused-direct-keeps-lane");
    cfg.providers.backup!.disabled = true;
    const direct = await post(cfg, bareContinuation, { "thread-id": "refused-direct-keeps-lane" });
    expect(direct.status).toBe(409);
    await direct.text();
    resetSubagentModelFallbackStateForTests();
    const retried = await subagent(bareContinuation);
    expect(retried.status).toBe(409);
    expect(await retried.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
    expect(sent).toEqual(["backup"]);
  });

  for (const [label, change] of [
    ["its Combo is deleted", (cfg: OcxConfig) => { delete cfg.combos!.auto; }],
    ["its Combo leaves the fallback chain and the subagent model recovers", (cfg: OcxConfig) => {
      cfg.subagentModelFallback = ["primary/m1"];
      resetSubagentModelFallbackStateForTests();
    }],
    ["the fallback chain is cleared and the subagent model recovers", (cfg: OcxConfig) => {
      cfg.subagentModelFallback = [];
      resetSubagentModelFallbackStateForTests();
    }],
  ] as const) test(`a pinned subagent continuation refuses once ${label}`, async () => {
    const { cfg, sent, subagent } = await collapsedSubagentTurn(`pinned-${label}`);
    change(cfg);
    const refused = await subagent(bareContinuation);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
    expect(sent).toEqual(["backup"]);
  });

  test("a quota-only continuation whose serving target lost paid-call consent is refused for consent", async () => {
    const { cfg, sent } = singleTargetQuotaOnlyCombo();
    const lane = { "thread-id": "withdrawn-consent" };
    expect(await (await post(cfg, [userMessage("weather?")], lane)).text()).toContain("get_weather");
    cfg.combos!.auto!.allowMeteredTargets = false;
    const refused = await post(cfg, bareContinuation, lane);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "combo_metered_consent_required" } });
    expect(sent).toEqual(["backup"]);
  });

  test("a pinned subagent continuation whose serving target lost paid-call consent is refused for consent", async () => {
    const { cfg, sent, subagent } = await collapsedSubagentTurn("pinned-consent");
    cfg.combos!.auto!.allowMeteredTargets = false;
    const refused = await subagent(bareContinuation);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "combo_metered_consent_required" } });
    expect(sent).toEqual(["backup"]);
  });

  test("a pinned subagent continuation reaches its Combo when the Combo alias is the requested model's bare name", async () => {
    // The turn fell back from another subagent model, then its continuation requests home/m0.
    const { sent, subagent } = await collapsedSubagentTurn("pinned-alias", { alias: "m0", firstModel: "home/m9" });
    const resumed = await subagent(bareContinuation);
    expect(await resumed.text()).toContain("Rain today.");
    expect(sent).toEqual(["backup", "backup"]);
  });

  test("a router-collapsed quota-only turn records its serving target when the Combo's flag is cleared during the turn", async () => {
    const resolveAuth = coreAuth.resolveResponsesCodexAuth;
    const { cfg, sent, subagent } = await collapsedSubagentTurn("admitted-quota-only", {
      // Cleared after the pick was selected, while preparation awaits its credentials.
      beforeFirstTurn: turnConfig => spyOn(coreAuth, "resolveResponsesCodexAuth").mockImplementationOnce(async (...args) => {
        turnConfig.combos!.auto!.quotaOnlyFallback = false;
        return resolveAuth(...args);
      }),
    });
    cfg.combos!.auto!.quotaOnlyFallback = true;
    const resumed = await subagent(bareContinuation);
    expect(await resumed.text()).toContain("Rain today.");
    expect(sent).toEqual(["backup", "backup"]);
  });

  test("Claude Code resumes a quota-only tool turn using its Messages session header", async () => {
    let attempts = 0;
    const upstream = serve(async request => {
      attempts++;
      const body = await request.json() as { input: Item[] };
      return Response.json(responsesBody("m1", [
        body.input.at(-1)?.type === "function_call_output" ? answer("Rain today.") : issuedCall,
      ]));
    });
    const cfg = combo({ primary: provider("openai-responses", baseUrl(upstream)) }, [{ provider: "primary", model: "m1" }],
      { quotaOnlyFallback: true, allowMeteredTargets: true });
    const first = { role: "user", content: "weather?" };
    const call = (messages: Item[]) => handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": "claude-tool-session" },
      body: JSON.stringify({ model: "combo/auto", messages, max_tokens: 32, stream: false,
        tools: [{ name: "get_weather", input_schema: { type: "object" } }] }),
    }), cfg, { model: "", provider: "" }, {
      requestId: "fixture", start: Date.now(), admission: { kind: "loopback", source: "loopback" },
    });
    expect(await (await call([first])).text()).toContain("get_weather");
    const resumed = await call([
      first, { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "rain" }] },
    ]);
    const resumedText = await resumed.text();
    expect(resumed.status, resumedText).toBe(200);
    expect(resumedText).toContain("Rain today.");
    expect(attempts).toBe(2);
  });

  test("a quota-only continuation follows the quota of its redirected destination", async () => {
    const sent: string[] = [];
    const subscription = serve(() => {
      sent.push("subscription");
      return Response.json(responsesBody("m1", [answer("wrong target")]));
    });
    const mirror = serve(async request => {
      sent.push("mirror");
      const body = await request.json() as { input: Item[] };
      return Response.json(responsesBody("m1", [
        body.input.at(-1)?.type === "function_call_output" ? answer("Rain today.") : issuedCall,
      ]));
    });
    const cfg = combo({
      subscription: provider("openai-responses", baseUrl(subscription)),
      mirror: provider("openai-responses", baseUrl(mirror)),
    }, [{ provider: "subscription", model: "m1" }], { quotaOnlyFallback: true, allowMeteredTargets: true });
    cfg.blockedModelRedirects = { "subscription/m1": "mirror/m1" };
    setCachedProviderQuotaForTests("subscription", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
    const lane = { "thread-id": "redirected-destination-quota" };
    expect(await (await post(cfg, [userMessage("weather?")], lane)).text()).toContain("get_weather");
    expect(await (await post(cfg, bareContinuation, lane)).text()).toContain("Rain today.");
    setCachedProviderQuotaForTests("mirror", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
    const stopped = await post(cfg, bareContinuation, lane);
    expect(stopped.status).toBe(429);
    expect(await stopped.json()).toMatchObject({ error: { code: "combo_tool_target_quota_exhausted" } });
    expect(sent).toEqual(["mirror", "mirror"]);
  });

  const servingChanges: Record<string, Partial<OcxProviderConfig>> = {
    "send path": { responsesPath: "/moved/responses" },
    "model adapter": { modelAdapters: { m1: "openai-chat" } },
    "Vertex project": { project: "project-b" },
    "Vertex location": { location: "europe-west4" },
  };
  for (const [change, patch] of Object.entries(servingChanges)) {
    test(`a quota-only continuation refuses its serving target once its ${change} changed`, async () => {
      const paths: string[] = [];
      const upstream = serve(async request => {
        paths.push(new URL(request.url).pathname);
        const body = await request.json() as { input: Item[] };
        return Response.json(responsesBody("m1", [
          body.input.at(-1)?.type === "function_call_output" ? answer("Rain today.") : issuedCall,
        ]));
      });
      const cfg = combo({ primary: provider("openai-responses", baseUrl(upstream)) }, [{ provider: "primary", model: "m1" }],
        { quotaOnlyFallback: true, allowMeteredTargets: true });
      const lane = { "thread-id": `changed-${change}` };
      expect(await (await post(cfg, [userMessage("weather?")], lane)).text()).toContain("get_weather");
      const changed = { ...cfg, providers: { primary: { ...cfg.providers.primary!, ...patch } } };
      const refused = await post(changed, bareContinuation, lane);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "combo_tool_target_unavailable" } });
      expect(await (await post(cfg, bareContinuation, lane)).text()).toContain("Rain today.");
      expect(paths).toEqual(["/v1/responses", "/v1/responses"]);
    });
  }

  for (const [fallbackModel, allowed] of [["m2", false], ["m1", true]] as const) {
    test(`a pinned continuation keeps the same-model guard when its target fails (${fallbackModel})`, async () => {
      let primaryDown = false;
      const sent: string[] = [];
      const primary = serve(() => {
        sent.push("primary");
        return primaryDown ? busy() : Response.json(responsesBody("m1", [issuedCall]));
      });
      const other = serve(() => {
        sent.push("other");
        return Response.json(responsesBody(fallbackModel, [answer("Rain today.")]));
      });
      const cfg = combo({
        primary: provider("openai-responses", baseUrl(primary)),
        other: provider("openai-responses", baseUrl(other)),
      }, [{ provider: "primary", model: "m1" }, { provider: "other", model: fallbackModel }], { preserveFallbackModel: true });
      const lane = { "thread-id": `pinned-model-lock-${fallbackModel}` };
      expect(await (await post(cfg, [userMessage("weather?")], lane)).text()).toContain("get_weather");
      primaryDown = true;
      const resumed = await post(cfg, bareContinuation, lane);
      if (allowed) {
        expect(await resumed.text()).toContain("Rain today.");
        expect(sent.at(-1)).toBe("other");
      } else {
        expect(resumed.status).toBe(409);
        expect(await resumed.json()).toMatchObject({ error: { code: "combo_model_change_refused" } });
        expect(sent).not.toContain("other");
      }
    });
  }

  for (const [label, withThird] of [["a target on the serving model", true], ["only a target on another model", false]] as const) {
    test(`the model lock follows the serving model of a pinned continuation (${label})`, async () => {
      let primaryDown = true;
      let secondDown = false;
      const sent: string[] = [];
      const primary = serve(() => {
        sent.push("primary");
        return primaryDown ? busy() : Response.json(responsesBody("m1", [answer("wrong model")]));
      });
      const second = serve(() => {
        sent.push("second");
        return secondDown ? busy() : Response.json(responsesBody("m2", [issuedCall]));
      });
      const third = serve(() => {
        sent.push("third");
        return Response.json(responsesBody("m2", [answer("Rain today.")]));
      });
      const providers = {
        primary: provider("openai-responses", baseUrl(primary)),
        second: provider("openai-responses", baseUrl(second)),
        third: provider("openai-responses", baseUrl(third)),
      };
      const targets = [{ provider: "primary", model: "m1" }, { provider: "second", model: "m2" },
        ...(withThird ? [{ provider: "third", model: "m2" }] : [])];
      const lane = { "thread-id": `pinned-serving-model-${withThird}` };
      // The turn starts without the model lock while the first target is down, so the second
      // target, on another model, issues the tool call.
      expect(await (await post(combo(providers, targets), [userMessage("weather?")], lane)).text()).toContain("get_weather");
      primaryDown = false;
      secondDown = true;
      // With no target left on the serving model, the recovered first target is the next hop.
      if (!withThird) clearComboTargetCooldowns("auto");
      const firstTurnSends = sent.length;
      const resumed = await post(combo(providers, targets, { preserveFallbackModel: true }), bareContinuation, lane);
      const continuationSends = sent.slice(firstTurnSends);
      expect(continuationSends).not.toContain("primary");
      if (withThird) {
        expect(await resumed.text()).toContain("Rain today.");
        expect(continuationSends.at(-1)).toBe("third");
      } else {
        expect(resumed.status).toBe(409);
        expect(await resumed.json()).toMatchObject({ error: { code: "combo_model_change_refused" } });
      }
    });
  }

  test("the model lock follows the serving model of a continuation whose serving target is already cooling", async () => {
    let secondDown = false;
    const sent: string[] = [];
    const primary = serve(() => { sent.push("primary"); return Response.json(responsesBody("m1", [answer("wrong model")])); });
    const second = serve(() => { sent.push("second"); return secondDown ? busy() : Response.json(responsesBody("m2", [issuedCall])); });
    const providers = { primary: provider("openai-responses", baseUrl(primary)), second: provider("openai-responses", baseUrl(second)) };
    const targets = [{ provider: "primary", model: "m1" }, { provider: "second", model: "m2" }];
    const lane = { "thread-id": "cooling-serving-model" };
    // The first target's quota is spent, so the second target, on another model, issues the tool call.
    setCachedProviderQuotaForTests("primary", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
    expect(await (await post(combo(providers, targets), [userMessage("weather?")], lane)).text()).toContain("get_weather");
    // Another conversation cools the serving target, then the first target's quota recovers.
    secondDown = true;
    await (await post(combo(providers, targets), [userMessage("hello")], { "thread-id": "cooling-other-lane" })).text();
    clearCachedProviderQuotas();
    const sendsBefore = sent.length;
    const resumed = await post(combo(providers, targets, { preserveFallbackModel: true }), bareContinuation, lane);
    expect(resumed.status).toBe(409);
    expect(await resumed.json()).toMatchObject({ error: { code: "combo_model_change_refused" } });
    expect(sent.slice(sendsBefore)).toEqual([]);
  });

  test("a pinned continuation resumes on a target whose configured model carries surrounding spaces", async () => {
    const { cfg, sent } = singleTargetQuotaOnlyCombo();
    cfg.combos!.auto!.targets = [{ provider: "backup", model: " m2 " }];
    const lane = { "thread-id": "padded-target" };
    expect(await (await post(cfg, [userMessage("weather?")], lane)).text()).toContain("get_weather");
    expect(await (await post(cfg, bareContinuation, lane)).text()).toContain("Rain today.");
    expect(sent).toEqual(["backup", "backup"]);
  });

  test("the model lock keeps the serving model when the serving target is disabled", async () => {
    const sent: string[] = [];
    const primary = serve(() => { sent.push("primary"); return Response.json(responsesBody("m1", [answer("wrong model")])); });
    const second = serve(() => { sent.push("second"); return Response.json(responsesBody("m2", [issuedCall])); });
    const providers = { primary: provider("openai-responses", baseUrl(primary)), second: provider("openai-responses", baseUrl(second)) };
    const targets = [{ provider: "primary", model: "m1" }, { provider: "second", model: "m2" }];
    const lane = { "thread-id": "disabled-serving-model" };
    // The first target's quota is spent, so the second target, on another model, issues the tool call.
    setCachedProviderQuotaForTests("primary", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
    expect(await (await post(combo(providers, targets), [userMessage("weather?")], lane)).text()).toContain("get_weather");
    clearCachedProviderQuotas();
    const cfg = combo(providers, targets, { preserveFallbackModel: true });
    cfg.providers.second!.disabled = true;
    for (const attempt of ["first", "retry"]) {
      const refused = await post(cfg, bareContinuation, lane);
      expect(refused.status, attempt).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "combo_model_change_refused" } });
    }
    expect(sent).toEqual(["second"]);
  });

  test("the fallback policy of the provider a redirected Combo child used decides the next hop", async () => {
    const sent: string[] = [];
    const next = serve(() => { sent.push("next"); return Response.json(responsesBody("m2", [answer("from next")])); });
    const exhausted = serve(() => {
      sent.push("elsewhere");
      return Response.json({ error: { code: "insufficient_quota", message: "Quota exhausted" } }, { status: 429 });
    });
    const cfg = combo({
      backup: provider("openai-responses", "http://127.0.0.1:9/v1"),
      next: provider("openai-responses", baseUrl(next)),
      elsewhere: provider("openai-responses", baseUrl(exhausted)),
    }, [{ provider: "backup", model: "m2" }, { provider: "next", model: "m2" }], { quotaOnlyFallback: true, allowMeteredTargets: true });
    // Hops away from the provider that refused are forbidden, while hops away from the planned one are not.
    cfg.fallback = { providers: { elsewhere: { provider: false } } };
    redirectWhileChildPrepares(cfg, "elsewhere/m2");
    const refused = await post(cfg, [userMessage("hello")], { "thread-id": "redirected-policy" });
    expect(await refused.json()).toMatchObject({ error: { code: "fallback_refused" } });
    expect(sent).toEqual(["elsewhere"]);
  });

  test("a pinned quota-only continuation keeps its pool target usable when another key is only rate-limited", async () => {
    const sent: string[] = [];
    let refusing = false;
    const pool = serve(async request => {
      const keyLabels: Record<string, string> = { "Bearer key-one": "one", "Bearer key-two": "two" };
      const key = keyLabels[request.headers.get("authorization") ?? ""] ?? "unexpected";
      sent.push(key);
      if (key === "unexpected") {
        return Response.json({ error: { message: "unexpected credential", type: "invalid_request_error" } }, { status: 400 });
      }
      const body = await request.json() as { input: Item[] };
      if (refusing) {
        return key === "one"
          ? Response.json({ error: { message: "Rate limit reached for requests per minute" } }, { status: 429 })
          : Response.json({ error: { code: "insufficient_quota", message: "Quota exhausted" } }, { status: 429 });
      }
      return Response.json(responsesBody("m2", [
        body.input.at(-1)?.type === "function_call_output" ? answer("Rain today.") : issuedCall,
      ]));
    });
    const cfg = combo({
      backup: provider("openai-responses", baseUrl(pool), {
        apiKey: "key-one", apiKeyPool: [{ id: "one", key: "key-one" }, { id: "two", key: "key-two" }],
      }),
    }, [{ provider: "backup", model: "m2" }], { quotaOnlyFallback: true, allowMeteredTargets: true });
    // Key rotation commits the next key to the persisted row, so the pool has to exist on disk.
    saveConfig(cfg);
    const lane = { "thread-id": "pinned-pool-rate-limit" };
    expect(await (await post(cfg, [userMessage("weather?")], lane)).text()).toContain("get_weather");
    refusing = true;
    const sendsBefore = sent.length;
    const stopped = await post(cfg, bareContinuation, lane);
    expect(stopped.status).toBe(429);
    await stopped.text();
    expect(sent.slice(sendsBefore)).toEqual(["one", "two"]);
    // The rate limit passes, so the pool can serve the continuation again.
    refusing = false;
    clearKeyCooldowns();
    expect(await (await post(cfg, bareContinuation, lane)).text()).toContain("Rain today.");
  });

  test("the model lock keeps the model that issued the call when a redirect moves its target to another model", async () => {
    const sent: string[] = [];
    const backup = serve(() => { sent.push("backup"); return Response.json(responsesBody("m2", [issuedCall])); });
    const other = serve(() => { sent.push("other"); return Response.json(responsesBody("m3", [answer("wrong model")])); });
    const providers = { backup: provider("openai-responses", baseUrl(backup)), other: provider("openai-responses", baseUrl(other)) };
    const targets = [{ provider: "backup", model: "m2" }];
    const lane = { "thread-id": "redirected-lock" };
    expect(await (await post(combo(providers, targets, { preserveFallbackModel: true }), [userMessage("weather?")], lane)).text())
      .toContain("get_weather");
    // The selector that issued the call now resolves to another model.
    const cfg = combo(providers, targets, { preserveFallbackModel: true });
    cfg.blockedModelRedirects = { "backup/m2": "other/m3" };
    const refused = await post(cfg, bareContinuation, lane);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "combo_model_change_refused" } });
    expect(sent).toEqual(["backup"]);
  });

  test("a quota refusal from a Combo child that settled on another provider is judged there, so the Combo advances", async () => {
    const sent: string[] = [];
    const answering = (name: string) => serve(() => { sent.push(name); return Response.json(responsesBody("m2", [answer(`from ${name}`)])); });
    const exhausted = serve(() => {
      sent.push("elsewhere");
      return Response.json({ error: { code: "insufficient_quota", message: "Quota exhausted" } }, { status: 429 });
    });
    const cfg = combo({
      // A pool with two usable keys on the planned target, which alone would keep the Combo there.
      backup: provider("openai-responses", baseUrl(answering("backup")), {
        apiKey: "key-one", apiKeyPool: [{ id: "one", key: "key-one" }, { id: "two", key: "key-two" }],
      }),
      next: provider("openai-responses", baseUrl(answering("next"))),
      elsewhere: provider("openai-responses", baseUrl(exhausted)),
    }, [{ provider: "backup", model: "m2" }, { provider: "next", model: "m2" }], { quotaOnlyFallback: true, allowMeteredTargets: true });
    redirectWhileChildPrepares(cfg, "elsewhere/m2");
    expect(await (await post(cfg, [userMessage("hello")], { "thread-id": "redirected-pool" })).text()).toContain("from next");
    mock.restore();
    expect(await (await post(cfg, [userMessage("hello")], { "thread-id": "after-redirected-pool" })).text()).toContain("from backup");
    expect(sent).toEqual(["elsewhere", "next", "backup"]);
  });

  test("the model lock lets a continuation reach another target on its serving model when the serving target cools", async () => {
    let secondDown = false;
    const sent: string[] = [];
    const primary = serve(() => { sent.push("primary"); return Response.json(responsesBody("m1", [answer("wrong model")])); });
    const second = serve(() => { sent.push("second"); return secondDown ? busy() : Response.json(responsesBody("m2", [issuedCall])); });
    const third = serve(() => { sent.push("third"); return Response.json(responsesBody("m2", [answer("Rain today.")])); });
    const providers = {
      primary: provider("openai-responses", baseUrl(primary)),
      second: provider("openai-responses", baseUrl(second)),
      third: provider("openai-responses", baseUrl(third)),
    };
    const targets = [{ provider: "primary", model: "m1" }, { provider: "second", model: "m2" }, { provider: "third", model: "m2" }];
    const lane = { "thread-id": "cooling-serving-model-third" };
    // The first target's quota stays spent, so the second target, on another model, issues the tool call.
    setCachedProviderQuotaForTests("primary", { updatedAt: Date.now(), weeklyPercent: 100 } as ProviderQuota);
    expect(await (await post(combo(providers, targets), [userMessage("weather?")], lane)).text()).toContain("get_weather");
    // Another conversation cools the serving target.
    secondDown = true;
    await (await post(combo(providers, targets), [userMessage("hello")], { "thread-id": "cooling-third-other-lane" })).text();
    const sendsBefore = sent.length;
    const resumed = await post(combo(providers, targets, { preserveFallbackModel: true }), bareContinuation, lane);
    expect(await resumed.text()).toContain("Rain today.");
    expect(sent.slice(sendsBefore)).toEqual(["third"]);
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

