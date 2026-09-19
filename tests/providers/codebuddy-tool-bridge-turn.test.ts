import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
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

  test("tool_choice required without a captured call fails closed instead of a text done", async () => {
    const p = parsed([tool("exec")]);
    p.options = { toolChoice: "required" } as OcxParsedRequest["options"];
    let child: FakeChild | undefined;
    const spawn: SpawnFn = (_cmd, _args) => {
      child = fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]);
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
    const spawn: SpawnFn = () => fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess;
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, p);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
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
