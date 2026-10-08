import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { buildQoderArgs, buildQoderChildEnv, createQoderAdapter } from "../../src/adapters/qoder/adapter";
import { buildConversationInput, mapStreamMessageToEvents, releaseOpenToolBlocks, type StreamParseState } from "../../src/adapters/coding-agent/protocol";
import type { CodingAgentDeps } from "../../src/adapters/coding-agent/turn";
import { buildCodingAgentToolCatalog, CODING_AGENT_TOOL_LIMITS } from "../../src/adapters/coding-agent/tool-catalog";
import { buildResponseJSON } from "../../src/bridge/response-json";
import { clearQoderBinaryCache, QODER_CN_PROFILE, QODER_GLOBAL_PROFILE, resolveQoderProfile } from "../../src/adapters/qoder/profiles";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const enc = new TextEncoder();
beforeEach(() => clearQoderBinaryCache());

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "qoder", baseUrl: "https://qoder.com", apiKey: "qoder-pat", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], ...overrides } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return { modelId: "Qwen3.8-Max", stream: true, options: {}, context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, ...overrides } as OcxParsedRequest;
}

function fakeChild(frames: string[], options: { parked?: boolean } = {}): ChildProcess {
  const child = new EventEmitter() as ChildProcess & { killed: boolean; exitCode: number | null };
  const stdout = new PassThrough();
  for (const frame of frames) stdout.write(enc.encode(frame));
  if (!options.parked) stdout.end();
  child.stdout = stdout;
  child.stderr = Readable.from([]);
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    queueMicrotask(() => {
      stdout.destroy();
      child.emit("close", 0);
    });
    return true;
  };
  if (!options.parked) {
    setTimeout(() => { child.exitCode = 0; child.emit("close", 0); }, 2);
  }
  return child;
}

describe("qoder adapter", () => {
  test.each([false, true])("unfinished repeated-ID blocks are bounded before a terminal frame (already emitted=%s)", async alreadyEmitted => {
    const id = "same_call";
    const name = "mcp__opencodex__probe_echo";
    const frames = [
      { type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] },
      ...(alreadyEmitted ? [{ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: {} }] } }] : []),
      ...Array.from({ length: 64 }, (_, index) => ({ type: "stream_event", event: { type: "content_block_start", index,
        content_block: { type: "tool_use", id, name } } })),
      // No stops or terminal frames: the seventeenth retained block itself must fail.
    ];
    const child = fakeChild(frames.map(frame => JSON.stringify(frame) + "\n"));
    const adapter = createQoderAdapter(provider(), { which: () => "/bin/qoder", spawn: () => child });
    const budget = createTestTranslatorBudget();
    const openCall = budget.openCall.bind(budget);
    let openedLeases = 0;
    let peakActive = 0;
    budget.openCall = leaseId => {
      openedLeases++;
      openCall(leaseId);
      peakActive = Math.max(peakActive, budget.snapshot().activeCalls);
    };
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: budget }, e => events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "tool_call_limit", status: 502 });
    expect(events.some(e => e.type === "done")).toBe(false);
    expect(events.filter(e => e.type === "tool_call_start")).toHaveLength(alreadyEmitted ? 1 : 0);
    expect(openedLeases).toBe(alreadyEmitted ? 18 : 17); // 16 blocks plus the shared identity/snapshot leases.
    expect(peakActive).toBe(openedLeases);
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0, overflows: 0 });
    expect(child.killed).toBe(true);
  });

  test.each([undefined, null, 7, "", " ", "bad,name", "bad\nname", "bad\ud800", "mcp__opencodex__undeclared"])("invalid partial tool name %j is refused before any lease", async name => {
    const child = fakeChild([
      JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] }) + "\n",
      JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 0,
        content_block: { type: "tool_use", id: "same_call", name } } }) + "\n",
    ]);
    const adapter = createQoderAdapter(provider(), { which: () => "/bin/qoder", spawn: () => child });
    // Empty names formerly allocated a block and an ID lease under even an 8-byte budget.
    const budget = createTestTranslatorBudget({ maxTurnBytes: 8 });
    const openCall = budget.openCall.bind(budget);
    let openedLeases = 0;
    budget.openCall = leaseId => { openedLeases++; openCall(leaseId); };
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: budget }, e => events.push(e));
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "protocol_error", status: 502 })]);
    expect(openedLeases).toBe(0);
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0, highWaterBytes: 0, overflows: 0 });
    expect(child.killed).toBe(true);
  });

  for (const repeatClosesFirst of [false, true]) {
    for (const representation of ["complete", "partial"] as const) {
      for (const distinctCalls of [16, 17]) {
        test(`distinct-call limit ignores a partial repeat (${representation}, repeat-first=${repeatClosesFirst}, calls=${distinctCalls})`, async () => {
          const call = (index: number) => ({ type: "tool_use", id: `call_limit_${index}`, name: "mcp__opencodex__probe_echo", input: { value: String(index) } });
          const complete = (index: number) => ({ type: "assistant", message: { content: [call(index)] } });
          const start = (index: number, blockIndex: number) => ({ type: "stream_event", event: { type: "content_block_start", index: blockIndex, content_block: call(index) } });
          const delta = (index: number, blockIndex: number) => ({ type: "stream_event", event: { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(call(index).input) } } });
          const stop = (index: number) => ({ type: "stream_event", event: { type: "content_block_stop", index } });
          const distinct = (index: number) => representation === "complete" ? [complete(index)] : [start(index, index), delta(index, index), stop(index)];
          const frames = [
            { type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] },
            ...Array.from({ length: 15 }, (_, index) => complete(index)),
            start(0, 20), delta(0, 20),
            ...(repeatClosesFirst ? [stop(20)] : []),
            ...distinct(15),
            ...(distinctCalls === 17 ? distinct(16) : []),
            ...(!repeatClosesFirst ? [stop(20)] : []),
            { type: "assistant", message: { stop_reason: "tool_use", content: [] } },
          ];
          const child = fakeChild(frames.map(frame => JSON.stringify(frame) + "\n"), { parked: true });
          const adapter = createQoderAdapter(provider(), { which: () => "/bin/qoder", spawn: () => child });
          const events: AdapterEvent[] = [];
          const budget = createTestTranslatorBudget();
          await adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: budget }, e => events.push(e));
          const starts = events.filter(e => e.type === "tool_call_start");
          expect(starts.map(e => e.id)).toEqual(Array.from({ length: 16 }, (_, index) => `call_limit_${index}`));
          expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(16);
          if (distinctCalls === 16) expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
          else {
            expect(events.at(-1)).toMatchObject({ type: "error", code: "tool_call_limit", status: 502 });
            expect(events.some(e => e.type === "done")).toBe(false);
          }
          expect(child.killed).toBe(true);
          expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
        });
      }
    }
  }

  test.each(["incomplete", "conflicting"])("a %s repeat still fails closed after the sixteenth distinct call", async outcome => {
    const frames: unknown[] = [
      { type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] },
      ...Array.from({ length: 15 }, (_, index) => ({ type: "assistant", message: { content: [
        { type: "tool_use", id: `call_limit_${index}`, name: "mcp__opencodex__probe_echo", input: { value: String(index) } },
      ] } })),
      { type: "stream_event", event: { type: "content_block_start", index: 20, content_block: { type: "tool_use", id: "call_limit_0", name: "mcp__opencodex__probe_echo" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 20, delta: { type: "input_json_delta", partial_json: outcome === "conflicting" ? '{"value":"different"}' : '{"value":' } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "call_limit_15", name: "mcp__opencodex__probe_echo", input: { value: "15" } }] } },
      ...(outcome === "conflicting" ? [{ type: "stream_event", event: { type: "content_block_stop", index: 20 } }] : []),
      { type: "assistant", message: { stop_reason: "tool_use", content: [] } },
    ];
    const child = fakeChild(frames.map(frame => JSON.stringify(frame) + "\n"), { parked: true });
    const adapter = createQoderAdapter(provider(), { which: () => "/bin/qoder", spawn: () => child });
    const events: AdapterEvent[] = [];
    const budget = createTestTranslatorBudget();
    await adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: budget }, e => events.push(e));
    expect(events.filter(e => e.type === "tool_call_start")).toHaveLength(16);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error", status: 502 });
    expect(events.some(e => e.type === "done")).toBe(false);
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
  });

  for (const order of ["complete-first", "partial-first"] as const) {
    for (const reuse of ["duplicate", "name", "input"] as const) {
      test(`mixed ${order} call-id ${reuse} reuse is checked against one emitted identity`, async () => {
        const first = { type: "tool_use", id: "call_mixed_identity", name: "mcp__opencodex__probe_echo", input: { value: "A" } };
        const second = structuredClone(first);
        if (reuse === "name") second.name = "mcp__opencodex__probe_other";
        if (reuse === "input") second.input.value = "B";
        const complete = (call: typeof first, stop = false) => ({ type: "assistant", message: { stop_reason: stop ? "tool_use" : null, content: [call] } });
        const partial = (call: typeof first) => [
          { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: call.id, name: call.name } } },
          // Whitespace differs from the complete serialization; the parsed input is identical.
          { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: `{ "value": "${call.input.value}" }` } } },
          { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
        ];
        const frames = [
          { type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] },
          ...(order === "complete-first" ? [complete(first), ...partial(second), complete(second, true)] : [...partial(first), complete(second, true)]),
        ];
        const child = fakeChild(frames.map(frame => JSON.stringify(frame) + "\n"), { parked: true });
        const adapter = createQoderAdapter(provider(), { which: () => "/bin/qoder", spawn: () => child });
        const events: AdapterEvent[] = [];
        const budget = createTestTranslatorBudget();
        await adapter.runTurn!(toolRequest(["probe_echo", "probe_other"]), { headers: new Headers(), translatorBudget: budget }, e => events.push(e));
        expect(events.filter(e => e.type === "tool_call_start")).toEqual([{ type: "tool_call_start", id: first.id, name: "probe_echo" }]);
        expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(1);
        if (reuse === "duplicate") {
          expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
          const output = buildResponseJSON(events, "fixture-model").output as Array<Record<string, unknown>>;
          expect(output.filter(item => item.type === "function_call")).toHaveLength(1);
          expect(output[0]).toMatchObject({ call_id: first.id, name: "probe_echo" });
          expect(JSON.parse(String(output[0]?.arguments))).toEqual({ value: "A" });
        } else {
          expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error", status: 502 });
          expect(events.some(e => e.type === "done")).toBe(false);
        }
        expect(child.killed).toBe(true);
        expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
      });
    }
  }

  test.each([false, true])("complete tool calls before init fail closed (late init=%s)", async lateInit => {
    const frames: unknown[] = [{ type: "assistant", message: { stop_reason: "tool_use", content: [
      { type: "tool_use", id: "call_pre_init", name: "mcp__opencodex__probe_echo", input: {} },
    ] } }];
    if (lateInit) frames.push({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] });
    const child = fakeChild(frames.map(frame => JSON.stringify(frame) + "\n"), { parked: true });
    const adapter = createQoderAdapter(provider(), { which: () => "/bin/qoder", spawn: () => child });
    const events: AdapterEvent[] = [];
    const budget = createTestTranslatorBudget();
    await adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: budget }, e => events.push(e));
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "tool_bridge_init_missing", status: 502 })]);
    expect(child.killed).toBe(true);
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
  });

  for (const field of ["id", "name", "arguments", "turn"] as const) {
    test(`complete tool ${field} overflow uses translation_buffer_limit and releases leases`, async () => {
      const block = { type: "tool_use", id: "call_budget", name: "mcp__opencodex__probe_echo", input: { value: "ok" } };
      if (field === "id") block.id = "x".repeat(65);
      if (field === "name") block.name = "x".repeat(65);
      if (field === "arguments") block.input.value = "x".repeat(65);
      const child = fakeChild([
        JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] }) + "\n",
        JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use", content: [block] } }) + "\n",
      ], { parked: true });
      const adapter = createQoderAdapter(provider(), { which: () => "/bin/qoder", spawn: () => child });
      const budget = createTestTranslatorBudget(field === "turn" ? { maxTurnBytes: 40 } : { maxCallArgumentBytes: 64 });
      const events: AdapterEvent[] = [];
      await adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: budget }, e => events.push(e));
      expect(events).toEqual([expect.objectContaining({ type: "error", code: "translation_buffer_limit", status: 502 })]);
      expect(child.killed).toBe(true);
      expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0, overflows: 1 });
    });
  }

  test("repeated complete snapshots emit once, retain bounded identity, and release on cleanup", () => {
    const budget = createTestTranslatorBudget();
    const state: StreamParseState = {
      sawPartialText: false, sawPartialThinking: false, sawTerminalResult: false,
      completeAssistantToolUse: true, partialToolCallIds: new Set(), translatorBudget: budget,
      maxToolBlockStarts: 1,
    };
    const frame = { type: "assistant", message: { content: [
      { type: "tool_use", id: "call_snapshot", name: "mcp__opencodex__probe_echo", input: { value: "A" } },
    ] } };
    expect(mapStreamMessageToEvents(frame, state).map(event => event.type)).toEqual(["tool_call_start", "tool_call_delta", "tool_call_end"]);
    const retained = budget.snapshot();
    expect(retained.currentBytes).toBeGreaterThanOrEqual(Buffer.byteLength("call_snapshotmcp__opencodex__probe_echo") + Buffer.byteLength('{"value":"A"}'));
    expect(mapStreamMessageToEvents(structuredClone(frame), state)).toEqual([]);
    expect(budget.snapshot()).toEqual(retained);
    expect(state.toolBlockStarts).toBe(1);
    expect(state.completedToolCalls).toBe(1);
    expect(state.toolCallLimitExceeded).toBeUndefined();
    releaseOpenToolBlocks(state);
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
  });

  test.each(["name", "input"])("conflicting complete snapshot %s reuse fails with protocol_error", async field => {
    const first = { type: "tool_use", id: "call_reused", name: "mcp__opencodex__probe_echo", input: { value: "A" } };
    const second = structuredClone(first);
    if (field === "name") second.name = "mcp__opencodex__other";
    else second.input.value = "B";
    const child = fakeChild([
      JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] }) + "\n",
      JSON.stringify({ type: "assistant", message: { content: [first] } }) + "\n",
      JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use", content: [second] } }) + "\n",
    ], { parked: true });
    const adapter = createQoderAdapter(provider(), { which: () => "/bin/qoder", spawn: () => child });
    const budget = createTestTranslatorBudget();
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: budget }, e => events.push(e));
    expect(events.filter(event => event.type === "tool_call_start")).toEqual([{ type: "tool_call_start", id: "call_reused", name: "probe_echo" }]);
    expect(events.filter(event => event.type === "tool_call_delta")).toEqual([{ type: "tool_call_delta", arguments: '{"value":"A"}' }]);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error", status: 502 });
    expect(events.some(event => event.type === "done")).toBe(false);
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
  });

  test("repeated snapshot at the authoritative stop completes a single call", async () => {
    const call = { type: "tool_use", id: "call_repeat", name: "mcp__opencodex__probe_echo", input: {} };
    const child = fakeChild([
      JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] }) + "\n",
      JSON.stringify({ type: "assistant", message: { content: [call] } }) + "\n",
      JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use", content: [call] } }) + "\n",
    ], { parked: true });
    const adapter = createQoderAdapter(provider(), { which: () => "/bin/qoder", spawn: () => child });
    const events: AdapterEvent[] = [];
    const budget = createTestTranslatorBudget();
    await adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: budget }, e => events.push(e));
    expect(events.map(event => event.type)).toEqual(["tool_call_start", "tool_call_delta", "tool_call_end", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
  });

  test("normalizes the observed complete assistant tool_use without replacing its native ID", () => {
    const state: StreamParseState = {
      sawPartialText: false, sawPartialThinking: false, sawTerminalResult: false,
      completeAssistantToolUse: true,
    };
    const events = mapStreamMessageToEvents({
      type: "assistant", message: { content: [{
        type: "tool_use", id: "call_42cfba72566547bda98a74bc",
        name: "mcp__opencodex__probe_echo", input: { value: "FACT1" },
      }] },
    }, state);
    expect(events).toEqual([
      { type: "tool_call_start", id: "call_42cfba72566547bda98a74bc", name: "mcp__opencodex__probe_echo" },
      { type: "tool_call_delta", arguments: '{"value":"FACT1"}' },
      { type: "tool_call_end" },
    ]);
    expect(state.completedToolCalls).toBe(1);
  });

  test("advertises only the selected client catalog and forwards the stdout ID as Responses call_id", async () => {
    const callId = "call_42cfba72566547bda98a74bc";
    let cliArgs: readonly string[] = [];
    let catalog: Array<{ name: string; inputSchema: Record<string, unknown> }> = [];
    const adapter = createQoderAdapter(provider(), {
      which: () => "/bin/qoder",
      spawn: (_binary, args) => {
        cliArgs = args;
        const configPath = args[args.indexOf("--mcp-config") + 1]!;
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        const catalogPath = config.mcpServers.opencodex.args.at(-1);
        catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
        return fakeChild([
          JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] }) + "\n",
          JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: callId,
            name: "mcp__opencodex__probe_echo", input: { value: "FACT1" } }] } }) + "\n",
        ], { parked: true });
      },
      killGraceMs: 10,
    });
    const request = parsed({
      options: { toolChoice: { allowedTools: ["probe_echo"], mode: "auto" } },
      context: { messages: [{ role: "user", content: "call probe_echo", timestamp: 0 }], tools: [
        { name: "probe_echo", description: "Return a marker", parameters: { type: "object", properties: { value: { type: "string" } } } },
        { name: "excluded", description: "Not allowed", parameters: { type: "object" } },
      ] },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(cliArgs[cliArgs.indexOf("--allowed-tools") + 1]).toBe("mcp__opencodex__probe_echo");
    // H7 regression pin: the bridge must keep the single-turn guard when tools are present.
    expect(cliArgs[cliArgs.indexOf("--tools") + 1]).toBe("");
    expect(cliArgs[cliArgs.indexOf("--max-turns") + 1]).toBe("1");
    expect(catalog).toEqual([{ name: "probe_echo", description: "Return a marker",
      inputSchema: { type: "object", properties: { value: { type: "string" } } } }]);
    expect(events).toContainEqual({ type: "tool_call_start", id: callId, name: "probe_echo" });
    expect(events).toContainEqual({ type: "tool_call_delta", arguments: '{"value":"FACT1"}' });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
    const response = buildResponseJSON(events, request.modelId, { declaredToolNames: new Set(["probe_echo"]) });
    expect(response.output).toContainEqual(expect.objectContaining({ type: "function_call", call_id: callId,
      name: "probe_echo", arguments: '{"value":"FACT1"}' }));
  });

  test("keeps valid wire identities, order, schema and emitted names without aliases or hashing", () => {
    const schema = { type: "object", properties: { value: { type: "string" } } };
    const tools = [
      { namespace: "linear", name: "create.issue", description: "Create issue", parameters: schema },
      { name: "probe_echo", description: "Return a marker", parameters: { type: "object" } },
    ];
    const catalog = buildCodingAgentToolCatalog(parsed({ context: { messages: [], tools } }), "opencodex");
    expect(catalog.tools).toEqual([
      { name: "linear__create.issue", description: "Create issue", inputSchema: schema },
      { name: "probe_echo", description: "Return a marker", inputSchema: { type: "object" } },
    ]);
    expect(catalog.tools[0]?.inputSchema).toEqual(schema);
    expect([...catalog.emittedNameMap]).toEqual([
      ["mcp__opencodex__linear__create.issue", "linear__create.issue"],
      ["mcp__opencodex__probe_echo", "probe_echo"],
    ]);
    // Duplicate/colliding identities are resolved by the Responses parser, not this projection.
    const duplicate = buildCodingAgentToolCatalog(parsed({ context: { messages: [], tools: [tools[1]!, tools[1]!] } }), "opencodex");
    expect(duplicate.tools).toHaveLength(2);
    expect(duplicate.emittedNameMap.size).toBe(1);
  });

  test("rejects malformed or unbounded selected catalogs locally before Qoder spawn", async () => {
    const base = { name: "probe_echo", description: "Return a marker", parameters: { type: "object" } };
    const limits = CODING_AGENT_TOOL_LIMITS;
    const argvOverflowCatalog = Array.from({ length: 32 }, (_, i) => ({ ...base, name: `tool_${i}_${"x".repeat(240)}` }));
    expect(enc.encode(argvOverflowCatalog.map(tool => tool.name).join(",")).byteLength).toBeLessThanOrEqual(limits.maxAllowedToolsArgBytes);
    expect(enc.encode(argvOverflowCatalog.map(tool => `mcp__opencodex__${tool.name}`).join(",")).byteLength).toBeGreaterThan(limits.maxAllowedToolsArgBytes);
    const catalogs = [
      [{ ...base, name: "" }],
      [{ ...base, name: "probe,echo" }],
      [{ ...base, name: "probe\n--allowed-tools" }],
      [{ ...base, namespace: "bad\u0000namespace" }],
      [{ ...base, namespace: "" }],
      [{ ...base, name: "bad\ud800" }],
      [{ ...base, name: "界".repeat(Math.floor(limits.maxNameBytes / 3) + 1) }],
      [{ ...base, description: "x".repeat(limits.maxToolBytes) }],
      Array.from({ length: 9 }, (_, i) => ({ ...base, name: `tool_${i}`, description: "x".repeat(240 * 1024) })),
      Array.from({ length: limits.maxTools + 1 }, (_, i) => ({ ...base, name: `tool_${i}` })),
      argvOverflowCatalog,
    ];
    let spawns = 0;
    const adapter = createQoderAdapter(provider(), {
      which: () => "/bin/qoder",
      spawn: () => { spawns++; return fakeChild([]); },
    });
    for (const tools of catalogs) {
      const events: AdapterEvent[] = [];
      await adapter.runTurn!(parsed({ context: { messages: [{ role: "user", content: "hello", timestamp: 0 }], tools } }),
        { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
      expect(events).toEqual([{
        type: "error", message: "Invalid Qoder tool catalog.", status: 400,
        errorType: "invalid_request_error", code: "tool_catalog_invalid", retryable: false,
      }]);
      expect(spawns).toBe(0);
    }
  });

  test("does not rewrite unexpected catalog exceptions as client input errors", async () => {
    const unexpected = new Error("unexpected catalog failure");
    const parameters = new Proxy<Record<string, unknown>>({}, {
      ownKeys() { throw unexpected; },
    });
    let spawns = 0;
    const adapter = createQoderAdapter(provider(), {
      which: () => "/bin/qoder",
      spawn: () => { spawns++; return fakeChild([]); },
    });
    const request = parsed({ context: {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
      tools: [{ name: "probe_echo", description: "Return a marker", parameters }],
    } });

    await expect(adapter.runTurn!(
      request,
      { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      () => {},
    )).rejects.toBe(unexpected);
    expect(spawns).toBe(0);
  });

  test("validates only selected definitions", () => {
    const tools = [
      { name: "probe_echo", description: "ok", parameters: { type: "object" } },
      { name: "other", description: "x".repeat(CODING_AGENT_TOOL_LIMITS.maxToolBytes), parameters: { type: "object" } },
    ];
    const catalog = buildCodingAgentToolCatalog(parsed({
      options: { toolChoice: { allowedTools: ["probe_echo"], mode: "auto" } },
      context: { messages: [], tools },
    }), "opencodex");
    expect(catalog.tools).toEqual([{ name: "probe_echo", description: "ok", inputSchema: { type: "object" } }]);
  });

  test("uses only the Global PAT and disables tools, MCP, settings hooks, and persistence", () => {
    const env = buildQoderChildEnv(QODER_GLOBAL_PROFILE, "qoder-pat");
    expect(env.QODER_PERSONAL_ACCESS_TOKEN).toBe("qoder-pat");
    expect(Object.keys(env).filter(key => key.startsWith("QODER"))).toEqual(["QODER_PERSONAL_ACCESS_TOKEN"]);
    const args = buildQoderArgs(parsed({ options: { reasoning: "high" } }), provider());
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("high");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("passes system and developer prompts only in the scoped child environment", async () => {
    const secretSystem = "private system instructions";
    const secretDeveloper = "private developer context";
    let args: readonly string[] = [];
    let childEnv: NodeJS.ProcessEnv = {};
    const adapter = createQoderAdapter(provider(), {
      which: () => "/bin/qoder",
      spawn: (_command, childArgs, options) => {
        args = childArgs;
        childEnv = options.env ?? {};
        return fakeChild(['{"type":"result","subtype":"success","is_error":false}\n']);
      },
    });
    await adapter.runTurn!(parsed({
      context: {
        systemPrompt: [secretSystem],
        messages: [
          { role: "developer", content: secretDeveloper, timestamp: 0 },
          { role: "user", content: "hello", timestamp: 0 },
        ],
      },
    }), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, () => {});

    expect(args.join(" ")).not.toContain(secretSystem);
    expect(args.join(" ")).not.toContain(secretDeveloper);
    expect(args).not.toContain("--append-system-prompt-file");
    expect(childEnv.QODER_APPEND_SYSTEM_PROMPT).toBe(`${secretSystem}\n\n${secretDeveloper}`);
  });

  test("never inherits an ambient Qoder prompt for either region", () => {
    const previous = process.env.QODER_APPEND_SYSTEM_PROMPT;
    const previousCn = process.env.QODERCN_APPEND_SYSTEM_PROMPT;
    process.env.QODER_APPEND_SYSTEM_PROMPT = "ambient-secret";
    process.env.QODERCN_APPEND_SYSTEM_PROMPT = "ambient-cn-secret";
    try {
      for (const profile of [QODER_GLOBAL_PROFILE, QODER_CN_PROFILE]) {
        expect(buildQoderChildEnv(profile, "pat").QODER_APPEND_SYSTEM_PROMPT).toBeUndefined();
        const promptEnv = profile.region === "cn" ? "QODERCN_APPEND_SYSTEM_PROMPT" : "QODER_APPEND_SYSTEM_PROMPT";
        expect(buildQoderChildEnv(profile, "pat")[promptEnv]).toBeUndefined();
        expect(buildQoderChildEnv(profile, "pat", "request-only")[promptEnv]).toBe("request-only");
      }
    } finally {
      if (previous === undefined) delete process.env.QODER_APPEND_SYSTEM_PROMPT;
      else process.env.QODER_APPEND_SYSTEM_PROMPT = previous;
      if (previousCn === undefined) delete process.env.QODERCN_APPEND_SYSTEM_PROMPT;
      else process.env.QODERCN_APPEND_SYSTEM_PROMPT = previousCn;
    }
  });

  test("keeps Global and CN profiles, executables, destinations, and PAT variables isolated", async () => {
    expect(resolveQoderProfile("https://qoder.com/")).toBe(QODER_GLOBAL_PROFILE);
    expect(resolveQoderProfile("https://qoder.cn/")).toBe(QODER_CN_PROFILE);
    expect(QODER_CN_PROFILE.binaryCandidates).toEqual(["qodercn", "qoderclicn"]);

    const globalEnv = buildQoderChildEnv(QODER_GLOBAL_PROFILE, "global-pat");
    const cnEnv = buildQoderChildEnv(QODER_CN_PROFILE, "cn-pat");
    expect(globalEnv.QODER_PERSONAL_ACCESS_TOKEN).toBe("global-pat");
    expect(globalEnv.QODERCN_PERSONAL_ACCESS_TOKEN).toBeUndefined();
    expect(cnEnv.QODERCN_PERSONAL_ACCESS_TOKEN).toBe("cn-pat");
    expect(cnEnv.QODER_PERSONAL_ACCESS_TOKEN).toBeUndefined();

    const spawned: Array<{ executable: string; env: NodeJS.ProcessEnv }> = [];
    const runRegion = async (configured: OcxProviderConfig, executable: string) => {
      const adapter = createQoderAdapter(configured, {
        which: candidate => candidate === executable ? `/bin/${candidate}` : undefined,
        spawn: (command, _args, options) => {
          spawned.push({ executable: command, env: options.env ?? {} });
          return fakeChild(['{"type":"result","subtype":"success","is_error":false}\n']);
        },
      });
      await adapter.runTurn!(parsed(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, () => {});
    };
    await Promise.all([
      runRegion(provider({ baseUrl: "https://qoder.com", apiKey: "global-pat" }), "qoder"),
      runRegion(provider({ baseUrl: "https://qoder.cn", apiKey: "cn-pat" }), "qodercn"),
    ]);
    expect(spawned).toHaveLength(2);
    const global = spawned.find(item => item.executable.endsWith("/qoder"))!;
    const cn = spawned.find(item => item.executable.endsWith("/qodercn"))!;
    expect(global.env.QODER_PERSONAL_ACCESS_TOKEN).toBe("global-pat");
    expect(global.env.QODERCN_PERSONAL_ACCESS_TOKEN).toBeUndefined();
    expect(cn.env.QODERCN_PERSONAL_ACCESS_TOKEN).toBe("cn-pat");
    expect(cn.env.QODER_PERSONAL_ACCESS_TOKEN).toBeUndefined();
  });

  test("fails closed before spawn for a non-canonical destination", async () => {
    let spawned = 0;
    const adapter = createQoderAdapter(provider({ baseUrl: "https://evil.example.test" }), { which: () => "/bin/qoder", spawn: () => { spawned++; return fakeChild([]); } });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(spawned).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", code: "non_canonical_destination" });
  });

  test("rejects unverified image input instead of silently dropping or forwarding it", async () => {
    let spawned = 0;
    const adapter = createQoderAdapter(provider(), { which: () => "/bin/qoder", spawn: () => { spawned++; return fakeChild([]); } });
    const request = parsed({ context: { messages: [{ role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,AA==" }], timestamp: 0 }] } });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(spawned).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", code: "unsupported_input_modality" });
  });

  test("maps Qoder credit exhaustion to a non-retryable 429", async () => {
    const adapter = createQoderAdapter(provider(), {
      which: () => "/bin/qoder",
      spawn: () => fakeChild([
        '{"type":"assistant","message":{"content":[{"type":"text","text":"limit"}]} }\n',
        '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["You reached your credit usage limit"],"error_code":118}\n',
      ]),
      killGraceMs: 10,
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "error", status: 429, errorType: "insufficient_quota", code: "insufficient_quota", retryable: false });
  });

  test("shared parser refuses Qoder's seventeenth tool start", async () => {
    const frames = Array.from({ length: 17 }, (_, index) => JSON.stringify({
      type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id: `id_${index}`, name: "exec" } },
    }) + "\n");
    const adapter = createQoderAdapter(provider(), { which: () => "/bin/qoder", spawn: () => fakeChild(frames) });
    const budget = createTestTranslatorBudget();
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed(), { headers: new Headers(), translatorBudget: budget }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "tool_call_limit", status: 502 });
    expect(events.some(event => event.type === "tool_call_start" || event.type === "done")).toBe(false);
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0 });
  });

  test("Qoder tool identity alone is charged to the shared budget", async () => {
    const frame = JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "abcd", name: "exec" } } }) + "\n";
    const adapter = createQoderAdapter(provider(), { which: () => "/bin/qoder", spawn: () => fakeChild([frame]) });
    const budget = createTestTranslatorBudget({ maxCallArgumentBytes: 7 });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed(), { headers: new Headers(), translatorBudget: budget }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "translation_buffer_limit", status: 502 });
    expect(events.some(event => event.type === "tool_call_start" || event.type === "done")).toBe(false);
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, activeCalls: 0, overflows: 1 });
  });

  test("replays prior assistant tool calls using the active vendor-facing MCP name", async () => {
    let stdinData = "";
    const callId = "call_test_123";
    const adapter = createQoderAdapter(provider(), {
      which: () => "/bin/qoder",
      spawn: () => {
        const child = fakeChild([
          JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] }) + "\n",
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }) + "\n",
          JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\n",
        ]);
        child.stdin = new Writable({
          write(chunk, _encoding, callback) {
            stdinData += String(chunk);
            callback();
          },
        });
        return child;
      },
      killGraceMs: 10,
    });
    const request = parsed({
      options: { toolChoice: "auto" },
      context: {
        messages: [
          { role: "user", content: "run probe", timestamp: 0 },
          { role: "assistant", content: [{ type: "toolCall", id: callId, name: "probe_echo", arguments: { value: "HELLO" } }], timestamp: 1 },
          { role: "toolResult", toolCallId: callId, content: "result text", timestamp: 2 },
          { role: "user", content: "what next?", timestamp: 3 },
        ],
        tools: [
          { name: "probe_echo", description: "Return a marker", parameters: { type: "object", properties: { value: { type: "string" } } } },
        ],
      },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(stdinData).toContain(`[Tool call: mcp__opencodex__probe_echo (call_id: ${callId})`);
    expect(stdinData).not.toContain(`[Tool call: probe_echo (call_id: ${callId})`);
    const parsedPayload = JSON.parse(stdinData.trim());
    const text = parsedPayload.message.content[0].text;
    expect(text).toContain(`[Tool call: mcp__opencodex__probe_echo (call_id: ${callId}) with args: {"value":"HELLO"}]`);
    expect(text).toContain(`TOOL RESULT (call_id: ${callId}):\nresult text`);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("shared history serialization without vendorNameByWire retains canonical wire names", () => {
    const request = parsed({
      context: {
        messages: [
          { role: "user", content: "run probe", timestamp: 0 },
          { role: "assistant", content: [{ type: "toolCall", id: "call_test_123", name: "probe_echo", arguments: { value: "HELLO" } }], timestamp: 1 },
          { role: "toolResult", toolCallId: "call_test_123", content: "result text", timestamp: 2 },
          { role: "user", content: "what next?", timestamp: 3 },
        ],
      },
    });
    const [line] = buildConversationInput(request);
    expect(line).toContain("[Tool call: probe_echo (call_id: call_test_123)");
    expect(line).not.toContain("mcp__");
    const parsedPayload = JSON.parse(line!);
    const text = parsedPayload.message.content[0].text;
    expect(text).toContain('[Tool call: probe_echo (call_id: call_test_123) with args: {"value":"HELLO"}]');
  });

  test("replays multiple mapped tools to their respective vendor-facing names", async () => {
    let stdinData = "";
    const adapter = createQoderAdapter(provider(), {
      which: () => "/bin/qoder",
      spawn: () => {
        const child = fakeChild([
          JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] }) + "\n",
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }) + "\n",
          JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\n",
        ]);
        child.stdin = new Writable({
          write(chunk, _encoding, callback) {
            stdinData += String(chunk);
            callback();
          },
        });
        return child;
      },
      killGraceMs: 10,
    });
    const request = parsed({
      options: { toolChoice: "auto" },
      context: {
        messages: [
          { role: "user", content: "run commands", timestamp: 0 },
          { role: "assistant", content: [
            { type: "toolCall", id: "call_exec_1", name: "exec", arguments: { cmd: "ls" } },
            { type: "toolCall", id: "call_read_2", name: "read_file", arguments: { path: "a.txt" } },
          ], timestamp: 1 },
          { role: "toolResult", toolCallId: "call_exec_1", content: "file.txt", timestamp: 2 },
          { role: "toolResult", toolCallId: "call_read_2", content: "hello", timestamp: 3 },
          { role: "user", content: "next step", timestamp: 4 },
        ],
        tools: [
          { name: "exec", description: "Run a command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
          { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
        ],
      },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(stdinData).toContain("[Tool call: mcp__opencodex__exec (call_id: call_exec_1)");
    expect(stdinData).toContain("[Tool call: mcp__opencodex__read_file (call_id: call_read_2)");
    expect(stdinData).not.toContain("[Tool call: exec (call_id: call_exec_1)");
    expect(stdinData).not.toContain("[Tool call: read_file (call_id: call_read_2)");
    const parsedPayload = JSON.parse(stdinData.trim());
    const text = parsedPayload.message.content[0].text;
    expect(text).toContain('[Tool call: mcp__opencodex__exec (call_id: call_exec_1) with args: {"cmd":"ls"}]');
    expect(text).toContain('[Tool call: mcp__opencodex__read_file (call_id: call_read_2) with args: {"path":"a.txt"}]');
    expect(text).toContain("TOOL RESULT (call_id: call_exec_1):\nfile.txt");
    expect(text).toContain("TOOL RESULT (call_id: call_read_2):\nhello");
    expect(events.at(-1)?.type).toBe("done");
  });

  test("tool_choice required fails closed with neutral diagnostic when Qoder outputs no tool call", async () => {
    const adapter = createQoderAdapter(provider(), {
      which: () => "/bin/qoder",
      spawn: () => fakeChild([
        JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] }) + "\n",
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "no tools needed" }] } }) + "\n",
        JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\n",
      ]),
      killGraceMs: 10,
    });
    const request = parsed({
      options: { toolChoice: "required" },
      context: {
        messages: [{ role: "user", content: "must call tool", timestamp: 0 }],
        tools: [{ name: "probe_echo", description: "Echo marker", parameters: { type: "object" } }],
      },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "Coding-agent CLI finished without calling the required tool.",
      status: 502,
      errorType: "upstream_error",
      code: "tool_call_required",
      retryable: false,
    });
  });

  test("tool_choice allowedTools with mode required propagates requireToolCall obligation", async () => {
    const adapter = createQoderAdapter(provider(), {
      which: () => "/bin/qoder",
      spawn: () => fakeChild([
        JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] }) + "\n",
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "text only" }] } }) + "\n",
        JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\n",
      ]),
      killGraceMs: 10,
    });
    const request = parsed({
      options: { toolChoice: { allowedTools: ["probe_echo"], mode: "required" } },
      context: {
        messages: [{ role: "user", content: "must call probe_echo", timestamp: 0 }],
        tools: [{ name: "probe_echo", description: "Echo marker", parameters: { type: "object" } }],
      },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "tool_call_required",
      message: "Coding-agent CLI finished without calling the required tool.",
    });
  });

  test("named tool choice with no selected tool cannot complete as text", async () => {
    const adapter = createQoderAdapter(provider(), {
      which: () => "/bin/qoder",
      spawn: () => { throw new Error("empty required catalog must fail before spawn"); },
    });
    const request = parsed({
      options: { toolChoice: { name: "missing_tool" } },
      context: {
        messages: [{ role: "user", content: "call missing_tool", timestamp: 0 }],
        tools: [{ name: "probe_echo", description: "Echo", parameters: { type: "object" } }],
      },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "tool_bridge_empty" });
  });

  test("replays namespaced tool calls in history with canonical wire identity", async () => {
    let stdinData = "";
    const adapter = createQoderAdapter(provider(), {
      which: () => "/bin/qoder",
      spawn: () => {
        const child = fakeChild([
          JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] }) + "\n",
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }) + "\n",
          JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\n",
        ]);
        child.stdin = new Writable({
          write(chunk, _encoding, callback) {
            stdinData += String(chunk);
            callback();
          },
        });
        return child;
      },
      killGraceMs: 10,
    });
    const request = parsed({
      options: { toolChoice: "auto" },
      context: {
        messages: [
          { role: "user", content: "start", timestamp: 0 },
          { role: "assistant", content: [
            { type: "toolCall", id: "call_ns_1", namespace: "custom_mcp", name: "fetch", arguments: { url: "http://example.com" } },
          ], timestamp: 1 },
          { role: "toolResult", toolCallId: "call_ns_1", content: "ok", timestamp: 2 },
          { role: "user", content: "next", timestamp: 3 },
        ],
        tools: [
          { namespace: "custom_mcp", name: "fetch", description: "Fetch url", parameters: { type: "object" } },
        ],
      },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(stdinData).toContain("[Tool call: mcp__opencodex__custom_mcp__fetch (call_id: call_ns_1)");
  });
});

function createTestClock() {
  let currentTime = 0;
  let nextId = 1;
  interface Scheduled {
    id: number;
    callback: () => void;
    dueTime: number;
    delay: number;
  }
  const scheduled: Scheduled[] = [];

  const fakeSetTimeout = ((callback: () => void, ms = 0): any => {
    const id = nextId++;
    scheduled.push({ id, callback, dueTime: currentTime + ms, delay: ms });
    scheduled.sort((a, b) => a.dueTime - b.dueTime);
    return id;
  }) as typeof setTimeout;

  const fakeClearTimeout = ((id: any): void => {
    const idx = scheduled.findIndex(item => item.id === id);
    if (idx !== -1) scheduled.splice(idx, 1);
  }) as typeof clearTimeout;

  const advanceTimersByTime = async (ms: number) => {
    currentTime += ms;
    while (scheduled.length > 0 && scheduled[0]!.dueTime <= currentTime) {
      const item = scheduled.shift()!;
      item.callback();
      await new Promise(r => setImmediate(r));
    }
  };

  return {
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    advanceTimersByTime,
    get pendingCount() { return scheduled.length; },
    get scheduled() { return scheduled; },
    get currentTime() { return currentTime; },
  };
}

function createParkedChild() {
  const child = fakeChild([], { parked: true }) as ChildProcess & { killed: boolean; exitCode: number | null };
  const stdout = child.stdout as PassThrough;
  return {
    child,
    pushFrame: (obj: Record<string, unknown>) => {
      stdout.write(enc.encode(JSON.stringify(obj) + "\n"));
    },
    pushRaw: (str: string) => {
      stdout.write(enc.encode(str));
    },
    end: () => {
      stdout.end();
      child.exitCode = 0;
      child.emit("close", 0);
    },
  };
}

function toolRequest(tools = ["probe_echo"]) {
  return parsed({
    options: { toolChoice: { allowedTools: tools, mode: "auto" } },
    context: {
      messages: [{ role: "user", content: "call tools", timestamp: 0 }],
      tools: tools.map(name => ({
        name,
        description: `Tool ${name}`,
        parameters: { type: "object", properties: { value: { type: "string" } } },
      })),
    },
  });
}

function setupParkedQoder(tools = ["probe_echo"], overrides: Partial<CodingAgentDeps> = {}) {
  const spawned = Promise.withResolvers<void>();
  const clock = createTestClock();
  const parked = createParkedChild();
  const adapter = createQoderAdapter(provider(), {
    which: () => "/bin/qoder",
    spawn: () => {
      spawned.resolve();
      return parked.child;
    },
    killGraceMs: 10,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...overrides,
  });
  return { spawned, clock, parked, adapter };
}

describe("qoder authoritative tool-turn completion", () => {
  test("single tool stop_reason completes immediately and reaps with identity/input intact", async () => {
    const { spawned, clock, parked, adapter } = setupParkedQoder();
    const events: AdapterEvent[] = [];
    const turn = adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, e => events.push(e));
    await spawned.promise;
    parked.pushFrame({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] });
    parked.pushFrame({ type: "assistant", message: { stop_reason: "tool_use", usage: { input_tokens: 12, output_tokens: 3 }, content: [
      { type: "tool_use", id: "call_1", name: "mcp__opencodex__probe_echo", input: { value: "A" } },
    ] } });
    await turn;
    expect(clock.currentTime).toBe(0);
    expect(events.filter(e => e.type === "tool_call_start")).toEqual([{ type: "tool_call_start", id: "call_1", name: "probe_echo" }]);
    expect(events.filter(e => e.type === "tool_call_delta")).toEqual([{ type: "tool_call_delta", arguments: '{"value":"A"}' }]);
    expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(1);
    expect(events.filter(e => e.type === "done")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false, usage: { inputTokens: 12, outputTokens: 3 } });
    expect(parked.child.killed).toBe(true);
    expect(clock.pendingCount).toBe(0);
  });

  for (const delay of [0, 1000]) {
    test(`two sibling tools survive ${delay}ms until final stop_reason`, async () => {
      const { spawned, clock, parked, adapter } = setupParkedQoder();
      const events: AdapterEvent[] = [];
      const turn = adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, e => events.push(e));
      await spawned.promise;
      parked.pushFrame({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] });
      parked.pushFrame({ type: "assistant", message: { stop_reason: null, content: [
        { type: "tool_use", id: "call_A", name: "mcp__opencodex__probe_echo", input: { value: "A" } },
      ] } });
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await clock.advanceTimersByTime(delay);
      expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(1);
      expect(events.some(e => e.type === "done")).toBe(false);
      expect(parked.child.killed).toBe(false);
      parked.pushFrame({ type: "assistant", message: { stop_reason: "tool_use", content: [
        { type: "tool_use", id: "call_B", name: "mcp__opencodex__probe_echo", input: { value: "B" } },
      ] } });
      await turn;
      expect(clock.currentTime).toBe(delay);
      expect(events.filter(e => e.type === "tool_call_start")).toEqual([
        { type: "tool_call_start", id: "call_A", name: "probe_echo" },
        { type: "tool_call_start", id: "call_B", name: "probe_echo" },
      ]);
      expect(events.filter(e => e.type === "tool_call_delta")).toEqual([
        { type: "tool_call_delta", arguments: '{"value":"A"}' },
        { type: "tool_call_delta", arguments: '{"value":"B"}' },
      ]);
      expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(2);
      expect(events.filter(e => e.type === "done")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
      expect(parked.child.killed).toBe(true);
    });
  }

  for (const stopReason of [undefined, null, "end_turn", "max_tokens"]) {
    test(`silence alone must not complete a tool turn (${stopReason}); EOF fails closed`, async () => {
      const { spawned, clock, parked, adapter } = setupParkedQoder();
      const events: AdapterEvent[] = [];
      const turn = adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, e => events.push(e));
      await spawned.promise;
      parked.pushFrame({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] });
      parked.pushFrame({ type: "assistant", message: { stop_reason: stopReason, content: [
        { type: "tool_use", id: "call_no_stop", name: "mcp__opencodex__probe_echo", input: {} },
      ] } });
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await clock.advanceTimersByTime(1000);
      expect(events.some(e => e.type === "done")).toBe(false);
      expect(parked.child.killed).toBe(false);
      parked.end();
      await turn;
      expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error", status: 502 });
      expect(events.some(e => e.type === "done")).toBe(false);
    });
  }

  test("abort while awaiting authoritative stop fails closed", async () => {
    const abortController = new AbortController();
    const { spawned, clock, parked, adapter } = setupParkedQoder();
    const events: AdapterEvent[] = [];
    const turnPromise = adapter.runTurn!(toolRequest(), {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
      abortSignal: abortController.signal,
    }, e => events.push(e));

    await spawned.promise;
    parked.pushFrame({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] });
    parked.pushFrame({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_abort_1", name: "mcp__opencodex__probe_echo", input: { value: "A" } }] },
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    abortController.abort();
    await turnPromise;

    expect(events.some(e => e.type === "error" && e.message.includes("aborted"))).toBe(true);
    expect(events.some(e => e.type === "done")).toBe(false);

    await clock.advanceTimersByTime(1000);
    expect(events.filter(e => e.type === "done")).toHaveLength(0);
    expect(events.filter(e => e.type === "error")).toHaveLength(1);
  });

  test("global timeout without authoritative stop cannot emit success", async () => {
    const { spawned, clock, parked, adapter } = setupParkedQoder(["probe_echo"], { timeoutMs: 100 });
    const events: AdapterEvent[] = [];
    const turnPromise = adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, e => events.push(e));

    await spawned.promise;
    parked.pushFrame({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] });
    parked.pushFrame({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_to_1", name: "mcp__opencodex__probe_echo", input: { value: "T" } }] },
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    await clock.advanceTimersByTime(100);
    await turnPromise;

    expect(events.some(e => e.type === "error" && e.code === "timeout")).toBe(true);
    expect(events.some(e => e.type === "done")).toBe(false);

    await clock.advanceTimersByTime(200);
    expect(events.filter(e => e.type === "done")).toHaveLength(0);
  });

  test("protocol error before authoritative stop prevents success", async () => {
    const { spawned, clock, parked, adapter } = setupParkedQoder();
    const events: AdapterEvent[] = [];
    const turnPromise = adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, e => events.push(e));

    await spawned.promise;
    parked.pushFrame({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] });
    parked.pushFrame({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_proto_1", name: "mcp__opencodex__probe_echo", input: { value: "P" } }] },
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    parked.pushRaw("not valid json\n");
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    await turnPromise;

    expect(events.some(e => e.type === "error")).toBe(true);
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("undeclared tool call before authoritative stop fails closed", async () => {
    const { spawned, clock, parked, adapter } = setupParkedQoder();
    const events: AdapterEvent[] = [];
    const turnPromise = adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, e => events.push(e));

    await spawned.promise;
    parked.pushFrame({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] });
    parked.pushFrame({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_decl_1", name: "mcp__opencodex__probe_echo", input: { value: "D" } }] },
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    parked.pushFrame({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_decl_2", name: "mcp__opencodex__undeclared", input: {} }] },
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    await turnPromise;

    expect(events.at(-1)).toMatchObject({ type: "error", code: "undeclared_tool_call", status: 502 });
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("authoritative assistant stop with incomplete tool block fails closed", async () => {
    const { spawned, clock, parked, adapter } = setupParkedQoder();
    const events: AdapterEvent[] = [];
    const turnPromise = adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, e => events.push(e));

    await spawned.promise;
    parked.pushFrame({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] });
    parked.pushFrame({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "call_inc_1", name: "mcp__opencodex__probe_echo", input: { value: "OK" } }] },
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    parked.pushFrame({
      type: "stream_event",
      event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_inc_2", name: "mcp__opencodex__probe_echo" } },
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    await clock.advanceTimersByTime(300);

    expect(events.some(e => e.type === "done")).toBe(false);
    expect(parked.child.killed).toBe(false);

    parked.pushFrame({ type: "assistant", message: { stop_reason: "tool_use", content: [] } });
    await turnPromise;

    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error", status: 502, message: "Coding-agent CLI ended with an incomplete tool call." });
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("12. sixteen separate assistant tool calls all survive to downstream events", async () => {
    const toolNames = Array.from({ length: 16 }, (_, i) => `tool_${i}`);
    const { spawned, clock, parked, adapter } = setupParkedQoder(toolNames);
    const events: AdapterEvent[] = [];
    const turnPromise = adapter.runTurn!(toolRequest(toolNames), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, e => events.push(e));

    await spawned.promise;
    parked.pushFrame({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] });
    for (let i = 0; i < 16; i++) {
      parked.pushFrame({
        type: "assistant",
        message: { stop_reason: i === 15 ? "tool_use" : null, content: [{ type: "tool_use", id: `call_16_${i}`, name: `mcp__opencodex__tool_${i}`, input: { value: String(i) } }] },
      });
    }
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    await clock.advanceTimersByTime(300);
    await turnPromise;

    const starts = events.filter(e => e.type === "tool_call_start");
    expect(starts).toHaveLength(16);
    for (let i = 0; i < 16; i++) {
      expect(starts[i]).toMatchObject({ id: `call_16_${i}`, name: `tool_${i}` });
    }
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
  });

  test("scaffold refusal suppresses authoritative success terminal", async () => {
    const { spawned, clock, parked, adapter } = setupParkedQoder();
    const events: AdapterEvent[] = [];
    const turnPromise = adapter.runTurn!(toolRequest(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, e => events.push(e));

    await spawned.promise;
    parked.pushFrame({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] });
    parked.pushFrame({
      type: "assistant",
      message: { content: [{ type: "text", text: "tail</system-reminder>" }] },
    });
    parked.pushFrame({
      type: "assistant",
      message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "call_scaffold_1", name: "mcp__opencodex__probe_echo", input: { value: "S" } }] },
    });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    await clock.advanceTimersByTime(300);
    await turnPromise;

    expect(events.some(e => e.type === "done")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "vendor_scaffold_detected" });
  });

  test("EOF after a non-selected message_stop still fails without Qoder stop_reason", async () => {
    const { spawned, parked, adapter } = setupParkedQoder();
    const events: AdapterEvent[] = [];
    const turnPromise = adapter.runTurn!(
      toolRequest(),
      { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      e => events.push(e),
    );

    await spawned.promise;
    parked.pushFrame({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] });
    parked.pushFrame({
      type: "assistant",
      message: {
        stop_reason: null,
        content: [{ type: "tool_use", id: "call_eof_1", name: "mcp__opencodex__probe_echo", input: { value: "EOF" } }],
      },
    });
    parked.pushFrame({ type: "result", subtype: "success", is_error: false });
    parked.pushFrame({ type: "stream_event", event: { type: "message_stop" } });
    parked.end();
    await turnPromise;

    expect(events.some(e => e.type === "done")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "protocol_error",
      status: 502,
      message: expect.stringContaining("authoritative tool-turn stop"),
    });
  });

  test("required tool without tool call fails with tool_call_required", async () => {
    const { spawned, clock, parked, adapter } = setupParkedQoder();
    const events: AdapterEvent[] = [];
    const req = parsed({
      options: { toolChoice: "required" },
      context: {
        messages: [{ role: "user", content: "must call", timestamp: 0 }],
        tools: [{ name: "probe_echo", description: "Echo", parameters: { type: "object" } }],
      },
    });
    const turnPromise = adapter.runTurn!(req, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, e => events.push(e));

    await spawned.promise;
    parked.pushFrame({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] });
    parked.pushFrame({
      type: "assistant",
      message: { content: [{ type: "text", text: "text only" }] },
    });
    parked.pushFrame({ type: "result", subtype: "success", is_error: false });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    await turnPromise;

    expect(clock.scheduled.filter(s => s.delay === 300)).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "tool_call_required", status: 502 });
  });

});
