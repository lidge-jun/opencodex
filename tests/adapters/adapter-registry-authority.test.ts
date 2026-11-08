import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createTraeCnAdapter } from "../../src/adapters/trae-cn/adapter";
import * as traeClient from "../../src/adapters/trae-cn/client";
import { traeCnChildEnv } from "../../src/adapters/trae-cn/profile";
import { fetchProviderModels, fetchProviderModelsWithAuth, refreshingModelsAuthResolver } from "../../src/codex/catalog/provider-models";
import { captureProviderGather } from "../../src/codex/catalog/gather-capture";
import { captureModelCacheGeneration, clearModelCache, getFreshCached, setCached } from "../../src/codex/model-cache";
import { probeTraeCnProvider } from "../../src/server/management/trae-cn-provider-probe";
import { handleProviderRoutes } from "../../src/server/management/provider-routes";
import { isVisionSidecarConsumer } from "../../src/vision/eligibility";
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

  for (const phase of ["initialize", "session/new", "session/prompt"]) {
    test(`abort during ${phase} tears down the child and directories`, async () => {
      const controller = new AbortController();
      const fixture = traeFixture(request => {
        if (request.method !== phase) return false;
        controller.abort();
        return true;
      });
      const budget = fakeSendBudget();
      let sends = 0;
      let deadlineReached = false;
      const watchdog = setTimeout(() => { deadlineReached = true; fixture.child.kill(); }, 1000);
      try {
        await createTraeCnAdapter(config(), { ...fixture.deps, timeoutMs: 60_000 }).runTurn!(traeRequest(), traeMeta({
          abortSignal: controller.signal, sendBudget: budget.budget, onPhysicalSend: () => { sends++; },
        }), () => undefined);
      } finally { clearTimeout(watchdog); }
      expect(deadlineReached).toBe(false);
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

  for (const kind of ["tools", "required", "toolCall", "toolResult", "image", "audio", "oversized"]) {
    test(`rejects ${kind} before starting the CLI`, async () => {
      const request = traeRequest();
      if (kind === "tools") request.context.tools = [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }];
      if (kind === "required") request.options.toolChoice = "required";
      if (kind === "toolCall") request.context.messages = [{ role: "assistant", content: [{ type: "toolCall", id: "call", name: "read_file", arguments: {} }], timestamp: 0 }];
      if (kind === "toolResult") request.context.messages = [{ role: "toolResult", toolCallId: "call", toolName: "read_file", content: "result", timestamp: 0 }];
      if (kind === "image" || kind === "audio") request.context.messages = [{ role: "user", content: [{ type: kind, data: "fixture", mimeType: "image/png" }], timestamp: 0 }] as OcxParsedRequest["context"]["messages"];
      if (kind === "oversized") request.context.messages.unshift({ role: "user", content: "x".repeat(1_000_001), timestamp: 0 });
      let spawned = false;
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config(), { resolveBinary: () => { spawned = true; throw new Error("must not spawn"); } })
        .runTurn!(request, traeMeta(), event => events.push(event));
      expect(spawned).toBe(false);
      expect(events[0]).toMatchObject({ type: "error", status: 400 });
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

  test("static catalogs never open ACP and retain unknown text-only models", async () => {
    const open = spyOn(traeClient, "openTraeSession").mockRejectedValue(new Error("must not discover"));
    const row = { ...config(), models: ["future-model"], liveModels: false };
    const captured = captureProviderGather("trae-cn", row, refreshingModelsAuthResolver);
    const result = await fetchProviderModelsWithAuth(captured, 60_000, undefined, refreshingModelsAuthResolver);
    expect(open).not.toHaveBeenCalled();
    expect(result.outcome.state).toBe("authoritative");
    expect(result.models).toMatchObject([{ id: "future-model", inputModalities: ["text"], supportsVerbosity: false }]);
    expect(isVisionSidecarConsumer({ providers: { "trae-cn": row } }, "trae-cn", "future-model")).toBe(true);
  });

  test("discovered models do not advertise unsupported verbosity or native image input", async () => {
    const fixture = traeFixture();
    const realOpen = traeClient.openTraeSession;
    spyOn(traeClient, "openTraeSession").mockImplementation((baseUrl, _deps, signal) => realOpen(baseUrl, fixture.deps, signal));
    const models = await fetchProviderModels("trae-cn", { ...config(), models: [] }, 60_000);
    expect(models).toMatchObject([{ id: "test-model", inputModalities: ["text"], supportsVerbosity: false }]);
    expect(fixture.child.killed).toBe(true);
  });

  test("cold failures use the cooldown without launching a second CLI", async () => {
    const open = spyOn(traeClient, "openTraeSession").mockRejectedValue(new Error("fixture offline"));
    expect((await fetchProviderModels("trae-cn", config(), 60_000)).map(row => row.id)).toContain("test-model");
    await fetchProviderModels("trae-cn", config(), 60_000);
    expect(open).toHaveBeenCalledTimes(1);
  });

  for (const cacheState of ["fresh", "stale", "cooldown"]) {
    test(`the ${cacheState} cache reapplies lower caps and retained models`, async () => {
      spyOn(traeClient, "openTraeSession").mockRejectedValue(new Error("fixture offline"));
      setCached("trae-cn", [{ id: "test-model", provider: "trae-cn", contextWindow: 120_000 }],
        cacheState === "fresh" ? Date.now() : 1, captureModelCacheGeneration("trae-cn"));
      const row = { ...config(), retainModels: ["retained-model"] };
      if (cacheState === "cooldown") await fetchProviderModels("trae-cn", row, 60_000, 80_000);
      const models = await fetchProviderModels("trae-cn", row, 60_000, 40_000);
      expect(models.map(model => model.id)).toContain("retained-model");
      expect(models.find(model => model.id === "test-model")!.contextWindow).toBeLessThanOrEqual(40_000);
      for (const model of models) expect(model).toMatchObject({ inputModalities: ["text"], supportsVerbosity: false });
    });
  }

  test("connection probe uses ACP evidence and invalidates the cached roster", async () => {
    const fixture = traeFixture();
    setCached("trae-cn", [{ id: "old-account-model", provider: "trae-cn" }], Date.now(), captureModelCacheGeneration("trae-cn"));
    const response = await probeTraeCnProvider("trae-cn", config(), undefined, fixture.deps);
    expect(await response.json()).toMatchObject({ ok: true, models: 1 });
    expect(fixture.requests.map(request => request.method)).toEqual(["initialize", "session/new"]);
    expect(getFreshCached("trae-cn", 60_000, Date.now())).toBeNull();
    expect(fixture.child.killed).toBe(true);
  });

  test("the management connection test reaches ACP without an HTTP website probe", async () => {
    const fixture = traeFixture();
    const realOpen = traeClient.openTraeSession;
    spyOn(traeClient, "openTraeSession").mockImplementation((baseUrl, _deps, signal) => realOpen(baseUrl, fixture.deps, signal));
    const outbound = spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch the vendor website"));
    const req = new Request("http://localhost/api/providers/test?name=trae-cn", { method: "POST" });
    const response = await handleProviderRoutes({ req, url: new URL(req.url), config: { providers: { "trae-cn": config() } }, deps: {},
    } as Parameters<typeof handleProviderRoutes>[0]);
    expect(await response!.json()).toMatchObject({ ok: true, models: 1 });
    expect(outbound).not.toHaveBeenCalled();
  });
});
