import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comboProviderFactory } from "../helpers/combo-provider";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { markUndeclaredToolGuardRefusal } from "../../src/lib/errors";
import {
  clearComboSelectionState,
  clearComboTargetCooldowns,
  comboFailureCooldownScope,
  comboFailureDecision,
  isComboTargetInCooldown,
} from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import {
  UNDECLARED_TOOL_CALL_ERROR_CODE,
  undeclaredToolCallMessage,
} from "../../src/server/responses-undeclared-tool-guard";
import type { OcxConfig } from "../../src/types";

const { handleResponses } = await import("../../src/server/responses");
const { handleChatCompletions } = await import("../../src/server/chat-completions");
const { handleClaudeMessages } = await import("../../src/server/claude-messages");

setDefaultTimeout(30_000);

const refusalBody = (): string => JSON.stringify({
  error: { message: undeclaredToolCallMessage(), type: "upstream_error", code: UNDECLARED_TOOL_CALL_ERROR_CODE },
});
const refusalResponse = (): Response =>
  new Response(refusalBody(), { status: 502, headers: { "content-type": "application/json" } });

describe("undeclared-tool guard refusal classification (#9163)", () => {
  test("the guard's provenance grants the hop and no cooldown", () => {
    expect(comboFailureDecision(502, undeclaredToolCallMessage(), {
      code: UNDECLARED_TOOL_CALL_ERROR_CODE,
      undeclaredToolCallRefusal: true,
    })).toBe("hop");
    expect(comboFailureCooldownScope(502, undeclaredToolCallMessage(), {
      code: UNDECLARED_TOOL_CALL_ERROR_CODE,
      undeclaredToolCallRefusal: true,
    })).toBe("none");
  });

  test("the bare refusal words alone stay terminal", () => {
    // Reflected prose must never hop (#8563). At 502 a bare status hops on the generic 5xx rule,
    // so the provenance gate is asserted at a request-validation status.
    expect(comboFailureDecision(400, undeclaredToolCallMessage())).toBe("stop");
    expect(comboFailureDecision(400, undeclaredToolCallMessage(), { code: UNDECLARED_TOOL_CALL_ERROR_CODE })).toBe("stop");
    expect(comboFailureCooldownScope(400, undeclaredToolCallMessage())).toBe("target");
  });

  test("an unmarked attempt that repeats the code gains nothing", async () => {
    const log: RequestLogContext = { model: "combo/test", provider: "combo" };
    const failure = await consumeComboFailure(refusalResponse(), undefined, Date.now(), log);
    expect(failure.upstreamCode).toBe(UNDECLARED_TOOL_CALL_ERROR_CODE);
    expect(failure.undeclaredToolCallRefusal).toBeUndefined();
  });

  test("the guard's mark on the attempt's context is the provenance", async () => {
    const log: RequestLogContext = { model: "combo/test", provider: "combo" };
    markUndeclaredToolGuardRefusal(log);
    const failure = await consumeComboFailure(refusalResponse(), undefined, Date.now(), log);
    expect(failure.undeclaredToolCallRefusal).toBe(true);
    // Another attempt's context carries nothing.
    const other = await consumeComboFailure(refusalResponse(), undefined, Date.now(), { model: "combo/test", provider: "combo" } as RequestLogContext);
    expect(other.undeclaredToolCallRefusal).toBeUndefined();
  });
});

let testDir = "";
let previousHome: string | undefined;
let isolatedHome: IsolatedCodexHome | null = null;
let releaseSpendHome: (() => void) | undefined;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const provider = comboProviderFactory(() => undefined);

const serve = (handler: (request: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
};
const baseUrl = (server: ReturnType<typeof Bun.serve>) => server.url.toString().replace(/\/$/, "") + "/v1";
const sse = (events: unknown[]) => new Response(
  events.map(event => "event: " + (event as { type: string }).type + "\ndata: " + JSON.stringify(event) + "\n\n").join(""),
  { headers: { "content-type": "text/event-stream" } },
);
const success = (text: string, model: string) => ({
  id: "resp-" + model, object: "response", status: "completed", model,
  output: [{ id: "msg_b", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
});
const call = (id: string, name: string) => ({ type: "function_call", id, call_id: "c_" + id, name, arguments: "" });
const callOnly = (name: string): unknown[] => [
  { type: "response.created", response: { id: "r1", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: call("fc_9", name) },
  { type: "response.function_call_arguments.delta", item_id: "fc_9", output_index: 0, delta: "{}" },
  { type: "response.output_item.done", output_index: 0, item: { ...call("fc_9", name), arguments: "{}", status: "completed" } },
  { type: "response.completed", response: { ...success("x", "m1"), output: [{ ...call("fc_9", name), arguments: "{}", status: "completed" }] } },
];
const textThenUndeclared: unknown[] = [
  { type: "response.created", response: { id: "r1", status: "in_progress" } },
  { type: "response.output_text.delta", delta: "visible", item_id: "msg_a", output_index: 0, content_index: 0 },
  { type: "response.output_item.added", output_index: 1, item: call("fc_9", "code_runner/bash") },
  { type: "response.completed", response: { ...success("x", "m1"), output: [] } },
];

function comboConfig(firstTarget: unknown[], targets: 1 | 2, hits: string[], streamMode?: string): OcxConfig {
  const a = serve(() => { hits.push("a"); return sse(firstTarget); });
  const b = serve(() => { hits.push("b"); return sse([{ type: "response.completed", response: success("BACKUP_OK", "m2") }]); });
  const all = [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }];
  return {
    port: 0,
    defaultProvider: "a",
    providers: { a: provider("openai-responses", baseUrl(a), "key-a"), b: provider("openai-responses", baseUrl(b), "key-b") },
    combos: { free: { strategy: "failover", targets: all.slice(0, targets) } },
    ...(streamMode ? { streamMode } : {}),
  } as OcxConfig;
}
const firstTargetCooled = () => isComboTargetInCooldown("free", { provider: "a", model: "m1" });

describe("combo hop on the undeclared-tool guard's refusal (#9163)", () => {
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedHome = installIsolatedCodexHome("ocx-undeclared-hop-");
    testDir = mkdtempSync(join(tmpdir(), "ocx-undeclared-hop-"));
    process.env.OPENCODEX_HOME = testDir;
    releaseSpendHome = acquireOwnedSpendHome();
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    clearCodexUpstreamHealth();
    clearRequestLogsForTests();
    clearResponseStateForTests();
  });

  afterEach(async () => {
    releaseSpendHome?.();
    for (const server of servers.splice(0)) await server.stop(true);
    await flushResponseState();
    clearResponseStateForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedHome?.restore();
    if (testDir) removeTreeWithRetry(testDir);
    clearComboSelectionState();
    clearComboTargetCooldowns();
  });

  const responsesRequest = (stream: boolean) => new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/free", input: "hi", stream, tools: [{ type: "function", name: "exec", parameters: { type: "object" } }] }),
  });

  for (const streamMode of [undefined, "eager-relay", "legacy-tee"] as const) for (const stream of [true, false]) {
    test(`Responses: a refused undeclared call advances without cooling the target (streamMode=${streamMode ?? "auto"}, stream=${stream})`, async () => {
      const hits: string[] = [];
      const config = comboConfig(callOnly("code_runner/bash"), 2, hits, streamMode);
      const response = await handleResponses(responsesRequest(stream), config, { model: "", provider: "" });
      const body = await response.text();
      expect(hits).toEqual(["a", "b"]);
      expect(body).toContain("BACKUP_OK");
      expect(body).not.toContain("code_runner/bash");
      // The model invented the call on a healthy target: the hop must not quarantine it.
      expect(firstTargetCooled()).toBe(false);
    });
  }

  // The buffered application/json refusal branch never runs the SSE block rewrite, so its
  // provenance must be marked directly: a primary answering non-streaming JSON with an
  // undeclared call still hops without cooling the target (#9163).
  for (const stream of [true, false] as const) {
    test(`Responses: a buffered JSON undeclared call advances without cooling the target (stream=${stream})`, async () => {
      const hits: string[] = [];
      const refusedJson = () => new Response(JSON.stringify({ ...success("x", "m1"), output: [{ ...call("fc_9", "code_runner/bash"), arguments: "{}", status: "completed" }] }), { headers: { "content-type": "application/json" } });
      const a = serve(() => { hits.push("a"); return refusedJson(); });
      const b = serve(() => { hits.push("b"); return new Response(JSON.stringify(success("BACKUP_OK", "m2")), { headers: { "content-type": "application/json" } }); });
      const config = {
        port: 0,
        defaultProvider: "a",
        providers: { a: provider("openai-responses", baseUrl(a), "key-a"), b: provider("openai-responses", baseUrl(b), "key-b") },
        combos: { free: { strategy: "failover", targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] } },
      } as OcxConfig;
      const response = await handleResponses(responsesRequest(stream), config, { model: "", provider: "" });
      const body = await response.text();
      expect(hits).toEqual(["a", "b"]);
      expect(body).toContain("BACKUP_OK");
      expect(body).not.toContain("code_runner/bash");
      expect(firstTargetCooled()).toBe(false);
    });
  }

  test("Responses: an upstream error before an undeclared call keeps its own cooldown", async () => {
    // The guard trips on the later call, but the failure the combo judges is the upstream's own
    // rate-limit error: that verdict, not the guard's, decides the cooldown.
    const hits: string[] = [];
    const config = comboConfig([
      { type: "response.created", response: { id: "r1", status: "in_progress" } },
      { type: "error", error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Rate limit reached" } },
      { type: "response.output_item.added", output_index: 0, item: call("fc_9", "code_runner/bash") },
    ], 2, hits);
    const response = await handleResponses(responsesRequest(true), config, { model: "", provider: "" });
    const body = await response.text();
    expect(hits).toEqual(["a", "b"]);
    expect(body).toContain("BACKUP_OK");
    expect(firstTargetCooled()).toBe(true);
  });

  test("Responses: text the client already received keeps the child committed", async () => {
    const hits: string[] = [];
    const config = comboConfig(textThenUndeclared, 2, hits);
    const response = await handleResponses(responsesRequest(true), config, { model: "", provider: "" });
    const body = await response.text();
    expect(hits).toEqual(["a"]);
    expect(body).toContain("visible");
    expect(body).not.toContain("BACKUP_OK");
  });

  for (const wire of ["chat", "messages"] as const) for (const targets of [1, 2] as const) for (const stream of [true, false]) {
    test(`${wire}: a deferred tool the client registry owns is delivered, not refused (targets=${targets}, stream=${stream})`, async () => {
      // Chat and Messages clients may defer tools to their own registry, so the guard stands down
      // on these wires and the combo must not refuse or reroute the call either.
      const hits: string[] = [];
      const config = comboConfig(callOnly("deferred_tool"), targets, hits);
      const request = wire === "chat"
        ? new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "combo/free", stream, messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "exec", parameters: { type: "object", properties: {} } } }] }),
        })
        : new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: "combo/free", stream, max_tokens: 100, messages: [{ role: "user", content: "hi" }], tools: [{ name: "exec", input_schema: { type: "object", properties: {} } }] }),
        });
      const log = { model: "", provider: "" } as never;
      const response = wire === "chat" ? await handleChatCompletions(request, config, log) : await handleClaudeMessages(request, config, log);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(hits).toEqual(["a"]);
      expect(body).toContain("deferred_tool");
      expect(body).not.toContain(UNDECLARED_TOOL_CALL_ERROR_CODE);
    });
  }
});

