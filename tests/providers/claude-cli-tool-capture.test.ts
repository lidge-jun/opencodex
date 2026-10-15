import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createClaudeCliAdapter, findClaudeCliBinary } from "../../src/adapters/claude-cli/adapter";
import { CLAUDE_CLI_PROFILE, clearClaudeCliBinaryCache } from "../../src/adapters/claude-cli/profiles";
import { buildCodeBuddyToolBridge } from "../../src/adapters/codebuddy/tool-bridge";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const enc = new TextEncoder();

// The binary-discovery cache is module-level (a production perf seam); reset it so a test that
// reports a missing CLI cannot mask a later test's injected binary.
beforeEach(() => clearClaudeCliBinaryCache());

test("Claude native install is found when a service PATH misses it", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-claude-home-"));
  try {
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const native = join(bin, "claude.exe");
    writeFileSync(native, "");
    expect(findClaudeCliBinary("claude", () => undefined, home, "win32")).toBe(native);
    expect(findClaudeCliBinary("claude", () => "C:\\on-path\\claude.exe", home, "win32")).toBe("C:\\on-path\\claude.exe");
    expect(findClaudeCliBinary("other", () => undefined, home, "win32")).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
  written: string[];
}

function fakeChild(stdout: Uint8Array[], opts: { stderr?: string; exitCode?: number } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Readable.from(stdout);
  child.stderr = Readable.from(opts.stderr ? [enc.encode(opts.stderr)] : []);
  child.written = [];
  child.stdin = new Writable({ write(chunk, _enc, cb) { child.written.push(String(chunk)); cb(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => { child.killed = true; return true; };
  setTimeout(() => { child.exitCode = opts.exitCode ?? 0; child.emit("close", opts.exitCode ?? 0); }, 3);
  return child;
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "claude-cli",
    baseUrl: CLAUDE_CLI_PROFILE.canonicalBaseUrl,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    ...overrides,
  } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "claude-sonnet-5",
    stream: true,
    options: {},
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    ...overrides,
  } as OcxParsedRequest;
}

function incoming(abortSignal?: AbortSignal) {
  return { headers: new Headers(), translatorBudget: createTestTranslatorBudget(), ...(abortSignal ? { abortSignal } : {}) };
}

async function run(adapter: ReturnType<typeof createClaudeCliAdapter>, p: OcxParsedRequest): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(p, incoming(), e => events.push(e));
  return events;
}


describe("claude-cli returns tool calls to the external client", () => {
  test("restores an exact wire alias after tool history without granting CLI permissions", async () => {
    const request = parsed({ context: {
      messages: [
        { role: "user", content: "Run the next command", timestamp: 0 },
        { role: "assistant", content: [{ type: "toolCall", id: "prior", name: "bash", arguments: { command: "echo prior" } }], timestamp: 1 },
        { role: "toolResult", toolCallId: "prior", toolName: "bash", content: "prior", isError: false, timestamp: 2 },
      ],
      tools: [{ name: "bash", description: "Pi shell", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
    } });
    const original = JSON.stringify(request);
    const frames = [
      { type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "next", name: "bash" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"echo next"}' } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "message_stop" } },
    ];
    const child = fakeChild(frames.map(frame => enc.encode(JSON.stringify(frame) + "\n")));
    let seenArgs: readonly string[] = [];
    let prompt = "";
    const adapter = createClaudeCliAdapter(provider(), { which: () => "/usr/bin/claude", spawn: (_file, args) => {
      seenArgs = args;
      prompt = readFileSync(args[args.indexOf("--system-prompt-file") + 1]!, "utf8");
      return child as unknown as ChildProcess;
    }, killGraceMs: 20 });
    const events = await run(adapter, request);
    expect(events[0]).toMatchObject({ type: "tool_call_start", name: "bash", id: "next" });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use" });
    expect(seenArgs[seenArgs.indexOf("--allowedTools") + 1]).toBe("mcp__opencodex__bash");
    expect(seenArgs[seenArgs.indexOf("--tools") + 1]).toBe("");
    expect(prompt).toContain('"bash":"mcp__opencodex__bash"');
    expect(child.written.join("")).toContain("[Tool call: mcp__opencodex__bash");
    expect(child.written.join("")).not.toContain("[Tool call: bash");
    expect(JSON.stringify(request)).toBe(original);
  });

  test.each(["Bash", "unknown_tool", "mcp__opencodex__unknown_tool", "write"])(
    "rejects the undeclared or filtered-out name %s", async name => {
      const request = parsed({ options: { toolChoice: { type: "function", name: "read" } }, context: {
        messages: [{ role: "user", content: "Read only", timestamp: 0 }],
        tools: ["read", "write"].map(name => ({ name, description: `Pi ${name}`, parameters: { type: "object" } })),
      } });
      const frames = [
        { type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] },
        { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "unlisted", name } } },
        { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } } },
        { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
        { type: "stream_event", event: { type: "message_stop" } },
      ];
      const adapter = createClaudeCliAdapter(provider(), { which: () => "/usr/bin/claude", spawn: () => fakeChild(
        frames.map(frame => enc.encode(JSON.stringify(frame) + "\n")),
      ) as unknown as ChildProcess, killGraceMs: 20 });
      const events = await run(adapter, request);
      expect(events[0]).toMatchObject({ type: "error", code: "undeclared_tool_call" });
      expect(events.some(event => event.type === "tool_call_start" || event.type === "done")).toBe(false);
    },
  );

  test("captures an advertised tool without executing it in the CLI", async () => {
    const request = parsed({
      context: {
        messages: [{ role: "user", content: "Read the fixture", timestamp: 0 }],
        tools: [{ name: "read_file", description: "Read a file", parameters: {
          type: "object", properties: { path: { type: "string" } }, required: ["path"],
        } }],
      },
    });
    const cliName = [...buildCodeBuddyToolBridge(request).emittedNameMap.keys()][0]!;
    const frames = [
      { type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] },
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "tu_1", name: cliName } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"path":"fixture.txt"}' } } },
      { type: "stream_event", event: { type: "content_block_stop" } },
      { type: "stream_event", event: { type: "message_stop" } },
    ];
    let seenArgs: readonly string[] = [];
    let prompt = "";
    const child = fakeChild(frames.map(frame => enc.encode(JSON.stringify(frame) + "\n")));
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/usr/bin/claude",
      spawn: (_command, args) => {
        seenArgs = args;
        prompt = readFileSync(args[args.indexOf("--system-prompt-file") + 1]!, "utf8");
        return child as unknown as ChildProcess;
      },
      killGraceMs: 20,
    });
    const events = await run(adapter, request);
    expect(seenArgs[seenArgs.indexOf("--tools") + 1]).toBe("");
    expect(seenArgs).toContain("--strict-mcp-config");
    expect(seenArgs[seenArgs.indexOf("--allowedTools") + 1]).toBe(cliName);
    expect(seenArgs).toContain("--mcp-config");
    expect(seenArgs).not.toContain("--dangerously-skip-permissions");
    expect(prompt).toContain("external client performs approval and execution");
    expect(events.map(event => event.type)).toEqual([
      "tool_call_start", "tool_call_delta", "tool_call_end", "done",
    ]);
    expect(events[0]).toMatchObject({ type: "tool_call_start", name: "read_file" });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
    expect(child.killed).toBe(true);
  });

  test("replayed calls keep their namespace when two tools share a name", async () => {
    const tools = ["alpha", "beta"].map(namespace => ({ name: "search", namespace, description: `${namespace} search`, parameters: { type: "object" } }));
    const request = parsed({ context: {
      messages: [
        { role: "user", content: "Search beta", timestamp: 0 },
        { role: "assistant", content: [{ type: "toolCall", id: "prior", name: "search", namespace: "beta", arguments: { q: "x" } }], timestamp: 1 },
        { role: "toolResult", toolCallId: "prior", toolName: "search", content: "beta result", isError: false, timestamp: 2 },
      ],
      tools,
    } } as Partial<OcxParsedRequest>);
    const names = new Map([...buildCodeBuddyToolBridge(request).emittedNameMap].map(([cli, wire]) => [wire, cli]));
    const beta = names.get("beta__search")!;
    expect(beta).toBeDefined();
    expect(beta).not.toBe(names.get("alpha__search"));
    const child = fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]);
    const adapter = createClaudeCliAdapter(provider(), { which: () => "/usr/bin/claude", spawn: () => child as unknown as ChildProcess });
    await run(adapter, request);
    expect(child.written.join("")).toContain(`[Tool call: ${beta}`);
    expect(child.written.join("")).not.toContain("[Tool call: search");
  });

  test("tool_choice none does not expose the MCP catalog", async () => {
    let seenArgs: readonly string[] = [];
    const request = parsed({
      options: { toolChoice: "none" },
      context: {
        messages: [{ role: "user", content: "Answer only", timestamp: 0 }],
        tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
      },
    });
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/usr/bin/claude",
      spawn: (_command, args) => {
        seenArgs = args;
        return fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess;
      },
    });
    const events = await run(adapter, request);
    expect(seenArgs).not.toContain("--mcp-config");
    expect(seenArgs).not.toContain("--allowedTools");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("the next turn receives the client's executed tool result", async () => {
    const child = fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]);
    const request = parsed({
      context: {
        messages: [
          { role: "user", content: "Read the fixture", timestamp: 0 },
          { role: "assistant", content: [{ type: "toolCall", id: "tu_1", name: "read_file", arguments: { path: "fixture.txt" } }], timestamp: 1 },
          { role: "toolResult", toolCallId: "tu_1", toolName: "read_file", content: "fixture says 42", isError: false, timestamp: 2 },
        ],
      },
    });
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/usr/bin/claude",
      spawn: () => child as unknown as ChildProcess,
    });
    const events = await run(adapter, request);
    expect(child.written.join("")).toContain("fixture says 42");
    expect(child.written.join("")).toContain("tu_1");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });
});
