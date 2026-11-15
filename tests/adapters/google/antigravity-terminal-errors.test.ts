import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createAntigravityCliAdapter, type SpawnFn } from "../../../src/adapters/antigravity-cli/adapter";
import {
  ANTIGRAVITY_CLI_MODELS,
  ANTIGRAVITY_CLI_PROFILE,
  clearAntigravityCliBinaryCache,
} from "../../../src/adapters/antigravity-cli/profiles";
import {
  ANTIGRAVITY_MCP_TOOL_PREFIX,
  AntigravityTerminalRefusalProtocolError,
  buildAntigravityCliToolBridge,
  createAntigravityStreamState,
  mapAntigravityStreamFrame,
} from "../../../src/adapters/antigravity-cli/protocol";
import { ANTIGRAVITY_TOOL_LIMITS } from "../../../src/adapters/codebuddy/tool-bridge";
import { bridgeToResponsesSSE } from "../../../src/bridge";
import { isTerminalRefusalCode } from "../../../src/lib/errors";
import { providerConfigSeed } from "../../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../../src/providers/registry";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { handleOwnedResponses as handleResponses } from "../../helpers/response-replay-owner";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const BRIDGED_READ_TOOL = `${ANTIGRAVITY_MCP_TOOL_PREFIX}read_file`;
const ONE_BY_ONE_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const enc = new TextEncoder();

beforeEach(() => clearAntigravityCliBinaryCache());

interface SseFrame {
  name: string;
  data: Record<string, any>;
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "antigravity-cli",
    baseUrl: ANTIGRAVITY_CLI_PROFILE.canonicalBaseUrl,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    ...overrides,
  } as OcxProviderConfig;
}

function parsedRequest(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "gemini-4-carbon",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: "inspect the workspace", timestamp: 0 }],
    },
    ...overrides,
  };
}

function toolRequest(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return parsedRequest({
    context: {
      messages: [{ role: "user", content: "read README.md", timestamp: 0 }],
      tools: [
        {
          name: "read_file",
          description: "Read a workspace file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    },
    ...overrides,
  });
}

function antigravityConfig(): OcxConfig {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "antigravity-cli")!;
  return {
    port: 0,
    defaultProvider: "antigravity-cli",
    providers: {
      "antigravity-cli": {
        ...providerConfigSeed(entry),
        selectedModels: [...ANTIGRAVITY_CLI_MODELS],
      },
    },
  } as OcxConfig;
}

function fakeChild(
  lines: string[],
  opts: { stderr?: string; exitCode?: number; autoClose?: boolean } = {},
): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    killed: boolean;
    exitCode: number | null;
    kill: () => boolean;
  };
  child.pid = 51515;
  child.stdout = Readable.from(lines.map(line => enc.encode(`${line}\n`)));
  child.stderr = Readable.from(opts.stderr ? [enc.encode(opts.stderr)] : []);
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    if (child.exitCode === null) {
      const code = opts.exitCode ?? 0;
      child.exitCode = code;
      queueMicrotask(() => child.emit("close", code));
    }
    return true;
  };
  if (opts.autoClose !== false) {
    setTimeout(() => {
      if (child.exitCode === null) {
        const code = opts.exitCode ?? 0;
        child.exitCode = code;
        child.emit("close", code);
      }
    }, 10);
  }
  return child as unknown as ChildProcess;
}

function parkedFakeChild(lines: string[]): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    killed: boolean;
    exitCode: number | null;
    kill: () => boolean;
  };
  child.pid = 52525;
  const stdout = Readable.from(lines.map(line => enc.encode(`${line}\n`)));
  // Keep stream open after delivering initial frames until kill() simulates parked agy process.
  child.stdout = new Readable({
    read() {},
  });
  void (async () => {
    for await (const chunk of stdout) {
      if (child.killed) break;
      child.stdout.push(chunk);
    }
  })();
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    child.stdout.push(null);
    child.stderr.push(null);
    if (child.exitCode === null) {
      child.exitCode = 0;
      queueMicrotask(() => child.emit("close", 0));
    }
    return true;
  };
  return child as unknown as ChildProcess;
}

async function runAdapterToSseFailed(
  adapter: ReturnType<typeof createAntigravityCliAdapter>,
  request: OcxParsedRequest,
  options: { terminalRefusalAsFailed?: boolean } = { terminalRefusalAsFailed: true },
): Promise<{ events: AdapterEvent[]; failed: Record<string, any> }> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(
    request,
    { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    event => events.push(event),
  );
  async function* stream(): AsyncGenerator<AdapterEvent> {
    for (const event of events) yield event;
  }
  const sseText = await new Response(
    bridgeToResponsesSSE(
      stream(),
      "antigravity-cli/gemini-4-carbon",
      undefined,
      undefined,
      undefined,
      undefined,
      2_000,
      options,
    ),
  ).text();
  const frames = parseSseFrames(sseText);
  const failed = frames.find(frame => frame.name === "response.failed");
  expect(failed).toBeDefined();
  return { events, failed: failed!.data.response };
}

function parseSseFrames(sseText: string): SseFrame[] {
  return sseText.split("\n\n").flatMap(block => {
    const lines = block.trim().split("\n");
    const name = lines.find(line => line.startsWith("event: "))?.slice(7);
    const data = lines.find(line => line.startsWith("data: "))?.slice(6);
    return name && data ? [{ name, data: JSON.parse(data) as Record<string, any> }] : [];
  });
}

describe("antigravity-cli /v1/responses SSE terminal error classification", () => {
  const deterministicCases: Array<{
    name: string;
    expectedAdapterCode: string;
    request: OcxParsedRequest;
    spawn: SpawnFn;
    extraDeps?: Record<string, unknown>;
  }> = [
      {
        name: "PreToolUse hook byte ceiling denial on declared MCP tool",
        expectedAdapterCode: "protocol_error",
        request: toolRequest(),
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { tools: [BRIDGED_READ_TOOL] } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ERROR",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: {
                name: BRIDGED_READ_TOOL,
                error: { message: "tool call denied by pre-tool hook: PreToolUse payload exceeded the byte ceiling." },
              },
            },
          }),
        ]),
      },
      {
        name: "undeclared tool call executed outside isolated catalog",
        expectedAdapterCode: "undeclared_tool_call",
        request: toolRequest(),
        spawn: () => parkedFakeChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"] } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "DONE",
              step_type: "tool",
              tool_name: "run_command",
              tool_info: { name: "run_command", parameters: { CommandLine: "pwd" } },
            },
          }),
        ]),
      },
      {
        name: "bridge protocol mismatch: init exposed forbidden built-in tool",
        expectedAdapterCode: "tool_bridge_init_mismatch",
        request: toolRequest(),
        spawn: () => parkedFakeChild([
          JSON.stringify({ event: "init", init: { tools: ["view_file"] } }),
        ]),
      },
      {
        name: "bridge protocol mismatch: tool called before init handshake",
        expectedAdapterCode: "tool_bridge_init_missing",
        request: toolRequest(),
        spawn: () => parkedFakeChild([
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "DONE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } },
            },
          }),
        ]),
      },
      {
        name: "bridge protocol mismatch: capture payload missing when bridge parks",
        expectedAdapterCode: "protocol_error",
        request: toolRequest(),
        extraDeps: { toolBatchCoalesceMs: 10, undeclaredToolGraceMs: 30 },
        spawn: (_cmd, _args, options) => {
          writeFileSync(join(String(options.cwd), "captured-calls.jsonl"), "");
          return parkedFakeChild([
            JSON.stringify({ event: "init", init: { tools: [BRIDGED_READ_TOOL] } }),
            JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 1,
                state: "ACTIVE",
                step_type: "tool",
                tool_name: BRIDGED_READ_TOOL,
                tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } },
              },
            }),
          ]);
        },
      },
      {
        name: "bridge protocol mismatch: settled with text instead of parking on tool bridge",
        expectedAdapterCode: "protocol_error",
        request: toolRequest(),
        extraDeps: { toolBatchCoalesceMs: 500 },
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { tools: [BRIDGED_READ_TOOL] } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } },
            },
          }),
          JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "done without waiting" } }),
        ]),
      },
      {
        name: "bridge protocol mismatch: non-object tool arguments",
        expectedAdapterCode: "protocol_error",
        request: toolRequest(),
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { tools: [BRIDGED_READ_TOOL] } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: "not-an-object" },
            },
          }),
        ]),
      },
      {
        name: "invalid or oversized tool catalog",
        expectedAdapterCode: "tool_catalog_invalid",
        request: parsedRequest({
          context: {
            messages: [{ role: "user", content: "call a tool", timestamp: 0 }],
            tools: Array.from({ length: ANTIGRAVITY_TOOL_LIMITS.maxTools + 1 }, (_, i) => ({
              name: `tool_${i}`,
              description: "overflow tool",
              parameters: { type: "object", properties: {} },
            })),
          },
        }),
        spawn: () => {
          throw new Error("spawn must not be called when tool catalog is invalid");
        },
      },
      {
        name: "exceeding single-turn tool call limit (maxTurnToolCalls)",
        expectedAdapterCode: "tool_call_limit",
        request: toolRequest(),
        extraDeps: { toolBatchCoalesceMs: 500 },
        spawn: () => parkedFakeChild([
          JSON.stringify({ event: "init", init: { tools: [BRIDGED_READ_TOOL] } }),
          ...Array.from({ length: ANTIGRAVITY_TOOL_LIMITS.maxTurnToolCalls + 1 }, (_, idx) =>
            JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: idx + 1,
                state: "ACTIVE",
                step_type: "tool",
                tool_name: BRIDGED_READ_TOOL,
                tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: `f${idx}.ts` } },
              },
            })),
        ]),
      },
      {
        name: "upstream INVALID_ARGUMENT",
        expectedAdapterCode: "invalid_request_error",
        request: parsedRequest(),
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { agent: "ocx_bridge" } }),
          JSON.stringify({
            event: "result",
            result: {
              status: "ERROR",
              error: { message: "Request failed: INVALID_ARGUMENT (code 400): invalid tool schema" },
            },
          }),
        ]),
      },
  ];

  for (const tc of deterministicCases) {
    test(`deterministic error -> terminal SSE: ${tc.name}`, async () => {
      const adapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: tc.spawn,
        ...tc.extraDeps,
      });
      const { events, failed } = await runAdapterToSseFailed(adapter, tc.request);
      const errEvent = events.find(e => e.type === "error");
      expect(errEvent, `${tc.name}: expected adapter error event`).toBeDefined();
      expect((errEvent as Extract<AdapterEvent, { type: "error" }>).code, tc.name).toBe(tc.expectedAdapterCode);
      expect(failed.status, tc.name).toBe("failed");
      expect(isTerminalRefusalCode(failed.error?.code), `${tc.name}: SSE code=${failed.error?.code}`).toBe(true);
      expect(failed.error?.code, tc.name).toBe("invalid_prompt");
      expect(failed.error?.type, tc.name).toBe("invalid_request_error");
      expect(failed.last_error, tc.name).toEqual(failed.error);
      expect(failed.retryable, tc.name).toBe(false);
    });
  }

  test("preserves adapter error codes when terminalRefusalAsFailed is disabled (non-Responses wires)", async () => {
    const adapter = createAntigravityCliAdapter(provider(), {
      which: () => "/bin/agy",
      platform: "linux",
      spawn: () => parkedFakeChild([
        JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"] } }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            step_index: 1,
            state: "DONE",
            step_type: "tool",
            tool_name: "run_command",
            tool_info: { name: "run_command", parameters: {} },
          },
        }),
      ]),
    });
    const { failed } = await runAdapterToSseFailed(adapter, toolRequest(), { terminalRefusalAsFailed: false });
    expect(failed.error?.code).toBe("undeclared_tool_call");
    expect(isTerminalRefusalCode(failed.error?.code)).toBe(false);
  });

  test("transient/retryable errors never receive a terminal refusal code on SSE", async () => {
    const cases: Array<{
      name: string;
      expectedAdapterCode: string;
      request: OcxParsedRequest;
      spawn: SpawnFn;
      extraDeps?: Record<string, unknown>;
    }> = [
      {
        name: "agy process crash (process_exit_error)",
        expectedAdapterCode: "process_exit_error",
        request: parsedRequest(),
        spawn: () => fakeChild([], { stderr: "fatal runtime panic", exitCode: 1 }),
      },
      {
        name: "agy ended on EOF without terminal result frame",
        expectedAdapterCode: "protocol_error",
        request: parsedRequest(),
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { agent: "ocx_bridge" } }),
        ], { exitCode: 0 }),
      },
      {
        name: "MCP tools/call EOF error during bridged tool step",
        expectedAdapterCode: "protocol_error",
        request: toolRequest(),
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { tools: [BRIDGED_READ_TOOL] } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ERROR",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, error: { message: "calling tools/call: EOF" } },
            },
          }),
        ]),
      },
      {
        name: "spawn ENOENT failure",
        expectedAdapterCode: "cli_spawn_failed",
        request: parsedRequest(),
        spawn: () => {
          const child = new EventEmitter() as EventEmitter & {
            stdout: Readable;
            stderr: Readable;
            stdin: Writable;
            killed: boolean;
            exitCode: number | null;
            kill: () => boolean;
          };
          child.stdout = new Readable({ read() {} });
          child.stderr = new Readable({ read() {} });
          child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
          child.killed = false;
          child.exitCode = null;
          child.kill = () => {
            child.killed = true;
            child.stdout.push(null);
            child.stderr.push(null);
            if (child.exitCode === null) {
              child.exitCode = 1;
              queueMicrotask(() => child.emit("close", 1));
            }
            return true;
          };
          queueMicrotask(() => {
            child.stdout.push(null);
            child.stderr.push(null);
            child.emit("error", Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" }));
            queueMicrotask(() => {
              if (child.exitCode === null) {
                child.exitCode = 1;
                child.emit("close", 1);
              }
            });
          });
          return child as unknown as ChildProcess;
        },
      },
      {
        name: "network/transient ECONNRESET upstream error",
        expectedAdapterCode: "upstream_error",
        request: parsedRequest(),
        spawn: () => fakeChild([], { stderr: "ECONNRESET: connection reset by peer", exitCode: 1 }),
      },
      {
        name: "504 turn timeout",
        expectedAdapterCode: "timeout",
        request: parsedRequest(),
        extraDeps: { timeoutMs: 25 },
        spawn: () => parkedFakeChild([
          JSON.stringify({ event: "init", init: { agent: "ocx_bridge" } }),
        ]),
      },
      {
        name: "upstream 429 rate limit",
        expectedAdapterCode: "rate_limit_exceeded",
        request: parsedRequest(),
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { agent: "ocx_bridge" } }),
          JSON.stringify({
            event: "result",
            result: { status: "ERROR", error: { message: "HTTP 429 RESOURCE_EXHAUSTED: try again later" } },
          }),
        ]),
      },
      {
        name: "upstream 503 service unavailable",
        expectedAdapterCode: "upstream_error",
        request: parsedRequest(),
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { agent: "ocx_bridge" } }),
          JSON.stringify({
            event: "result",
            result: { status: "ERROR", error: { message: "HTTP 503 Service Unavailable" } },
          }),
        ]),
      },
    ];

    for (const tc of cases) {
      const adapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: tc.spawn,
        ...tc.extraDeps,
      });
      const { events, failed } = await runAdapterToSseFailed(adapter, tc.request);
      const errEvent = events.find(e => e.type === "error") as Extract<AdapterEvent, { type: "error" }> | undefined;
      expect(errEvent, `${tc.name}: expected adapter error event`).toBeDefined();
      expect(errEvent?.code, tc.name).toBe(tc.expectedAdapterCode);
      expect(failed.status, tc.name).toBe("failed");
      expect(isTerminalRefusalCode(failed.error?.code), `${tc.name}: unexpected terminal code ${failed.error?.code}`).toBe(false);
    }
  });

  test("POST /v1/responses streaming route maps deterministic antigravity-cli tool catalog failure to terminal response.failed", async () => {
    const releaseSpend = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "antigravity-cli/gemini-4-carbon",
            stream: true,
            input: "hello",
            tools: Array.from({ length: ANTIGRAVITY_TOOL_LIMITS.maxTools + 1 }, (_, i) => ({
              type: "function",
              name: `overflow_tool_${i}`,
              description: "tool",
              parameters: { type: "object", properties: {} },
            })),
          }),
        }),
        antigravityConfig(),
        { model: "", provider: "" },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const frames = parseSseFrames(await response.text());
      const failed = frames.find(frame => frame.name === "response.failed")?.data.response;
      expect(failed).toBeDefined();
      expect(isTerminalRefusalCode(failed.error?.code)).toBe(true);
      expect(failed.error?.code).toBe("invalid_prompt");
      expect(failed.retryable).toBe(false);
    } finally {
      releaseSpend();
    }
  });

  test("ACTIVE -> ERROR PreToolUse byte-ceiling denial fails with terminal refusal across MCP, staged-image view_file, and undeclared tools", async () => {
    const byteCeilingMessage = "tool call denied by pre-tool hook: PreToolUse payload exceeded the byte ceiling.";
    const bridge = buildAntigravityCliToolBridge(toolRequest())!;

    // 1. Direct protocol-level assertions: ACTIVE(step 1) -> ERROR(step 1) throws AntigravityTerminalRefusalProtocolError
    const mcpState = createAntigravityStreamState();
    mapAntigravityStreamFrame({ event: "init", init: { tools: ["call_mcp_tool"] } }, mcpState, bridge);
    mapAntigravityStreamFrame(
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: BRIDGED_READ_TOOL,
          tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } },
        },
      },
      mcpState,
      bridge,
    );
    expect(() =>
      mapAntigravityStreamFrame(
        {
          event: "step_update",
          step_update: {
            step_index: 1,
            state: "ERROR",
            step_type: "tool",
            tool_name: BRIDGED_READ_TOOL,
            tool_info: { name: BRIDGED_READ_TOOL, error: { message: byteCeilingMessage } },
          },
        },
        mcpState,
        bridge,
      ),
    ).toThrow(AntigravityTerminalRefusalProtocolError);

    const stagedImagePath = "/tmp/t/.ocx-images/img-0.png";
    const imageState = createAntigravityStreamState(undefined, {
      stagedImagePaths: new Set([stagedImagePath]),
      turnDir: "/tmp/t",
      platform: "linux",
    });
    mapAntigravityStreamFrame({ event: "init", init: { tools: ["view_file"] } }, imageState);
    mapAntigravityStreamFrame(
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "view_file",
          tool_info: { name: "view_file", parameters: { AbsolutePath: stagedImagePath } },
        },
      },
      imageState,
    );
    expect(() =>
      mapAntigravityStreamFrame(
        {
          event: "step_update",
          step_update: {
            step_index: 1,
            state: "ERROR",
            step_type: "tool",
            tool_name: "view_file",
            tool_info: { name: "view_file", error: { message: byteCeilingMessage } },
          },
        },
        imageState,
      ),
    ).toThrow(AntigravityTerminalRefusalProtocolError);

    const undeclaredState = createAntigravityStreamState();
    mapAntigravityStreamFrame({ event: "init", init: { tools: ["call_mcp_tool"] } }, undeclaredState, bridge);
    mapAntigravityStreamFrame(
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { name: "run_command", parameters: { CommandLine: "pwd" } },
        },
      },
      undeclaredState,
      bridge,
    );
    expect(() =>
      mapAntigravityStreamFrame(
        {
          event: "step_update",
          step_update: {
            step_index: 1,
            state: "ERROR",
            step_type: "tool",
            tool_name: "run_command",
            tool_info: { name: "run_command", error: { message: byteCeilingMessage } },
          },
        },
        undeclaredState,
        bridge,
      ),
    ).toThrow(AntigravityTerminalRefusalProtocolError);

    // 2. End-to-end adapter + SSE response.failed(code: "invalid_prompt") assertions across all 3 cases
    const adapterCases: Array<{
      label: string;
      request: OcxParsedRequest;
      spawn: SpawnFn;
    }> = [
      {
        label: "bridged MCP tool ACTIVE -> ERROR byte ceiling",
        request: toolRequest(),
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"] } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } },
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ERROR",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, error: { message: byteCeilingMessage } },
            },
          }),
          JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "should not succeed" } }),
        ]),
      },
      {
        label: "staged-image view_file ACTIVE -> ERROR byte ceiling",
        request: parsedRequest({
          context: {
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "Inspect image" },
                { type: "image", imageUrl: ONE_BY_ONE_PNG_DATA_URL },
              ],
              timestamp: 0,
            }],
          },
        }),
        spawn: (_cmd, _args, options) => {
          const imgPath = join(String(options.cwd), ".ocx-images", "img-0.png");
          return fakeChild([
            JSON.stringify({ event: "init", init: { tools: ["view_file"] } }),
            JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 1,
                state: "ACTIVE",
                step_type: "tool",
                tool_name: "view_file",
                tool_info: { name: "view_file", parameters: { AbsolutePath: imgPath } },
              },
            }),
            JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 1,
                state: "ERROR",
                step_type: "tool",
                tool_name: "view_file",
                tool_info: { name: "view_file", error: { message: byteCeilingMessage } },
              },
            }),
            JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "should not succeed" } }),
          ]);
        },
      },
      {
        label: "undeclared built-in run_command ACTIVE -> ERROR byte ceiling",
        request: toolRequest(),
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"] } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: "run_command",
              tool_info: { name: "run_command", parameters: { CommandLine: "pwd" } },
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ERROR",
              step_type: "tool",
              tool_name: "run_command",
              tool_info: { name: "run_command", error: { message: byteCeilingMessage } },
            },
          }),
          JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "should not succeed" } }),
        ]),
      },
    ];

    for (const tc of adapterCases) {
      const adapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        toolBatchCoalesceMs: 50,
        spawn: tc.spawn,
      });
      const { events, failed } = await runAdapterToSseFailed(adapter, tc.request);
      const errEvent = events.find(e => e.type === "error") as Extract<AdapterEvent, { type: "error" }> | undefined;
      expect(errEvent, `${tc.label}: expected error event`).toBeDefined();
      expect(errEvent?.code, tc.label).toBe("protocol_error");
      expect(errEvent?.terminalRefusal, tc.label).toBe(true);
      expect(failed.status, tc.label).toBe("failed");
      expect(failed.error?.code, tc.label).toBe("invalid_prompt");
      expect(failed.retryable, tc.label).toBe(false);
    }
  });
});
