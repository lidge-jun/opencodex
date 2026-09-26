import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createCodeBuddyAdapter, type SpawnFn } from "../../src/adapters/codebuddy/adapter";
import { buildCodeBuddyToolBridge } from "../../src/adapters/codebuddy/tool-bridge";
import { CODEBUDDY_GLOBAL_PROFILE, clearCodeBuddyBinaryCache } from "../../src/adapters/codebuddy/profiles";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const enc = new TextEncoder();

beforeEach(() => clearCodeBuddyBinaryCache());

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
}

function fakeChild(stdout: Uint8Array[]): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Readable.from(stdout);
  child.stderr = Readable.from([]);
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => { child.killed = true; return true; };
  setTimeout(() => { child.exitCode = 0; child.emit("close", 0); }, 3);
  return child;
}

function tool(name: string): OcxTool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: { a: { type: "number" } } },
  };
}

function parsed(tools: OcxTool[] = []): OcxParsedRequest {
  return {
    modelId: "kimi-k3-1",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: "Use a tool", timestamp: 1 }],
      ...(tools.length > 0 ? { tools } : {}),
    },
  } as OcxParsedRequest;
}

function provider(): OcxProviderConfig {
  return {
    adapter: "codebuddy",
    baseUrl: CODEBUDDY_GLOBAL_PROFILE.canonicalBaseUrl,
    apiKey: "cb-global-key",
    reasoningEfforts: ["low", "high", "xhigh", "max"],
  } as OcxProviderConfig;
}

function incoming() {
  return { headers: new Headers(), translatorBudget: createTestTranslatorBudget() };
}

async function run(adapter: ReturnType<typeof createCodeBuddyAdapter>, p: OcxParsedRequest): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(p, incoming(), e => events.push(e));
  return events;
}

function frameLines(frames: unknown[]): Uint8Array[] {
  return frames.map(f => enc.encode(JSON.stringify(f) + "\n"));
}

const INIT_OK = { type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] };
const INIT_EMPTY = { type: "system", subtype: "init", mcp_servers: [] };

function toolUseStart(name: string, id = "tu_1"): unknown {
  return { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id, name } } };
}
function inputJsonDelta(part: string): unknown {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: part } } };
}
const BLOCK_STOP = { type: "stream_event", event: { type: "content_block_stop" } };
const MESSAGE_STOP = { type: "stream_event", event: { type: "message_stop" } };

describe("CodeBuddy capture-only tool bridge turn", () => {
  test.each(["catalog.json", "mcp.json"])("bridge staging failure in %s is private and cleans both staging directories", async failedFile => {
    const before = new Set(readdirSync(tmpdir()));
    const promptDirs: string[] = [];
    const writes: string[] = [];
    let bridgeDir: string | undefined;
    let spawns = 0;
    const adapter = createCodeBuddyAdapter(provider(), {
      which: () => "/usr/bin/codebuddy",
      spawn: () => { spawns++; throw new Error("must not spawn after staging failure"); },
      writeToolBridgeFile: async (path, data, options) => {
        const target = String(path);
        bridgeDir = dirname(target);
        writes.push(basename(target));
        if (basename(target) === failedFile) {
          promptDirs.push(...readdirSync(tmpdir())
            .filter(name => name.startsWith("ocx-codebuddy-prompt-") && !before.has(name))
            .map(name => join(tmpdir(), name)));
          throw new Error(`ENOSPC private-path=${target} token=fixture-sensitive-value`);
        }
        await writeFile(path, data, options);
      },
    });
    const events = await run(adapter, parsed([tool("exec")]));
    expect(writes).toEqual(failedFile === "catalog.json" ? ["catalog.json"] : ["catalog.json", "mcp.json"]);
    expect(events).toEqual([{
      type: "error",
      message: "Coding-agent tool bridge could not be staged securely.",
      status: 500,
      errorType: "server_error",
      code: "tool_bridge_setup_failed",
      retryable: false,
    }]);
    expect(spawns).toBe(0);
    expect(bridgeDir).toBeDefined();
    expect(existsSync(bridgeDir!)).toBe(false);
    expect(promptDirs).toHaveLength(1);
    expect(existsSync(promptDirs[0]!)).toBe(false);
  });

  test.each(["catalog.json", "mcp.json"])("pre-existing %s fails exclusive bridge staging before spawn", async occupiedFile => {
    const before = new Set(readdirSync(tmpdir()));
    const promptDirs: string[] = [];
    let bridgeDir: string | undefined;
    let spawns = 0;
    let writeErrorCode: string | undefined;
    const writeOptions: unknown[] = [];
    const adapter = createCodeBuddyAdapter(provider(), {
      which: () => "/usr/bin/codebuddy",
      spawn: () => { spawns++; throw new Error("must not spawn"); },
      writeToolBridgeFile: async (path, data, options) => {
        const target = String(path);
        bridgeDir = dirname(target);
        writeOptions.push(options);
        if (basename(target) === occupiedFile) {
          promptDirs.push(...readdirSync(tmpdir())
            .filter(name => name.startsWith("ocx-codebuddy-prompt-") && !before.has(name))
            .map(name => join(tmpdir(), name)));
          await writeFile(path, "occupied", { flag: "wx", mode: 0o600 });
        }
        try {
          await writeFile(path, data, options);
        } catch (error) {
          writeErrorCode = (error as NodeJS.ErrnoException).code;
          throw error;
        }
      },
    });
    const events = await run(adapter, parsed([tool("exec")]));
    expect(writeOptions).toEqual(Array.from({ length: occupiedFile === "catalog.json" ? 1 : 2 }, () =>
      expect.objectContaining({ flag: "wx", mode: 0o600 }),
    ));
    expect(writeErrorCode).toBe("EEXIST");
    expect(events).toEqual([{
      type: "error",
      message: "Coding-agent tool bridge could not be staged securely.",
      status: 500,
      errorType: "server_error",
      code: "tool_bridge_setup_failed",
      retryable: false,
    }]);
    expect(spawns).toBe(0);
    expect(bridgeDir).toBeDefined();
    expect(existsSync(bridgeDir!)).toBe(false);
    expect(promptDirs).toHaveLength(1);
    expect(existsSync(promptDirs[0]!)).toBe(false);
  });

  test("advertises the catalog, captures the call, renames it, and ends the leg at message_stop", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildCodeBuddyToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const wireName = bridge.emittedNameMap.get(cliName)!;

    let child: FakeChild | undefined;
    let seenArgs: readonly string[] = [];
    const spawn: SpawnFn = (_cmd, args) => {
      seenArgs = args;
      child = fakeChild(frameLines([
        INIT_OK,
        toolUseStart(cliName),
        inputJsonDelta('{"a":'),
        inputJsonDelta("1}"),
        BLOCK_STOP,
        MESSAGE_STOP,
        // Deliberately no result frame: in production the CLI parks on the
        // never-answering capture server after message_stop.
      ]));
      return child as unknown as ChildProcess;
    };
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);

    expect(seenArgs).toContain("--strict-mcp-config");
    expect(seenArgs[seenArgs.indexOf("--tools") + 1]).toBe("");
    const allowedIdx = seenArgs.indexOf("--allowedTools");
    expect(allowedIdx).toBeGreaterThanOrEqual(0);
    expect(seenArgs[allowedIdx + 1]).toBe(cliName);
    const mcpIdx = seenArgs.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    expect(seenArgs[mcpIdx + 1]).toContain("ocx-coding-agent-tools-");
    // The private temp dir is removed once the turn settles.
    expect(existsSync(dirname(seenArgs[mcpIdx + 1]!))).toBe(false);

    expect(events.map(e => e.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call_end",
      "done",
    ]);
    expect(events[0]).toMatchObject({ type: "tool_call_start", name: wireName });
    expect(events[4]).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
    expect(child?.killed).toBe(true);
  });

  test("a request without tools keeps the text-only arg shape", async () => {
    let seenArgs: readonly string[] = [];
    const spawn: SpawnFn = (_cmd, args) => {
      seenArgs = args;
      return fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess;
    };
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, parsed());
    expect(seenArgs).not.toContain("--mcp-config");
    expect(seenArgs).not.toContain("--allowedTools");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("a tool-bridge turn reports the partial usage observed before message_stop", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildCodeBuddyToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const spawn: SpawnFn = (_cmd, _args) => fakeChild(frameLines([
      INIT_OK,
      { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 12, output_tokens: 5 } } },
      toolUseStart(cliName),
      inputJsonDelta("{}"),
      BLOCK_STOP,
      { type: "stream_event", event: { type: "message_delta", delta: {}, usage: { input_tokens: 15, output_tokens: 4, cache_read_input_tokens: 3 } } },
      MESSAGE_STOP,
      // No result frame: the CLI parks on the never-answering capture server after message_stop.
    ])) as unknown as ChildProcess;
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "tool_use",
      endTurn: false,
      usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20, cachedInputTokens: 3, cacheReadInputTokens: 3 },
    });
  });

  test("a tool-bridge turn records input tokens from message_start", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildCodeBuddyToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const spawn: SpawnFn = (_cmd, _args) => fakeChild(frameLines([
      INIT_OK,
      { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 31, output_tokens: 0 } } } },
      toolUseStart(cliName),
      inputJsonDelta("{}"),
      BLOCK_STOP,
      { type: "stream_event", event: { type: "message_delta", delta: {}, usage: { input_tokens: 31, output_tokens: 6 } } },
      MESSAGE_STOP,
    ])) as unknown as ChildProcess;
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "tool_use",
      usage: { inputTokens: 31, outputTokens: 6, totalTokens: 37 },
    });
  });

  test("message_stop with an incomplete tool call fails with protocol_error", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildCodeBuddyToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const spawn: SpawnFn = (_cmd, _args) => fakeChild(frameLines([
      INIT_OK,
      toolUseStart(cliName),
      inputJsonDelta("{}"),
      // Missing BLOCK_STOP (tool_call_end not emitted, so toolCallStarts=1, completedToolCalls=0)
      MESSAGE_STOP,
    ])) as unknown as ChildProcess;
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "protocol_error",
      status: 502,
      retryable: false,
    });
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("a terminal result with an incomplete tool call fails with protocol_error", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildCodeBuddyToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const spawn: SpawnFn = (_cmd, _args) => fakeChild(frameLines([
      INIT_OK,
      toolUseStart(cliName),
      inputJsonDelta("{}"),
      // Missing BLOCK_STOP (toolCallStarts=1, completedToolCalls=0) and no message_stop: the
      // stream ends via a terminal result frame, which previously emitted done and let the
      // open call slip through as a successful turn.
      { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 7, output_tokens: 2 } },
    ])) as unknown as ChildProcess;
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "protocol_error",
      status: 502,
      retryable: false,
    });
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("interleaved parallel tool calls are serialized per block and complete the leg", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildCodeBuddyToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const wireName = bridge.emittedNameMap.get(cliName)!;
    const startAt = (index: number, id: string) => ({
      type: "stream_event",
      event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name: cliName } },
    });
    const deltaAt = (index: number, part: string) => ({
      type: "stream_event",
      event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: part } },
    });
    const stopAt = (index: number) => ({ type: "stream_event", event: { type: "content_block_stop", index } });
    let child: FakeChild | undefined;
    const spawn: SpawnFn = (_cmd, _args) => {
      child = fakeChild(frameLines([
        INIT_OK,
        // CodeBuddy emits genuinely interleaved blocks for parallel calls: starts arrive
        // before earlier blocks stop and argument deltas alternate across indices (captured
        // from the live CLI on 2026-09-25). Single-slot accounting led to a spurious
        // "incomplete tool call" 502 at message_stop.
        startAt(1, "tu_a"),
        startAt(2, "tu_b"),
        deltaAt(1, "{\"command\":[\"ec"),
        deltaAt(2, "{\"command\":[\"ls"),
        deltaAt(1, "ho\"]}"),
        deltaAt(2, "\"]}"),
        stopAt(2),
        stopAt(1),
        MESSAGE_STOP,
      ]));
      return child as unknown as ChildProcess;
    };
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);
    expect(events.map(e => e.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call_end",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call_end",
      "done",
    ]);
    // Blocks are emitted atomically in stop order: tu_b closed first.
    expect(events[0]).toMatchObject({ type: "tool_call_start", id: "tu_b", name: wireName });
    expect(events[1]).toMatchObject({ arguments: "{\"command\":[\"ls" });
    expect(events[4]).toMatchObject({ type: "tool_call_start", id: "tu_a", name: wireName });
    expect(events[5]).toMatchObject({ arguments: "{\"command\":[\"ec" });
    expect(events[6]).toMatchObject({ arguments: "ho\"]}" });
    expect(events[8]).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
    expect(child?.killed).toBe(true);
  });

  test("an indexless argument delta with two open tool blocks fails before emitting a tool call", async () => {
    const p = parsed([tool("exec")]);
    const cliName = [...buildCodeBuddyToolBridge(p).emittedNameMap.keys()][0]!;
    const frame = (event: Record<string, unknown>) => ({ type: "stream_event", event });
    let child: FakeChild | undefined;
    const spawn: SpawnFn = () => {
      child = fakeChild(frameLines([
        INIT_OK,
        frame({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_a", name: cliName } }),
        frame({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_b", name: cliName } }),
        frame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a":' } }),
        inputJsonDelta("2"),
        frame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "1}" } }),
        frame({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"a":3}' } }),
        frame({ type: "content_block_stop", index: 1 }),
        frame({ type: "content_block_stop", index: 2 }),
        MESSAGE_STOP,
      ]));
      return child as unknown as ChildProcess;
    };
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);
    // Dropping the ambiguous "2" would still leave valid JSON ({"a":1}) and a successful turn.
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "protocol_error", status: 502, retryable: false })]);
    expect(child?.killed).toBe(true);
  });

  test("a parallel batch on one shared block index completes every call in the leg", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildCodeBuddyToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const wireName = bridge.emittedNameMap.get(cliName)!;
    const start = (id: string) => ({
      type: "stream_event",
      event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id, name: cliName } },
    });
    const delta = (part: string) => ({
      type: "stream_event",
      event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: part } },
    });
    let child: FakeChild | undefined;
    const spawn: SpawnFn = (_cmd, _args) => {
      child = fakeChild(frameLines([
        INIT_OK,
        // Live capture 2026-09-26 (CodeBuddy 2.158.0, kimi-k3-1): a parallel batch reuses one
        // content-block index — alpha starts, streams its complete arguments, then beta starts
        // on the same index with no stop for alpha; only the final block receives a stop.
        start("tu_a"),
        delta("{\"command\":[\"echo\"]}"),
        start("tu_b"),
        delta("{\"command\":[\"ls\"]}"),
        { type: "stream_event", event: { type: "content_block_stop", index: 2 } },
        MESSAGE_STOP,
      ]));
      return child as unknown as ChildProcess;
    };
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);
    expect(events.map(e => e.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "done",
    ]);
    expect(events[0]).toMatchObject({ type: "tool_call_start", id: "tu_a", name: wireName });
    expect(events[1]).toMatchObject({ arguments: "{\"command\":[\"echo\"]}" });
    expect(events[3]).toMatchObject({ type: "tool_call_start", id: "tu_b", name: wireName });
    expect(events[4]).toMatchObject({ arguments: "{\"command\":[\"ls\"]}" });
    expect(events[6]).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
    expect(child?.killed).toBe(true);
  });

  test("a tool call before the init frame fails closed with tool_bridge_init_missing", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildCodeBuddyToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const spawn: SpawnFn = (_cmd, _args) => fakeChild(frameLines([
      // A complete tool call arrives before the init frame: the bridge was never validated
      // when the model started calling tools.
      toolUseStart(cliName),
      inputJsonDelta("{}"),
      BLOCK_STOP,
      INIT_OK,
      MESSAGE_STOP,
    ])) as unknown as ChildProcess;
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "tool_bridge_init_missing",
      status: 502,
      retryable: false,
    });
    // No tool lifecycle events surface from an unvalidated bridge.
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("a tool start before init stays invalid when the block stops after init", async () => {
    const p = parsed([tool("exec")]);
    const cliName = [...buildCodeBuddyToolBridge(p).emittedNameMap.keys()][0]!;
    const adapter = createCodeBuddyAdapter(provider(), {
      spawn: () => fakeChild(frameLines([
        toolUseStart(cliName),
        INIT_OK,
        BLOCK_STOP,
        MESSAGE_STOP,
      ])) as unknown as ChildProcess,
      which: () => "/usr/bin/codebuddy",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "tool_bridge_init_missing",
      status: 502,
      retryable: false,
    });
    expect(events.some(e => e.type === "tool_call_start" || e.type === "done")).toBe(false);
  });

  test("a result frame before message_stop defers to the synthesized tool_use done", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildCodeBuddyToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    let child: FakeChild | undefined;
    const spawn: SpawnFn = (_cmd, _args) => {
      child = fakeChild(frameLines([
        INIT_OK,
        toolUseStart(cliName),
        inputJsonDelta("{}"),
        BLOCK_STOP,
        // The CLI settles with a successful result while every captured call is already
        // complete, instead of parking on the never-answering capture server.
        { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 42, output_tokens: 8 } },
        MESSAGE_STOP,
      ]));
      return child as unknown as ChildProcess;
    };
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);

    // The result-derived done(stop) must never surface: the leg ends as done(tool_use) with
    // the vendor result frame's usage folded in.
    expect(events.map(e => e.type)).toEqual([
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "tool_use",
      endTurn: false,
      usage: { inputTokens: 42, outputTokens: 8, totalTokens: 50 },
    });
    expect(events.some(e => e.type === "done" && e.stopReason === "stop")).toBe(false);
    expect(child?.killed).toBe(true);
  });

  test("a deferred result without message_stop fails closed with protocol_error", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildCodeBuddyToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const spawn: SpawnFn = (_cmd, _args) => fakeChild(frameLines([
      INIT_OK,
      toolUseStart(cliName),
      inputJsonDelta("{}"),
      BLOCK_STOP,
      // Result arrives but message_stop never does: the stream ends before the synthesized
      // terminal event can be emitted.
      { type: "result", subtype: "success", is_error: false },
    ])) as unknown as ChildProcess;
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "protocol_error",
      status: 502,
      retryable: false,
    });
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("tool_choice required without a captured call fails closed instead of a text done", async () => {
    const p = parsed([tool("exec")]);
    p.options = { toolChoice: "required" } as OcxParsedRequest["options"];
    let child: FakeChild | undefined;
    const spawn: SpawnFn = (_cmd, _args) => {
      child = fakeChild(frameLines([INIT_OK, { type: "result", subtype: "success" }]));
      return child as unknown as ChildProcess;
    };
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "tool_call_required",
      status: 502,
      retryable: false,
    });
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("tool_choice auto keeps a text-only result as a normal done", async () => {
    const p = parsed([tool("exec")]);
    const spawn: SpawnFn = () => fakeChild(frameLines([INIT_OK, { type: "result", subtype: "success" }])) as unknown as ChildProcess;
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  });

  test("tool_choice auto refuses a successful result without bridge init", async () => {
    const adapter = createCodeBuddyAdapter(provider(), {
      spawn: () => fakeChild(frameLines([{ type: "result", subtype: "success" }])) as unknown as ChildProcess,
      which: () => "/usr/bin/codebuddy",
    });
    const events = await run(adapter, parsed([tool("exec")]));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "tool_bridge_init_missing", status: 502, retryable: false });
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("a complete assistant tool block without partial capture fails closed", async () => {
    const p = parsed([tool("exec")]);
    const cliName = [...buildCodeBuddyToolBridge(p).emittedNameMap.keys()][0]!;
    const adapter = createCodeBuddyAdapter(provider(), {
      spawn: () => fakeChild(frameLines([
        INIT_OK,
        { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: cliName, input: { a: 1 } }] } },
        MESSAGE_STOP,
        { type: "result", subtype: "success" },
      ])) as unknown as ChildProcess,
      which: () => "/usr/bin/codebuddy",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error", status: 502, retryable: false });
    expect(events.some(e => e.type === "done" || e.type === "tool_call_start")).toBe(false);
  });

  test("a complete assistant repeat of a captured partial tool does not duplicate it", async () => {
    const p = parsed([tool("exec")]);
    const cliName = [...buildCodeBuddyToolBridge(p).emittedNameMap.keys()][0]!;
    const adapter = createCodeBuddyAdapter(provider(), {
      spawn: () => fakeChild(frameLines([
        INIT_OK,
        toolUseStart(cliName),
        inputJsonDelta('{"a":1}'),
        BLOCK_STOP,
        { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: cliName, input: { a: 1 } }] } },
        MESSAGE_STOP,
      ])) as unknown as ChildProcess,
      which: () => "/usr/bin/codebuddy",
    });
    const events = await run(adapter, p);
    expect(events.map(e => e.type)).toEqual(["tool_call_start", "tool_call_delta", "tool_call_end", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use" });
  });

  test("a mixed assistant fallback with an additional uncaptured tool fails closed", async () => {
    const p = parsed([tool("exec")]);
    const cliName = [...buildCodeBuddyToolBridge(p).emittedNameMap.keys()][0]!;
    const adapter = createCodeBuddyAdapter(provider(), {
      spawn: () => fakeChild(frameLines([
        INIT_OK,
        toolUseStart(cliName),
        inputJsonDelta('{}'),
        BLOCK_STOP,
        { type: "assistant", message: { role: "assistant", content: [
          { type: "tool_use", id: "tu_1", name: cliName, input: {} },
          { type: "tool_use", id: "tu_2", name: cliName, input: {} },
        ] } },
        MESSAGE_STOP,
      ])) as unknown as ChildProcess,
      which: () => "/usr/bin/codebuddy",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "protocol_error", retryable: false });
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("a synchronous spawn throw still removes the private temp dir", async () => {
    const p = parsed([tool("exec")]);
    // Diff-based so a concurrently running proxy's own bridge dirs can never flake this.
    const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith("ocx-coding-agent-tools-")));
    const spawn: SpawnFn = () => { throw new Error("spawn exploded"); };
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);
    expect(events[0]).toMatchObject({ type: "error", code: "cli_spawn_failed" });
    const leftovers = readdirSync(tmpdir())
      .filter(name => name.startsWith("ocx-coding-agent-tools-") && !before.has(name));
    expect(leftovers).toEqual([]);
  });

  test("an init frame without the bridge server fails closed", async () => {
    const adapter = createCodeBuddyAdapter(provider(), {
      spawn: () => fakeChild(frameLines([INIT_EMPTY])) as unknown as ChildProcess,
      which: () => "/usr/bin/codebuddy",
    });
    const events = await run(adapter, parsed([tool("exec")]));
    expect(events[0]).toMatchObject({ type: "error", code: "tool_bridge_init_mismatch", retryable: false });
  });

  test("a tool call that precedes the init handshake fails closed", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildCodeBuddyToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    // The call arrives before system/init acknowledged the bridge server, then the handshake and a
    // clean stop follow. The later init frame must not retroactively legitimize the early call.
    const adapter = createCodeBuddyAdapter(provider(), {
      spawn: () => fakeChild(frameLines([
        toolUseStart(cliName),
        inputJsonDelta("{}"),
        BLOCK_STOP,
        INIT_OK,
        MESSAGE_STOP,
      ])) as unknown as ChildProcess,
      which: () => "/usr/bin/codebuddy",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "tool_bridge_init_missing",
      status: 502,
      retryable: false,
    });
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("a tool call outside the advertised catalog fails closed", async () => {
    const adapter = createCodeBuddyAdapter(provider(), {
      spawn: () => fakeChild(frameLines([
        INIT_OK,
        toolUseStart("mcp__opencodex__evil"),
        inputJsonDelta("{}"),
        BLOCK_STOP,
        MESSAGE_STOP,
      ])) as unknown as ChildProcess,
      which: () => "/usr/bin/codebuddy",
    });
    const events = await run(adapter, parsed([tool("exec")]));
    expect(events[0]).toMatchObject({ type: "error", code: "undeclared_tool_call", retryable: false });
  });

  test("more captured calls than the turn limit fails closed", async () => {
    const p = parsed([tool("exec")]);
    const bridge = buildCodeBuddyToolBridge(p);
    const cliName = [...bridge.emittedNameMap.keys()][0]!;
    const frames: unknown[] = [INIT_OK];
    for (let i = 0; i < 17; i += 1) {
      frames.push(toolUseStart(cliName, `tu_${i}`));
      frames.push(BLOCK_STOP);
    }
    frames.push(MESSAGE_STOP);
    const adapter = createCodeBuddyAdapter(provider(), {
      spawn: () => fakeChild(frameLines(frames)) as unknown as ChildProcess,
      which: () => "/usr/bin/codebuddy",
    });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "tool_call_limit" });
  });
});
