import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { buildArgs, buildChildEnv, createCodeBuddyAdapter, type SpawnFn } from "../src/adapters/codebuddy/adapter";
import { CODEBUDDY_CN_PROFILE, CODEBUDDY_GLOBAL_PROFILE, clearCodeBuddyBinaryCache } from "../src/adapters/codebuddy/profiles";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const enc = new TextEncoder();

// The binary-discovery cache is module-level (a production perf seam); reset it so a test that
// reports a missing CLI cannot mask a later test's injected binary.
beforeEach(() => clearCodeBuddyBinaryCache());

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
  written: string[];
}

function fakeChild(stdout: Uint8Array[], opts: { stderr?: string; exitCode?: number; emitClose?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Readable.from(stdout);
  child.stderr = Readable.from(opts.stderr ? [enc.encode(opts.stderr)] : []);
  child.written = [];
  child.stdin = new Writable({ write(chunk, _enc, cb) { child.written.push(String(chunk)); cb(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => { child.killed = true; return true; };
  if (opts.emitClose !== false) {
    setTimeout(() => { child.exitCode = opts.exitCode ?? 0; child.emit("close", opts.exitCode ?? 0); }, 3);
  }
  return child;
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "codebuddy",
    baseUrl: CODEBUDDY_GLOBAL_PROFILE.canonicalBaseUrl,
    apiKey: "cb-global-key",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    ...overrides,
  } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "glm-5.3",
    stream: true,
    options: {},
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    ...overrides,
  } as OcxParsedRequest;
}

function incoming(abortSignal?: AbortSignal) {
  return { headers: new Headers(), translatorBudget: createTestTranslatorBudget(), ...(abortSignal ? { abortSignal } : {}) };
}

async function run(adapter: ReturnType<typeof createCodeBuddyAdapter>, p: OcxParsedRequest, inc = incoming()): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(p, inc, e => events.push(e));
  return events;
}

describe("codebuddy child environment is region-scoped and never global", () => {
  test("global profile sets public environment and the global key only", () => {
    const env = buildChildEnv(CODEBUDDY_GLOBAL_PROFILE, "cb-global-key");
    expect(env.CODEBUDDY_INTERNET_ENVIRONMENT).toBe("public");
    expect(env.CODEBUDDY_API_KEY).toBe("cb-global-key");
    expect(env.CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
  });

  test("CN profile sets internal environment and the CN key only", () => {
    const env = buildChildEnv(CODEBUDDY_CN_PROFILE, "cb-cn-key");
    expect(env.CODEBUDDY_INTERNET_ENVIRONMENT).toBe("internal");
    expect(env.CODEBUDDY_API_KEY).toBe("cb-cn-key");
  });

  test("a stray parent CODEBUDDY_INTERNET_ENVIRONMENT cannot flip the region", () => {
    const previous = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = "internal";
    try {
      const env = buildChildEnv(CODEBUDDY_GLOBAL_PROFILE, "k");
      expect(env.CODEBUDDY_INTERNET_ENVIRONMENT).toBe("public");
      // The parent CODEBUDDY_* is never inherited: only the profile-set keys are present.
      expect(Object.keys(env).filter(k => k.startsWith("CODEBUDDY_")).sort()).toEqual([
        "CODEBUDDY_API_KEY", "CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS", "CODEBUDDY_INTERNET_ENVIRONMENT",
      ]);
    } finally {
      if (previous === undefined) delete process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
      else process.env.CODEBUDDY_INTERNET_ENVIRONMENT = previous;
    }
  });
});

describe("codebuddy headless arguments keep tool ownership with Codex", () => {
  test("disables all CLI tools and never requests permission bypass", () => {
    const args = buildArgs(CODEBUDDY_GLOBAL_PROFILE, parsed(), provider());
    const toolsIndex = args.indexOf("--tools");
    expect(toolsIndex).toBeGreaterThanOrEqual(0);
    expect(args[toolsIndex + 1]).toBe(""); // "" = disable all built-in tools
    expect(args).toContain("--strict-mcp-config"); // no MCP tools either
    expect(args).not.toContain("-y");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--model") + 1]).toBe("glm-5.3");
  });

  test("maps Codex reasoning effort onto --effort and folds the system prompt", () => {
    const args = buildArgs(
      CODEBUDDY_GLOBAL_PROFILE,
      parsed({ options: { reasoning: "high" }, context: { systemPrompt: ["Be terse."], messages: [] } }),
      provider(),
    );
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("Be terse.");
  });
});

describe("codebuddy runTurn fails closed before any spawn", () => {
  test("a non-canonical base URL is refused and the credential is never placed in a child env", async () => {
    let spawned = 0;
    const spawn: SpawnFn = () => { spawned++; return fakeChild([]) as unknown as ChildProcess; };
    const adapter = createCodeBuddyAdapter(provider({ baseUrl: "https://evil.example.test" }), { spawn, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, parsed());
    expect(spawned).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", code: "non_canonical_destination", retryable: false });
  });

  test("a missing credential is refused before spawn", async () => {
    let spawned = 0;
    const adapter = createCodeBuddyAdapter(provider({ apiKey: undefined }), { spawn: () => { spawned++; return fakeChild([]) as unknown as ChildProcess; }, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, parsed());
    expect(spawned).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", code: "missing_credential" });
  });

  test("a missing CLI is a clear pre-flight error, not a mid-turn ENOENT", async () => {
    let spawned = 0;
    const adapter = createCodeBuddyAdapter(provider(), { spawn: () => { spawned++; return fakeChild([]) as unknown as ChildProcess; }, which: () => undefined });
    const events = await run(adapter, parsed());
    expect(spawned).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", code: "cli_not_found" });
    expect(String((events[0] as { message: string }).message)).toContain("npm install -g @tencent-ai/codebuddy-code");
  });

  test("an asynchronous spawn failure settles as cli_spawn_failed without waiting for close", async () => {
    const child = fakeChild([], { emitClose: false });
    const adapter = createCodeBuddyAdapter(provider(), {
      spawn: () => {
        setTimeout(() => child.emit("error", Object.assign(new Error("spawn ENOENT cb-global-key"), { code: "ENOENT" })), 0);
        return child as unknown as ChildProcess;
      },
      which: () => "/stale/path/codebuddy",
      killGraceMs: 20,
    });

    const events = await run(adapter, parsed());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "cli_spawn_failed", retryable: false });
    expect((events[0] as { message: string }).message).not.toContain("cb-global-key");
  });

  test("a synchronous spawn failure redacts the exact configured credential", async () => {
    const adapter = createCodeBuddyAdapter(provider(), {
      spawn: () => { throw new Error("launch rejected credential cb-global-key"); },
      which: () => "/stale/path/codebuddy",
    });

    const events = await run(adapter, parsed());
    expect(events[0]).toMatchObject({ type: "error", code: "cli_spawn_failed", retryable: false });
    expect((events[0] as { message: string }).message).toContain("credential [redacted]");
    expect((events[0] as { message: string }).message).not.toContain("cb-global-key");
  });

  test("a Windows cmd shim is launched through commandInvocation with escaped arguments", async () => {
    let command = "";
    let args: readonly string[] = [];
    let options: import("node:child_process").SpawnOptions | undefined;
    const adapter = createCodeBuddyAdapter(provider(), {
      platform: "win32",
      which: () => "C:\\npm\\codebuddy.cmd",
      spawn: (seenCommand, seenArgs, seenOptions) => {
        command = seenCommand;
        args = seenArgs;
        options = seenOptions;
        return fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess;
      },
      killGraceMs: 20,
    });

    await run(adapter, parsed({ context: { systemPrompt: ['Say "hello" & stop'], messages: [] } }));
    expect(command.toLowerCase()).toContain("cmd.exe");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(args[3]).toContain("codebuddy.cmd");
    expect(args[3]).toContain("Say");
    expect(options?.windowsVerbatimArguments).toBe(true);
  });
});

describe("codebuddy runTurn streams a headless turn", () => {
  test("emits text deltas then done with usage, and feeds the conversation to stdin", async () => {
    const stdout = [
      enc.encode('{"type":"system","subtype":"init"}\n'),
      enc.encode('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}\n'),
      enc.encode('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}\n'),
      enc.encode('{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":7,"output_tokens":2}}\n'),
    ];
    const child = fakeChild(stdout);
    const adapter = createCodeBuddyAdapter(provider(), { spawn: () => child as unknown as ChildProcess, which: () => "/usr/bin/codebuddy", killGraceMs: 20 });
    const events = await run(adapter, parsed());
    expect(events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("")).toBe("Hello");
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 } });
    expect(child.written.join("")).toContain('"text":"hello"');
  });

  test("region isolation: the global adapter never spawns with the CN environment", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const spawn: SpawnFn = (_cmd, _args, opts) => { seenEnv = opts.env as NodeJS.ProcessEnv; return fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess; };
    const adapter = createCodeBuddyAdapter(provider(), { spawn, which: () => "/usr/bin/codebuddy", killGraceMs: 20 });
    await run(adapter, parsed());
    expect(seenEnv?.CODEBUDDY_INTERNET_ENVIRONMENT).toBe("public");
    expect(seenEnv?.CODEBUDDY_API_KEY).toBe("cb-global-key");
  });

  test("an upstream error result surfaces as an error event", async () => {
    const stdout = [enc.encode('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"insufficient credits"}\n')];
    const adapter = createCodeBuddyAdapter(provider(), { spawn: () => fakeChild(stdout) as unknown as ChildProcess, which: () => "/usr/bin/codebuddy", killGraceMs: 20 });
    const events = await run(adapter, parsed());
    expect(events.at(-1)).toMatchObject({ type: "error", message: "insufficient credits", status: 502 });
  });

  test("a pre-aborted signal ends the turn without spawning", async () => {
    let spawned = 0;
    const controller = new AbortController();
    controller.abort();
    const adapter = createCodeBuddyAdapter(provider(), { spawn: () => { spawned++; return fakeChild([]) as unknown as ChildProcess; }, which: () => "/usr/bin/codebuddy" });
    const events = await run(adapter, parsed(), incoming(controller.signal));
    expect(spawned).toBe(0);
    expect(events[0]).toMatchObject({ type: "error" });
  });

  test("a CLI that exits without a result reports stderr (redacted) as an upstream error", async () => {
    const child = fakeChild([], { stderr: "fatal: CODEBUDDY_API_KEY=sk-secretvalue rejected", exitCode: 1 });
    const adapter = createCodeBuddyAdapter(provider(), { spawn: () => child as unknown as ChildProcess, which: () => "/usr/bin/codebuddy", killGraceMs: 20 });
    const events = await run(adapter, parsed());
    const last = events.at(-1) as { type: string; message: string; code: string };
    expect(last.type).toBe("error");
    expect(last.code).toBe("process_exit_error");
    expect(last.message).not.toContain("sk-secretvalue");
  });

  test("redacts the exact configured credential even when stderr uses no known secret prefix", async () => {
    const child = fakeChild([], { stderr: "authentication failed: token cb-global-key rejected", exitCode: 1 });
    const adapter = createCodeBuddyAdapter(provider(), { spawn: () => child as unknown as ChildProcess, which: () => "/usr/bin/codebuddy", killGraceMs: 20 });
    const events = await run(adapter, parsed());
    const last = events.at(-1) as { message: string };
    expect(last.message).toContain("token [redacted] rejected");
    expect(last.message).not.toContain("cb-global-key");
  });

  test("a CLI that exits with non-zero exit code and empty stderr reports process_exit_error and never done", async () => {
    const child = fakeChild([], { stderr: "", exitCode: 1 });
    const adapter = createCodeBuddyAdapter(provider(), { spawn: () => child as unknown as ChildProcess, which: () => "/usr/bin/codebuddy", killGraceMs: 20 });
    const events = await run(adapter, parsed());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      status: 502,
      code: "process_exit_error",
      errorType: "upstream_error",
    });
    expect((events[0] as { message: string }).message).toContain("exited with non-zero exit code 1");
    // Under no circumstance should a synthetic done be emitted!
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("a CLI that exits with code 0 but emitted no terminal result frame fails closed with protocol_error", async () => {
    // Upstream closed stdout without emitting a result frame
    const child = fakeChild([
      enc.encode('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}}\n'),
    ], { exitCode: 0 });
    const adapter = createCodeBuddyAdapter(provider(), { spawn: () => child as unknown as ChildProcess, which: () => "/usr/bin/codebuddy", killGraceMs: 20 });
    const events = await run(adapter, parsed());
    expect(events.some(e => e.type === "done")).toBe(false);
    const last = events.at(-1) as { type: string; message: string; code: string; status: number };
    expect(last.type).toBe("error");
    expect(last.code).toBe("protocol_error");
    expect(last.status).toBe(502);
    expect(last.message).toContain("ended without a terminal result frame");
  });

  test("a stream with malformed JSON terminates child and fails closed with protocol_error", async () => {
    const child = fakeChild([
      enc.encode('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}\n'),
      enc.encode('CORRUPTED_NOT_JSON\n'),
      enc.encode('{"type":"result","subtype":"success","is_error":false}\n'),
    ], { exitCode: 0 });
    const adapter = createCodeBuddyAdapter(provider(), { spawn: () => child as unknown as ChildProcess, which: () => "/usr/bin/codebuddy", killGraceMs: 20 });
    const events = await run(adapter, parsed());
    expect(child.killed).toBe(true);
    expect(events.some(e => e.type === "done")).toBe(false);
    const last = events.at(-1) as { type: string; message: string; code: string; status: number };
    expect(last.type).toBe("error");
    expect(last.code).toBe("protocol_error");
    expect(last.status).toBe(502);
    expect(last.message).toContain("Malformed stream-json frame");
  });

  test("an in-flight abort kills the child process gracefully with SIGTERM", async () => {
    const controller = new AbortController();
    const stdoutStream = new Readable({
      read() {
        // Feed one partial delta then abort before result
        this.push(enc.encode('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"start"}}}\n'));
        setTimeout(() => controller.abort(), 5);
      },
    });
    const child = new EventEmitter() as FakeChild;
    child.stdout = stdoutStream;
    child.stderr = Readable.from([]);
    child.written = [];
    child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    child.killed = false;
    child.exitCode = null;
    let killSignal: string | undefined;
    child.kill = (sig?: string) => {
      child.killed = true;
      killSignal = sig;
      setTimeout(() => { child.exitCode = 143; child.emit("close", 143); }, 5);
      return true;
    };

    const adapter = createCodeBuddyAdapter(provider(), { spawn: () => child as unknown as ChildProcess, which: () => "/usr/bin/codebuddy", killGraceMs: 20 });
    const events = await run(adapter, parsed(), incoming(controller.signal));
    expect(child.killed).toBe(true);
    expect(killSignal).toBe("SIGTERM");
    expect(events.some(e => e.type === "error")).toBe(true);
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("a timeout destroys a stalled stdout stream and returns even when close never arrives", async () => {
    const stdoutStream = new Readable({ read() { /* stays open until timeout destroys it */ } });
    const child = new EventEmitter() as FakeChild;
    child.stdout = stdoutStream;
    child.stderr = Readable.from([]);
    child.written = [];
    child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    child.killed = false;
    child.exitCode = null;
    const signals: string[] = [];
    child.kill = (sig?: string) => {
      child.killed = true;
      signals.push(sig ?? "SIGTERM");
      return true;
    };

    const adapter = createCodeBuddyAdapter(provider(), {
      spawn: () => child as unknown as ChildProcess,
      which: () => "/usr/bin/codebuddy",
      timeoutMs: 10,
      killGraceMs: 10,
      reapTimeoutMs: 35,
    });
    const startedAt = Date.now();
    const events = await run(adapter, parsed());

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(stdoutStream.destroyed).toBe(true);
    expect(signals).toContain("SIGTERM");
    expect(events).toContainEqual(expect.objectContaining({ type: "error", status: 504, code: "timeout" }));
    expect(events.some(e => e.type === "done")).toBe(false);
  });
});
