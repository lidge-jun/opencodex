import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  buildChildEnv,
  createAntigravityCliAdapter,
  resolveAntigravityOutboundProxyEnv,
} from "../../../src/adapters/antigravity-cli/adapter";
import { ANTIGRAVITY_CLI_MODELS, ANTIGRAVITY_CLI_PROFILE } from "../../../src/adapters/antigravity-cli/profiles";
import { ANTIGRAVITY_MCP_TOOL_PREFIX } from "../../../src/adapters/antigravity-cli/protocol";
import { AntigravitySessionPool } from "../../../src/adapters/antigravity-cli/session-pool";
import type { IncomingMeta } from "../../../src/adapters/base";
import { getAdapterDefinition } from "../../../src/adapters/registry";
import { saveConfig } from "../../../src/config";
import { providerConfigSeed } from "../../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../../src/providers/registry";
import { startServer } from "../../../src/server";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { installIsolatedCodexHome } from "../../helpers/isolated-codex-home";
import { BACKGROUND_WORK_TEARDOWN_TIMEOUT_MS, removeTreeAfterBackgroundWork } from "../../helpers/remove-tree";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const enc = new TextEncoder();
const BRIDGED_READ_TOOL = `${ANTIGRAVITY_MCP_TOOL_PREFIX}read_file`;
const BRIDGED_LIST_TOOL = `${ANTIGRAVITY_MCP_TOOL_PREFIX}list_files`;

interface FakeChild extends EventEmitter {
  pid?: number;
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
  written: string[];
}

function createStreamChild(
  initialLines: string[],
  opts: { stderr?: string; keepStderrOpen?: boolean; exitCode?: number; emitClose?: boolean; pid?: number } = {},
): { child: FakeChild; stdout: PassThrough; stderrStream?: PassThrough } {
  const child = new EventEmitter() as FakeChild;
  const stdout = new PassThrough();
  for (const line of initialLines) stdout.write(`${line}\n`);
  child.pid = opts.pid ?? 61616;
  child.stdout = stdout;
  let stderrStream: PassThrough | undefined;
  if (opts.keepStderrOpen) {
    stderrStream = new PassThrough();
    if (opts.stderr) stderrStream.write(opts.stderr);
    child.stderr = stderrStream;
  } else {
    child.stderr = Readable.from(opts.stderr ? [enc.encode(opts.stderr)] : []);
  }
  child.written = [];
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      child.written.push(String(chunk));
      cb();
    },
  });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    stdout.end();
    stderrStream?.end();
    if (child.exitCode === null) {
      child.exitCode = opts.exitCode ?? 143;
      queueMicrotask(() => child.emit("close", child.exitCode));
    }
    return true;
  };
  if (opts.emitClose) {
    setTimeout(() => {
      if (child.exitCode === null) {
        stdout.end();
        stderrStream?.end();
        child.exitCode = opts.exitCode ?? 0;
        child.emit("close", child.exitCode);
      }
    }, 5);
  }
  return { child, stdout, stderrStream };
}

function provider(): OcxProviderConfig {
  return {
    adapter: "antigravity-cli",
    baseUrl: ANTIGRAVITY_CLI_PROFILE.canonicalBaseUrl,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
  } as OcxProviderConfig;
}

function twoToolRequest(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "gemini-4-carbon",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: "Inspect README.md and src", timestamp: 0 }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
        {
          name: "list_files",
          description: "List directory",
          parameters: { type: "object", properties: { dir: { type: "string" } }, required: ["dir"] },
        },
      ],
    },
    ...overrides,
  } as OcxParsedRequest;
}

function incomingWithRequestId(
  requestId: string,
  budget = createTestTranslatorBudget(),
): IncomingMeta & { requestId: string } {
  return {
    headers: new Headers(),
    translatorBudget: budget,
    requestId,
  };
}

async function runTurn(
  adapter: ReturnType<typeof createAntigravityCliAdapter>,
  req: OcxParsedRequest,
  meta: IncomingMeta = incomingWithRequestId("req-test-default"),
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(req, meta, event => events.push(event));
  return events;
}

const activeSpies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  while (activeSpies.length > 0) {
    activeSpies.pop()!.mockRestore();
  }
});

describe("antigravity-cli Stage 1 P1-2 same-step ERROR recovery", () => {
  test("1) ACTIVE(3) -> 100ms -> ERROR(3) -> text -> done(stop) completes under 1s without payload/settled errors", async () => {
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    activeSpies.push(debugSpy);
    const budget = createTestTranslatorBudget();
    const startedAt = Date.now();

    const adapter = createAntigravityCliAdapter(provider(), {
      which: () => "/bin/agy",
      platform: "linux",
      undeclaredToolGraceMs: 2_000,
      spawn: (_cmd, _args, opts) => {
        // Simulate real MCP handshake creating an empty captured-calls.jsonl upfront (F5).
        writeFileSync(join(String(opts.cwd), "captured-calls.jsonl"), "", { mode: 0o600 });
        const { child, stdout } = createStreamChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 3,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } },
            },
          }),
        ]);
        setTimeout(() => {
          stdout.write(`${JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 3,
              state: "ERROR",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: {
                name: BRIDGED_READ_TOOL,
                parameters: { path: "README.md" },
                error: { message: "denied with token sk-secret1234567890" },
              },
            },
          })}\n`);
        }, 100);
        setTimeout(() => {
          stdout.write(`${JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 4,
              state: "DONE",
              step_type: "agent_response",
              text_delta: "I cannot call that tool, answering directly.",
            },
          })}\n`);
          stdout.write(`${JSON.stringify({
            event: "result",
            result: { status: "SUCCESS", response: "I cannot call that tool, answering directly." },
          })}\n`);
          stdout.end();
          child.exitCode = 0;
          child.emit("close", 0);
        }, 125);
        return child as unknown as ChildProcess;
      },
    });

    const events = await runTurn(
      adapter,
      twoToolRequest(),
      incomingWithRequestId("req-p1-2-case1", budget),
    );
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(events).toEqual([
      { type: "text_delta", text: "I cannot call that tool, answering directly." },
      { type: "done", stopReason: "stop" },
    ]);
    expect(budget.snapshot().activeCalls).toBe(0);
    expect(budget.snapshot().currentBytes).toBe(0);
    const debugLogs = debugSpy.mock.calls.map(call => call.join(" ")).join("\n");
    expect(debugLogs).toContain("step=3");
    expect(debugLogs).toMatch(/\[redacted\]/i);
    expect(debugLogs).not.toContain("sk-secret1234567890");
  });

  test("2) ACTIVE(3) -> ERROR(3) -> ACTIVE(4, same tool) emits 1 tool_call with captured arguments", async () => {
    const budget = createTestTranslatorBudget();
    const fullPath = `notes/${"x".repeat(700)}.md`;
    const truncatedPreview = `${fullPath.slice(0, 512)}…`;

    const adapter = createAntigravityCliAdapter(provider(), {
      which: () => "/bin/agy",
      platform: "linux",
      toolBatchCoalesceMs: 20,
      undeclaredToolGraceMs: 1_000,
      spawn: (_cmd, _args, opts) => {
        const captureFile = join(String(opts.cwd), "captured-calls.jsonl");
        writeFileSync(captureFile, "", { mode: 0o600 });
        const { child, stdout } = createStreamChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 3,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "bad.md" } },
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 3,
              state: "ERROR",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, error: { message: "validation failed" } },
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 4,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: truncatedPreview } },
            },
          }),
        ]);
        setTimeout(() => {
          writeFileSync(
            captureFile,
            `${JSON.stringify({ seq: 1, name: "read_file", arguments: { path: fullPath } })}\n`,
          );
        }, 30);
        // Ensure coalesce does not park solely because captureFile exists when empty:
        void stdout;
        return child as unknown as ChildProcess;
      },
    });

    const events = await runTurn(
      adapter,
      twoToolRequest(),
      incomingWithRequestId("req-p1-2-case2", budget),
    );

    const starts = events.filter(e => e.type === "tool_call_start");
    expect(starts).toHaveLength(1);
    expect(events).toEqual([
      expect.objectContaining({ type: "tool_call_start", name: "read_file" }),
      { type: "tool_call_delta", arguments: JSON.stringify({ path: fullPath }) },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ]);
    expect(budget.snapshot().activeCalls).toBe(0);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("3) parallel tools where 1 errors and 1 succeeds emits only the surviving tool", async () => {
    const budget = createTestTranslatorBudget();

    const adapter = createAntigravityCliAdapter(provider(), {
      which: () => "/bin/agy",
      platform: "linux",
      toolBatchCoalesceMs: 25,
      undeclaredToolGraceMs: 1_000,
      spawn: (_cmd, _args, opts) => {
        const captureFile = join(String(opts.cwd), "captured-calls.jsonl");
        writeFileSync(captureFile, "", { mode: 0o600 });
        const { child, stdout } = createStreamChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 3,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "missing.md" } },
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 4,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_LIST_TOOL,
              tool_info: { name: BRIDGED_LIST_TOOL, parameters: { dir: "src" } },
            },
          }),
        ]);
        setTimeout(() => {
          stdout.write(`${JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 3,
              state: "ERROR",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, error: { message: "hook rejected step 3" } },
            },
          })}\n`);
          writeFileSync(
            captureFile,
            `${JSON.stringify({ seq: 1, name: "list_files", arguments: { dir: "src/adapters" } })}\n`,
          );
        }, 35);
        return child as unknown as ChildProcess;
      },
    });

    const events = await runTurn(
      adapter,
      twoToolRequest(),
      incomingWithRequestId("req-p1-2-case3", budget),
    );

    expect(events).toEqual([
      expect.objectContaining({ type: "tool_call_start", name: "list_files" }),
      { type: "tool_call_delta", arguments: JSON.stringify({ dir: "src/adapters" }) },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ]);
    expect(budget.snapshot().activeCalls).toBe(0);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("4) regression: normal single and parallel bridged tool calls still succeed cleanly", async () => {
    const singleAdapter = createAntigravityCliAdapter(provider(), {
      which: () => "/bin/agy",
      platform: "linux",
      toolBatchCoalesceMs: 15,
      spawn: (_cmd, _args, opts) => {
        const captureFile = join(String(opts.cwd), "captured-calls.jsonl");
        writeFileSync(captureFile, `${JSON.stringify({ seq: 1, name: "read_file", arguments: { path: "a.ts" } })}\n`);
        return createStreamChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "a.ts" } },
            },
          }),
        ]).child as unknown as ChildProcess;
      },
    });
    const singleEvents = await runTurn(singleAdapter, twoToolRequest());
    expect(singleEvents).toEqual([
      expect.objectContaining({ type: "tool_call_start", name: "read_file" }),
      { type: "tool_call_delta", arguments: '{"path":"a.ts"}' },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ]);

    const parallelAdapter = createAntigravityCliAdapter(provider(), {
      which: () => "/bin/agy",
      platform: "linux",
      toolBatchCoalesceMs: 15,
      spawn: (_cmd, _args, opts) => {
        const captureFile = join(String(opts.cwd), "captured-calls.jsonl");
        writeFileSync(
          captureFile,
          [
            JSON.stringify({ seq: 1, name: "read_file", arguments: { path: "a.ts" } }),
            JSON.stringify({ seq: 2, name: "list_files", arguments: { dir: "src" } }),
          ].join("\n") + "\n",
        );
        return createStreamChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "a.ts" } },
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 2,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_LIST_TOOL,
              tool_info: { name: BRIDGED_LIST_TOOL, parameters: { dir: "src" } },
            },
          }),
        ]).child as unknown as ChildProcess;
      },
    });
    const parallelEvents = await runTurn(parallelAdapter, twoToolRequest());
    expect(parallelEvents.filter(e => e.type === "tool_call_start").map(e => (e as { name: string }).name)).toEqual([
      "read_file",
      "list_files",
    ]);
    expect(parallelEvents.at(-1)).toEqual({ type: "done", stopReason: "tool_use", endTurn: false });
  });

  test("5) warm-session tool continuation ignores prior-turn step_index ERROR (isError tool result) without crashing", async () => {
    const pool = new AntigravitySessionPool();
    let stdoutRef: PassThrough | undefined;
    try {
      const adapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        enableSessionPool: true,
        sessionPool: pool,
        toolBatchCoalesceMs: 15,
        spawn: (_cmd, _args, opts) => {
          const captureFile = join(String(opts.cwd), "captured-calls.jsonl");
          writeFileSync(captureFile, `${JSON.stringify({ seq: 1, name: "read_file", arguments: { path: "missing.txt" } })}\n`);
          const { child, stdout } = createStreamChild([
            JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } }),
            JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 3,
                state: "ACTIVE",
                step_type: "tool",
                tool_name: BRIDGED_READ_TOOL,
                tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "missing.txt" } },
              },
            }),
          ]);
          stdoutRef = stdout;
          return child as unknown as ChildProcess;
        },
      });

      const turn1Events = await runTurn(adapter, twoToolRequest());
      const startEvent = turn1Events.find(e => e.type === "tool_call_start") as Extract<AdapterEvent, { type: "tool_call_start" }>;
      expect(startEvent.name).toBe("read_file");

      const turn2Req = twoToolRequest({
        context: {
          messages: [
            { role: "user", content: "Inspect README.md and src", timestamp: 0 },
            {
              role: "assistant",
              content: [{ type: "toolCall", id: startEvent.id, name: "read_file", arguments: { path: "missing.txt" } }],
              timestamp: 1,
            },
            {
              role: "toolResult",
              toolCallId: startEvent.id,
              toolName: "read_file",
              isError: true,
              content: [{ type: "text", text: "ENOENT" }],
              timestamp: 2,
            },
          ],
          tools: twoToolRequest().context.tools,
        },
      });

      setTimeout(() => {
        stdoutRef?.write(`${JSON.stringify({
          event: "step_update",
          step_update: {
            step_index: 3,
            state: "ERROR",
            step_type: "tool",
            tool_name: BRIDGED_READ_TOOL,
            tool_info: { name: BRIDGED_READ_TOOL, error: { message: "tool returned isError" } },
          },
        })}\n`);
        stdoutRef?.write(`${JSON.stringify({
          event: "step_update",
          step_update: {
            step_index: 4,
            state: "DONE",
            step_type: "agent_response",
            text_delta: "File does not exist.",
          },
        })}\n`);
        stdoutRef?.write(`${JSON.stringify({
          event: "result",
          result: { status: "SUCCESS", response: "File does not exist." },
        })}\n`);
      }, 15);

      const turn2Events = await runTurn(adapter, turn2Req);
      expect(turn2Events).toEqual([
        { type: "text_delta", text: "File does not exist." },
        { type: "done", stopReason: "stop" },
      ]);
    } finally {
      await pool.disposeAll();
    }
  });
});

describe("antigravity-cli Stage 1 P1-0 observability", () => {
  test("warn-logs raw upstream error redacted and capped to 2048 bytes while keeping outward AdapterEvent intact", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    activeSpies.push(warnSpy);

    const longDetail = `INVALID_ARGUMENT: sk-topsecret123456 ${"z".repeat(2500)}`;
    const adapter = createAntigravityCliAdapter(provider(), {
      which: () => "/bin/agy",
      platform: "linux",
      spawn: () => createStreamChild([
        JSON.stringify({
          event: "result",
          result: {
            status: "ERROR",
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message: "INVALID_ARGUMENT: Invalid schema",
              details: longDetail,
            },
          },
        }),
      ], { emitClose: true }).child as unknown as ChildProcess,
    });

    const events = await runTurn(
      adapter,
      twoToolRequest({ context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] } }),
      incomingWithRequestId("req-p1-0-raw"),
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        status: 400,
        code: "invalid_request_error",
        message: "INVALID_ARGUMENT: Invalid schema",
      }),
    ]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0]!.join(" ");
    expect(line).toContain("requestId=req-p1-0-raw");
    expect(line).toContain("status=400");
    expect(line).toContain("code=invalid_request_error");
    expect(line).toMatch(/\[redacted\]/i);
    expect(line).not.toContain("sk-topsecret123456");
    const rawMatch = /raw=(".*")/.exec(line);
    expect(rawMatch).toBeTruthy();
    const loggedRaw = JSON.parse(rawMatch![1]!) as string;
    expect(loggedRaw).toContain("INVALID_ARGUMENT");
    expect(Buffer.byteLength(loggedRaw, "utf8")).toBeLessThanOrEqual(2048);
  });

  test("warn-logs redacted last 2048 bytes of stderr on non-zero exit in both single-shot and warm-session paths", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    activeSpies.push(warnSpy);

    const headMarker = "HEAD_MARKER_SHOULD_BE_TRUNCATED";
    const tailMarker = "TAIL_MARKER_MUST_REMAIN";
    const bigStderr = `${headMarker} ${"a".repeat(2600)} authorization: Bearer secret-tok sk-stderr987654\n${tailMarker}`;

    // Single-shot path
    const singleShotAdapter = createAntigravityCliAdapter(provider(), {
      which: () => "/bin/agy",
      platform: "linux",
      spawn: () => createStreamChild([], { exitCode: 2, emitClose: true, stderr: bigStderr }).child as unknown as ChildProcess,
    });
    const singleEvents = await runTurn(
      singleShotAdapter,
      twoToolRequest({ context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] } }),
      incomingWithRequestId("req-p1-0-stderr-single"),
    );
    expect(singleEvents).toEqual([expect.objectContaining({ type: "error", code: "process_exit_error" })]);

    const singleWarn = warnSpy.mock.calls.at(-1)!.join(" ");
    expect(singleWarn).toContain("requestId=req-p1-0-stderr-single");
    expect(singleWarn).toContain("exitCode=2");
    const singleStderrMatch = /stderr=(".*")$/.exec(singleWarn);
    expect(singleStderrMatch).toBeTruthy();
    const singleLoggedStderr = JSON.parse(singleStderrMatch![1]!) as string;
    expect(Buffer.byteLength(singleLoggedStderr, "utf8")).toBeLessThanOrEqual(2048);
    expect(singleLoggedStderr).toContain(tailMarker);
    expect(singleLoggedStderr).not.toContain(headMarker);
    expect(singleLoggedStderr).not.toContain("sk-stderr987654");

    // Warm-session path
    const pool = new AntigravitySessionPool();
    try {
      const warmAdapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        enableSessionPool: true,
        sessionPool: pool,
        spawn: () => createStreamChild([], { exitCode: 3, emitClose: true, stderr: bigStderr }).child as unknown as ChildProcess,
      });
      const warmEvents = await runTurn(
        warmAdapter,
        twoToolRequest({ context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] } }),
        incomingWithRequestId("req-p1-0-stderr-warm"),
      );
      expect(warmEvents).toEqual([expect.objectContaining({ type: "error", code: "process_exit_error" })]);

      const warmWarn = warnSpy.mock.calls.at(-1)!.join(" ");
      expect(warmWarn).toContain("requestId=req-p1-0-stderr-warm");
      expect(warmWarn).toContain("exitCode=3");
      const warmStderrMatch = /stderr=(".*")$/.exec(warmWarn);
      expect(warmStderrMatch).toBeTruthy();
      const warmLoggedStderr = JSON.parse(warmStderrMatch![1]!) as string;
      expect(Buffer.byteLength(warmLoggedStderr, "utf8")).toBeLessThanOrEqual(2048);
      expect(warmLoggedStderr).toContain(tailMarker);
      expect(warmLoggedStderr).not.toContain(headMarker);
      expect(warmLoggedStderr).not.toContain("sk-stderr987654");
    } finally {
      await pool.disposeAll();
    }
  });

  test("warn-logs last 5 stream frames' { type, stepType, state } without content on empty completion", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    activeSpies.push(warnSpy);

    const adapter = createAntigravityCliAdapter(provider(), {
      which: () => "/bin/agy",
      platform: "linux",
      spawn: () => createStreamChild([
        JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } }),
        JSON.stringify({
          event: "step_update",
          step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", thinking_delta: "SECRET_THINKING_1" },
        }),
        JSON.stringify({
          event: "step_update",
          step_update: { step_index: 1, state: "DONE", step_type: "agent_response", thinking_delta: "SECRET_THINKING_2" },
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            step_index: 2,
            state: "ACTIVE",
            step_type: "tool",
            tool_name: BRIDGED_READ_TOOL,
            tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "SECRET_PARAM_PATH" } },
          },
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            step_index: 2,
            state: "ERROR",
            step_type: "tool",
            tool_name: BRIDGED_READ_TOOL,
            tool_info: { name: BRIDGED_READ_TOOL, error: { message: "SECRET_ERROR_MSG" } },
          },
        }),
        JSON.stringify({
          event: "step_update",
          step_update: { step_index: 3, state: "DONE", step_type: "agent_response", thinking_delta: "SECRET_THINKING_3" },
        }),
        JSON.stringify({
          event: "result",
          result: { status: "SUCCESS", response: "" },
        }),
      ], { emitClose: true }).child as unknown as ChildProcess,
    });

    const events = await runTurn(
      adapter,
      twoToolRequest(),
      incomingWithRequestId("req-p1-0-empty"),
    );

    expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0]!.join(" ");
    expect(line).toContain("requestId=req-p1-0-empty");
    expect(line).not.toContain("SECRET_THINKING");
    expect(line).not.toContain("SECRET_PARAM_PATH");
    expect(line).not.toContain("SECRET_ERROR_MSG");

    const framesMatch = /recentFrames=(\[.*\])/.exec(line);
    expect(framesMatch).toBeTruthy();
    const recentFrames = JSON.parse(framesMatch![1]!) as Array<{ type: string; stepType?: string; state?: string }>;
    expect(recentFrames).toEqual([
      { type: "step_update", stepType: "agent_response", state: "DONE" },
      { type: "step_update", stepType: "tool", state: "ACTIVE" },
      { type: "step_update", stepType: "tool", state: "ERROR" },
      { type: "step_update", stepType: "agent_response", state: "DONE" },
      { type: "result", state: "SUCCESS" },
    ]);
  });

  test("Defect 1: real startServer /v1/responses without x-request-id logs ocx-... requestId matching response header", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    activeSpies.push(warnSpy);

    const previousHome = process.env.OPENCODEX_HOME;
    const isolatedCodexHome = installIsolatedCodexHome("ocx-ag-p1-defect1-");
    const testDir = mkdtempSync(join(tmpdir(), "ocx-ag-p1-defect1-"));
    process.env.OPENCODEX_HOME = testDir;

    const definition = getAdapterDefinition("antigravity-cli")! as { create: (...args: unknown[]) => unknown };
    const originalCreate = definition.create;
    let proxy: ReturnType<typeof startServer> | undefined;

    try {
      const entry = PROVIDER_REGISTRY.find(row => row.id === "antigravity-cli")!;
      const cfg: OcxConfig = {
        port: 0,
        clientIntegrations: { codex: false },
        defaultProvider: "antigravity-cli",
        providers: {
          "antigravity-cli": {
            ...providerConfigSeed(entry),
            selectedModels: [...ANTIGRAVITY_CLI_MODELS],
          },
        },
      } as OcxConfig;
      saveConfig(cfg);

      definition.create = (providerCfg: OcxProviderConfig) => createAntigravityCliAdapter(providerCfg, {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: () => createStreamChild([
          JSON.stringify({
            event: "result",
            result: {
              status: "ERROR",
              error: {
                code: 400,
                status: "INVALID_ARGUMENT",
                message: "INVALID_ARGUMENT: Server E2E failure",
              },
            },
          }),
        ], { emitClose: true }).child as unknown as ChildProcess,
      });

      proxy = startServer(0);
      const response = await fetch(new URL("/v1/responses", proxy.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "antigravity-cli/gemini-4-carbon", input: "hi", stream: false }),
      });
      await response.text();

      const headerReqId = response.headers.get("x-opencodex-request-id");
      expect(headerReqId).toBeTruthy();
      expect(headerReqId!).toMatch(/^ocx-/);

      const matchedWarn = warnSpy.mock.calls
        .map(call => call.join(" "))
        .find(line => line.includes("[antigravity-cli] error"));
      expect(matchedWarn).toBeDefined();
      expect(matchedWarn!).toContain(`requestId=${headerReqId}`);
    } finally {
      definition.create = originalCreate;
      try { await proxy?.stop(true); } catch { /* ignore */ }
      if (testDir) await removeTreeAfterBackgroundWork(testDir);
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      isolatedCodexHome.restoreEnvironment();
      isolatedCodexHome.removeAfterDrain();
    }
  }, BACKGROUND_WORK_TEARDOWN_TIMEOUT_MS);

  test("Defect 2: redacts Bearer, Google OAuth ya29, x-goog-api-key AIza, and sk- tokens across raw error, stderr, and debug logs", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    activeSpies.push(warnSpy, debugSpy);

    const secretPayload = [
      "authorization: Bearer secret-tok",
      "ya29.a0AfH6SM_test_google_oauth_token",
      "x-goog-api-key: AIzaSyTestKey1234567890",
      "sk-stderr987654",
    ].join(" | ");

    // Raw error path + bridged tool ERROR debug log path
    const rawAdapter = createAntigravityCliAdapter(provider(), {
      which: () => "/bin/agy",
      platform: "linux",
      toolBatchCoalesceMs: 120,
      spawn: () => {
        const { child, stdout } = createStreamChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 3,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } },
            },
          }),
        ]);
        setTimeout(() => {
          stdout.write(`${JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 3,
              state: "ERROR",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, error: { message: secretPayload } },
            },
          })}\n`);
          stdout.write(`${JSON.stringify({
            event: "result",
            result: {
              status: "ERROR",
              error: {
                code: 401,
                status: "UNAUTHENTICATED",
                message: "UNAUTHENTICATED: auth failed",
                details: secretPayload,
              },
            },
          })}\n`);
          stdout.end();
        }, 20);
        return child as unknown as ChildProcess;
      },
    });

    await runTurn(rawAdapter, twoToolRequest(), incomingWithRequestId("req-defect2-raw"));

    const rawWarnLine = warnSpy.mock.calls.at(-1)!.join(" ");
    const debugLine = debugSpy.mock.calls.at(-1)!.join(" ");
    for (const logged of [rawWarnLine, debugLine]) {
      expect(logged).not.toContain("secret-tok");
      expect(logged).not.toContain("ya29.");
      expect(logged).not.toContain("AIzaSyTestKey");
      expect(logged).not.toContain("sk-stderr987654");
    }

    // Stderr crash path
    const stderrAdapter = createAntigravityCliAdapter(provider(), {
      which: () => "/bin/agy",
      platform: "linux",
      spawn: () => createStreamChild([], {
        exitCode: 2,
        emitClose: true,
        stderr: `CRASH: ${secretPayload}`,
      }).child as unknown as ChildProcess,
    });

    await runTurn(
      stderrAdapter,
      twoToolRequest({ context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] } }),
      incomingWithRequestId("req-defect2-stderr"),
    );

    const stderrWarnLine = warnSpy.mock.calls.at(-1)!.join(" ");
    expect(stderrWarnLine).toContain("requestId=req-defect2-stderr");
    expect(stderrWarnLine).not.toContain("secret-tok");
    expect(stderrWarnLine).not.toContain("ya29.");
    expect(stderrWarnLine).not.toContain("AIzaSyTestKey");
    expect(stderrWarnLine).not.toContain("sk-stderr987654");
  });

  test("Defect 3: preserves rolling stderr tail past 8 KiB on single-shot and 2-turn warm session crashes", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    activeSpies.push(warnSpy);

    const singleStderr = `SINGLE_HEAD_DROPPED ${"x".repeat(12_500)} FATAL_TAIL_SINGLE_SHOT`;
    const singleAdapter = createAntigravityCliAdapter(provider(), {
      which: () => "/bin/agy",
      platform: "linux",
      spawn: () => createStreamChild([], {
        exitCode: 2,
        emitClose: true,
        stderr: singleStderr,
      }).child as unknown as ChildProcess,
    });

    await runTurn(
      singleAdapter,
      twoToolRequest({ context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] } }),
      incomingWithRequestId("req-defect3-single"),
    );

    const singleWarn = warnSpy.mock.calls.at(-1)!.join(" ");
    const singleMatch = /stderr=(".*")$/.exec(singleWarn);
    expect(singleMatch).toBeTruthy();
    const singleLogged = JSON.parse(singleMatch![1]!) as string;
    expect(Buffer.byteLength(singleLogged, "utf8")).toBeLessThanOrEqual(2048);
    expect(singleLogged).toContain("FATAL_TAIL_SINGLE_SHOT");
    expect(singleLogged).not.toContain("SINGLE_HEAD_DROPPED");

    // 2-turn warm session: turn 1 writes 9 KiB stderr and succeeds; turn 2 writes 12 KiB stderr and exits non-zero.
    const pool = new AntigravitySessionPool();
    let stdoutRef: PassThrough | undefined;
    let stderrRef: PassThrough | undefined;
    let childRef: FakeChild | undefined;
    try {
      const warmAdapter = createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        enableSessionPool: true,
        sessionPool: pool,
        spawn: () => {
          const created = createStreamChild(
            [
              JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } }),
            ],
            { keepStderrOpen: true },
          );
          stdoutRef = created.stdout;
          stderrRef = created.stderrStream;
          childRef = created.child;
          setTimeout(() => {
            stderrRef?.write(`TURN1_NOISE_HEAD ${"t".repeat(9_500)} TURN1_END\n`);
            stdoutRef?.write(`${JSON.stringify({
              event: "step_update",
              step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "ok turn 1" },
            })}\n`);
            stdoutRef?.write(`${JSON.stringify({
              event: "result",
              result: { status: "SUCCESS", response: "ok turn 1" },
            })}\n`);
          }, 15);
          return created.child as unknown as ChildProcess;
        },
      });

      const turn1Events = await runTurn(
        warmAdapter,
        twoToolRequest({ context: { messages: [{ role: "user", content: "turn 1", timestamp: 0 }] } }),
        incomingWithRequestId("req-defect3-warm-1"),
      );
      expect(turn1Events).toEqual([
        { type: "text_delta", text: "ok turn 1" },
        { type: "done", stopReason: "stop" },
      ]);

      setTimeout(() => {
        stdoutRef?.write(`${JSON.stringify({
          event: "step_update",
          step_update: { step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "partial turn 2 " },
        })}\n`);
        stderrRef?.write(`TURN2_NOISE_HEAD ${"w".repeat(12_500)} FATAL_TAIL_WARM_TURN2\n`);
        stderrRef?.end();
        stdoutRef?.end();
        if (childRef) {
          childRef.exitCode = 7;
          childRef.emit("close", 7);
        }
      }, 25);

      const turn2Events = await runTurn(
        warmAdapter,
        twoToolRequest({
          context: {
            messages: [
              { role: "user", content: "turn 1", timestamp: 0 },
              { role: "assistant", content: [{ type: "text", text: "ok turn 1" }], timestamp: 1 },
              { role: "user", content: "turn 2", timestamp: 2 },
            ],
          },
        }),
        incomingWithRequestId("req-defect3-warm-2"),
      );
      expect(turn2Events).toEqual([
        { type: "text_delta", text: "partial turn 2 " },
        expect.objectContaining({ type: "error", code: "process_exit_error" }),
      ]);

      const warmWarn = warnSpy.mock.calls.at(-1)!.join(" ");
      expect(warmWarn).toContain("requestId=req-defect3-warm-2");
      expect(warmWarn).toContain("exitCode=7");
      const warmMatch = /stderr=(".*")$/.exec(warmWarn);
      expect(warmMatch).toBeTruthy();
      const warmLogged = JSON.parse(warmMatch![1]!) as string;
      expect(Buffer.byteLength(warmLogged, "utf8")).toBeLessThanOrEqual(2048);
      expect(warmLogged).toContain("FATAL_TAIL_WARM_TURN2");
      expect(warmLogged).not.toContain("TURN2_NOISE_HEAD");
      expect(warmLogged).not.toContain("TURN1_NOISE_HEAD");
    } finally {
      await pool.disposeAll();
    }
  });

  test("forwards configured outbound proxy with loopback NO_PROXY and transparently retries pre-output Eligibility EOF", async () => {
    const httpResolved = resolveAntigravityOutboundProxyEnv(
      { ...provider(), proxy: "http://127.0.0.1:7897" },
      {},
    );
    expect(httpResolved).toMatchObject({
      httpProxy: "http://127.0.0.1:7897/",
      httpsProxy: "http://127.0.0.1:7897/",
    });
    expect(httpResolved?.noProxy).toContain("127.0.0.1");
    expect(httpResolved?.noProxy).toContain("localhost");
    const childEnv = buildChildEnv(undefined, undefined, httpResolved);
    expect(childEnv.HTTPS_PROXY).toBe("http://127.0.0.1:7897/");
    expect(childEnv.HTTP_PROXY).toBe("http://127.0.0.1:7897/");
    expect(childEnv.NO_PROXY).toContain("127.0.0.1");

    const directResolved = resolveAntigravityOutboundProxyEnv(
      { ...provider(), proxy: "direct" },
      { outboundProxy: "http://127.0.0.1:7897" },
    );
    expect(directResolved).toEqual({ noProxy: "*" });
    expect(buildChildEnv(undefined, undefined, directResolved).HTTPS_PROXY).toBeUndefined();

    const pool = new AntigravitySessionPool();
    let spawns = 0;
    const spawnedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    try {
      const adapter = createAntigravityCliAdapter(
        { ...provider(), proxy: "http://127.0.0.1:7897" },
        {
          which: () => "/bin/agy",
          platform: "linux",
          enableSessionPool: true,
          sessionPool: pool,
          maxPreludeRetries: 2,
          preludeRetryDelayMs: 5,
          spawn: (_cmd, _args, opts) => {
            spawns += 1;
            spawnedEnvs.push(opts.env);
            if (spawns === 1) {
              return createStreamChild([], {
                exitCode: 1,
                emitClose: true,
                stderr: 'Eligibility check failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": EOF\n',
              }).child as unknown as ChildProcess;
            }
            const created = createStreamChild([
              JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "request-review" } }),
              JSON.stringify({
                event: "step_update",
                step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "recovered ok" },
              }),
              JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "recovered ok" } }),
            ]);
            return created.child as unknown as ChildProcess;
          },
        },
      );

      const events = await runTurn(
        adapter,
        twoToolRequest({ context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] } }),
        incomingWithRequestId("req-eof-retry"),
      );
      expect(spawns).toBe(2);
      expect(spawnedEnvs[0]?.HTTPS_PROXY).toBe("http://127.0.0.1:7897/");
      expect(events).toEqual([
        { type: "text_delta", text: "recovered ok" },
        { type: "done", stopReason: "stop" },
      ]);
    } finally {
      await pool.disposeAll();
    }
  });
});
