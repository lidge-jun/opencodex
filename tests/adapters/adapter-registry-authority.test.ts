import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter, once } from "node:events";
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, posix, win32 } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createTraeCnAdapter } from "../../src/adapters/trae-cn/adapter";
import * as traeClient from "../../src/adapters/trae-cn/client";
import { traePosixInvocation, traeStopPipe } from "../../src/adapters/trae-cn/process";
import { prepareTraeWindowsJob, TraeWindowsJobFrames, traeWindowsCommandLine, traeWindowsJobExecutable } from "../../src/adapters/trae-cn/windows-job";
import { commandInvocation } from "../../src/lib/win-exec";
import { buildCatalogEntries } from "../../src/codex/catalog";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import { resolveTraeCli, traeCnChildEnv } from "../../src/adapters/trae-cn/profile";
import { parseTraeAcpMessage, parseTraeModels, traeSessionId } from "../../src/adapters/trae-cn/protocol";
import * as traeProtocol from "../../src/adapters/trae-cn/protocol";
import { parseRequest as parseResponsesRequest } from "../../src/responses/parser";
import { fetchProviderModels, fetchProviderModelsWithAuth, observedModelsAuthResolver, refreshingModelsAuthResolver } from "../../src/codex/catalog/provider-models";
import { captureProviderGather } from "../../src/codex/catalog/gather-capture";
import { captureModelCacheGeneration, clearModelCache, getFreshCached, observeModelCacheRevision, setCached } from "../../src/codex/model-cache";
import { probeTraeCnProvider } from "../../src/server/management/trae-cn-provider-probe";
import { handleProviderRoutes } from "../../src/server/management/provider-routes";
import { customRowInputModalities, isModelVisionSidecarConsumer, isVisionSidecarConsumer, modelAcceptsImageInput } from "../../src/vision/eligibility";
import { requiresVisionPreprocessing } from "../../src/vision/plan";
import { gatherRoutedModels } from "../../src/codex/catalog/routed-gather";
import { refreshTraeCnCatalogSources } from "../../src/codex/catalog/trae-cn-models";
import * as managementConvergence from "../../src/codex/management-convergence";
import * as catalogScheduler from "../../src/codex/catalog-auto-refresh";
import * as configApi from "../../src/config";
import * as catalogAdmission from "../../src/codex/catalog-admission";
import type { CatalogDisposition } from "../../src/codex/convergence-types";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import { SpendLedgerFileRefusedError } from "../../src/lib/spend-reservation-ledger";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { mapSpendLedgerStorageError } from "../../src/server/responses/spend-storage-error";
import { appOwnedBytesSnapshot, configureAppOwnedMemoryBudget, enforceAppOwnedMemoryBudget, registerRetainedStore, resetAppOwnedMemoryForTests } from "../../src/lib/app-owned-memory";
import { registerDefaultAppOwnedMemoryStores } from "../../src/lib/app-owned-memory-stores";
import { getPinnedCached, evictOldestModelCacheForBudget, modelCacheRetainedStoreSnapshot } from "../../src/codex/model-cache";
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
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../helpers/translator-budget";

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
    if (String(chunk) === "__OCX_STOP_TRAE__\n") { callback(); child.emit("trae-stop-request"); return; }
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
  const stopPipe = new Writable({ write(_chunk, _encoding, callback) { callback(); child.kill("SIGTERM"); } });
  Object.assign(child, { stdio: [child.stdin, stdout, child.stderr, stopPipe] });
  const deps: traeClient.TraeAcpDeps = {
    platform: "linux",
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
  return { headers: new Headers(), translatorBudget: createTestTranslatorBudget(), ...extra };
}

function fakeSendBudget({ reserveAllowed = true, useAllowed = true } = {}) {
  const state = { used: 0, refunded: 0, closed: 0 };
  const budget = {
    beginSpendProducer: () => ({ close: () => { state.closed++; } }),
    reserveDispatch: () => reserveAllowed ? ({ allowed: true, permit: {
      use: () => { if (!useAllowed) return false; state.used++; return true; },
      release: () => { if (!state.used) state.refunded++; },
    } }) : { allowed: false },
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

  async function withProbeMemory<T>(pinned: boolean, run: (evictions: () => number) => Promise<T>): Promise<T> {
    const budget = 64 * 1024 * 1024;
    resetAppOwnedMemoryForTests(); clearModelCache(); configureAppOwnedMemoryBudget(budget);
    registerRetainedStore({ id: "model_cache", category: "caches",
      snapshot: modelCacheRetainedStoreSnapshot, evictOldest: evictOldestModelCacheForBudget });
    let bytes = pinned ? budget : budget - 1;
    let evictions = 0;
    registerRetainedStore({ id: "probe-continuation", category: "continuation",
      snapshot: () => ({ count: bytes ? 1 : 0, bytes, pinnedBytes: pinned ? bytes : 0,
        evictableBytes: pinned ? 0 : bytes, oldestAt: pinned || !bytes ? null : 1 }),
      evictOldest: () => { evictions++; const released = bytes; bytes = 0; return released; },
    });
    try { return await run(() => evictions); }
    finally { clearModelCache(); resetAppOwnedMemoryForTests(); registerDefaultAppOwnedMemoryStores(); }
  }

  function pressureSession() {
    return spyOn(traeClient, "openTraeSession").mockImplementation(async () => ({
      models: ["new-probed-model"], prompt: async () => undefined, close: async () => undefined,
    }));
  }

  for (const ttl of [60_000, 0]) {
    test("probe publication keeps one discovered roster under pressure; ttl=" + ttl, async () => {
      await withProbeMemory(false, async evictions => {
        const open = pressureSession();
        const row = { ...config(), models: ["configured-fallback"] };
        const next: OcxConfig = { port: 10100, defaultProvider: "trae-cn", modelCacheTtlMs: ttl, providers: { "trae-cn": row } };
        let state: string | undefined;
        let rosterAvailable = false;
        let clientRosterAvailable = false;
        const response = await probeTraeCnProvider("trae-cn", row, async () => {
          await refreshTraeCnCatalogSources(next);
          const resolver = observedModelsAuthResolver(null, []);
          const gathered = await fetchProviderModelsWithAuth(captureProviderGather("trae-cn", row, resolver), ttl, undefined, resolver);
          state = gathered.outcome.state;
          rosterAvailable = gathered.models.some(model => model.id === "new-probed-model");
          enforceAppOwnedMemoryBudget();
          expect(appOwnedBytesSnapshot().retainedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
          return { status: "committed", changed: true, degraded: false, notices: [] };
        }, undefined, { refreshConnectedClients: async admit => {
          expect(admit()).toBe(true); enforceAppOwnedMemoryBudget();
          clientRosterAvailable = Boolean(getPinnedCached("trae-cn")?.some(model => model.id === "new-probed-model"));
          return [];
        } });
        expect(open).toHaveBeenCalledTimes(1);
        expect(state).toBe("authoritative"); expect(rosterAvailable).toBe(true); expect(clientRosterAvailable).toBe(true);
        expect(await response.json()).toMatchObject({ ok: true, rosterReplaced: true, clientRefreshPending: false, catalogRefresh: { status: "committed" } });
        expect(evictions()).toBe(1); expect(modelCacheRetainedStoreSnapshot().pinnedBytes).toBe(0);
        if (ttl === 0) expect(getFreshCached("trae-cn", ttl, Date.now())).toBeNull();
      });
    });
  }

  test("saturated pinned memory refuses publication without another CLI discovery", async () => {
    await withProbeMemory(true, async () => {
      const open = pressureSession();
      const converge = mock(async (): Promise<CatalogDisposition> => ({ status: "committed", changed: true, degraded: false, notices: [] }));
      const body = await (await probeTraeCnProvider("trae-cn", config(), converge)).json();
      expect(body).toMatchObject({ ok: true, rosterReplaced: false, rosterRetentionPending: true,
        catalogRefresh: { status: "failed", reason: "admission", phase: "gather", partialWrite: false } });
      expect(converge).not.toHaveBeenCalled(); expect(open).toHaveBeenCalledTimes(1);
      expect(modelCacheRetainedStoreSnapshot().pinnedBytes).toBe(0);
      expect(appOwnedBytesSnapshot().retainedBytes).toBe(64 * 1024 * 1024);
    });
  });

  test("convergence and client-refresh errors release every roster pin", async () => {
    await withProbeMemory(false, async () => {
      pressureSession();
      const body = await (await probeTraeCnProvider("trae-cn", config(), async () => { throw new Error("fixture"); }, undefined, {
        refreshConnectedClients: async () => { throw new Error("fixture"); },
      })).json();
      expect(body).toMatchObject({ ok: true, clientRefreshPending: true, catalogRefresh: { status: "failed" } });
      expect(modelCacheRetainedStoreSnapshot().pinnedBytes).toBe(0);
    });
  });

  test("local spend-ledger refusals retain the shared 503 diagnostic before CLI startup", async () => {
    const refusal = new SpendLedgerFileRefusedError("journal", "extra-hard-link");
    let producerClosed = 0;
    const sendBudget = createRequestExecutionBudget(undefined, "trae-ledger-refusal", {
      enforced: true, charge: () => { throw refusal; }, refund: () => undefined,
      beginReporter: () => ({ start: () => undefined, rebindTarget: () => true, report: () => undefined,
        close: () => { producerClosed++; } }),
    });
    const fixture = traeFixture();
    const events: AdapterEvent[] = [];
    await expect(createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta({ sendBudget }),
      event => events.push(event))).rejects.toBe(refusal);
    expect(fixture.options()).toBeUndefined(); expect(events).toEqual([]);
    expect(sendBudget.used).toBe(0); expect(producerClosed).toBe(1);
    expect(mapSpendLedgerStorageError(refusal)).toMatchObject({ status: 503, code: "spend_ledger_storage_unavailable", errorType: "server_error" });
  });

  for (const closeFails of [false, true]) {
    test("cleanup cancellation retains received usage without provider errors; closeFails=" + closeFails, async () => {
      const controller = new AbortController();
      const usage = { inputTokens: 123, outputTokens: 456, totalTokens: 579 };
      spyOn(traeClient, "openTraeSession").mockResolvedValue({
        models: ["test-model"],
        prompt: async (_model, _text, emit, _signal, dispatch) => {
          dispatch?.beforeSend?.(); dispatch?.onSend?.();
          emit({ type: "text_delta", text: "finished" }); emit({ type: "done", usage });
        },
        close: async () => { controller.abort(); if (closeFails) throw new Error("fixture cleanup failed"); },
      });
      const budget = fakeSendBudget();
      const meta = traeMeta({ abortSignal: controller.signal, sendBudget: budget.budget });
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config()).runTurn!(traeRequest(), meta, event => events.push(event));
      expect(events.map(event => event.type)).toEqual(["heartbeat", "text_delta", "incomplete"]);
      expect(events.at(-1)).toMatchObject({ type: "incomplete", reason: "client_cancelled", usage, retryable: false });
      expect(budget.state).toEqual({ used: 1, refunded: 0, closed: 1 });
      const observed: unknown[] = [];
      const json = buildResponseJSON(events, "test-model", { translatorBudget: meta.translatorBudget, onUsage: value => observed.push(value) });
      expect(observed).toEqual([usage]);
      expect(json.status).toBe("incomplete");
      expect(json.usage).toMatchObject({ input_tokens: 123, output_tokens: 456, total_tokens: 579 });
    });
  }

  test("client cancellation retains usage from a thrown prompt failure", async () => {
    const controller = new AbortController();
    const usage = { inputTokens: 123, outputTokens: 456, totalTokens: 579 };
    spyOn(traeClient, "openTraeSession").mockResolvedValue({
      models: ["test-model"],
      prompt: async (_model, _text, _emit, _signal, dispatch) => {
        dispatch?.beforeSend(); dispatch?.onSend();
        throw new traeClient.TraeAcpError("fixture prompt failure", "trae_acp_error", usage);
      },
      close: async () => { controller.abort(); },
    });
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config()).runTurn!(traeRequest(), traeMeta({ abortSignal: controller.signal }),
      event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "incomplete", reason: "client_cancelled", usage });
  });

  for (const attachment of [
    { type: "input_image", image_url: "https://fixture.invalid/image.png" },
    { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/nkAAAAASUVORK5CYII=" },
    { type: "input_video", video_url: "https://fixture.invalid/clip.mp4" },
    { type: "input_audio", audio_url: "https://fixture.invalid/audio.wav", format: "wav" },
    { type: "input_file", file_id: "fixture-file" },
  ]) {
    test("original Responses instruction media are refused before CLI startup: " + attachment.type, async () => {
      const fixture = traeFixture();
      const parsed = parseResponsesRequest({ model: "test-model", input: [
        { role: "system", content: [{ type: "input_text", text: "Describe the attachment" }, attachment] },
        { role: "user", content: "Question" },
      ] });
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config(), fixture.deps).runTurn!(parsed, traeMeta(), event => events.push(event));
      expect(events).toMatchObject([{ type: "error", status: 400, code: "unsupported_input_modality" }]);
      expect(fixture.options()).toBeUndefined(); expect(fixture.requests).toEqual([]);
    });
  }

  for (const attachment of [
    { type: "input_file", file_id: "fixture-agent-file" },
    { type: "input_audio", audio_url: "https://fixture.invalid/agent.wav", format: "wav" },
  ]) {
    test("agent-message media references are refused before dispatch: " + attachment.type, async () => {
      const fixture = traeFixture();
      const parsed = parseResponsesRequest({ model: "test-model", input: [
        { type: "agent_message", content: [attachment] }, { role: "user", content: "Question" },
      ] });
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config(), fixture.deps).runTurn!(parsed, traeMeta(), event => events.push(event));
      expect(events).toMatchObject([{ type: "error", status: 400, code: "unsupported_input_modality" }]);
      expect(fixture.options()).toBeUndefined(); expect(fixture.requests).toEqual([]);
    });
  }

  test("user file references remain refused when inline document bytes are also present", async () => {
    const fixture = traeFixture();
    const parsed = parseResponsesRequest({ model: "test-model", input: [{ role: "user", content: [
      { type: "input_file", file_id: "fixture-user-file",
        file_data: "data:application/pdf;base64,JVBERi0xLjQK", filename: "fixture.pdf" },
    ] }] });
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), fixture.deps).runTurn!(parsed, traeMeta(), event => events.push(event));
    expect(events).toMatchObject([{ type: "error", status: 400, code: "unsupported_input_modality" }]);
    expect(fixture.options()).toBeUndefined(); expect(fixture.requests).toEqual([]);
  });

  for (const stop of ["cancelled", "end_turn"]) {
    test("client abort after a parsed ACP reply retains usage: stop=" + stop, async () => {
      const controller = new AbortController();
      const usage = { inputTokens: 123, outputTokens: 456, totalTokens: 579 };
      const fixture = traeFixture(request => {
        if (request.method !== "session/prompt") return false;
        fixture.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "received" } } } });
        fixture.send({ jsonrpc: "2.0", id: request.id, result: { stopReason: stop, usage } });
        return true;
      });
      const readUsage = traeProtocol.traeUsage;
      spyOn(traeProtocol, "traeUsage").mockImplementation(result => {
        const received = readUsage(result); controller.abort(); return received;
      });
      const budget = fakeSendBudget();
      const meta = traeMeta({ abortSignal: controller.signal, sendBudget: budget.budget });
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), meta, event => events.push(event));
      expect(events.at(-1)).toMatchObject({ type: "incomplete", reason: "client_cancelled", usage });
      expect(events.some(event => event.type === "error")).toBe(false);
      expect(budget.state).toEqual({ used: 1, refunded: 0, closed: 1 });
      expect(fixture.child.killed).toBe(true);
      expect(buildResponseJSON(events, "test-model", { translatorBudget: meta.translatorBudget }).usage)
        .toMatchObject({ input_tokens: 123, output_tokens: 456, total_tokens: 579 });
    });
  }

  // Captured from traecli --version 0.120.19 on 2026-11-08T16:22:30Z.
  // Session/model strings are replaced and unrelated fields omitted; the opt-in test below checks the installed CLI.
  test("recorded CLI 0.120.19 session/new keeps the reported model shape", () => {
    const frame = parseTraeAcpMessage({ jsonrpc: "2.0", id: 2, result: {
      sessionId: "recorded-session", models: {
        currentModelId: "recorded-model-1", availableModels: [
          {"modelId": "recorded-model-1", "name": "Recorded model 1", "description": "Redacted description"},
          {"modelId": "recorded-model-2", "name": "Recorded model 2", "description": "Redacted description"},
          {"modelId": "recorded-model-3", "name": "Recorded model 3", "description": "Redacted description"},
          {"modelId": "recorded-model-4", "name": "Recorded model 4", "description": "Redacted description"},
          {"modelId": "recorded-model-5", "name": "Recorded model 5", "description": "Redacted description"},
          {"modelId": "recorded-model-6", "name": "Recorded model 6", "description": "Redacted description"},
          {"modelId": "recorded-model-7", "name": "Recorded model 7", "description": "Redacted description"},
          {"modelId": "recorded-model-8", "name": "Recorded model 8", "description": "Redacted description"},
          {"modelId": "recorded-model-9", "name": "Recorded model 9", "description": "Redacted description"},
          {"modelId": "recorded-model-10", "name": "Recorded model 10", "description": "Redacted description"},
          {"modelId": "recorded-model-11", "name": "Recorded model 11", "description": "Redacted description"},
          {"modelId": "recorded-model-12", "name": "Recorded model 12", "description": "Redacted description"},
          {"modelId": "recorded-model-13", "name": "Recorded model 13", "description": "Redacted description"},
          {"modelId": "recorded-model-14", "name": "Recorded model 14", "description": "Redacted description"},
          {"modelId": "recorded-model-15", "name": "Recorded model 15", "description": "Redacted description"},
        ],
      },
    } });
    expect(frame.kind).toBe("response");
    if (frame.kind !== "response") throw new Error("Expected recorded response");
    expect(traeSessionId(frame.result)).toBe("recorded-session");
    const models = parseTraeModels(frame.result);
    expect(models).toHaveLength(15);
    expect(models.slice(0, 2)).toEqual(["recorded-model-1", "recorded-model-2"]);
    expect(models.at(-1)).toBe("recorded-model-15");
  });

  test.skipIf(process.env.OCX_TRAE_CN_LIVE_TEST !== "1")("installed TRAE CLI discovery (opt-in)", async () => {
    const binary = process.env.OCX_TRAE_CN_LIVE_BINARY;
    const cliHome = process.env.TRAE_HOME;
    if (!binary || !isAbsolute(binary) || !cliHome || !isAbsolute(cliHome)) {
      throw new Error("The opt-in check requires absolute OCX_TRAE_CN_LIVE_BINARY and TRAE_HOME paths; keep test HOME isolation enabled.");
    }
    const session = await traeClient.openTraeSession(config().baseUrl, { timeoutMs: 30_000, resolveBinary: () => binary });
    try { expect(session.models.length).toBeGreaterThan(0); }
    finally { await session.close(); }
  }, 90_000);

  test("developer replay records preserve chronology and instruction priority", async () => {
    const prompts: string[] = [];
    for (const developerFirst of [true, false]) {
      const fixture = traeFixture();
      const request = traeRequest();
      const developer = { role: "developer" as const, content: "Chronology instruction" };
      const assistant = { role: "assistant" as const, content: [{ type: "text" as const, text: "Earlier assistant reply" }] };
      request.context.messages = [
        { role: "user", content: "Earlier user request" },
        ...(developerFirst ? [developer, assistant] : [assistant, developer]),
        { role: "user", content: "Current chronology question" },
        { role: "developer", content: "Trailing developer instruction" },
      ];
      await createTraeCnAdapter(config(), fixture.deps).runTurn!(request, traeMeta(), () => undefined);
      const prompt = fixture.requests.find(entry => entry.method === "session/prompt")!.params.prompt![0]!.text;
      expect(prompt.split("</system>")[0]).toContain("Chronology instruction");
      const replay = prompt.split("Prior conversation context:")[1]!;
      expect(replay).toContain("DEVELOPER:\nChronology instruction");
      expect(replay.indexOf("DEVELOPER:\nChronology instruction") < replay.indexOf("ASSISTANT:\nEarlier assistant reply")).toBe(developerFirst);
      expect(replay).toContain("Current request:\n\nUSER:\nCurrent chronology question");
      expect(replay.indexOf("Trailing developer instruction")).toBeGreaterThan(replay.indexOf("Current chronology question"));
      prompts.push(prompt);
    }
    expect(prompts[0]).not.toBe(prompts[1]);
  });

  test("streams text, reasoning and usage; charges only the prompt write", async () => {
    const fixture = traeFixture();
    const budget = fakeSendBudget();
    const events: AdapterEvent[] = [];
    const reports: string[] = [];
    await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta({
      sendBudget: budget.budget, onPhysicalSend: () => reports.push(fixture.requests.at(-1)!.method),
    }), event => events.push(event));
    expect(events.map(event => event.type)).toEqual(["heartbeat", "thinking_delta", "text_delta", "done"]);
    expect(events[0]).toEqual({ type: "heartbeat", replayUnsafe: true });
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

  for (const reserveAllowed of [false, true]) {
    test("dispatch-budget rejection writes no prompt: reservation=" + reserveAllowed, async () => {
      const fixture = traeFixture();
      const budget = fakeSendBudget({ reserveAllowed, useAllowed: false });
      const events: AdapterEvent[] = [];
      let sends = 0;
      await expect(createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta({
        sendBudget: budget.budget, onPhysicalSend: () => { sends++; },
      }), event => events.push(event))).rejects.toBeInstanceOf(SendBudgetExhaustedError);
      expect(fixture.requests.some(request => request.method === "session/prompt")).toBe(false);
      expect(sends).toBe(0);
      expect(events).toEqual([]);
      expect(budget.state).toEqual({ used: 0, refunded: reserveAllowed ? 1 : 0, closed: 1 });
      if (!reserveAllowed) expect(fixture.requests).toHaveLength(0);
    });
  }

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
      expect(events).toEqual(phase === "session/prompt" ? [{ type: "heartbeat", replayUnsafe: true }] : []);
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

  test("a local ENOSPC startup failure reports its stage without arbitrary error text", async () => {
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), { resolveBinary: () => "/fixture/traecli",
      makeTempDir: (async () => { throw Object.assign(new Error("private path and diagnostic"), { code: "ENOSPC" }); }) as typeof mkdtemp,
    }).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
    expect(events).toMatchObject([{ type: "error", status: 500, code: "trae_startup_home_enospc", message: "TRAE CN startup failed during home (ENOSPC)." }]);
  });

  test("a stdout byte ceiling has a distinct safe diagnostic", async () => {
    const fixture = traeFixture((request, child) => {
      if (request.method !== "initialize") return false;
      (child.stdout as PassThrough).write("x".repeat(1024 * 1024 + 1));
      return true;
    });
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
    expect(events).toMatchObject([{ type: "error", code: "trae_stdout_limit", message: "TRAE CN ACP stdout exceeded its size limit." }]);
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
    expect(events).toMatchObject([{ type: "heartbeat", replayUnsafe: true }, { type: "error", message: "TRAE CN ACP ended with an invalid protocol response.", retryable: false }]);
  });

  test("an upstream cancellation without client abort emits a terminal event and usage", async () => {
    const fixture = traeFixture(request => {
      if (request.method !== "session/prompt") return false;
      fixture.send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "cancelled", usage: { inputTokens: 3, outputTokens: 0, totalTokens: 3 } } });
      return true;
    });
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
    expect(events).toMatchObject([{ type: "heartbeat", replayUnsafe: true }, { type: "incomplete", reason: "upstream_cancelled", retryable: false, usage: { inputTokens: 3, outputTokens: 0 } }]);
  });

  for (const selected of ["test-model", "unexpected-model"]) {
    test(`post-selection model notification validates ${selected}`, async () => {
      const fixture = traeFixture(request => {
        if (request.method === "session/prompt") fixture.send({ jsonrpc: "2.0", method: "session/update",
          params: { sessionId: "fixture-session", update: { sessionUpdate: "current_model_update", currentModelId: selected } } });
        return false;
      });
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
      expect(events.at(-1)).toMatchObject(selected === "test-model" ? { type: "done" } : { type: "error", code: "trae_model_changed" });
    });
  }

  for (const initialBeforeReply of [true, false]) for (const selectionNotification of [true, false]) {
    test("initial model notifications are superseded by set_model: " + initialBeforeReply + "/" + selectionNotification, async () => {
      const modelUpdate = (model: string) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session",
        update: { sessionUpdate: "current_model_update", currentModelId: model } } });
      const fixture = traeFixture(request => {
        if (request.method === "session/new") {
          if (initialBeforeReply) fixture.send(modelUpdate("default-model"));
          fixture.send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "fixture-session", models: {
            availableModels: [{ modelId: "default-model" }, { modelId: "test-model" }], currentModelId: "default-model",
          } } });
          if (!initialBeforeReply) fixture.send(modelUpdate("default-model"));
          return true;
        }
        if (request.method === "session/set_model" && selectionNotification) fixture.send(modelUpdate("test-model"));
        return false;
      });
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
      expect(events.at(-1)).toMatchObject({ type: "done" });
      expect(events.some(event => event.type === "error")).toBe(false);
      expect(fixture.requests.filter(request => request.method === "session/set_model").map(request => request.params))
        .toEqual([{ sessionId: "fixture-session", modelId: "test-model" }]);
      expect(fixture.requests.filter(request => request.method === "session/prompt")).toHaveLength(1);
    });
  }

  test("relative PATH entries resolve before the CLI changes its working directory", () => {
    expect(resolveTraeCli({ platform: "linux", env: { PATH: "./node_modules/.bin" }, exists: () => true }))
      .toBe(posix.resolve("./node_modules/.bin/traecli"));
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

  test("tool refusal retains usage from an already received prompt reply", async () => {
    const usage = { inputTokens: 123, outputTokens: 456, totalTokens: 579 };
    const fixture = traeFixture(request => {
      if (request.method !== "session/prompt") return false;
      fixture.send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn", usage } });
      fixture.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session",
        update: { sessionUpdate: "tool_call" } } });
      return true;
    });
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "trae_tool_call_unsupported", usage });
    expect(buildResponseJSON(events, "test-model").usage)
      .toMatchObject({ input_tokens: 123, output_tokens: 456, total_tokens: 579 });
  });

  test("malformed update refusal retains usage from an already received prompt reply", async () => {
    const usage = { inputTokens: 123, outputTokens: 456, totalTokens: 579 };
    const fixture = traeFixture(request => {
      if (request.method !== "session/prompt") return false;
      fixture.send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn", usage } });
      fixture.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: {
        sessionUpdate: "agent_message_chunk", content: { type: "image", data: "fixture" },
      } } });
      return true;
    });
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "trae_acp_protocol_error", usage });
    expect(buildResponseJSON(events, "test-model").usage)
      .toMatchObject({ input_tokens: 123, output_tokens: 456, total_tokens: 579 });
  });

  for (const trailing of [
    { name: "permission request", code: "trae_client_request_unsupported", frame: {
      jsonrpc: "2.0", id: 99, method: "session/request_permission", params: {},
    } },
    { name: "unexpected model update", code: "trae_model_changed", frame: {
      jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: {
        sessionUpdate: "current_model_update", currentModelId: "unexpected-model",
      } },
    } },
    { name: "malformed envelope", code: "trae_acp_protocol_error", frame: {
      jsonrpc: "1.0", id: 100, result: {},
    } },
  ]) {
    test("trailing " + trailing.name + " supersedes success and retains usage", async () => {
      const usage = { inputTokens: 123, outputTokens: 456, totalTokens: 579 };
      const fixture = traeFixture(request => {
        if (request.method !== "session/prompt") return false;
        fixture.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: {
          sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" },
        } } });
        fixture.send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn", usage } });
        fixture.send(trailing.frame);
        return true;
      });
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
      expect(events.at(-1)).toMatchObject({ type: "error", code: trailing.code, usage });
      expect(events.some(event => event.type === "done")).toBe(false);
      expect(buildResponseJSON(events, "test-model").usage)
        .toMatchObject({ input_tokens: 123, output_tokens: 456, total_tokens: 579 });
    });
  }

  test("trailing stdout EOF supersedes success and retains usage", async () => {
    const usage = { inputTokens: 123, outputTokens: 456, totalTokens: 579 };
    const fixture = traeFixture((request, child) => {
      if (request.method !== "session/prompt") return false;
      fixture.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" },
      } } });
      fixture.send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn", usage } });
      child.stdout!.end();
      return true;
    });
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "trae_acp_closed", usage });
    expect(events.some(event => event.type === "done")).toBe(false);
    expect(buildResponseJSON(events, "test-model").usage)
      .toMatchObject({ input_tokens: 123, output_tokens: 456, total_tokens: 579 });
  });

  test("shutdown remains bounded when the process and its pipe never close", async () => {
    const fixture = traeFixture(request => request.method === "session/prompt");
    fixture.child.kill = () => true;
    const allocated: string[] = [];
    const makeTempDir = (async () => {
      const directory = await mkdtemp(testHome.path("owned-"));
      allocated.push(directory);
      return directory;
    }) as typeof mkdtemp;
    const session = await traeClient.openTraeSession(config().baseUrl, { ...fixture.deps, makeTempDir });
    const turn = session.prompt("test-model", "hello", () => undefined).catch(error => error);
    await expect(session.close()).rejects.toThrow("shutdown was not confirmed");
    expect(await turn).toBeInstanceOf(Error);
    expect(fixture.child.stdout!.destroyed).toBe(true);
    expect(existsSync(String(fixture.options()!.cwd))).toBe(true);
    expect(allocated).toHaveLength(2);
    expect(allocated.every(directory => existsSync(directory))).toBe(true);
  });

  test("a cleanup failure preserves already-received terminal usage", async () => {
    const fixture = traeFixture();
    fixture.child.kill = () => true;
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), { ...fixture.deps, home: testHome.root, cwd: testHome.root })
      .runTurn!(traeRequest(), traeMeta(), event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "trae_shutdown_timeout", usage: { inputTokens: 10, outputTokens: 2 } });
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("cleanup timeout preserves usage from a thrown reader failure", async () => {
    const usage = { inputTokens: 123, outputTokens: 456, totalTokens: 579 };
    const fixture = traeFixture(request => {
      if (request.method !== "session/prompt") return false;
      fixture.send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn", usage } });
      fixture.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: {
        sessionUpdate: "current_model_update", currentModelId: "unexpected-model",
      } } });
      return true;
    });
    fixture.child.kill = () => true;
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), { ...fixture.deps, home: testHome.root, cwd: testHome.root })
      .runTurn!(traeRequest(), traeMeta(), event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "trae_shutdown_timeout", usage });
    expect(events.some(event => event.type === "done")).toBe(false);
    expect(buildResponseJSON(events, "test-model").usage)
      .toMatchObject({ input_tokens: 123, output_tokens: 456, total_tokens: 579 });
  });

  test("inner EOF cleanup timeout preserves received usage", async () => {
    const usage = { inputTokens: 123, outputTokens: 456, totalTokens: 579 };
    const fixture = traeFixture((request, child) => {
      if (request.method !== "session/prompt") return false;
      fixture.send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn", usage } });
      child.stdout!.end();
      return true;
    });
    fixture.child.kill = () => true;
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), { ...fixture.deps, home: testHome.root, cwd: testHome.root })
      .runTurn!(traeRequest(), traeMeta(), event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "trae_shutdown_timeout", usage });
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("dispatch-budget refusal outranks cleanup timeout", async () => {
    spyOn(traeClient, "openTraeSession").mockResolvedValue({
      models: ["test-model"],
      prompt: async (_model, _text, _emit, _signal, dispatch) => { dispatch?.beforeSend(); },
      close: async () => { throw new traeClient.TraeAcpError("fixture cleanup", "trae_shutdown_timeout"); },
    });
    const budget = fakeSendBudget({ useAllowed: false });
    await expect(createTraeCnAdapter(config()).runTurn!(traeRequest(), traeMeta({ sendBudget: budget.budget }),
      () => undefined)).rejects.toBeInstanceOf(SendBudgetExhaustedError);
  });

  for (const stopReason of ["end_turn", "max_tokens", "max_turn_requests", "fixture_unknown_stop"]) {
    test("a reasoning-only completion preserves its reason and usage: " + stopReason, async () => {
      const fixture = traeFixture(request => {
        if (request.method !== "session/prompt") return false;
        fixture.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: {
          sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" },
        } } });
        fixture.send({ jsonrpc: "2.0", id: request.id, result: { stopReason, usage: { inputTokens: 123, outputTokens: 456, totalTokens: 579 } } });
        return true;
      });
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
      const terminal = events.at(-1)!;
      expect(terminal).toMatchObject({ usage: { inputTokens: 123, outputTokens: 456, totalTokens: 579 } });
      if (stopReason === "max_tokens") {
        expect(terminal).toMatchObject({ type: "done", stopReason: "max_tokens" });
        expect(buildResponseJSON(events, "test-model")).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
      } else if (stopReason === "max_turn_requests") {
        expect(terminal).toMatchObject({ type: "incomplete", reason: "max_turn_requests", retryable: false });
        expect(buildResponseJSON(events, "test-model")).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_turn_requests" } });
      } else {
        const code = stopReason === "end_turn" ? "trae_empty_response" : "trae_acp_protocol_error";
        expect(terminal).toMatchObject({ type: "error", code, retryable: false });
        expect(events.some(event => event.type === "done")).toBe(false);
      }
    });
  }

  test("a request-limit terminal retains partial text and usage in JSON and SSE", async () => {
    const fixture = traeFixture(request => {
      if (request.method !== "session/prompt") return false;
      fixture.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial answer" },
      } } });
      fixture.send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "max_turn_requests", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
      return true;
    });
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
    const json = buildResponseJSON(events, "test-model");
    expect(json).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_turn_requests" }, usage: { input_tokens: 10, output_tokens: 2 } });
    expect(JSON.stringify(json.output)).toContain("partial answer");
    const budget = createTranslatorBudget();
    async function* source() { yield* events; }
    try {
      const wire = await new Response(bridgeToResponsesSSE(source(), "test-model", undefined, undefined, undefined, undefined, 2000, { translatorBudget: budget })).text();
      const frames = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      expect(frames.find(frame => frame.type === "response.incomplete")?.response)
        .toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_turn_requests" }, usage: { input_tokens: 10, output_tokens: 2 } });
      expect(frames.filter(frame => frame.type === "response.output_text.delta").map(frame => frame.delta).join(""))
        .toBe("partial answer");
    } finally { budget.dispose(); }
  });

  for (const consumer of ["adapter", "probe"]) {
    test("stderr overflow suppresses a split authorization value in " + consumer, async () => {
      const fixture = traeFixture((request, child) => {
        if (request.method !== "initialize") return false;
        const prefix = "Authorization: Bearer ";
        (child.stderr as PassThrough).write("x".repeat(8192 - prefix.length) + prefix);
        (child.stderr as PassThrough).write("opaque-fixture-credential\n");
        (child.stdout as PassThrough).end();
        return true;
      });
      let serialized: string;
      if (consumer === "adapter") {
        const events: AdapterEvent[] = [];
        await createTraeCnAdapter(config(), fixture.deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
        serialized = JSON.stringify(events);
      } else serialized = JSON.stringify(await (await probeTraeCnProvider("trae-cn", config(), async () => { throw new Error("must not converge"); }, undefined, fixture.deps)).json());
      expect(serialized).toContain("contents were suppressed");
      expect(serialized).not.toContain("opaque-fixture-credential");
    });
  }

  for (const removed of [true, false]) {
    test.skipIf(process.platform === "win32")("POSIX lookup-to-launch failure hides paths: removed=" + removed, async () => {
      const binary = testHome.path("private cli");
      writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const deps: traeClient.TraeAcpDeps = { home: testHome.root, cwd: testHome.root, killGraceMs: 20,
        resolveBinary: () => { if (removed) unlinkSync(binary); else chmodSync(binary, 0o600); return binary; } };
      const events: AdapterEvent[] = [];
      await createTraeCnAdapter(config(), deps).runTurn!(traeRequest(), traeMeta(), event => events.push(event));
      expect(events).toMatchObject([{ type: "error", status: 500, code: "trae_startup_spawn_" + (removed ? "enoent" : "eacces") }]);
      expect(JSON.stringify(events)).not.toContain(binary);
    });
  }

  test("POSIX shutdown uses the owned pipe without signalling a possibly reused PID", async () => {
    const fixture = traeFixture();
    Object.assign(fixture.child, { pid: 424242 });
    const signalGroup = spyOn(process, "kill").mockImplementation(() => { throw new Error("must not signal PID"); });
    const session = await traeClient.openTraeSession(config().baseUrl, { ...fixture.deps, platform: "linux" });
    await session.close();
    expect(signalGroup).not.toHaveBeenCalled();
    expect(traeStopPipe(fixture.child)!.destroyed).toBe(true);
  });

  (process.platform === "win32" ? test.skip : test)("the live supervisor terminates a TERM-ignoring descendant after the CLI exits", async () => {
    const heartbeat = testHome.path("descendant-heartbeat");
    const worker = "const fs=require('node:fs');process.on('SIGTERM',()=>{});const beat=()=>fs.writeFileSync(" + JSON.stringify(heartbeat) + ",String(Date.now()));beat();setInterval(beat,10);setTimeout(()=>process.exit(0),5000);";
    const cli = "const p=require('node:child_process').spawn(process.execPath,['-e'," + JSON.stringify(worker) + "],{stdio:'ignore'});p.unref();process.stdout.write(String(p.pid));";
    const invocation = traePosixInvocation(process.execPath, ["-e", cli], 20);
    const child = nodeSpawn(invocation.file, invocation.args, { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
    const closed = once(child, "close");
    const watchdog = setTimeout(() => { traeStopPipe(child)?.end("stop\n"); }, 2000);
    try {
      let output = "";
      for await (const chunk of child.stdout!) output += String(chunk);
      expect(Number(output)).toBeGreaterThan(0);
      expect(child.exitCode).toBeNull();
      const until = Date.now() + 1000;
      while (!existsSync(heartbeat) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
      const before = readFileSync(heartbeat, "utf8");
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(readFileSync(heartbeat, "utf8")).not.toBe(before);
      traeStopPipe(child)!.end("stop\n");
      await closed;
      const after = readFileSync(heartbeat, "utf8");
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(readFileSync(heartbeat, "utf8")).toBe(after);
    } finally {
      clearTimeout(watchdog);
      traeStopPipe(child)?.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  }, 5000);

  test("a long pending prompt does not retain completion reactions for consumed chunks", async () => {
    let ready!: () => void;
    const drained = new Promise<void>(resolve => { ready = resolve; });
    let finish!: () => void;
    const release = new Promise<void>(resolve => { finish = resolve; });
    let before = 0;
    const fixture = traeFixture(request => {
      if (request.method !== "session/prompt") return false;
      Bun.gc(true);
      before = process.memoryUsage().heapUsed;
      void (async () => {
        for (let i = 0; i < 100_000; i++) {
          fixture.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } } });
          if (i % 128 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        await release;
        fixture.send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
      })();
      return true;
    });
    let chunks = 0;
    const turn = createTraeCnAdapter(config(), { ...fixture.deps, timeoutMs: 12_000 }).runTurn!(traeRequest(), traeMeta(), event => {
      if (event.type === "text_delta" && ++chunks === 100_000) ready();
    });
    let growth = 0;
    try {
      await Promise.race([drained, turn.then(() => { if (chunks !== 100_000) throw new Error("stream ended before the fixture drained"); })]);
      Bun.gc(true);
      growth = process.memoryUsage().heapUsed - before;
    } finally { finish(); await turn; }
    expect(chunks).toBe(100_000);
    expect(growth).toBeLessThan(16 * 1024 * 1024);
  }, 15000);

  for (const proof of [true, false]) {
    test("Windows cleanup requires Job accounting proof: " + proof, async () => {
      const fixture = traeFixture();
      fixture.child.once("trae-stop-request", () => {
        if (proof) (fixture.child.stderr as PassThrough).write("OCX_TRAE_JOB_STOPPED\n");
        fixture.child.kill();
      });
      const session = await traeClient.openTraeSession(config().baseUrl, { ...fixture.deps, platform: "win32", home: testHome.root, cwd: testHome.root });
      if (proof) await session.close();
      else await expect(session.close()).rejects.toThrow("shutdown was not confirmed");
      expect(fixture.options()?.windowsVerbatimArguments).toBeUndefined();
    });
  }

  test("Windows CLI diagnostics cannot forge supervisor proof, even with split frames", () => {
    let text = "";
    const frames = new TraeWindowsJobFrames(chunk => { text += chunk; }, () => { throw new Error("unexpected status"); });
    const encoded = "OCX_TRAE_STDERR:" + Buffer.from("OCX_TRAE_JOB_STOPPED\n中文").toString("base64") + "\n";
    for (const byte of Buffer.from(encoded)) frames.push(Uint8Array.of(byte));
    expect(text).toBe("OCX_TRAE_JOB_STOPPED\n中文");
    expect(frames.processTreeExited).toBe(false);
    frames.push(Buffer.from("OCX_TRAE_JOB_STOPPED\n"));
    frames.finish();
    expect(frames.processTreeExited).toBe(true);
    const invalid = new TraeWindowsJobFrames(() => {}, () => {});
    invalid.push(Buffer.from("x".repeat(5000) + "\nOCX_TRAE_JOB_STOPPED\n"));
    expect(invalid.processTreeExited).toBe(false);
  });

  test("Windows cleanup stays bounded without a responding supervisor or status pipe", async () => {
    const fixture = traeFixture();
    const kill = spyOn(fixture.child, "kill").mockReturnValue(false);
    const session = await traeClient.openTraeSession(config().baseUrl, {
      ...fixture.deps, platform: "win32", home: testHome.root, cwd: testHome.root,
    });
    const started = performance.now();
    await expect(session.close()).rejects.toThrow("shutdown was not confirmed");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(fixture.child.stdout!.destroyed).toBe(true);
    expect(fixture.child.stderr!.destroyed).toBe(true);
  });

  test("a Windows stdout forwarding failure reports transport failure and closes the Job", async () => {
    const fixture = traeFixture((request, child) => {
      if (request.method !== "session/prompt") return false;
      (child.stderr as PassThrough).write("OCX_TRAE_ERROR:transport:0\n");
      return true;
    });
    fixture.child.once("trae-stop-request", () => {
      (fixture.child.stderr as PassThrough).write("OCX_TRAE_JOB_STOPPED\n");
      fixture.child.kill();
    });
    const events: AdapterEvent[] = [];
    await createTraeCnAdapter(config(), { ...fixture.deps, platform: "win32", home: testHome.root, cwd: testHome.root })
      .runTurn!(traeRequest(), traeMeta(), event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "trae_acp_transport", status: 502,
      message: "TRAE CN Windows supervisor failed during transport (Win32 0)." });
    expect(fixture.child.killed).toBe(true);
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("Windows launcher preserves cmd escaping and owns only its staging directory", async () => {
    const env = { COMSPEC: "D:\\Windows\\System32\\cmd.exe", SYSTEMROOT: "D:\\Windows" };
    const invocation = commandInvocation("C:\\Users\\test\\trae cli.cmd", ["a&b", "with space"], "win32", { env });
    expect(invocation.file).toBe("cmd.exe");
    expect(traeWindowsJobExecutable(invocation.file, env)).toBe(env.COMSPEC);
    expect(traeWindowsJobExecutable("cmd.exe", { SYSTEMROOT: "D:\\Windows" })).toBe("D:\\Windows\\System32\\cmd.exe");
    expect(() => traeWindowsJobExecutable("unknown.exe", env)).toThrow("absolute executable path");
    expect(traeWindowsCommandLine(invocation)).toEndWith(invocation.args.join(" "));
    const job = await prepareTraeWindowsJob(invocation, testHome.root, testHome.root, 2000, env);
    try {
      expect(job.options.windowsVerbatimArguments).toBeUndefined();
      expect(job.file).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      const loader = Buffer.from(job.args.at(-1)!, "base64").toString("utf16le");
      expect(loader).not.toContain("ExecutionPolicy");
      expect(loader).toContain("Add-Type");
      expect(loader).toContain(env.COMSPEC);
      expect(loader.length).toBeLessThan(10000);
    } finally { await job.cleanup(); }
    expect(existsSync(testHome.root)).toBe(true);
  });

  for (const stop of ["exit", "marker", "eof"]) for (const inheritedPipes of [true, false]) {
    test.skipIf(process.platform !== "win32")("Windows Job cleanup: stop=" + stop + ", inherited pipes=" + inheritedPipes, async () => {
      const heartbeat = testHome.path("heartbeat");
      const dispatcher = testHome.path("dispatcher ready");
      const argv = testHome.path("argv.json");
      const script = testHome.path("cli fixture.mjs");
      const shim = testHome.path("cli fixture.cmd");
      const helper = "const fs=require('node:fs');setInterval(()=>fs.writeFileSync(" + JSON.stringify(heartbeat) + ",String(Date.now())),10);";
      writeFileSync(script, [
        "import {spawn} from 'node:child_process';import fs from 'node:fs';",
        "fs.writeFileSync(" + JSON.stringify(argv) + ",JSON.stringify(process.argv.slice(2)));",
        "spawn(process.execPath,['-e'," + JSON.stringify(helper) + "],{stdio:" + JSON.stringify(inheritedPipes ? ["ignore", "inherit", "inherit"] : "ignore") + "}).unref();",
        "while(!fs.existsSync(" + JSON.stringify(heartbeat) + ")) await new Promise(r=>setTimeout(r,10));",
        "fs.writeFileSync(" + JSON.stringify(dispatcher) + ",'ready');" + (stop === "exit" ? "process.exit(0);" : "setInterval(()=>{},1000);"),
      ].join("\n"));
      writeFileSync(shim, '@"' + process.execPath + '" "' + script + '" %*\r\n');
      const env = traeCnChildEnv(process.env, "win32");
      const args = ["acp", "serve", "a&b", "with space"];
      const invocation = commandInvocation(shim, args, "win32", { env });
      const job = await prepareTraeWindowsJob(invocation, testHome.root, testHome.root, 2000, env);
      const child = nodeSpawn(job.file, job.args, { ...job.options, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const closed = once(child, "close");
      let diagnostic = "";
      const failures: string[] = [];
      const frames = new TraeWindowsJobFrames(text => { diagnostic += text; }, (stage, code) => { failures.push(stage + ":" + code); });
      child.stdout!.resume();
      child.stderr!.on("data", chunk => frames.push(chunk));
      child.stdin!.on("error", () => {});
      child.stdin!.write("{}\n");
      const watchdog = setTimeout(() => { child.kill("SIGKILL"); }, 15_000);
      try {
        if (stop !== "exit") {
          const readyDeadline = Date.now() + 10_000;
          while (!existsSync(dispatcher) && child.exitCode === null && Date.now() < readyDeadline) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(existsSync(dispatcher)).toBe(true);
          expect(child.exitCode).toBeNull();
          const started = performance.now();
          // Keep stdin open for the marker case so EOF cannot hide a broken marker reader.
          if (stop === "marker") child.stdin!.write("__OCX_STOP_TRAE__\n");
          else child.stdin!.end();
          await closed;
          expect(performance.now() - started).toBeLessThan(5000);
        }
        await closed;
        frames.finish();
        expect(failures).toEqual([]);
        expect(diagnostic).toBe("");
        expect(frames.processTreeExited).toBe(true);
        expect(existsSync(dispatcher)).toBe(true);
        expect(JSON.parse(readFileSync(argv, "utf8"))).toEqual(args);
        const after = readFileSync(heartbeat, "utf8");
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(readFileSync(heartbeat, "utf8")).toBe(after);
      } finally {
        clearTimeout(watchdog);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        child.stdin?.destroy();
        await closed.catch(() => undefined);
        await job.cleanup();
      }
    }, 20_000);
  }

  test("workspace allocation failure removes only an owned temporary HOME", async () => {
    let owned = "";
    let calls = 0;
    const makeTempDir = (async (prefix: string) => {
      if (calls++) throw new Error("workspace unavailable");
      owned = await mkdtemp(prefix);
      return owned;
    }) as typeof mkdtemp;
    await expect(traeClient.openTraeSession(config().baseUrl, { resolveBinary: () => "/fixture/traecli", makeTempDir })).rejects.toThrow("startup failed during workspace");
    expect(existsSync(owned)).toBe(false);
    await expect(traeClient.openTraeSession(config().baseUrl, { home: testHome.root, resolveBinary: () => "/fixture/traecli",
      makeTempDir: (async () => { throw new Error("workspace unavailable"); }) as typeof mkdtemp,
    })).rejects.toThrow("startup failed during workspace");
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
      .toBe(posix.resolve("./selected-trae"));
  });

  for (const platform of ["linux", "win32"] as const) {
    test("a relative user-local CLI fallback resolves before changing cwd: " + platform, () => {
      const pathApi = platform === "win32" ? win32 : posix;
      const expected = pathApi.resolve("relative-user", ".local", "bin", platform === "win32" ? "traecli.exe" : "traecli");
      const result = resolveTraeCli({ platform, env: { PATH: "", HOME: "relative-user", USERPROFILE: "relative-user" }, exists: path => path === expected });
      expect(result).toBe(expected);
      expect(traeCnChildEnv({ HOME: "relative-user", USERPROFILE: "relative-user" }, platform).TRAE_HOME)
        .toBe(pathApi.resolve("relative-user", ".trae"));
      if (platform === "win32") expect(traeWindowsJobExecutable(result!, {})).toBe(expected);
    });
  }

  for (const binaries of [["traecli.cmd"], ["traecli.bat"], ["traecli.exe", "traecli.cmd"]]) {
    test("Windows home fallback keeps native/launcher priority: " + binaries.join(","), () => {
      const root = "C:\\Users\\fixture";
      const available = binaries.map(name => win32.join(root, ".local", "bin", name));
      const found = resolveTraeCli({ platform: "win32", env: { USERPROFILE: root, PATH: "" }, exists: path => available.includes(path) });
      expect(found).toBe(available[0]);
    });
  }

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

  for (const enabled of [false, true]) {
    test("the final custom catalog row applies the wire ceiling before sidecar publication: " + enabled, async () => {
      const models = await gatherRoutedModels({ port: 10100, defaultProvider: "trae-cn",
        providers: { "trae-cn": { ...config(), liveModels: false } }, visionSidecar: { enabled },
        customModels: [{ provider: "trae-cn", modelId: "test-model", inputModalities: ["text", "image"] }],
        combos: { selected: { targets: [{ provider: "trae-cn", model: "test-model" }] } },
      });
      expect(models.find(model => model.provider === "trae-cn" && model.id === "test-model"))
        .toMatchObject({ inputModalities: enabled ? ["text", "image"] : ["text"], supportsVerbosity: false });
      expect(buildCatalogEntries(null, [], models).find(model => model.slug === "combo/selected")?.input_modalities)
        .toEqual(enabled ? ["text", "image"] : ["text"]);
    });
  }

  test("management admission stays cache-only while an independent source refresh prepares the next roster", async () => {
    const fixture = traeFixture();
    const realOpen = traeClient.openTraeSession;
    const open = spyOn(traeClient, "openTraeSession").mockImplementation((baseUrl, _deps, signal) => realOpen(baseUrl, fixture.deps, signal));
    const admittedRosters: unknown[] = [];
    const admission = spyOn(catalogAdmission, "captureCatalogAdmissionSnapshot").mockImplementation(() => {
      admittedRosters.push(getFreshCached("trae-cn", 60_000, Date.now())?.map(model => model.id) ?? null);
      throw new Error("fixture stops before any catalog write");
    });
    const next = { port: 10100, defaultProvider: "trae-cn", providers: { "trae-cn": { ...config(), models: [] } } };
    const converge = managementConvergence.createManagementConvergeCodex(next);
    await converge(catalogAdmission.createCatalogConvergeRequest({ deadlineMs: 1000 }));
    expect(open).not.toHaveBeenCalled();
    expect(admittedRosters).toEqual([null]);
    await refreshTraeCnCatalogSources(next);
    await converge(catalogAdmission.createCatalogConvergeRequest({ deadlineMs: 1000 }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(admission).toHaveBeenCalledTimes(2);
    expect(admittedRosters).toEqual([null, ["test-model"]]);
  });

  test("background discovery retains authoritative roster evidence through TTL-zero convergence", async () => {
    const fixture = traeFixture();
    const open = spyOn(traeClient, "openTraeSession").mockResolvedValue({ models: ["fresh-roster"],
      prompt: async () => undefined, close: async () => undefined });
    const row = { ...config(), models: [] };
    const next: OcxConfig = { port: 10100, defaultProvider: "trae-cn", modelCacheTtlMs: 0, providers: { "trae-cn": row } };
    let pinned = false;
    await refreshTraeCnCatalogSources(next, () => true, async () => {
      pinned = getPinnedCached("trae-cn")?.some(model => model.id === "fresh-roster") === true;
      const resolver = observedModelsAuthResolver(null, []);
      const gathered = await fetchProviderModelsWithAuth(captureProviderGather("trae-cn", row, resolver), 0, undefined, resolver);
      expect(gathered.outcome.state).toBe("authoritative");
      expect(gathered.models.some(model => model.id === "fresh-roster")).toBe(true);
    });
    expect(pinned).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(getPinnedCached("trae-cn")).toBeNull();
  });

  test("background publication pins the authoritative roster after ordinary cache eviction", async () => {
    await withProbeMemory(false, async evictions => {
      const open = pressureSession();
      const row = { ...config(), models: ["configured-fallback"] };
      const next: OcxConfig = { port: 10100, defaultProvider: "trae-cn", providers: { "trae-cn": row } };
      let published = false;
      await refreshTraeCnCatalogSources(next, () => true, async () => {
        published = getPinnedCached("trae-cn")?.some(model => model.id === "new-probed-model") === true;
      });
      expect(published).toBe(true);
      expect(open).toHaveBeenCalledTimes(1);
      expect(evictions()).toBe(1);
      expect(modelCacheRetainedStoreSnapshot().pinnedBytes).toBe(0);
    });
  });

  test("background publication retains multiple rosters under ordinary cache pressure", async () => {
    await withProbeMemory(false, async evictions => {
      let calls = 0;
      const open = spyOn(traeClient, "openTraeSession").mockImplementation(async () => ({
        models: [++calls === 1 ? "first-model" : "second-model"],
        prompt: async () => undefined, close: async () => undefined,
      }));
      const next: OcxConfig = { port: 10100, defaultProvider: "trae-a",
        providers: { "trae-a": { ...config(), models: [] }, "trae-b": { ...config(), models: [] } } };
      let rosters: string[][] = [];
      await refreshTraeCnCatalogSources(next, () => true, async () => {
        rosters = [getPinnedCached("trae-a")!.map(model => model.id), getPinnedCached("trae-b")!.map(model => model.id)];
      });
      expect(rosters).toEqual([["first-model"], ["second-model"]]);
      expect(open).toHaveBeenCalledTimes(2);
      expect(evictions()).toBe(1);
      expect(modelCacheRetainedStoreSnapshot().pinnedBytes).toBe(0);
    });
  });

  test("background source exceptions release an earlier roster pin", async () => {
    const open = pressureSession();
    const next: OcxConfig = { port: 10100, defaultProvider: "trae-a",
      providers: { "trae-a": { ...config(), models: [] }, "trae-b": { ...config(), models: [] } } };
    let checks = 0;
    await expect(refreshTraeCnCatalogSources(next, () => {
      if (++checks === 3) throw new Error("fixture current failure");
      return true;
    }, async () => undefined)).rejects.toThrow("fixture current failure");
    expect(open).toHaveBeenCalledTimes(1);
    expect(getPinnedCached("trae-a")).toBeNull();
    expect(getPinnedCached("trae-b")).toBeNull();
    expect(modelCacheRetainedStoreSnapshot().pinnedBytes).toBe(0);
  });

  test("background publication cannot pin a roster replaced after gather", async () => {
    const open = spyOn(traeClient, "openTraeSession").mockResolvedValue({ models: ["old-model"],
      prompt: async () => undefined, close: async () => undefined });
    const row = { ...config(), models: [] };
    const next: OcxConfig = { port: 10100, defaultProvider: "trae-cn", providers: { "trae-cn": row } };
    let checks = 0;
    let published = false;
    await refreshTraeCnCatalogSources(next, () => {
      if (++checks === 2) {
        setCached("trae-cn", [{ id: "new-model", provider: "trae-cn" }], Date.now(),
          captureModelCacheGeneration("trae-cn"));
      }
      return true;
    }, async () => { published = true; });
    const resolver = observedModelsAuthResolver(null, []);
    const observed = await fetchProviderModelsWithAuth(captureProviderGather("trae-cn", row, resolver),
      0, undefined, resolver);
    expect(published).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    expect(observed.models.map(model => model.id)).toContain("new-model");
    expect(observed.models.map(model => model.id)).not.toContain("old-model");
    expect(getPinnedCached("trae-cn")).toBeNull();
  });

  test("concurrent refreshing discovery publishes in serialized session order", async () => {
    const row = { ...config(), models: [] };
    let calls = 0;
    let entered!: () => void;
    const firstCloseStarted = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const releaseFirstClose = new Promise<void>(resolve => { release = resolve; });
    const session = (models: string[], close: () => Promise<void>) => ({
      models, prompt: async () => undefined, close,
    });
    const open = spyOn(traeClient, "openTraeSession").mockImplementation(async () => {
      calls++;
      return calls === 1
        ? session(["old-model"], async () => { entered(); await releaseFirstClose; })
        : session(["new-model"], async () => undefined);
    });
    const first = fetchProviderModelsWithAuth(
      captureProviderGather("trae-cn", row, refreshingModelsAuthResolver), 0, undefined, refreshingModelsAuthResolver,
    );
    await firstCloseStarted;
    const second = fetchProviderModelsWithAuth(
      captureProviderGather("trae-cn", row, refreshingModelsAuthResolver), 0, undefined, refreshingModelsAuthResolver,
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(open).toHaveBeenCalledTimes(1);
    release();
    const [older, newer] = await Promise.all([first, second]);
    expect(older.models.map(model => model.id)).toContain("old-model");
    expect(newer.models.map(model => model.id)).toContain("new-model");
    expect(open).toHaveBeenCalledTimes(2);
    const resolver = observedModelsAuthResolver(null, []);
    const observed = await fetchProviderModelsWithAuth(captureProviderGather("trae-cn", row, resolver),
      0, undefined, resolver);
    expect(observed.models.map(model => model.id)).toContain("new-model");
    expect(observed.models.map(model => model.id)).not.toContain("old-model");
  });

  test("queued discovery cannot borrow a replacement cache generation", async () => {
    const row = { ...config(), models: [] };
    let entered!: () => void;
    const firstCloseStarted = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const releaseFirstClose = new Promise<void>(resolve => { release = resolve; });
    const open = spyOn(traeClient, "openTraeSession").mockResolvedValue({ models: ["old-model"],
      prompt: async () => undefined, close: async () => { entered(); await releaseFirstClose; } });
    const first = fetchProviderModelsWithAuth(
      captureProviderGather("trae-cn", row, refreshingModelsAuthResolver), 0, undefined, refreshingModelsAuthResolver,
    );
    await firstCloseStarted;
    const second = fetchProviderModelsWithAuth(
      captureProviderGather("trae-cn", row, refreshingModelsAuthResolver), 0, undefined, refreshingModelsAuthResolver,
    );
    clearModelCache("trae-cn");
    release();
    const [older, queued] = await Promise.all([first, second]);
    expect(older.outcome.state).toBe("degraded");
    expect(queued.outcome.state).toBe("degraded");
    expect(open).toHaveBeenCalledTimes(1);
    expect(getPinnedCached("trae-cn")).toBeNull();
  });

  test("background publication cannot replace an intervening newer roster", async () => {
    const rowA = { ...config(), models: [] };
    const rowB = { ...config(), models: [] };
    let calls = 0;
    const session = (models: string[]) => ({ models, prompt: async () => undefined, close: async () => undefined });
    const open = spyOn(traeClient, "openTraeSession").mockImplementation(async () => {
      calls++;
      if (calls === 1) return session(["old-model"]);
      if (calls === 2) {
        clearModelCache("trae-a");
        const newer = await fetchProviderModelsWithAuth(
          captureProviderGather("trae-a", rowA, refreshingModelsAuthResolver), 0, undefined, refreshingModelsAuthResolver,
        );
        expect(newer.outcome.state).toBe("authoritative");
        return session(["second-provider-model"]);
      }
      return session(["new-model"]);
    });
    const next: OcxConfig = { port: 10100, defaultProvider: "trae-a", modelCacheTtlMs: 0,
      providers: { "trae-a": rowA, "trae-b": rowB } };
    let published = false;
    await refreshTraeCnCatalogSources(next, () => true, async () => { published = true; });
    const observed = await fetchProviderModelsWithAuth(
      captureProviderGather("trae-a", rowA, observedModelsAuthResolver(null, [])), 0, undefined,
      observedModelsAuthResolver(null, []),
    );
    expect(published).toBe(false);
    expect(open).toHaveBeenCalledTimes(3);
    expect(observed.models.map(model => model.id)).toContain("new-model");
    expect(observed.models.map(model => model.id)).not.toContain("old-model");
    expect(getPinnedCached("trae-a")).toBeNull();
    expect(getPinnedCached("trae-b")).toBeNull();
  });

  for (const stopped of [false, true]) {
    test("background CLI refresh does not hold management admission; stopped=" + stopped, async () => {
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      let release!: (session: traeClient.TraeSession) => void;
      const open = spyOn(traeClient, "openTraeSession").mockImplementation(() => {
        entered(); return new Promise(resolve => { release = resolve; });
      });
      const next: OcxConfig = { port: 10100, defaultProvider: "trae-cn", providers: { "trae-cn": config() },
        clientIntegrations: { codex: false }, catalogAutoRefresh: { enabled: true } };
      spyOn(configApi, "loadConfig").mockReturnValue(next);
      const rosters: unknown[] = [];
      const admission = spyOn(catalogAdmission, "captureCatalogAdmissionSnapshot").mockImplementation(() => {
        rosters.push(getFreshCached("trae-cn", 60_000, Date.now())?.map(model => model.id) ?? null);
        throw new Error("fixture stops before any catalog write");
      });
      const session = { models: ["background-model"], prompt: async () => undefined, close: async () => undefined };
      catalogScheduler.resetCatalogAutoRefreshForTests();
      const tick = catalogScheduler.runCatalogAutoRefreshTickForTests();
      try {
        await started;
        await managementConvergence.createManagementConvergeCodex(next)(catalogAdmission.createCatalogConvergeRequest({ deadlineMs: 1000 }));
        expect(open).toHaveBeenCalledTimes(1);
        expect(admission).toHaveBeenCalledTimes(1); expect(rosters).toEqual([null]);
        if (stopped) catalogScheduler.stopCatalogAutoRefresh();
        release(session); await tick;
        expect(rosters).toEqual(stopped ? [null] : [null, ["background-model"]]);
      } finally { release?.(session); await tick; catalogScheduler.resetCatalogAutoRefreshForTests(); }
    });
  }

  for (const failed of [false, true]) {
    test("discovery losing its generation returns the replacement roster on " + (failed ? "failure" : "success"), async () => {
      let opened!: () => void;
      const entered = new Promise<void>(resolve => { opened = resolve; });
      let resolve!: (session: traeClient.TraeSession) => void;
      let reject!: (error: Error) => void;
      spyOn(traeClient, "openTraeSession").mockImplementation(() => { opened(); return new Promise((yes, no) => { resolve = yes; reject = no; }); });
      setCached("trae-cn", [{ id: "old-account-model", provider: "trae-cn" }], 1, captureModelCacheGeneration("trae-cn"));
      const captured = captureProviderGather("trae-cn", config(), refreshingModelsAuthResolver);
      const pending = fetchProviderModelsWithAuth(captured, 60_000, undefined, refreshingModelsAuthResolver);
      await entered;
      clearModelCache("trae-cn");
      setCached("trae-cn", [{ id: "new-account-model", provider: "trae-cn" }], Date.now(), captureModelCacheGeneration("trae-cn"));
      if (failed) reject(new Error("old discovery failed"));
      else resolve({ models: ["old-account-model"], prompt: async () => undefined, close: async () => undefined });
      const result = await pending;
      expect(result.models.map(model => model.id)).toContain("new-account-model");
      expect(result.models.map(model => model.id)).not.toContain("old-account-model");
      expect(result.contentRevision).toBe(observeModelCacheRevision("trae-cn"));
    });
  }

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
    const body = await (await probe).json();
    expect(body).toMatchObject({ ok: true, rosterReplaced: false, catalogRefresh: { status: "skipped", reason: "stale" } });
    expect(body.message).toContain("Run Test connection again");
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
