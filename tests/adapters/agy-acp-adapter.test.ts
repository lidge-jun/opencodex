/**
 * Antigravity ACP adapter driven against a scripted fake ACP child (plan 080). No real agy runs.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createAgyAcpAdapter, AGY_ACP_ARGS, type AgyAcpDeps } from "../../src/adapters/agy-acp/adapter";
import { MAX_ACP_LINE_BYTES } from "../../src/adapters/agy-acp/acp";
import { AgyAcpTreeCleanupError, createTurnWorkspace, reapProcessTree, type AgyAcpChild } from "../../src/adapters/agy-acp/process";
import * as windowsAcl from "../../src/lib/windows-secret-acl";
import { runWithRequestPeer } from "../../src/lib/request-peer-scope";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import type { IncomingMeta } from "../../src/adapters/base";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type Frame = Record<string, any>;
interface AgentApi {
  reply(id: unknown, result: unknown): void;
  error(id: unknown, code: number, message: string): void;
  notify(update: Record<string, unknown>): void;
  request(id: unknown, method: string, params?: unknown): void;
  stderr(text: string): void;
  exit(code: number): void;
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean { return true; }
}

const SENTINEL = "SENTINEL-prompt-body-7f3a";
const provider = { adapter: "agy-acp", baseUrl: "https://antigravity.google/docs/cli/acp" } as OcxProviderConfig;

function modelOption(current: string, values: string[], extra: Record<string, unknown> = { category: "model" }): Frame {
  return { id: "model", name: "Model", type: "select", currentValue: current, options: values.map(value => ({ value, name: value })), ...extra };
}
function thoughtOption(current: string, values = ["low", "medium", "high", "extra", "max"]): Frame {
  return { id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: current, options: values.map(value => ({ value, name: value[0]!.toUpperCase() + value.slice(1) })) };
}
const OFFERED = ["gemini-3.8-flash", "gemini-4-argon", "claude-opus-5-5"];

function parsed(overrides: Partial<OcxParsedRequest> = {}, reasoning?: string): OcxParsedRequest {
  return {
    modelId: "gemini-3.8-flash", stream: true,
    options: reasoning ? { reasoning } : {},
    context: { systemPrompt: ["be brief"], messages: [{ role: "user", content: "hi there" }] },
    ...overrides,
  } as unknown as OcxParsedRequest;
}

interface Harness { events: AdapterEvent[]; sent: Frame[]; spawned: number; probed: number; args: string[]; env: Record<string, string>; cwd: string; removed: boolean }

/** The default agent: answers every phase; `onFrame` may intercept a frame first. */
function script(onFrame?: (frame: Frame, api: AgentApi, state: { config: Frame[] }) => boolean | void, options: { initial?: Frame[]; systemPrompt?: boolean; stopReason?: string } = {}) {
  return (child: FakeChild, sent: Frame[]) => {
    const state = { config: options.initial ?? [modelOption("gemini-3.8-flash", OFFERED), thoughtOption("high")] };
    const write = (frame: Frame) => child.stdout.write(`${JSON.stringify(frame)}\n`);
    const api: AgentApi = {
      reply: (id, result) => write({ jsonrpc: "2.0", id, result }),
      error: (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } }),
      notify: update => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update } }),
      request: (id, method, params) => write({ jsonrpc: "2.0", id, method, params }),
      stderr: text => child.stderr.write(text),
      exit: code => { child.exitCode = code; child.stdout.end(); child.emit("close", code); },
    };
    let buffer = "";
    child.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, index)) as Frame;
        buffer = buffer.slice(index + 1);
        sent.push(frame);
        if (onFrame?.(frame, api, state)) continue;
        if (frame.method === "initialize") api.reply(frame.id, { protocolVersion: 1, agentCapabilities: options.systemPrompt ? { sessionCapabilities: { systemPrompt: {} } } : {} });
        else if (frame.method === "session/new") api.reply(frame.id, { sessionId: "s1", configOptions: state.config });
        else if (frame.method === "session/set_config_option") {
          state.config = state.config.map(option => option.id === frame.params.configId ? { ...option, currentValue: frame.params.value } : option);
          api.reply(frame.id, { configOptions: state.config });
        } else if (frame.method === "session/prompt") {
          api.notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
          api.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } });
          api.reply(frame.id, { stopReason: options.stopReason ?? "end_turn" });
        }
      }
    });
  };
}

async function run(agent: ReturnType<typeof script>, opts: {
  parsed?: OcxParsedRequest; headers?: Headers; comboAttempt?: boolean; subagentFallback?: boolean; internalDecisionCall?: boolean; local?: boolean;
  deps?: Partial<AgyAcpDeps>; abort?: AbortController; beforeRun?: (child: FakeChild) => void;
  sendAccounting?: Pick<IncomingMeta, "sendBudget" | "beforePhysicalSend" | "onPhysicalSend">;
} = {}): Promise<Harness> {
  const h: Harness = { events: [], sent: [], spawned: 0, probed: 0, args: [], env: {}, cwd: "", removed: false };
  const adapter = createAgyAcpAdapter(provider, {
    resolveBinary: () => "/fake/agy",
    probeVersion: async () => { h.probed++; return { ok: true, version: "1.5.3" }; },
    createWorkspace: async () => ({ dir: "/tmp/ocx-agy-acp-test", tmp: "/tmp/ocx-agy-acp-test/.tmp", remove: async () => { h.removed = true; } }),
    reap: async () => {},
    spawn: (_binary, args, options) => {
      h.spawned++; h.args = args; h.env = options.env; h.cwd = options.cwd;
      const child = new FakeChild();
      agent(child, h.sent);
      opts.beforeRun?.(child);
      return child as unknown as AgyAcpChild;
    },
    ...opts.deps,
  });
  const go = () => adapter.runTurn!(opts.parsed ?? parsed(), {
    headers: opts.headers ?? new Headers(),
    translatorBudget: undefined as never,
    ...(opts.comboAttempt ? { comboAttempt: true } : {}),
    ...(opts.subagentFallback ? { subagentFallback: true } : {}),
    ...(opts.internalDecisionCall ? { internalDecisionCall: true } : {}),
    ...(opts.abort ? { abortSignal: opts.abort.signal } : {}),
    ...opts.sendAccounting,
  }, event => h.events.push(event));
  await runWithRequestPeer(opts.local === false ? undefined : { local: true }, go);
  return h;
}

const terminal = (h: Harness) => h.events.filter(e => e.type === "done" || e.type === "error");
const methods = (h: Harness) => h.sent.filter(f => typeof f.method === "string").map(f => f.method as string);
const errorCode = (h: Harness) => (terminal(h)[0] as { code?: string } | undefined)?.code;
const adminShape = "ocx_admin_" + "a_".repeat(21) + "A";
const sessionShape = "ocx_session_" + "b".repeat(43);
const dataKeyShape = "ocx_data_" + "c".repeat(40);
const workspaceTokenShape = "ocxrw_" + "w".repeat(43);

afterEach(() => { delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; });

describe("agy acp turn", () => {
  test.each(["success", "failure"])("Windows requires a private workspace ACL before spawning (%s)", async outcome => {
    const root = mkdtempSync(join(tmpdir(), "ocx-agy-acl-test-"));
    const calls: string[] = [];
    const platform = spyOn(windowsAcl, "windowsSecretAclApplies").mockReturnValue(true);
    const harden = spyOn(windowsAcl, "hardenSecretDirAsync").mockImplementation(async (dir, options) => {
      calls.push("acl");
      expect(options.required).toBe(true);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, ".tmp"))).toBe(false);
      if (outcome === "failure") throw new Error("mock icacls failure");
      return { ok: true };
    });
    const forget = spyOn(windowsAcl, "forgetEphemeralSecretDir").mockImplementation(dir => {
      expect(existsSync(dir)).toBe(false);
      calls.push("forget");
    });
    try {
      const h = await run(script(), {
        deps: { createWorkspace: () => createTurnWorkspace(join(root, "home"), root) },
        beforeRun: () => { calls.push("spawn"); },
      });
      expect(calls).toEqual(outcome === "success" ? ["acl", "spawn", "forget"] : ["acl", "forget"]);
      if (outcome === "success") {
        expect(terminal(h)).toEqual([{ type: "done" }]);
      } else {
        expect(h.spawned).toBe(0);
        expect(errorCode(h)).toBe("agy_acp_unavailable");
      }
      expect(readdirSync(root)).toEqual([]);
    } finally {
      harden.mockRestore();
      forget.mockRestore();
      platform.mockRestore();
      removeTreeWithRetry(root);
    }
  });

  test.each([true, false])("nonzero version probe exit uses tree confirmation before workspace removal (%s)", async confirmed => {
    const calls: string[] = [];
    const h = await run(script(), {
      deps: {
        probeVersion: undefined,
        spawn: (_binary, args) => {
          expect(args).toEqual(["--version"]);
          const child = new FakeChild();
          queueMicrotask(() => {
            child.stdout.end("1.5.3\n");
            child.exitCode = 7;
            child.emit("close", 7);
          });
          return child as unknown as AgyAcpChild;
        },
        reap: async child => {
          expect(child.exitCode).toBe(7);
          calls.push("reap");
          if (!confirmed) throw new AgyAcpTreeCleanupError();
        },
        createWorkspace: async () => ({
          dir: "/tmp/probe-test", tmp: "/tmp/probe-test/.tmp", remove: async () => { calls.push("remove"); },
        }),
      },
    });
    expect(errorCode(h)).toBe("agy_acp_unavailable");
    expect(calls).toEqual(confirmed ? ["reap", "remove"] : ["reap"]);
  });

  test.each(["probe", "turn"])("an asynchronous missing executable removes the %s workspace", async phase => {
    let warned = false;
    const h = await run(script(), {
      deps: {
        ...(phase === "probe" ? { probeVersion: undefined } : {}),
        spawn: () => {
          const child = new FakeChild();
          child.pid = undefined;
          queueMicrotask(() => child.emit("error", Object.assign(new Error("missing executable"), { code: "ENOENT" })));
          return child as unknown as AgyAcpChild;
        },
        reap: child => reapProcessTree(child, {
          graceMs: 0, reapTimeoutMs: 1000, platform: "win32", warnTreeFailure: () => { warned = true; },
        }),
      },
    });
    expect(h.removed).toBe(true);
    expect(warned).toBe(false);
    expect(errorCode(h)).toBe("agy_acp_unavailable");
  });

  test("a valid Windows version probe retains its workspace when taskkill cannot confirm a completed leader", async () => {
    const calls: string[] = [];
    const h = await run(script(), {
      deps: {
        probeVersion: undefined,
        spawn: (_binary, args) => {
          const child = new FakeChild();
          if (args[0] === "--version") {
            queueMicrotask(() => {
              child.stdout.end("1.5.3\n");
              child.exitCode = 0;
              child.emit("close", 0);
            });
          } else {
            calls.push("turn");
            script()(child, []);
          }
          return child as unknown as AgyAcpChild;
        },
        reap: child => reapProcessTree(child, {
          graceMs: 0, reapTimeoutMs: 1_000, platform: "win32",
          warnTreeFailure: () => { calls.push("warning"); },
          killWindowsTree: (_pid, done) => {
            (child as unknown as FakeChild).emit("close", 1);
            done(true);
          },
        }),
        createWorkspace: async () => {
          const name = calls.length ? "turn" : "probe";
          return { dir: "/tmp/" + name, tmp: "/tmp/" + name + "/.tmp", remove: async () => { calls.push("remove " + name); } };
        },
      },
    });
    expect(calls).toEqual(["warning", "turn", "remove turn"]);
    expect(terminal(h)).toEqual([{ type: "done" }]);
  });

  test.each(["signal failure", "deadline"])("POSIX retains the workspace when tree cleanup is unconfirmed (%s)", async outcome => {
    const signals: (NodeJS.Signals | 0)[] = [];
    let warnings = 0;
    const h = await run(script((frame, api) => {
      if (frame.method !== "session/prompt") return;
      api.exit(1);
      return true;
    }), {
      deps: {
        reap: child => reapProcessTree(child, {
          graceMs: 0, reapTimeoutMs: 30, platform: "linux",
          warnTreeFailure: () => { warnings++; },
          signalGroup: (_pid, signal) => {
            signals.push(signal);
            if (signal === "SIGKILL" && outcome === "signal failure") throw Object.assign(new Error(), { code: "EPERM" });
          },
        }),
      },
    });
    expect(signals).toContain("SIGKILL");
    if (outcome === "deadline") expect(signals).toContain(0);
    expect(warnings).toBe(1);
    expect(h.removed).toBe(false);
    expect(terminal(h)).toEqual([expect.objectContaining({
      type: "error", status: 502, message: "Antigravity ACP could not confirm POSIX process tree cleanup.",
    })]);
  });

  test("redacts whole credentials in answer deltas and flushes the final tail", async () => {
    const h = await run(script((frame, api) => {
      if (frame.method !== "session/prompt") return;
      for (const text of [adminShape, sessionShape, dataKeyShape, workspaceTokenShape, "sk-" + "d".repeat(20)]) {
        api.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: text + " " } });
      }
      api.reply(frame.id, { stopReason: "end_turn" });
      return true;
    }));
    expect(h.events.flatMap(event => event.type === "text_delta" ? [event.text] : []).join("") === "[REDACTED] ".repeat(5)).toBe(true);
    expect(h.events.at(-1)).toEqual({ type: "done" });
  });

  test("redacts split credentials independently in answer and reasoning deltas", async () => {
    const answerPrefix = "ordinary output ".repeat(100);
    const h = await run(script((frame, api) => {
      if (frame.method !== "session/prompt") return;
      const answer = (text: string) => api.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      const thought = (text: string) => api.notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
      answer(answerPrefix + adminShape.slice(0, 5));
      thought(dataKeyShape.slice(0, -3));
      answer(adminShape.slice(5) + " done.");
      thought(dataKeyShape.slice(-3) + " " + "sk-" + "e".repeat(2));
      thought("e".repeat(20) + " " + workspaceTokenShape.slice(0, 4));
      thought(workspaceTokenShape.slice(4) + " done.");
      api.reply(frame.id, { stopReason: "end_turn" });
      return true;
    }));
    expect(h.events.flatMap(event => event.type === "text_delta" ? [event.text] : []).join("")).toBe(answerPrefix + "[REDACTED] done.");
    expect(h.events.flatMap(event => event.type === "thinking_delta" ? [event.thinking] : []).join("") === "[REDACTED] [REDACTED] [REDACTED] done.").toBe(true);
  });

  test("preserves ordinary code and prose across the buffering boundary", async () => {
    const example = 'Authorization: required for write requests.\nconst headers = { "Authorization": "run the setup first" };\n'
      + 'const token = process.env.OPENAI_API_KEY; // ocx_admin_…\n' + "x".repeat(1500) + "😺";
    const h = await run(script((frame, api) => {
      if (frame.method !== "session/prompt") return;
      for (const text of [example.slice(0, -1), example.slice(-1), "\nordinary prose"]) {
        api.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      }
      api.reply(frame.id, { stopReason: "end_turn" });
      return true;
    }));
    expect(h.events.flatMap(event => event.type === "text_delta" ? [event.text] : []).join("")).toBe(example + "\nordinary prose");
  });

  test("masks long JWT and Bearer values across batches without losing surrounding text", async () => {
    const jwtShape = "eyJ" + "h".repeat(12) + "." + "p".repeat(2500) + "." + "s".repeat(20);
    const bearerShape = "Authorization: Bearer " + "z".repeat(2500) + "==";
    const input = jwtShape + "\n" + bearerShape + "\nfinished.";
    const h = await run(script((frame, api) => {
      if (frame.method !== "session/prompt") return;
      for (let offset = 0; offset < input.length; offset += 100) {
        api.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: input.slice(offset, offset + 100) } });
      }
      api.reply(frame.id, { stopReason: "end_turn" });
      return true;
    }));
    const output = h.events.flatMap(event => event.type === "text_delta" ? [event.text] : []).join("");
    expect(output === "[REDACTED]\nAuthorization: Bearer [REDACTED]\nfinished.").toBe(true);
  });

  test("selection errors never interpolate credential-shaped option identifiers", async () => {
    const model = modelOption("gemini-3.8-flash", ["gemini-3.8-flash", "gemini-" + dataKeyShape]);
    const thought = thoughtOption("low", ["low", sessionShape]);
    const agent = script(undefined, { initial: [model, thought] });
    const modelError = await run(agent, { parsed: parsed({ modelId: "gemini-" + adminShape }) });
    const thoughtError = await run(agent, { parsed: parsed({}, "max") });
    expect(terminal(modelError)[0]).toMatchObject({ message: "The requested Gemini model is not offered by this Antigravity CLI." });
    expect(terminal(thoughtError)[0]).toMatchObject({ message: "The requested reasoning effort is not offered by this Antigravity CLI." });
  });

  test.each(["leader exited", "taskkill failed", "taskkill timed out"])(
    "Windows retains the workspace and fails the turn when %s",
    async outcome => {
      let treeKills = 0;
      let warnings = 0;
      const h = await run(script((frame, api) => {
        if (frame.method !== "session/prompt" || outcome !== "leader exited") return;
        api.exit(0);
        return true;
      }), {
        deps: {
          reap: child => reapProcessTree(child, {
            graceMs: 0, reapTimeoutMs: 10, platform: "win32",
            killWindowsTree: (_pid, complete) => {
              treeKills++;
              if (outcome === "taskkill failed") complete(false);
            },
            warnTreeFailure: () => { warnings++; },
          }),
        },
      });
      expect(h.removed).toBe(false);
      expect(terminal(h)).toEqual([expect.objectContaining({
        type: "error", status: 502, message: expect.stringContaining("could not confirm Windows process tree cleanup"),
      })]);
      expect(treeKills).toBe(outcome === "leader exited" ? 0 : 1);
      expect(warnings).toBe(1);
    },
  );

  test("Windows removes the workspace and completes the turn after taskkill and leader closure", async () => {
    const h = await run(script(), {
      deps: {
        reap: child => reapProcessTree(child, {
          graceMs: 0, reapTimeoutMs: 1_000, platform: "win32",
          killWindowsTree: (_pid, complete) => {
            (child as unknown as FakeChild).emit("close", 1);
            complete(true);
          },
        }),
      },
    });
    expect(h.removed).toBe(true);
    expect(terminal(h)).toEqual([expect.objectContaining({ type: "done" })]);
  });

  test("one shared send allowance admits exactly one prompt across attempts", async () => {
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0,
    });
    const steps: string[] = [];
    const agent = script(frame => {
      if (frame.method === "session/prompt") steps.push("prompt");
    });
    const sendAccounting: Pick<IncomingMeta, "sendBudget" | "beforePhysicalSend" | "onPhysicalSend"> = {
      sendBudget: budget,
      beforePhysicalSend: () => { steps.push("fence"); },
      onPhysicalSend: ({ ordinal }) => { steps.push(`reported ${ordinal}`); },
    };

    const first = await run(agent, { sendAccounting });
    expect(terminal(first)[0]?.type).toBe("done");
    expect(steps).toEqual(["fence", "reported 1", "prompt"]);
    await expect(run(agent, { sendAccounting })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(steps).toEqual(["fence", "reported 1", "prompt"]);
    expect(budget.used).toBe(1);
    expect(createAgyAcpAdapter(provider).reportsPhysicalSends).toBe(true);
  });

  test("a denied prompt owns the terminal before another ACP frame in the chunk", async () => {
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0,
    });
    const reserved = budget.reserveDispatch({ sendClass: "initial", targetKey: "agy" });
    if (!reserved.allowed || !reserved.permit.use()) throw new Error("test must spend the allowance");

    const sent: string[] = [];
    const sendAccounting = { sendBudget: budget, onPhysicalSend: () => { sent.push("reported"); } };
    await expect(run(script((frame, _api, state) => {
      if (frame.method === "session/prompt") sent.push("prompt");
      if (frame.method !== "session/new") return;
      return true;
    }), {
      sendAccounting,
      beforeRun: child => {
        child.stdin.on("data", (chunk: Buffer) => {
          const frame = JSON.parse(chunk.toString()) as Frame;
          if (frame.method !== "session/new") return;
          child.stdout.write([
            JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "s1", configOptions: [modelOption("gemini-3.8-flash", OFFERED)] } }),
            JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "config_option_update", configOptions: [] } } }),
            "",
          ].join("\n"));
        });
      },
    })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(sent).toEqual([]);
  });

  test("failed Windows cleanup preserves send-budget refusal and retains the workspace", async () => {
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0,
    });
    const spent = budget.reserveDispatch({ sendClass: "initial", targetKey: "agy" });
    if (!spent.allowed || !spent.permit.use()) throw new Error("test must spend the allowance");
    const removed = { value: false };
    const sent: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(run(script(frame => { if (frame.method === "session/prompt") sent.push("prompt"); }), {
        sendAccounting: { sendBudget: budget, onPhysicalSend: () => { sent.push("reported"); } },
        deps: {
          createWorkspace: async () => ({
            dir: "/fixture/workspace", tmp: "/fixture/workspace/.tmp", remove: async () => { removed.value = true; },
          }),
          reap: child => reapProcessTree(child, {
            graceMs: 0, reapTimeoutMs: 1000, platform: "win32", killWindowsTree: (_pid, done) => done(false),
          }),
        },
      })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
      expect(removed.value).toBe(false);
      expect(sent).toEqual([]);
      expect(warn.mock.calls).toEqual([["Antigravity ACP could not confirm Windows process tree cleanup."]]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a permit that refuses dispatch is released without a prompt or a send report", async () => {
    const budget = createRequestExecutionBudget();
    let released = false;
    budget.reserveDispatch = () => ({
      allowed: true,
      permit: { sendClass: "transient", use: () => false, assumeCharge: () => false, release: () => { released = true; } },
    });
    const sent: string[] = [];
    const agent = script(frame => { if (frame.method === "session/prompt") sent.push("prompt"); });
    await expect(run(agent, { sendAccounting: {
      sendBudget: budget,
      onPhysicalSend: () => { sent.push("reported"); },
    } })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(released).toBe(true);
    expect(sent).toEqual([]);
  });
  test("prompt serialization errors reap the child from the stdout callback", async () => {
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 50_000; depth++) nested = { nested };
    let escaped = false;
    let reaped = false;
    let sentPrompt = false;
    const agent = script((frame, api, state) => {
      if (frame.method === "session/prompt") sentPrompt = true;
      if (frame.method !== "session/new") return;
      queueMicrotask(() => {
        try {
          api.reply(frame.id, { sessionId: "s1", configOptions: state.config });
        } catch {
          escaped = true;
          api.exit(1);
        }
      });
      return true;
    });
    await expect(run(agent, {
      parsed: parsed({ context: { messages: [{
        role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "fixture", arguments: nested }],
      }] } }),
      deps: { reap: async () => { reaped = true; } },
    })).rejects.toBeInstanceOf(RangeError);
    expect({ escaped, reaped, sentPrompt }).toEqual({ escaped: false, reaped: true, sentPrompt: false });
  });

  test.each([0, 1])("completed lines respect the frame byte limit across reads (+%d)", async extra => {
    let child!: FakeChild;
    const h = await run(script((frame, _api) => {
      if (frame.method !== "session/prompt") return;
      const reply = JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn" } });
      const line = reply.padStart(MAX_ACP_LINE_BYTES + extra);
      child.stdout.write(line.slice(0, -1));
      child.stdout.write(line.slice(-1) + "\n");
      return true;
    }), { beforeRun: spawned => { child = spawned; } });
    expect(terminal(h)).toEqual(extra
      ? [expect.objectContaining({ type: "error", code: "agy_acp_protocol", message: expect.stringContaining("frame over the line limit") })]
      : [{ type: "done" }]);
  });

  test("a local interactive turn: initialize, session/new in the private workspace, prompt, one done", async () => {
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret-should-not-leak";
    const h = await run(script());
    expect(methods(h)).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(h.sent[0]!.params).toMatchObject({ protocolVersion: 1, clientCapabilities: {} });
    expect(h.sent[1]!.params).toEqual({ cwd: "/tmp/ocx-agy-acp-test", mcpServers: [] });
    // Both buffered deltas report activity before the terminal flush.
    expect(h.events).toEqual([
      { type: "heartbeat" },
      { type: "heartbeat" },
      { type: "thinking_delta", thinking: "thinking" },
      { type: "text_delta", text: "hello" },
      { type: "done" },
    ]);
    expect(h.args).toEqual([...AGY_ACP_ARGS]);
    expect(h.args).toContain("--sandbox");
    expect(h.args.join(" ")).not.toMatch(/dangerously|add-dir|--agent|--login/);
    expect(h.cwd).toBe("/tmp/ocx-agy-acp-test");
    expect(h.env.TMPDIR).toBe("/tmp/ocx-agy-acp-test/.tmp");
    expect(Object.values(h.env).join("\n")).not.toContain("admin-secret-should-not-leak");
    expect(h.removed).toBe(true);
  });

  test("system text travels on session/new only when the CLI advertises it, never twice", async () => {
    const withCap = await run(script(undefined, { systemPrompt: true }));
    expect(withCap.sent[1]!.params.systemPrompt).toEqual({ mode: "append", content: [{ type: "text", text: "be brief" }] });
    expect(withCap.sent.find(f => f.method === "session/prompt")!.params.prompt[0].text).not.toContain("[System]");
    const without = await run(script());
    expect(without.sent[1]!.params.systemPrompt).toBeUndefined();
    expect(without.sent.find(f => f.method === "session/prompt")!.params.prompt[0].text).toContain("[System]\nbe brief");
  });

  test("a different requested Gemini model is set first, acknowledged, then exactly one prompt", async () => {
    const h = await run(script(), { parsed: parsed({ modelId: "antigravity-acp/gemini-4-argon" }) });
    expect(methods(h)).toEqual(["initialize", "session/new", "session/set_config_option", "session/prompt"]);
    expect(h.sent[2]!.params).toEqual({ sessionId: "s1", configId: "model", value: "gemini-4-argon" });
    expect(terminal(h)).toEqual([{ type: "done" }]);
  });

  test("a wrong-model acknowledgement fails closed before any prompt", async () => {
    const h = await run(script((frame, api, state) => {
      if (frame.method !== "session/set_config_option") return;
      api.reply(frame.id, { configOptions: state.config });
      return true;
    }), { parsed: parsed({ modelId: "gemini-4-argon" }) });
    expect(methods(h)).not.toContain("session/prompt");
    expect(errorCode(h)).toBe("agy_acp_model_unproven");
  });

  test("a thinking-level reply cannot reuse the opaque model ID for another Gemini model", async () => {
    const initial = [{ ...modelOption("g1", []), options: [{ value: "g1", name: "Gemini 3.8 Flash" }] }, thoughtOption("high")];
    const h = await run(script((frame, api) => {
      if (frame.method !== "session/set_config_option") return;
      api.reply(frame.id, { configOptions: [
        { ...initial[0], options: [{ value: "g1", name: "Gemini 4 Argon" }] }, thoughtOption("low"),
      ] });
      return true;
    }, { initial }), { parsed: parsed({}, "low") });
    expect(methods(h)).not.toContain("session/prompt");
    expect(errorCode(h)).toBe("agy_acp_model_unproven");
  });

  test("grouped values and a category-less model selector are matched by value", async () => {
    const grouped = { id: "model", name: "Model", type: "select", currentValue: "g-flash", options: [
      { group: "fast", name: "Fast", options: [{ value: "g-flash", name: "Gemini 3.8 Flash" }] },
      { group: "deep", name: "Deep", options: [{ value: "g-argon", name: "Gemini 4 Argon" }] },
    ] };
    const h = await run(script(undefined, { initial: [grouped] }), { parsed: parsed({ modelId: "gemini-4-argon" }) });
    expect(h.sent[2]!.params).toEqual({ sessionId: "s1", configId: "model", value: "g-argon" });
    expect(terminal(h)).toEqual([{ type: "done" }]);
  });

  test("Gemini only: a non-Gemini request never spawns and an unoffered model returns a fixed error", async () => {
    const claude = await run(script(), { parsed: parsed({ modelId: "claude-opus-5-5" }) });
    expect(claude.spawned).toBe(0);
    expect(errorCode(claude)).toBe("agy_acp_model_not_gemini");
    const missing = await run(script(), { parsed: parsed({ modelId: "gemini-9-ultra" }) });
    const error = terminal(missing)[0] as { status: number; code: string; message: string };
    expect(error).toMatchObject({ status: 400, code: "agy_acp_model_not_offered" });
    expect(error.message).toBe("The requested Gemini model is not offered by this Antigravity CLI.");
    expect(methods(missing)).not.toContain("session/prompt");
  });

  test("the CLI's non-Gemini default is never used", async () => {
    const h = await run(script(undefined, { initial: [modelOption("claude-opus-5-5", OFFERED)] }));
    // The requested Gemini model is selected instead, then proved.
    expect(h.sent[2]!.params.value).toBe("gemini-3.8-flash");
    expect(terminal(h)).toEqual([{ type: "done" }]);
  });

  test("thinking level: xhigh selects extra after the model; an unoffered level is a 400", async () => {
    const h = await run(script(), { parsed: parsed({ modelId: "gemini-4-argon" }, "xhigh") });
    expect(methods(h)).toEqual(["initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/prompt"]);
    expect(h.sent[2]!.params.configId).toBe("model");
    expect(h.sent[3]!.params).toMatchObject({ configId: "thought_level", value: "extra" });
    const narrow = await run(script(undefined, { initial: [modelOption("gemini-3.8-flash", OFFERED), thoughtOption("low", ["low", "high"])] }), { parsed: parsed({}, "max") });
    expect(errorCode(narrow)).toBe("agy_acp_effort_not_offered");
    expect(methods(narrow)).not.toContain("session/prompt");
  });

  test("model proof: unknown current value and a missing selector fail closed before prompting", async () => {
    const unknown = await run(script(undefined, { initial: [modelOption("mystery", OFFERED)] }));
    expect(errorCode(unknown)).toBe("agy_acp_model_unproven");
    const none = await run(script(undefined, { initial: [thoughtOption("high")] }));
    expect(errorCode(none)).toBe("agy_acp_unsupported_selection");
    for (const h of [unknown, none]) expect(methods(h)).not.toContain("session/prompt");
  });

  test("a mid-turn switch to a non-Gemini model, or a removed selector, cancels the turn", async () => {
    for (const replacement of [[modelOption("claude-opus-5-5", OFFERED)], [thoughtOption("high")]]) {
      const h = await run(script((frame, api) => {
        if (frame.method !== "session/prompt") return;
        api.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "part" } });
        api.notify({ sessionUpdate: "config_option_update", configOptions: replacement });
        return true;
      }));
      expect(errorCode(h)).toBe("agy_acp_model_switched");
      expect(methods(h)).toContain("session/cancel");
    }
  });

  test("terminal table", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["end_turn", { type: "done" }],
      ["max_tokens", { type: "done", stopReason: "max_tokens" }],
      ["refusal", { type: "done", stopReason: "content_filter" }],
      ["max_turn_requests", { type: "error", code: "agy_acp_turn_limit", status: 502 }],
      ["cancelled", { type: "error", code: "agy_acp_cancelled", status: 502 }],
      ["something_new", { type: "error", code: "agy_acp_protocol", status: 502 }],
    ];
    for (const [stopReason, expected] of cases) {
      const h = await run(script(undefined, { stopReason }));
      expect(terminal(h)).toHaveLength(1);
      expect(terminal(h)[0]).toMatchObject(expected);
    }
  });

  test("Authentication required at any phase is a 401 with the login hint", async () => {
    for (const method of ["initialize", "session/new", "session/set_config_option", "session/prompt"]) {
      const h = await run(script((frame, api) => {
        if (frame.method !== method) return;
        api.error(frame.id, -32000, `Authentication required ${SENTINEL}`);
        return true;
      }), { parsed: parsed({ modelId: "gemini-4-argon" }) });
      const error = terminal(h)[0] as { status: number; code: string; message: string };
      expect(error).toMatchObject({ status: 401, errorType: "authentication_error", code: "agy_login_required" });
      expect(error.message).toContain("agy acp --login");
      expect(error.message).not.toContain(SENTINEL);
    }
  });

  test("permission requests are refused with the exact cancelled outcome; other client requests are not executed", async () => {
    const h = await run(script((frame, api) => {
      if (frame.method !== "session/prompt") return;
      api.request(7, "session/request_permission", { sessionId: "s1", toolCall: { title: SENTINEL }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] });
      api.request("perm-2", "session/request_permission", { sessionId: "s1", options: [] });
      api.request(9, "fs/read_text_file", { path: "/etc/passwd" });
      api.reply(frame.id, { stopReason: "end_turn" });
      return true;
    }));
    const answers = h.sent.filter(f => f.method === undefined);
    expect(answers).toEqual([
      { jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } },
      { jsonrpc: "2.0", id: "perm-2", result: { outcome: { outcome: "cancelled" } } },
      { jsonrpc: "2.0", id: 9, error: { code: -32601, message: "Method not found" } },
    ]);
    expect(JSON.stringify(h.events)).not.toContain(SENTINEL);
  });

  test("child-authored text never reaches an error: stderr, error messages and early exit", async () => {
    const crashed = await run(script((frame, api) => {
      if (frame.method !== "session/prompt") return;
      api.stderr(`stack trace with ${SENTINEL}`);
      api.exit(3);
      return true;
    }));
    const error = terminal(crashed)[0] as { code: string; message: string };
    expect(error.code).toBe("agy_acp_protocol");
    expect(error.message).toContain("exit code 3");
    const failed = await run(script((frame, api) => {
      if (frame.method !== "session/prompt") return;
      api.error(frame.id, -32603, `internal: ${SENTINEL}`);
      return true;
    }));
    for (const h of [crashed, failed]) expect(JSON.stringify(h.events)).not.toContain(SENTINEL);
  });

  test("a caller abort during the prompt sends session/cancel and emits no terminal", async () => {
    const abort = new AbortController();
    const h = await run(script((frame, api) => {
      if (frame.method !== "session/prompt") return;
      api.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
      queueMicrotask(() => abort.abort());
      return true;
    }), { abort });
    expect(methods(h)).toContain("session/cancel");
    expect(terminal(h)).toEqual([]);
  });
});

describe("agy acp use policy at runTurn", () => {
  test("subagent, combo, combo-decision, subagent-fallback and non-local turns are refused before any probe or spawn", async () => {
    const cases: Array<[Parameters<typeof run>[1], string]> = [
      [{ headers: new Headers({ "x-codex-parent-thread-id": "" }) }, "agy_acp_interactive_only"],
      [{ comboAttempt: true }, "agy_acp_interactive_only"],
      [{ internalDecisionCall: true }, "agy_acp_interactive_only"],
      [{ subagentFallback: true }, "agy_acp_interactive_only"],
      [{ local: false }, "agy_acp_local_only"],
    ];
    for (const [opts, code] of cases) {
      const h = await run(script(), opts);
      expect(h.spawned).toBe(0);
      expect(h.probed).toBe(0);
      expect(terminal(h)).toEqual([expect.objectContaining({ type: "error", status: 403, errorType: "permission_error", code })]);
      expect((terminal(h)[0] as { message: string }).message).toMatch(/Gemini API key or Vertex AI/);
    }
  });

  test("a missing or old CLI fails closed with the install hint", async () => {
    const missing = await run(script(), { deps: { resolveBinary: () => undefined } });
    expect(terminal(missing)[0]).toMatchObject({ status: 503, code: "agy_acp_unavailable" });
    const old = await run(script(), { deps: { probeVersion: async () => ({ ok: false, reason: "too_old", version: "1.3.3" }) } });
    expect((terminal(old)[0] as { message: string }).message).toContain("found 1.3.3");
    expect(old.spawned).toBe(0);
  });
});
