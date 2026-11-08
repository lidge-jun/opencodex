import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createTraeCnAdapter } from "../../src/adapters/trae-cn/adapter";
import * as traeClient from "../../src/adapters/trae-cn/client";
import { resolveTraeCli, traeCnChildEnv } from "../../src/adapters/trae-cn/profile";
import { fetchProviderModels, fetchProviderModelsWithAuth, observedModelsAuthResolver, refreshingModelsAuthResolver } from "../../src/codex/catalog/provider-models";
import { captureProviderGather } from "../../src/codex/catalog/gather-capture";
import { captureModelCacheGeneration, clearModelCache, getFreshCached, setCached } from "../../src/codex/model-cache";
import { probeTraeCnProvider } from "../../src/server/management/trae-cn-provider-probe";
import { handleProviderRoutes } from "../../src/server/management/provider-routes";
import { customRowInputModalities, isModelVisionSidecarConsumer, isVisionSidecarConsumer, modelAcceptsImageInput } from "../../src/vision/eligibility";
import { requiresVisionPreprocessing } from "../../src/vision/plan";
import type { CatalogDisposition } from "../../src/codex/convergence-types";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { AdapterEvent } from "../../src/types";
import type { IncomingMeta } from "../../src/adapters/base";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import {
  adapterDefinitions,
  createRegisteredAdapter,
  effectiveAdapterContract,
  getAdapterDefinition,
} from "../../src/adapters/registry";
import { resolveAdapter } from "../../src/server/adapter-resolve";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const EXPECTED_ADAPTER_NAMES = {
  "workbuddy-ai": "workbuddy-ai",
  codebuddy: "codebuddy",
  "command-code": "command-code",
  "openai-chat": "openai-chat",
  "ollama-native": "ollama-native",
  anthropic: "anthropic",
  "openai-responses": "openai-responses",
  google: "google",
  kiro: "kiro",
  azure: "azure-openai",
  "azure-openai": "azure-openai",
  cursor: "cursor",
  devin: "devin",
  zed: "zed",
  "mimo-free": "mimo-free",
  qoder: "qoder",
  "claude-cli": "claude-cli",
  "trae-cn": "trae-cn",
  "dsh-account": "dsh-account",
} as const;

function provider(adapter: string): OcxProviderConfig {
  return {
    adapter,
    // mimo-free throws for non-canonical endpoints since #1714; every other
    // adapter accepts the placeholder URL.
    baseUrl: adapter === "mimo-free"
      ? "https://api.xiaomimimo.com/api/free-ai/openai/chat"
      : adapter === "codebuddy"
        ? "https://www.codebuddy.ai"
        : adapter === "qoder"
          ? "https://qoder.com"
        : adapter === "trae-cn"
          ? "https://www.trae.cn"
        // ollama-native refuses a bare /v1 path on a host it does not recognise, rather than
        // guessing that an arbitrary destination speaks Ollama's compatibility surface.
        : adapter === "ollama-native"
          ? "https://example.invalid/api"
          : "https://example.invalid/v1",
    authMode: "key",
    apiKey: "test-key",
    defaultMaxOutputTokens: 4096,
  } as OcxProviderConfig;
}

const ANTHROPIC_CACHE_REQUEST: OcxParsedRequest = {
  modelId: "claude-haiku-4-5",
  stream: true,
  options: {},
  context: {
    messages: [{ role: "user", content: "cache me", timestamp: 0 }],
  },
};

async function expectLongCacheRetention(adapter: ReturnType<typeof resolveAdapter>): Promise<void> {
  const request = await withTestTranslatorBudget(adapter).buildRequest(ANTHROPIC_CACHE_REQUEST);
  const body = JSON.parse(request.body) as {
    messages?: Array<{ content?: string | Array<{ cache_control?: { type?: string; ttl?: string } }> }>;
  };
  const content = body.messages?.[0]?.content;
  if (!Array.isArray(content)) throw new Error("expected Anthropic cache retention to annotate user content");
  expect(content.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
}

describe("adapter registry authority", () => {
  test("enumerates every production adapter exactly once", () => {
    expect(adapterDefinitions().map(([id]) => id)).toEqual(Object.keys(EXPECTED_ADAPTER_NAMES));
  });

  test("records semantic inheritance without forcing constructor wrapping", () => {
    expect(getAdapterDefinition("azure")?.contractParent).toBe("openai-responses");
    expect(getAdapterDefinition("azure-openai")?.contractParent).toBe("openai-responses");
    expect(getAdapterDefinition("mimo-free")?.contractParent).toBe("openai-chat");

    expect(effectiveAdapterContract("azure").wire).toBe("openai-responses");
    expect(effectiveAdapterContract("azure-openai").wire).toBe("openai-responses");
    expect(effectiveAdapterContract("mimo-free").wire).toBe("openai-chat");
    expect(effectiveAdapterContract("cursor").mutation).toBe("codex-owned-with-gated-native-fallback");
  });

  test("constructs every current adapter with its existing observable identity", () => {
    for (const [adapterId, expectedName] of Object.entries(EXPECTED_ADAPTER_NAMES)) {
      expect(createRegisteredAdapter(provider(adapterId)).name, adapterId).toBe(expectedName);
      expect(resolveAdapter(provider(adapterId)).name, adapterId).toBe(expectedName);
    }
  });

  test("forwards Anthropic cache retention through registry and server resolution", async () => {
    await expectLongCacheRetention(createRegisteredAdapter(provider("anthropic"), { cacheRetention: "long" }));
    await expectLongCacheRetention(resolveAdapter(provider("anthropic"), "long"));
  });

  test("rejects unknown persisted adapter ids at the runtime boundary", () => {
    for (const adapterId of ["not-a-real-adapter", "__proto__", "constructor"]) {
      expect(() => createRegisteredAdapter(provider(adapterId)))
        .toThrow(`Unknown adapter: ${adapterId}`);
      expect(() => effectiveAdapterContract(adapterId))
        .toThrow(`Unknown adapter: ${adapterId}`);
    }
  });

  test("rejects non-string persisted adapter ids before registry lookup", () => {
    for (const adapterId of [null, 42, ["azure"]]) {
      expect(getAdapterDefinition(adapterId)).toBeUndefined();
      const malformed = { ...provider("anthropic"), adapter: adapterId } as unknown as OcxProviderConfig;
      expect(() => createRegisteredAdapter(malformed)).toThrow("Unknown adapter:");
    }
  });
});

type AcpRequest = { id: number; method: string; params: { prompt?: Array<{ text: string }> } };

function traeFixture(intercept?: (request: AcpRequest, child: ChildProcess) => boolean) {
  const child = new EventEmitter() as ChildProcess & { killed: boolean; exitCode: number | null };
  const stdout = new PassThrough();
  const requests: AcpRequest[] = [];
  const signals: Array<string | number | undefined> = [];
  let options: SpawnOptions | undefined;
  const send = (frame: unknown) => stdout.write(JSON.stringify(frame) + "\n");
  Object.assign(child, { stdout, stderr: new PassThrough(), killed: false, exitCode: null });
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(String(chunk)) as AcpRequest;
    requests.push(request);
    callback();
    queueMicrotask(() => {
      if (stdout.destroyed || intercept?.(request, child)) return;
      let result: unknown = {};
      if (request.method === "session/new") result = { sessionId: "fixture-session", models: { availableModels: [{ modelId: "test-model" }] } };
      if (request.method === "session/prompt") {
        for (const [sessionUpdate, text] of [["agent_thought_chunk", "thinking"], ["agent_message_chunk", "answer"]]) {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate, content: { type: "text", text } } } });
        }
        result = { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
      }
      send({ jsonrpc: "2.0", id: request.id, result });
    });
  } });
  child.kill = signal => {
    signals.push(signal);
    child.killed = true;
    child.exitCode = 0;
    queueMicrotask(() => { stdout.end(); child.emit("close", 0); });
    return true;
  };
  const deps: traeClient.TraeAcpDeps = {
    resolveBinary: () => "/fixture/traecli", timeoutMs: 300, killGraceMs: 2, reapTimeoutMs: 5,
    spawn: (_command, _args, opts) => { options = opts; return child; },
  };
  return { child, requests, signals, deps, send, options: () => options };
}

function traeRequest(): OcxParsedRequest {
  return { modelId: "test-model", stream: true, options: {}, context: {
    systemPrompt: ["Keep the system policy"],
    messages: [{ role: "user", content: "current request", timestamp: 0 }],
  } };
}

function traeMeta(extra: Partial<IncomingMeta> = {}): IncomingMeta {
  return { headers: new Headers(), translatorBudget: createTranslatorBudget(), ...extra };
}

function fakeSendBudget() {
  const state = { used: 0, refunded: 0, closed: 0 };
  const budget = {
    beginSpendProducer: () => ({ close: () => { state.closed++; } }),
    reserveDispatch: () => ({ allowed: true, permit: {
      use: () => { state.used++; return true; },
      release: () => { if (!state.used) state.refunded++; },
    } }),
  } as unknown as NonNullable<IncomingMeta["sendBudget"]>;
  return { state, budget };
}

describe("TRAE CN ACP regression contract", () => {
  let testHome: TempHome;
  const config = (): OcxProviderConfig => ({ adapter: "trae-cn", baseUrl: "https://www.trae.cn", authMode: "key", models: ["test-model"], liveModels: true });
  const rawModels = async (row: OcxProviderConfig, cap?: number) => (await fetchProviderModelsWithAuth(
    captureProviderGather("trae-cn", row, refreshingModelsAuthResolver), 60_000, cap, refreshingModelsAuthResolver,
  )).models;
  beforeEach(() => { testHome = createTempHome("ocx-trae-regression-"); clearModelCache(); });
  afterEach(() => { mock.restore(); clearModelCache(); testHome.remove(); });

  test("streams text, reasoning and usage; charges only the prompt write", async () => {
    const fixture = traeFixture();
    const budget = fakeSendBudget();
    const events: AdapterEvent[] = [];
    const reports: string[] = [];
    await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta({
      sendBudget: budget.budget, onPhysicalSend: () => reports.push(fixture.requests.at(-1)!.method),
    }), event => events.push(event));
    expect(events.map(event => event.type)).toEqual(["thinking_delta", "text_delta", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 10, outputTokens: 2 } });
    expect(reports).toEqual(["session/prompt"]);
    expect(budget.state).toEqual({ used: 1, refunded: 0, closed: 1 });
    const prompt = fixture.requests.find(request => request.method === "session/prompt")!.params.prompt![0]!.text;
    expect(prompt).toContain("Keep the system policy");
    expect(prompt).toContain("current request");
    expect(fixture.child.killed).toBe(true);
    expect(existsSync(String(fixture.options()!.env!.HOME))).toBe(false);
    expect(existsSync(String(fixture.options()!.cwd))).toBe(false);
  });

  for (const phase of ["initialize", "session/new", "session/set_model", "session/prompt"]) {
    test(`abort during ${phase} tears down the child and directories`, async () => {
      const controller = new AbortController();
      const fixture = traeFixture(request => {
        if (request.method !== phase) return false;
        controller.abort();
        return true;
      });
      const budget = fakeSendBudget();
      let sends = 0;
      const events: AdapterEvent[] = [];
      let deadlineReached = false;
      const watchdog = setTimeout(() => { deadlineReached = true; fixture.child.kill(); }, 1000);
      try {
        await createTraeCnAdapter(config(), { ...fixture.deps, timeoutMs: 60_000 }).runTurn!(traeRequest(), traeMeta({
          abortSignal: controller.signal, sendBudget: budget.budget, onPhysicalSend: () => { sends++; },
        }), event => events.push(event));
      } finally { clearTimeout(watchdog); }
      expect(deadlineReached).toBe(false);
      expect(events).toEqual([]);
      expect(fixture.child.killed).toBe(true);
      expect(existsSync(String(fixture.options()!.env!.HOME))).toBe(false);
      expect(existsSync(String(fixture.options()!.cwd))).toBe(false);
      const dispatched = phase === "session/prompt" ? 1 : 0;
      expect(sends).toBe(dispatched);
      expect(budget.state).toEqual({ used: dispatched, refunded: 1 - dispatched, closed: 1 });
    });
  }

  test("an unavailable model releases its reservation without a send", async () => {
    const fixture = traeFixture();
    const budget = fakeSendBudget();
    let sends = 0;
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), fixture.deps).runTurn!({ ...traeRequest(), modelId: "unavailable" },
      traeMeta({ sendBudget: budget.budget, onPhysicalSend: () => { sends++; } }), event => events.push(event));
    expect(events[0]).toMatchObject({ type: "error", code: "trae_model_unavailable", status: 400 });
    expect(sends).toBe(0);
    expect(budget.state).toEqual({ used: 0, refunded: 1, closed: 1 });
  });

  for (const kind of ["tools", "required", "toolCall", "toolResult", "image", "audio", "video", "document", "oversized", "output limit"]) {
    test(`rejects ${kind} before starting the CLI`, async () => {
      const request = traeRequest();
      if (kind === "tools") request.context.tools = [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }];
      if (kind === "required") request.options.toolChoice = "required";
      if (kind === "output limit") request.options.maxOutputTokens = 32;
      if (kind === "toolCall") request.context.messages = [{ role: "assistant", content: [{ type: "toolCall", id: "call", name: "read_file", arguments: {} }], timestamp: 0 }];
      if (kind === "toolResult") request.context.messages = [{ role: "toolResult", toolCallId: "call", toolName: "read_file", content: "result", timestamp: 0 }];
      if (kind === "image" || kind === "audio") request.context.messages = [{ role: "user", content: [{ type: kind, data: "fixture", mimeType: "image/png" }], timestamp: 0 }] as OcxParsedRequest["context"]["messages"];
      if (kind === "video") request.context.messages = [{ role: "user", content: [{ type: "video", videoUrl: "https://example.com/video.mp4" }], timestamp: 0 }];
      if (kind === "document") request.context.messages = [{ role: "user", content: [{ type: "document", text: "[document: fixture]", mediaType: "application/pdf", data: "Zml4dHVyZQ==" }], timestamp: 0 }];
      if (kind === "oversized") request.context.messages.unshift({ role: "user", content: "x".repeat(1_000_001), timestamp: 0 });
      let spawned = false;
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config(), { resolveBinary: () => { spawned = true; throw new Error("must not spawn"); } })
        .runTurn!(request, traeMeta(), event => events.push(event));
      expect(spawned).toBe(false);
      expect(events[0]).toMatchObject({ type: "error", status: 400 });
    });
  }

  for (const proxy of ["http://127.0.0.1:8080", "socks5://127.0.0.1:1080", "direct", null]) {
    test(`rejects provider proxy ${proxy} before CLI startup in turns, discovery and probes`, async () => {
      const row = { ...config(), proxy };
      const fixture = traeFixture();
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(row, fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
      expect(events[0]).toMatchObject({ type: "error", code: "trae_proxy_unsupported", status: 400 });
      const converge = mock(async (): Promise<CatalogDisposition> => ({ status: "skipped", reason: "busy", retryable: true }));
      expect(await (await probeTraeCnProvider("trae-cn", row, converge, undefined, fixture.deps)).json()).toMatchObject({ ok: false });
      expect(fixture.options()).toBeUndefined();
      const open = spyOn(traeClient, "openTraeSession");
      const result = await fetchProviderModelsWithAuth(captureProviderGather("trae-cn", row, refreshingModelsAuthResolver), 60_000, undefined, refreshingModelsAuthResolver);
      expect(result.outcome.state).toBe("degraded");
      expect(open).not.toHaveBeenCalled();
      expect(converge).not.toHaveBeenCalled();
    });
  }

  for (const phase of ["initialize", "session/prompt"]) {
    test(`unexpected EOF during ${phase} retains late, redacted stderr`, async () => {
      const fixture = traeFixture((request, child) => {
        if (request.method !== phase) return false;
        (child.stdout as PassThrough).end();
        child.kill = () => {
          setTimeout(() => {
            (child.stderr as PassThrough).write("Not logged in; run traecli login. Authorization: Bearer fixture-secret-value");
            child.exitCode = 1;
            child.emit("close", 1);
          }, 1);
          return true;
        };
        return true;
      });
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config(), { ...fixture.deps, killGraceMs: 50 }).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
      expect(events.at(-1)).toMatchObject({ type: "error", status: 401, code: "trae_cn_not_logged_in" });
      expect(JSON.stringify(events)).toContain("run traecli login");
      expect(JSON.stringify(events)).not.toContain("fixture-secret-value");
    });
  }

  for (const withText of [false, true]) {
    test(`refusal preserves usage without retry or success (text=${withText})`, async () => {
      const fixture = traeFixture(request => {
        if (request.method !== "session/prompt") return false;
        if (withText) fixture.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Unable to help." } } } });
        fixture.send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "refusal", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
        return true;
      });
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
      expect(events.at(-1)).toMatchObject({ type: "incomplete", reason: "content_filter", retryable: false, usage: { inputTokens: 10, outputTokens: 2 } });
      expect(events.some(event => event.type === "done" || event.type === "error")).toBe(false);
    });
  }

  test("stdin EPIPE rejects the pending RPC without an uncaught stream error", async () => {
    const fixture = traeFixture((request, child) => {
      if (request.method !== "initialize") return false;
      child.stdin!.emit("error", new Error("write EPIPE"));
      return true;
    });
    await expect(traeClient.openTraeSession(config().baseUrl, fixture.deps)).rejects.toThrow("EPIPE");
    expect(fixture.child.killed).toBe(true);
  });

  for (let fragmentLength = 1; fragmentLength <= 7; fragmentLength++) {
    test(`probe hides a ${fragmentLength}-character bearer fragment at the parser boundary`, async () => {
      const fixture = traeFixture((request, child) => {
        if (request.method !== "initialize") return false;
        (child.stdout as PassThrough).write("x".repeat(64 - 7 - fragmentLength) + "Bearer abcdefghi\n");
        return true;
      });
      const response = await probeTraeCnProvider("trae-cn", config(), async () => { throw new Error("must not converge"); }, undefined, fixture.deps);
      expect(await response.json()).toMatchObject({ ok: false, error: "TRAE CN ACP returned malformed or unsupported protocol data." });
    });
  }

  test("malformed prompt output never exposes parser snippets to the client", async () => {
    const fixture = traeFixture((request, child) => {
      if (request.method !== "session/prompt") return false;
      (child.stdout as PassThrough).write("x".repeat(50) + "Bearer abcdefghi\n");
      return true;
    });
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
    expect(events).toMatchObject([{ type: "error", message: "TRAE CN ACP ended with an invalid protocol response.", retryable: false }]);
  });

  test("an upstream cancellation without client abort emits a terminal event and usage", async () => {
    const fixture = traeFixture(request => {
      if (request.method !== "session/prompt") return false;
      fixture.send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "cancelled", usage: { inputTokens: 3, outputTokens: 0, totalTokens: 3 } } });
      return true;
    });
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
    expect(events).toMatchObject([{ type: "incomplete", reason: "upstream_cancelled", retryable: false, usage: { inputTokens: 3, outputTokens: 0 } }]);
  });

  for (const selected of ["test-model", "unexpected-model"]) {
    test(`model-selection notification validates ${selected}`, async () => {
      const fixture = traeFixture(request => {
        if (request.method === "session/set_model") fixture.send({ jsonrpc: "2.0", method: "session/update",
          params: { sessionId: "fixture-session", update: { sessionUpdate: "current_model_update", currentModelId: selected } } });
        return false;
      });
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
      expect(events.at(-1)).toMatchObject(selected === "test-model" ? { type: "done" } : { type: "error", code: "trae_model_changed" });
    });
  }

  test("relative PATH entries resolve before the CLI changes its working directory", () => {
    expect(resolveTraeCli({ platform: "linux", env: { PATH: "./node_modules/.bin" }, exists: () => true }))
      .toBe(`${process.cwd()}/node_modules/.bin/traecli`);
  });

  for (const kind of ["tool_call", "session/request_permission"]) {
    test(`server ${kind} is rejected and the session is closed`, async () => {
      const fixture = traeFixture(request => {
        if (request.method !== "session/prompt") return false;
        fixture.send(kind === "tool_call"
          ? { jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: kind } } }
          : { jsonrpc: "2.0", id: 99, method: kind, params: {} });
        return true;
      });
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
      expect(events.some(event => event.type === "error")).toBe(true);
      expect(events.some(event => event.type === "done")).toBe(false);
      expect(fixture.child.killed).toBe(true);
    });
  }

  test("shutdown remains bounded when the process and its pipe never close", async () => {
    const fixture = traeFixture(request => request.method === "session/prompt");
    fixture.child.kill = () => true;
    const session = await traeClient.openTraeSession(config().baseUrl, fixture.deps);
    const turn = session.prompt("test-model", "hello", () => undefined).catch(error => error);
    await session.close();
    expect(await turn).toBeInstanceOf(Error);
    expect(fixture.child.stdout!.destroyed).toBe(true);
    expect(existsSync(String(fixture.options()!.cwd))).toBe(false);
  });

  test("POSIX shutdown kills remaining group members after the leader exits", async () => {
    const fixture = traeFixture();
    Object.assign(fixture.child, { pid: 424242 });
    const signals: NodeJS.Signals[] = [];
    const session = await traeClient.openTraeSession(config().baseUrl, { ...fixture.deps, platform: "linux",
      signalPosixProcessGroup: (pid, signal) => {
        expect(pid).toBe(424242);
        signals.push(signal);
        if (signal === "SIGTERM") fixture.child.kill();
      },
    });
    await session.close();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("Windows dispatchers use process-tree termination", async () => {
    const fixture = traeFixture();
    Object.assign(fixture.child, { pid: 4242 });
    const killed: number[] = [];
    const session = await traeClient.openTraeSession(config().baseUrl, { ...fixture.deps, platform: "win32",
      killWindowsProcessTree: pid => { killed.push(pid); fixture.child.kill(); },
    });
    await session.close();
    expect(killed).toEqual([4242]);
  });

  test("workspace allocation failure removes only an owned temporary HOME", async () => {
    let owned = "";
    let calls = 0;
    const makeTempDir = (async (prefix: string) => {
      if (calls++) throw new Error("workspace unavailable");
      owned = await mkdtemp(prefix);
      return owned;
    }) as typeof mkdtemp;
    await expect(traeClient.openTraeSession(config().baseUrl, { resolveBinary: () => "/fixture/traecli", makeTempDir })).rejects.toThrow("workspace unavailable");
    expect(existsSync(owned)).toBe(false);
    await expect(traeClient.openTraeSession(config().baseUrl, { home: testHome.root, resolveBinary: () => "/fixture/traecli",
      makeTempDir: (async () => { throw new Error("workspace unavailable"); }) as typeof mkdtemp,
    })).rejects.toThrow("workspace unavailable");
    expect(existsSync(testHome.root)).toBe(true);
  });

  test("TRAE_HOME is inherited without changing the parent environment", () => {
    const previous = process.env.TRAE_HOME;
    try {
      process.env.TRAE_HOME = testHome.path("selected-trae-home");
      expect(traeCnChildEnv().TRAE_HOME).toBe(process.env.TRAE_HOME);
    } finally { if (previous === undefined) delete process.env.TRAE_HOME; else process.env.TRAE_HOME = previous; }
  });

  test("the default CLI directory survives HOME isolation on POSIX and Windows", () => {
    expect(traeCnChildEnv({ HOME: "/fixture/operator" }, "linux").TRAE_HOME).toBe("/fixture/operator/.trae");
    expect(traeCnChildEnv({ USERPROFILE: "C:\\Users\\operator" }, "win32").TRAE_HOME).toBe("C:\\Users\\operator\\.trae");
    expect(traeCnChildEnv({ HOME: "/fixture/operator", TRAE_HOME: "./selected-trae" }, "linux").TRAE_HOME)
      .toBe(`${process.cwd()}/selected-trae`);
  });

  test("static catalogs never open ACP and retain unknown text-only models", async () => {
    const open = spyOn(traeClient, "openTraeSession").mockRejectedValue(new Error("must not discover"));
    const row = { ...config(), models: ["future-model"], liveModels: false,
      modelCapabilities: { "future-model": { inputModalities: ["text", "image"], supportsVerbosity: true } },
      modelInputModalities: { "future-model": ["text", "image"] } };
    const captured = captureProviderGather("trae-cn", row, refreshingModelsAuthResolver);
    const result = await fetchProviderModelsWithAuth(captured, 60_000, undefined, refreshingModelsAuthResolver);
    expect(open).not.toHaveBeenCalled();
    expect(result.outcome.state).toBe("authoritative");
    expect(result.models).toMatchObject([{ id: "future-model", inputModalities: ["text"], supportsVerbosity: false }]);
    expect(isVisionSidecarConsumer({ providers: { "trae-cn": row } }, "trae-cn", "future-model")).toBe(true);
    expect(isModelVisionSidecarConsumer(row, "future-model")).toBe(true);
    const visionConfig = { providers: { "trae-cn": row }, customModels: [{ provider: "trae-cn", modelId: "future-model", inputModalities: ["text", "image"] }] };
    expect(modelAcceptsImageInput(visionConfig, { provider: "trae-cn", id: "future-model", inputModalities: ["text", "image"] })).toBe(false);
    expect(requiresVisionPreprocessing(visionConfig, row, "future-model", "trae-cn")).toBe(true);
  });

  test("a custom image row cannot override the TRAE wire without per-model capability hints", () => {
    const row = config();
    const visionConfig = { providers: { "trae-cn": row }, customModels: [{ provider: "trae-cn", modelId: "test-model", inputModalities: ["text", "image"] }] };
    expect(customRowInputModalities(visionConfig, "trae-cn", "test-model")).toEqual(["text", "image"]);
    expect(isVisionSidecarConsumer(visionConfig, "trae-cn", "test-model")).toBe(true);
    expect(modelAcceptsImageInput(visionConfig, { provider: "trae-cn", id: "test-model" })).toBe(false);
    expect(requiresVisionPreprocessing(visionConfig, row, "test-model", "trae-cn")).toBe(true);
  });

  test("discovered models do not advertise unsupported verbosity or native image input", async () => {
    const fixture = traeFixture();
    const realOpen = traeClient.openTraeSession;
    spyOn(traeClient, "openTraeSession").mockImplementation((baseUrl, _deps, signal) => realOpen(baseUrl, fixture.deps, signal));
    const models = await rawModels({ ...config(), models: [] });
    expect(models).toMatchObject([{ id: "test-model", inputModalities: ["text"], supportsVerbosity: false }]);
    expect(fixture.child.killed).toBe(true);
  });

  test("cold failures use the cooldown without launching a second CLI", async () => {
    const open = spyOn(traeClient, "openTraeSession").mockRejectedValue(new Error("fixture offline"));
    expect((await fetchProviderModels("trae-cn", config(), 60_000)).map(row => row.id)).toContain("test-model");
    await fetchProviderModels("trae-cn", config(), 60_000);
    expect(open).toHaveBeenCalledTimes(1);
  });

  for (const warm of [false, true]) {
    test(`observed catalogs never launch or refresh CLI authentication (warm=${warm})`, async () => {
      const open = spyOn(traeClient, "openTraeSession").mockRejectedValue(new Error("observed gather must not launch"));
      if (warm) setCached("trae-cn", [{ id: "cached-model", provider: "trae-cn" }], Date.now(), captureModelCacheGeneration("trae-cn"));
      const auth = observedModelsAuthResolver(null, []);
      const captured = captureProviderGather("trae-cn", config(), auth);
      const result = await fetchProviderModelsWithAuth(captured, 60_000, undefined, auth);
      expect(open).not.toHaveBeenCalled();
      expect(result.outcome.state).toBe(warm ? "authoritative" : "degraded");
      expect(result.models.map(model => model.id)).toContain(warm ? "cached-model" : "test-model");
    });
  }

  for (const cacheState of ["fresh", "stale", "cooldown"]) {
    test(`the ${cacheState} cache reapplies lower caps and retained models`, async () => {
      spyOn(traeClient, "openTraeSession").mockRejectedValue(new Error("fixture offline"));
      setCached("trae-cn", [{ id: "test-model", provider: "trae-cn", contextWindow: 120_000 }],
        cacheState === "fresh" ? Date.now() : 1, captureModelCacheGeneration("trae-cn"));
      const row = { ...config(), retainModels: ["retained-model"] };
      if (cacheState === "cooldown") await fetchProviderModels("trae-cn", row, 60_000, 80_000);
      const models = await rawModels(row, 40_000);
      expect(models.map(model => model.id)).toContain("retained-model");
      expect(models.find(model => model.id === "test-model")!.contextWindow).toBeLessThanOrEqual(40_000);
      for (const model of models) expect(model).toMatchObject({ inputModalities: ["text"], supportsVerbosity: false });
    });
  }

  test("connection probe publishes the ACP roster through catalog convergence", async () => {
    const fixture = traeFixture();
    setCached("trae-cn", [{ id: "old-account-model", provider: "trae-cn" }], Date.now(), captureModelCacheGeneration("trae-cn"));
    const converge = mock(async (): Promise<CatalogDisposition> => {
      expect(getFreshCached("trae-cn", 60_000, Date.now())?.map(model => model.id)).toEqual(["test-model"]);
      return { status: "committed", changed: true, degraded: false, notices: [] };
    });
    const refreshConnectedClients = mock(async (admit: () => boolean) => { expect(admit()).toBe(true); return []; });
    const response = await probeTraeCnProvider("trae-cn", config(), converge, undefined, { ...fixture.deps, refreshConnectedClients });
    expect(await response.json()).toMatchObject({ ok: true, models: 1, catalogRefresh: { status: "committed" } });
    expect(fixture.requests.map(request => request.method)).toEqual(["initialize", "session/new"]);
    expect(converge).toHaveBeenCalledTimes(1);
    expect(refreshConnectedClients).toHaveBeenCalledTimes(1);
    expect(fixture.child.killed).toBe(true);
  });

  test("a connection probe cannot replace a newer cache generation", async () => {
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    let requestId = 0;
    const fixture = traeFixture(request => {
      if (request.method !== "session/new") return false;
      requestId = request.id;
      started();
      return true;
    });
    const converge = mock(async (): Promise<CatalogDisposition> => ({ status: "committed", changed: true, degraded: false, notices: [] }));
    const probe = probeTraeCnProvider("trae-cn", config(), converge, undefined, fixture.deps);
    await waiting;
    clearModelCache("trae-cn");
    setCached("trae-cn", [{ id: "new-account-model", provider: "trae-cn" }], Date.now(), captureModelCacheGeneration("trae-cn"));
    fixture.send({ jsonrpc: "2.0", id: requestId, result: { sessionId: "fixture-session", models: { availableModels: [{ modelId: "old-account-model" }] } } });
    expect(await (await probe).json()).toMatchObject({ ok: true, catalogRefresh: { status: "skipped", reason: "stale" } });
    expect(getFreshCached("trae-cn", 60_000, Date.now())?.map(model => model.id)).toEqual(["new-account-model"]);
    expect(converge).not.toHaveBeenCalled();
  });

  test("a successful probe reports pending catalog publication", async () => {
    const fixture = traeFixture();
    const response = await probeTraeCnProvider("trae-cn", config(), async () => ({ status: "skipped", reason: "busy", retryable: true }), undefined, fixture.deps);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, catalogRefresh: { status: "skipped", reason: "busy" } });
    expect(body.message).toContain("Catalog refresh is pending");
  });

  test("the management connection test reaches ACP without an HTTP website probe", async () => {
    const fixture = traeFixture();
    const realOpen = traeClient.openTraeSession;
    spyOn(traeClient, "openTraeSession").mockImplementation((baseUrl, _deps, signal) => realOpen(baseUrl, fixture.deps, signal));
    const outbound = spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch the vendor website"));
    const req = new Request("http://localhost/api/providers/test?name=trae-cn", { method: "POST" });
    const refreshOwnedCatalogIntegrations = mock(async () => []);
    const response = await handleProviderRoutes({ req, url: new URL(req.url), config: { providers: { "trae-cn": config() } }, deps: { refreshOwnedCatalogIntegrations },
      convergeCodexCatalog: async () => ({ status: "committed", changed: true, degraded: false, notices: [] }),
    } as Parameters<typeof handleProviderRoutes>[0]);
    expect(await response!.json()).toMatchObject({ ok: true, models: 1 });
    expect(outbound).not.toHaveBeenCalled();
    expect(refreshOwnedCatalogIntegrations).toHaveBeenCalledTimes(1);
  });
});
