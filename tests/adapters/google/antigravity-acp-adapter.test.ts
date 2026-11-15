import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createAntigravityAcpAdapter, findAntigravityCliBinary } from "../../../src/adapters/antigravity-acp/adapter";
import { mapAcpUsage, planAcpSession } from "../../../src/adapters/antigravity-acp/acp";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

type Frame = Record<string, unknown>;

interface FakeAgy extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: Writable;
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
  kill: (signal?: string) => boolean;
  received: Frame[];
  reply: (frame: Frame) => void;
}

/** A fake `agy acp`: every frame the adapter writes is recorded and handed to `script`. */
function fakeAgy(script: (frame: Frame, agy: FakeAgy) => void): FakeAgy {
  const agy = new EventEmitter() as FakeAgy;
  agy.stdout = new PassThrough();
  agy.stderr = new PassThrough();
  agy.pid = 4242;
  agy.exitCode = null;
  agy.signalCode = null;
  agy.killed = false;
  agy.received = [];
  agy.reply = frame => { agy.stdout.write(`${JSON.stringify(frame)}\n`); };
  let pending = "";
  agy.stdin = new Writable({
    write(chunk, _encoding, callback) {
      pending += String(chunk);
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        const frame = JSON.parse(pending.slice(0, index)) as Frame;
        pending = pending.slice(index + 1);
        agy.received.push(frame);
        queueMicrotask(() => script(frame, agy));
      }
      callback();
    },
  });
  agy.kill = signal => {
    if (agy.killed) {
      return true;
    }
    agy.killed = true;
    setTimeout(() => {
      agy.signalCode = signal ?? "SIGTERM";
      agy.emit("close", null, agy.signalCode);
    }, 1);
    return true;
  };
  return agy;
}

const SESSION_RESULT = {
  sessionId: "s-1",
  models: {
    availableModels: [{ modelId: "gemini-3.8-flash-high" }, { modelId: "gemini-3.8-flash-low" }],
    currentModelId: "gemini-3.8-flash-high",
  },
  configOptions: [
    { id: "model", currentValue: "gemini-3.8-flash", options: [{ value: "gemini-3.8-flash" }, { value: "gpt-oss-120b-medium" }] },
    { id: "thought_level", currentValue: "high", options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
  ],
};

const USAGE = { inputTokens: 9184, outputTokens: 338, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 307, totalTokens: 9522 };

function update(update: Frame): Frame {
  return { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update } };
}

/** Answers the handshake, then runs `onPrompt` for the prompt request. */
function standardScript(onPrompt: (frame: Frame, agy: FakeAgy) => void, sessionResult: Frame = SESSION_RESULT) {
  return (frame: Frame, agy: FakeAgy): void => {
    if (frame.method === "initialize") {
      agy.reply({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } });
    } else if (frame.method === "session/new") {
      agy.reply({ jsonrpc: "2.0", id: frame.id, result: sessionResult });
    } else if (frame.method === "session/set_config_option" || frame.method === "session/set_model") {
      agy.reply({ jsonrpc: "2.0", id: frame.id, result: {} });
    } else if (frame.method === "session/prompt") {
      onPrompt(frame, agy);
    }
  };
}

function provider(): OcxProviderConfig {
  return {
    adapter: "antigravity-acp",
    baseUrl: "https://antigravity.google",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "gemini-3.8-flash",
    stream: true,
    options: {},
    context: { systemPrompt: ["Be brief."], messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    ...overrides,
  } as OcxParsedRequest;
}

async function run(agy: FakeAgy, request: OcxParsedRequest): Promise<{ events: AdapterEvent[]; cwd?: string; args?: readonly string[] }> {
  const events: AdapterEvent[] = [];
  let cwd: string | undefined;
  let args: readonly string[] | undefined;
  const adapter = createAntigravityAcpAdapter(provider(), {
    which: () => "/usr/local/bin/agy",
    platform: "darwin",
    killGraceMs: 10,
    spawn: (_file, spawnArgs, options) => {
      cwd = options.cwd as string;
      args = spawnArgs;
      return agy as unknown as ChildProcess;
    },
  });
  await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
  return { events, cwd, args };
}

const sent = (agy: FakeAgy, method: string) => agy.received.filter(frame => frame.method === method);

describe("antigravity-acp adapter", () => {
  test("streams a text turn through the official ACP server with the caller's instructions", async () => {
    const agy = fakeAgy(standardScript((frame, child) => {
      child.reply(update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } }));
      child.reply(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello there." } }));
      child.reply({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn", usage: USAGE } });
    }));
    const { events, cwd, args } = await run(agy, parsed());

    expect(args).toEqual(["acp"]);
    expect(events).toEqual([
      { type: "thinking_delta", thinking: "thinking" },
      { type: "text_delta", text: "Hello there." },
      expect.objectContaining({ type: "done", usage: expect.objectContaining({ inputTokens: 9184, outputTokens: 338, reasoningOutputTokens: 307 }) }),
    ]);
    const init = sent(agy, "initialize")[0]!.params as Frame;
    expect(init.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    const sessionNew = sent(agy, "session/new")[0]!.params as { cwd: string; mcpServers: unknown[]; _meta: { antigravity: { systemPrompt: { append: string } } } };
    expect(sessionNew.cwd).toBe(cwd!);
    expect(sessionNew.mcpServers).toEqual([]);
    expect(sessionNew._meta.antigravity.systemPrompt.append).toStartWith("Be brief.");
    // The requested model and default thinking level are already current: nothing to change.
    expect(sent(agy, "session/set_config_option")).toEqual([]);
    expect(JSON.stringify(sent(agy, "session/prompt")[0])).toContain("hello");
    // The private working directory is removed with the turn.
    expect(existsSync(cwd!)).toBe(false);
  });

  test("returns a client tool call to Codex, refuses the agent's own tools, and ends the leg", async () => {
    const agy = fakeAgy(standardScript((_frame, child) => {
      child.reply({ jsonrpc: "2.0", id: "7", method: "session/request_permission", params: {
        sessionId: "s-1",
        toolCall: { toolCallId: "builtin-1", name: "run_command", rawInput: { CommandLine: "rm -rf /" } },
        options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }],
      } });
      child.reply(update({
        sessionUpdate: "tool_call", toolCallId: "call_1", name: "mcp_opencodex_exec_command", status: "in_progress",
        rawInput: { cmd: "echo hi", toolSummary: "Echo hi" },
      }));
    }));
    const request = parsed({ context: {
      messages: [{ role: "user", content: "run it", timestamp: 0 }],
      tools: [{ name: "exec_command", description: "Run a command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } }],
    } });
    const { events } = await run(agy, request);

    const refusal = agy.received.find(frame => frame.id === "7");
    expect(refusal).toEqual({ jsonrpc: "2.0", id: "7", result: { outcome: { outcome: "selected", optionId: "deny" } } });
    const toolEvents = events.filter(event => event.type !== "heartbeat");
    expect(toolEvents).toEqual([
      { type: "tool_call_start", id: "call_1", name: "exec_command" },
      { type: "tool_call_delta", arguments: JSON.stringify({ cmd: "echo hi" }) },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ]);
    expect(agy.killed).toBe(true);
    const servers = (sent(agy, "session/new")[0]!.params as { mcpServers: Array<{ name: string; args: string[] }> }).mcpServers;
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe("opencodex");
    expect(servers[0]!.args.at(-1)).toEndWith("catalog.json");
  });

  test("replays prior tool calls under the names Antigravity was offered", async () => {
    const agy = fakeAgy(standardScript((frame, child) => {
      child.reply({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn" } });
    }));
    const request = parsed({ context: {
      messages: [
        { role: "user", content: "run it", timestamp: 0 },
        { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "exec_command", arguments: { cmd: "echo hi" } }], timestamp: 1 },
        { role: "toolResult", toolCallId: "call_1", toolName: "exec_command", content: "hi", isError: false, timestamp: 2 },
      ],
      tools: [{ name: "exec_command", description: "Run a command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
    } });
    await run(agy, request);
    const promptText = JSON.stringify(sent(agy, "session/prompt")[0]);
    expect(promptText).toContain("[Tool call: mcp_opencodex_exec_command (call_id: call_1)");
    expect(promptText).toContain("TOOL RESULT (call_id: call_1)");
  });

  test("selects the requested model and clamps the thinking level to what the account offers", async () => {
    const agy = fakeAgy(standardScript((frame, child) => {
      child.reply({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn" } });
    }, {
      ...SESSION_RESULT,
      configOptions: [
        { id: "model", currentValue: "gpt-oss-120b-medium", options: [{ value: "gemini-3.8-flash" }, { value: "gpt-oss-120b-medium" }] },
        { id: "thought_level", currentValue: "low", options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
      ],
    }));
    await run(agy, parsed({ options: { reasoning: "xhigh" } }));
    expect(sent(agy, "session/set_config_option").map(frame => frame.params)).toEqual([
      { sessionId: "s-1", configId: "model", value: "gemini-3.8-flash" },
      { sessionId: "s-1", configId: "thought_level", value: "high" },
    ]);
    expect(sent(agy, "session/prompt")).toHaveLength(1);
  });

  test("refuses a model the server does not offer, naming the server's list", async () => {
    const agy = fakeAgy(standardScript(() => undefined));
    const { events } = await run(agy, parsed({ modelId: "claude-opus-5" }));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "model_not_found", status: 400 });
    expect((events.at(-1) as { message: string }).message).toContain("gemini-3.8-flash");
    expect(sent(agy, "session/prompt")).toEqual([]);
  });

  test("turns the CLI's authentication error into a sign-in instruction", async () => {
    const agy = fakeAgy((frame, child) => {
      if (frame.method === "initialize") {
        child.reply({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1 } });
      } else if (frame.method === "session/new") {
        child.reply({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message: "Authentication required" } });
      }
    });
    const { events } = await run(agy, parsed());
    expect(events.at(-1)).toMatchObject({ type: "error", status: 401, code: "antigravity_cli_not_signed_in" });
  });

  test("fails a required tool turn that ends with text only", async () => {
    const agy = fakeAgy(standardScript((frame, child) => {
      child.reply({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn", usage: USAGE } });
    }));
    const { events } = await run(agy, parsed({
      options: { toolChoice: "required" },
      context: {
        messages: [{ role: "user", content: "run it", timestamp: 0 }],
        tools: [{ name: "exec_command", description: "Run a command", parameters: { type: "object" } }],
      },
    }));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "tool_call_required" });
  });

  test("reports a missing CLI before spawning", async () => {
    const events: AdapterEvent[] = [];
    const home = mkdtempSync(join(tmpdir(), "ocx-agy-home-"));
    try {
      const adapter = createAntigravityAcpAdapter(provider(), {
        which: () => undefined,
        home,
        spawn: () => { throw new Error("must not spawn"); },
      });
      await adapter.runTurn!(parsed(), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "cli_not_found" })]);
  });
});

describe("antigravity-acp helpers", () => {
  test("finds the installer's ~/.local/bin/agy when PATH misses it", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-agy-home-"));
    try {
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      writeFileSync(join(home, ".local", "bin", "agy"), "");
      expect(findAntigravityCliBinary(() => undefined, home, "darwin")).toBe(join(home, ".local", "bin", "agy"));
      expect(findAntigravityCliBinary(() => "/opt/agy", home, "darwin")).toBe("/opt/agy");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("selects an effort-suffixed id through set_model", () => {
    expect(planAcpSession(SESSION_RESULT, "gemini-3.8-flash-low", "high")).toEqual({
      ok: true,
      changes: [{ kind: "model", modelId: "gemini-3.8-flash-low" }],
    });
  });

  test("counts thought tokens inside output tokens", () => {
    expect(mapAcpUsage(USAGE)).toEqual({
      inputTokens: 9184, outputTokens: 338, totalTokens: 9522, reasoningOutputTokens: 307, upstreamReported: true,
    });
    expect(mapAcpUsage({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
  });
});

