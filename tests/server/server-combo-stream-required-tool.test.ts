import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { comboProviderFactory } from "../helpers/combo-provider";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearResponseStateForTests, expandPreviousResponseInput, flushResponseState } from "../../src/responses/state";
import { setRelayPlatformForTests } from "../../src/server/responses/passthrough-delivery";
import type { OcxConfig } from "../../src/types";
import type { RequestLogContext } from "../../src/server/request-log";
import { handleResponses } from "../../src/server/responses";

const provider = comboProviderFactory(() => undefined);
const tools = [{ type: "function", name: "marker_func", parameters: { type: "object", properties: {} } }];
const named = { type: "function", name: "marker_func" };
const usage = { input_tokens: 7, output_tokens: 2, total_tokens: 9 };
let home: string;
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;
let release: () => void;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  codexHome = installIsolatedCodexHome("ocx-stream-required-codex-");
  home = mkdtempSync(join(tmpdir(), "ocx-stream-required-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearComboRecallForTests();
  clearResponseStateForTests();
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  await flushResponseState();
  clearResponseStateForTests();
  release();
  setRelayPlatformForTests(undefined);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  codexHome.restore();
  removeTreeWithRetry(home);
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearComboRecallForTests();
});

function completed(model: string, call = false) {
  return { id: `resp_${model}`, object: "response", model, status: "completed", usage,
    output: call ? [{ type: "function_call", id: "fc_backup", name: "marker_func", call_id: "call_backup", arguments: "{}", status: "completed" }]
      : [{ type: "message", id: "msg_bad", role: "assistant", status: "completed", content: [{ type: "output_text", text: "false success", annotations: [] }] }] };
}
function frame(event: Record<string, unknown>) { return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`; }
function sse(...events: Array<Record<string, unknown>>) {
  return new Response(events.map(frame).join(""), { headers: { "content-type": "text/event-stream" } });
}
function configFor(first: () => Response, sent: Array<Record<string, unknown>>) {
  const providers: OcxConfig["providers"] = {};
  for (const [index, name] of ["a", "b"].entries()) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const body = await req.json() as Record<string, unknown>;
      sent.push(body);
      if (index === 1 && Array.isArray(body.input) && body.input.some(item => item.type === "function_call_output")) {
        const result = completed("m2");
        result.output = [{ type: "message", id: "msg_result", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "synthetic result accepted", annotations: [] }] }];
        return sse({ type: "response.completed", response: result });
      }
      return index === 0 ? first() : sse({ type: "response.completed", response: completed("m2", true) });
    } });
    servers.push(server);
    providers[name] = provider("openai-responses", `${server.url.toString().replace(/\/$/, "")}/v1`, `key-${name}`);
  }
  return { port: 0, defaultProvider: "a", providers,
    combos: { fixture: { strategy: "failover", targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }] } } } as OcxConfig;
}
async function request(config: OcxConfig, choice: unknown, log: RequestLogContext = { model: "", provider: "" }, extra = {}, options = {}) {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/fixture", input: "Call the inert marker", stream: true, store: false, tools, tool_choice: choice, ...extra }),
  }), config, log, options);
}
function terminal(text: string) {
  return text.split(/\r?\n/).filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
    .filter(event => ["response.completed", "response.failed"].includes(event.type));
}

describe("native streaming combo mandatory tools (#7456)", () => {
  for (const platform of ["win32", "linux"] as const) for (const choice of [
    { type: "function", namespace: "mcp", name: "ping" },
    { type: "function", name: "mcp__ping" },
  ]) for (const echo of ["mcp__ping", "mcp.ping"]) {
    test(`${platform}: namespace selector ${JSON.stringify(choice)} and echo ${echo} agree`, async () => {
      setRelayPlatformForTests(platform);
      const sent: Array<Record<string, unknown>> = [];
      const payload = { ...completed("m1", true), output: [{ type: "function_call", id: "fc_ping",
        call_id: "call_ping", name: echo, arguments: "{}", status: "completed" }] };
      const config = configFor(() => sse({ type: "response.completed", response: payload }), sent);
      const models: string[] = [];
      const statuses: string[] = [];
      const text = await (await request(config, choice, undefined, { store: true,
        tools: [{ type: "namespace", name: "mcp", tools: [{ type: "function", name: "ping", parameters: { type: "object", properties: {} } }] }],
      }, {
        onResponseComplete: (model: string) => models.push(model),
        onNativePassthroughTerminal: (status: string) => statuses.push(status),
      })).text();
      const replay = expandPreviousResponseInput({ previous_response_id: "resp_m1",
        input: [{ type: "function_call_output", call_id: "call_ping", output: "inert" }] });
      expect({ terminal: terminal(text), statuses, models, replay }).toMatchObject({
        terminal: [{ type: "response.completed", response: { output: [{ name: "ping", namespace: "mcp", call_id: "call_ping" }] } }],
        statuses: ["completed"], models: ["m1"],
        replay: { input: expect.arrayContaining([expect.objectContaining({ type: "function_call", name: "ping", namespace: "mcp", call_id: "call_ping" })]) },
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.tool_choice).toEqual({ type: "function", name: "mcp__ping" });
    });
  }
  for (const platform of ["win32", "linux"] as const) for (const echo of [
    { name: "default.marker_func" },
    { name: "marker_func", namespace: "marker_func" },
  ]) test(`${platform}: normalized named call ${JSON.stringify(echo)} agrees with inspector and continuation`, async () => {
    setRelayPlatformForTests(platform);
    const sent: Array<Record<string, unknown>> = [];
    const payload = completed("m1", true);
    payload.output = [{ ...completed("m1", true).output[0]!, ...echo }];
    const config = configFor(() => sse({ type: "response.completed", response: payload }), sent);
    const models: string[] = [];
    const statuses: string[] = [];
    const text = await (await request(config, named, undefined, { store: true }, {
      onResponseComplete: (model: string) => models.push(model),
      onNativePassthroughTerminal: (status: string) => statuses.push(status),
    })).text();
    expect(terminal(text)).toMatchObject([{ type: "response.completed", response: { output: [{ name: "marker_func", call_id: "call_backup" }] } }]);
    expect(sent).toHaveLength(1);
    expect(statuses).toEqual(["completed"]);
    expect(models).toEqual(["m1"]);
    const replay = expandPreviousResponseInput({ previous_response_id: "resp_m1", input: [{ type: "function_call_output", call_id: "call_backup", output: "inert" }] });
    expect(replay).toMatchObject({ input: expect.arrayContaining([expect.objectContaining({ type: "function_call", name: "marker_func", call_id: "call_backup" })]) });
  });
  for (const platform of ["win32", "linux"] as const) for (const choice of ["required", named]) {
    test(`${platform}: held text-only completion hops for ${JSON.stringify(choice)}`, async () => {
      setRelayPlatformForTests(platform);
      const sent: Array<Record<string, unknown>> = [];
      const config = configFor(() => sse({ type: "response.created", response: { id: "discarded", output: [], status: "in_progress" } },
        { type: "response.completed", response: completed("m1") }), sent);
      const log: RequestLogContext = { model: "", provider: "" };
      const text = await (await request(config, choice, log)).text();
      expect(sent).toHaveLength(2);
      expect(text).not.toContain("false success");
      expect(text).not.toContain("discarded");
      expect(terminal(text)).toMatchObject([{ type: "response.completed", response: { model: "m2", output: [{ call_id: "call_backup" }] } }]);
      expect(log).toMatchObject({ model: "combo/fixture", requestedModel: "combo/fixture", resolvedModel: "m2" });
      expect(sent.map(body => body.tools)).toEqual([tools, tools]);
      expect(sent.map(body => body.tool_choice)).toEqual([choice, choice]);
      expect(log.attempts?.[0]).toMatchObject({ status: 502, usage: { inputTokens: 7, outputTokens: 2 } });
    });
  }
  test("reasoning held by mandatory-tool preflight does not leak from a discarded child", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const config = configFor(() => sse(
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "reason_discarded", summary: [] } },
      { type: "response.reasoning_summary_text.delta", item_id: "reason_discarded", delta: "held reasoning" },
      { type: "response.completed", response: completed("m1") }), sent);
    const text = await (await request(config, "required")).text();
    expect(sent).toHaveLength(2);
    expect(text).not.toContain("held reasoning");
    expect(text).toContain("call_backup");
  });
  for (const prefix of [
    { type: "response.output_text.delta", delta: "visible text" },
    { type: "response.output_item.added", output_index: 0, item: { type: "web_search_call", id: "hosted", status: "in_progress" } },
    { type: "provider.future_commit", value: "ambiguous" },
  ]) test(`committed ${prefix.type}: typed failure without another send`, async () => {
    const sent: Array<Record<string, unknown>> = [];
    const config = configFor(() => sse(prefix, { type: "response.completed", response: completed("m1") }), sent);
    const completedModels: string[] = [];
    const statuses: string[] = [];
    const text = await (await request(config, named, { model: "", provider: "" }, {}, {
      onResponseComplete: (model: string) => completedModels.push(model),
      onNativePassthroughTerminal: (status: string) => statuses.push(status),
    })).text();
    expect(sent).toHaveLength(1);
    expect(terminal(text)).toMatchObject([{ type: "response.failed", response: { status: "failed", error: { code: "required_tool_contract_unsatisfied" }, usage } }]);
    expect(text).not.toContain("event: response.completed");
    expect(completedModels).toEqual([]);
    expect(statuses).toEqual(["failed"]);
  });
  test("a hosted call only in the terminal snapshot refuses replay", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const payload = { ...completed("m1"), output: [{ type: "web_search_call", id: "already_executed", status: "completed" }] };
    const config = configFor(() => sse({ type: "response.completed", response: payload }), sent);
    const text = await (await request(config, named)).text();
    expect(sent).toHaveLength(1);
    expect(terminal(text)).toMatchObject([{ type: "response.failed", response: { error: { code: "required_tool_contract_unsatisfied" } } }]);
  });
  for (const choice of [undefined, "auto", "none"]) test(`non-required ${choice} remains completed`, async () => {
    const sent: Array<Record<string, unknown>> = [];
    const config = configFor(() => sse({ type: "response.completed", response: completed("m1") }), sent);
    const text = await (await request(config, choice)).text();
    expect(sent).toHaveLength(1);
    expect(terminal(text)).toMatchObject([{ type: "response.completed" }]);
    expect(text).toContain("false success");
  });
  test("a valid required call retains its call id without hopping", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const config = configFor(() => sse({ type: "response.completed", response: completed("m1", true) }), sent);
    const text = await (await request(config, named)).text();
    expect(sent).toHaveLength(1);
    expect(terminal(text)).toMatchObject([{ type: "response.completed", response: { output: [{ call_id: "call_backup" }] } }]);
  });
  test("a completed incremental call survives a sparse terminal and a 151-tool catalog", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const catalog = [...tools, ...Array.from({ length: 150 }, (_, i) => ({ ...tools[0], name: `fixture_${i}` }))];
    const call = completed("m1", true).output[0]!;
    const config = configFor(() => sse({ type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: { ...completed("m1"), output: [] } }), sent);
    const text = await (await request(config, named, undefined, { tools: catalog })).text();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.tools).toEqual(catalog);
    expect(text).toContain("call_backup");
    expect(terminal(text)).toMatchObject([{ type: "response.completed" }]);
  });
  test("a call start alone cannot satisfy the terminal contract or authorize replay", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const config = configFor(() => sse({ type: "response.output_item.added", output_index: 0,
      item: { type: "function_call", id: "fc_partial", call_id: "call_partial", name: "marker_func", status: "in_progress" } },
    { type: "response.completed", response: { ...completed("m1"), output: [] } }), sent);
    const text = await (await request(config, named)).text();
    expect(sent).toHaveLength(1);
    expect(terminal(text)).toMatchObject([{ type: "response.failed" }]);
  });
  test("streaming fallback preserves the 151-tool call/result cycle", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const catalog = [...tools, ...Array.from({ length: 150 }, (_, i) => ({ ...tools[0], name: `fixture_${i}` }))];
    const config = configFor(() => sse({ type: "response.completed", response: completed("m1") }), sent);
    const first = terminal(await (await request(config, "required", undefined, { tools: catalog })).text())[0].response;
    expect(first.output[0]).toMatchObject({ name: "marker_func", call_id: "call_backup" });
    const input = [{ role: "user", content: "Use the marker" }, first.output[0],
      { type: "function_call_output", call_id: first.output[0].call_id, output: "synthetic result" }];
    const second = await (await request(config, "auto", undefined, { tools: catalog, input })).text();
    expect(second).toContain("synthetic result accepted");
    expect(terminal(second)).toMatchObject([{ type: "response.completed" }]);
    expect(sent.map(body => body.model)).toEqual(["m1", "m2", "m2"]);
    expect(sent.map(body => body.tools)).toEqual([catalog, catalog, catalog]);
    // Native normalization drops response item ids; call_id binds the portable result.
    const { id: _itemId, ...portableCall } = first.output[0];
    expect(sent[2]!.input).toEqual([input[0], portableCall, input[2]]);
  });
  test("a direct native required request retains its existing terminal owner", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const config = configFor(() => sse({ type: "response.completed", response: completed("m1") }), sent);
    const text = await (await request(config, "required", undefined, { model: "a/m1" })).text();
    expect(sent).toHaveLength(1);
    expect(terminal(text)).toMatchObject([{ type: "response.completed" }]);
  });
  test("cancellation while the first child is held never dispatches a backup", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let readStarted!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    const config = configFor(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ type: "response.created", response: { id: "held", output: [] } })));
      readStarted();
    } }), { headers: { "content-type": "text/event-stream" } }), sent);
    const abort = new AbortController();
    const pending = request(config, "required", undefined, {}, { abortSignal: abort.signal });
    await started;
    abort.abort(new Error("fixture cancellation"));
    const response = await pending;
    expect(response.status).toBe(499);
    expect(sent).toHaveLength(1);
    await response.text();
  });
});
