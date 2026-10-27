import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import { buildCatalogEntries, gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { pendingBackgroundWork, settleBackgroundWork, trackBackgroundWork } from "../../src/lib/background-work";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import * as outbound from "../../src/lib/provider-outbound";
import { routeModel } from "../../src/router";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { resetVisionDescriptionCache } from "../../src/vision";
import { requiresVisionPreprocessing } from "../../src/vision/plan";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { stubbedProviderFetch, withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import * as removal from "../helpers/remove-tree";

const GLM = "zai-glm-5-3";
const NATIVE = "mistral-large-4-0";
const IMAGE = "data:image/png;base64,aGVsbG8taW1hZ2UtYnl0ZXM=";
const CAPTION = "A red square with a white circle.";
let forbiddenProviderCalls = 0;
const nativeFetch = globalThis.fetch;
const originalFetch = ((input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1") return nativeFetch(input, init);
  forbiddenProviderCalls++;
  throw new Error("Network forbidden outside an active Mistral vision fixture");
}) as typeof fetch;
const realOutboundGet = outbound.providerOutboundGet;
const realOutboundPost = outbound.providerOutboundPost;
let outboundGet: ReturnType<typeof spyOn<typeof outbound, "providerOutboundGet">>;
let outboundPost: ReturnType<typeof spyOn<typeof outbound, "providerOutboundPost">>;
let previousHome: string | undefined;
let home = "";
let codexHome: IsolatedCodexHome;
let sidecarCalls: Array<Record<string, unknown>>;
let mainCalls: Array<Record<string, unknown>>;
let proxy: ReturnType<typeof startServer> | undefined;
let stopServer: () => Promise<void> | undefined;
let requestFlight: Promise<{ status: number; body: string }> | undefined;
let requestPending = false;
const ownedCleanup = new Set<Promise<unknown>>();
let cleanupFlight: Promise<void> | undefined;
let sidecarWait: Promise<void> | undefined;
let sidecarEntered: (() => void) | undefined;
let isolationActive = false;
let cleanupPending = false;
let cleanupRetryUsed = false;
let cleanupFailures: unknown[] = [];

function assertFixtureReleased(): void {
  if (isolationActive || requestPending || ownedCleanup.size) throw new Error("Previous fixture is undrained; refusing to replace its isolation");
}

beforeAll(() => {
  globalThis.fetch = originalFetch;
  // File reload drops function-valued provider.fetch. Keep discovery on its real
  // transport path with an injected executor, including late startup work.
  outboundGet = spyOn(outbound, "providerOutboundGet").mockImplementation((name, provider, url, init, deps) =>
    realOutboundGet(name, { ...provider, fetch: stubbedProviderFetch }, url, init, deps));
  outboundPost = spyOn(outbound, "providerOutboundPost").mockImplementation((name, provider, url, init, deps) =>
    realOutboundPost(name, { ...provider, fetch: stubbedProviderFetch }, url, init, deps));
});

afterAll(async () => {
  assertFixtureReleased();
  if (!(await settleBackgroundWork({ timeoutMs: 15_000 })).settled) throw new Error("Suite still owns background work; mocks retained");
  expect(forbiddenProviderCalls).toBe(0);
  outboundGet.mockRestore();
  outboundPost.mockRestore();
  globalThis.fetch = nativeFetch;
});

beforeEach(() => {
  assertFixtureReleased();
  isolationActive = true;
  cleanupPending = cleanupRetryUsed = false;
  cleanupFailures = [];
  previousHome = process.env.OPENCODEX_HOME;
  codexHome = installIsolatedCodexHome("ocx-mistral-vision-codex-");
  home = mkdtempSync(join(tmpdir(), "ocx-mistral-vision-"));
  process.env.OPENCODEX_HOME = home;
  clearModelCache();
  resetVisionDescriptionCache();
  sidecarCalls = [];
  mainCalls = [];
  proxy = undefined;
  stopServer = () => proxy?.stop(false);
  requestFlight = cleanupFlight = undefined;
  requestPending = false;
  sidecarWait = undefined;
  sidecarEntered = undefined;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://api.mistral.ai") {
      if (url.pathname === "/v1/models") return Response.json({ data: [
        { id: GLM, capabilities: { vision: false }, max_context_length: 1_048_576 },
        { id: NATIVE, capabilities: { vision: true }, max_context_length: 1_048_576 },
      ] });
      if (url.pathname === "/v1/chat/completions") {
        mainCalls.push(JSON.parse(String(init?.body)));
        return Response.json({
          id: "chatcmpl-mistral-vision", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "A red square." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        });
      }
    }
    if (url.origin === "https://chatgpt.com" && url.pathname === "/backend-api/codex/responses") {
      sidecarCalls.push(JSON.parse(String(init?.body)));
      sidecarEntered?.();
      await sidecarWait;
      return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: CAPTION })}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.hostname === "127.0.0.1") return originalFetch(input, init);
    throw new Error("Unexpected network destination in Mistral vision fixture");
  }) as typeof fetch;
});

function finishFixture(drainTimeoutMs = 15_000, cleanupTimeoutMs = 10_000): Promise<void> {
  return cleanupFlight ??= (async () => {
    cleanupPending = true;
    try {
      // Background settlement alone does not own HTTP requests. Close ingress gracefully
      // and await the complete response body before any fetch mock or home is restored.
      try { await awaitOwnedCleanup(Promise.resolve().then(stopServer), "server shutdown", cleanupTimeoutMs); }
      catch (error) {
        cleanupFailures.push(error);
        if (ownedCleanup.size) throw new AggregateError(cleanupFailures, "Fixture shutdown is pending; mocks retained");
        // A shutdown hook can fail after closing ingress. Retry gracefully: forcing
        // a socket closed could reject the client while its handler still uses fetch.
        try { await awaitOwnedCleanup(Promise.resolve().then(stopServer), "server shutdown retry", cleanupTimeoutMs); }
        catch (retryError) {
          cleanupFailures.push(retryError);
          throw new AggregateError(cleanupFailures, "Fixture ingress did not confirm shutdown; mocks retained");
        }
      }
      try {
        if (requestFlight) await awaitOwnedCleanup(requestFlight.catch(() => undefined), "response drain", cleanupTimeoutMs);
      } catch (error) {
        cleanupFailures.push(error);
        throw new AggregateError(cleanupFailures, "Fixture response is pending; mocks retained");
      }
      // A drain timeout is not a deletion failure: producers still own fetch and both homes.
      try {
        const drained = await settleBackgroundWork({ timeoutMs: drainTimeoutMs });
        if (!drained.settled) throw new Error(`Fixture background drain timed out: ${drained.pending.join(", ")}`);
        await awaitOwnedCleanup(flushWindowsSecretAclReapsBeforeRemoval(home), "ACL reap", cleanupTimeoutMs);
        if (pendingBackgroundWork().length) throw new Error("Fixture background work restarted during reap");
      } catch (error) {
        cleanupFailures.push(error);
        throw new AggregateError(cleanupFailures, "Fixture background work is undrained; mocks retained");
      }
      // No asynchronous producer can start between the final check and guarded removal.
      try { removeTreeWithRetry(home); }
      catch (error) { cleanupFailures.push(error); }
      finally {
        clearModelCache();
        resetVisionDescriptionCache();
        if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
        else process.env.OPENCODEX_HOME = previousHome;
        try { codexHome.restore(); }
        finally { globalThis.fetch = originalFetch; isolationActive = false; }
      }
      if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "Fixture cleanup failed", { cause: cleanupFailures[0] });
    } finally { cleanupPending = false; }
  })();
}

/** One explicit recovery after the owner releases retained work; preserve the initial failure. */
function retryFixtureCleanup(): Promise<void> {
  if (!isolationActive || cleanupPending || cleanupRetryUsed || requestPending || ownedCleanup.size || pendingBackgroundWork().length) throw new Error("Fixture cleanup recovery is unavailable");
  cleanupRetryUsed = true;
  cleanupFlight = undefined;
  return finishFixture();
}

afterEach(() => finishFixture(), 60_000);

function ownFixtureRequest(work: Promise<{ status: number; body: string }>) {
  requestPending = true;
  return requestFlight = work.finally(() => { requestPending = false; });
}

function imageRequest(model: string): Promise<{ status: number; body: string }> {
  return ownFixtureRequest((async () => {
    const token = fakeChatGptJwt({ chatgpt_account_id: "acct-mistral-vision-fixture" });
    const response = await fetch(new URL("/v1/responses", proxy!.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "chatgpt-account-id": "acct-mistral-vision-fixture" },
      body: JSON.stringify({ model, stream: false, input: [{ role: "user", content: [
        { type: "input_text", text: "Describe this image." }, { type: "input_image", image_url: IMAGE },
      ] }] }),
    });
    return { status: response.status, body: await response.text() };
  })());
}

function awaitOwnedCleanup<T>(work: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  ownedCleanup.add(work);
  void work.then(() => ownedCleanup.delete(work), () => ownedCleanup.delete(work));
  return fixtureDeadline(work, label, timeoutMs);
}

async function fixtureDeadline<T>(work: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture timed out waiting for ${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Build an isolated Mistral configuration with a caller-authenticated OpenAI vision helper. */
function configuration(): OcxConfig {
  return {
    port: 0, hostname: "127.0.0.1", defaultProvider: "mistral", openaiProviderTierVersion: 2,
    providers: {
      mistral: { adapter: "openai-chat", baseUrl: "https://api.mistral.ai/v1", apiKey: "fixture-mistral-key" },
      openai: {
        adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    },
  };
}

describe("Mistral GLM vision sidecar defaults", () => {
  test("file-reloaded provider discovery uses the fixture executor without native outbound transport", async () => {
    saveConfig(configuration());
    const reloaded = loadConfig();
    expect(reloaded.providers.mistral?.fetch).toBeUndefined();
    const before = outboundGet.mock.calls.length;
    const models = await gatherRoutedModels(reloaded);
    expect(outboundGet.mock.calls.length).toBeGreaterThan(before);
    expect(buildCatalogEntries(null, [], models).find(row => row.slug === `mistral/${GLM}`)?.input_modalities)
      .toEqual(["text", "image"]);
  });
  test("live discovery publishes GLM attachments without a saved modality override", async () => {
    const config = configuration();
    const models = await gatherRoutedModels(withStubbedProviderFetch(config));
    expect(buildCatalogEntries(null, [], models).find(row => row.slug === `mistral/${GLM}`)?.input_modalities)
      .toEqual(["text", "image"]);
    const route = routeModel(config, `mistral/${GLM}`);
    expect(requiresVisionPreprocessing(config, route.provider, GLM, "mistral")).toBe(true);
    expect(config.providers.mistral!.modelInputModalities).toBeUndefined();
    expect(config.providers.mistral!.modelCapabilities).toBeUndefined();
  });

  test("disabled vision sidecar leaves the GLM catalog text-only", async () => {
    const config = { ...configuration(), visionSidecar: { enabled: false } };
    const models = await gatherRoutedModels(withStubbedProviderFetch(config));
    expect(models.find(row => row.provider === "mistral" && row.id === GLM)?.inputModalities).toEqual(["text"]);
  });

  test("native Mistral vision and explicit operator declarations keep their precedence", async () => {
    const config = configuration();
    config.providers.mistral!.modelInputModalities = { [GLM]: ["text", "image"] };
    const models = await gatherRoutedModels(withStubbedProviderFetch(config));
    expect(models.find(row => row.provider === "mistral" && row.id === GLM)?.inputModalities).toEqual(["text", "image"]);
    expect(models.find(row => row.provider === "mistral" && row.id === NATIVE)?.inputModalities).toEqual(["text", "image"]);
    for (const id of [GLM, NATIVE]) {
      const route = routeModel(config, `mistral/${id}`);
      expect(requiresVisionPreprocessing(config, route.provider, id, "mistral")).toBe(false);
    }
  });

  test("an exact capability override still wins over the GLM preset", () => {
    const config = configuration();
    config.providers.mistral!.modelCapabilities = { [GLM]: { inputModalities: ["text", "image"] } };
    const route = routeModel(config, `mistral/${GLM}`);
    expect(requiresVisionPreprocessing(config, route.provider, GLM, "mistral")).toBe(false);
  });

  test("the GLM enrollment does not apply to unknown Mistral models or another provider", () => {
    const config = configuration();
    config.providers.other = { adapter: "openai-chat", baseUrl: "https://other.example/v1", apiKey: "fixture-other-key" };
    for (const selector of ["mistral/unknown-text-model", `other/${GLM}`]) {
      const route = routeModel(config, selector);
      expect(requiresVisionPreprocessing(config, route.provider, route.modelId, route.providerName)).toBe(false);
    }
  });

  test.each(["sidecar", "disabled", "native", "retired-disabled", "retired-enabled", "retired-implicit"] as const)("image request uses the %s path", async mode => {
    const config = configuration();
    if (mode === "disabled") config.visionSidecar = { enabled: false };
    saveConfig(config);
    if (mode.startsWith("retired-")) {
      // Exercise file loading before real request admission, with a healthy helper available.
      writeFileSync(getConfigPath(), JSON.stringify({ ...config, visionSidecar: {
        backend: "routed", model: "opencode-free/old",
        ...(mode === "retired-implicit" ? {} : { enabled: mode === "retired-enabled" }),
      } }));
    }
    proxy = startServer(0);
    const response = await imageRequest(`mistral/${mode === "native" ? NATIVE : GLM}`);
    expect(response.status).toBe(200);
    expect(mainCalls).toHaveLength(1);
    expect(sidecarCalls).toHaveLength(mode === "sidecar" ? 1 : 0);
    const forwarded = JSON.stringify(mainCalls[0]);
    if (mode === "sidecar") {
      expect(sidecarCalls[0]!.model).toBe("gpt-5.6-luna");
      expect(JSON.stringify(sidecarCalls[0])).toContain(IMAGE);
      expect(forwarded).toContain(CAPTION);
    }
    if (mode === "native") expect(forwarded).toContain(IMAGE);
    else {
      expect(forwarded).not.toContain(IMAGE);
      expect(forwarded).not.toContain("image_url");
    }
    if (mode === "disabled" || mode.startsWith("retired-")) expect(forwarded).toContain("[image omitted:");
  }, 60_000);

  test("fixture retains its fetch mock until an in-flight request and server have finished", async () => {
    let release!: () => void;
    sidecarWait = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { sidecarEntered = resolve; });
    saveConfig(configuration());
    proxy = startServer(0);
    const guardedFetch = globalThis.fetch;
    let requestFinished = false;
    const response = imageRequest(`mistral/${GLM}`).then(value => { requestFinished = true; return value; });
    try {
      await fixtureDeadline(entered, "helper admission");
      expect((await settleBackgroundWork({ timeoutMs: 5_000 })).settled).toBe(true);
      expect(requestFinished).toBe(false);
      let cleanupFinished = false;
      const cleanup = finishFixture().then(() => { cleanupFinished = true; });
      await Promise.resolve();
      expect(cleanupFinished).toBe(false);
      expect(globalThis.fetch).toBe(guardedFetch);
      release();
      await cleanup;
      expect((await response).status).toBe(200);
      expect(requestFinished).toBe(true);
      expect(globalThis.fetch).toBe(originalFetch);
      expect(sidecarCalls).toHaveLength(1);
    } finally { release(); }
  }, 60_000);

  test("fixture restores globals after a drained home removal failure", async () => {
    const remove = spyOn(removal, "removeTreeWithRetry").mockImplementationOnce(() => { throw new Error("fixture removal failed"); });
    const attempt = finishFixture();
    cleanupFlight = attempt.catch(() => undefined);
    try {
      await expect(attempt).rejects.toThrow("Fixture cleanup failed");
      expect(globalThis.fetch).toBe(originalFetch);
      expect(process.env.OPENCODEX_HOME).toBe(previousHome);
      expect(process.env.CODEX_HOME).not.toBe(codexHome.path);
    } finally {
      remove.mockRestore();
      removeTreeWithRetry(home);
    }
  }, 60_000);

  test.each([1, 2])("fixture retains isolation through %s injected shutdown failures", async failures => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const response = ownFixtureRequest(gate.then(() => ({ status: 200, body: "fixture response drained" })));
    let calls = 0;
    stopServer = async () => {
      if (++calls <= failures) throw new Error("fixture shutdown failed");
    };
    const guardedFetch = globalThis.fetch;
    try {
      const attempt = finishFixture();
      cleanupFlight = attempt.catch(() => undefined);
      let outcome: unknown;
      if (failures === 2) {
        // Ingress did not close: reject promptly without waiting for the held request.
        outcome = await fixtureDeadline(attempt.catch(error => error), "shutdown refusal");
        expect(outcome).toBeInstanceOf(AggregateError);
        expect(requestPending).toBe(true);
        expect(() => retryFixtureCleanup()).toThrow("recovery is unavailable");
      } else {
        for (let tick = 0; tick < 8; tick++) await Promise.resolve();
        expect(cleanupPending).toBe(true);
      }
      expect(globalThis.fetch).toBe(guardedFetch);
      expect(process.env.OPENCODEX_HOME).toBe(home);
      release();
      await response;
      outcome ??= await fixtureDeadline(attempt.catch(error => error), "cleanup result");
      expect((outcome as AggregateError).errors[0].message).toBe("fixture shutdown failed");
      expect(globalThis.fetch).toBe(failures === 1 ? originalFetch : guardedFetch);
      expect(calls).toBe(2);
    } finally {
      release();
      await response;
      stopServer = () => undefined;
      if (failures === 2 && isolationActive && !cleanupPending) {
        const recovery = retryFixtureCleanup();
        cleanupFlight = recovery.catch(() => undefined);
        await expect(recovery).rejects.toThrow("Fixture cleanup failed");
        expect(globalThis.fetch).toBe(originalFetch);
      }
    }
  }, 60_000);

  test("fixture retains isolation after a real background drain timeout until its one recovery", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const guardedFetch = globalThis.fetch;
    const observed: { fetch?: typeof fetch; home?: string; codex?: string } = {};
    const work = trackBackgroundWork("held-fixture-observer", gate.then(() => {
      observed.fetch = globalThis.fetch;
      observed.home = process.env.OPENCODEX_HOME;
      observed.codex = process.env.CODEX_HOME;
    }));
    try {
      const attempt = finishFixture(1);
      cleanupFlight = attempt.catch(() => undefined);
      await expect(attempt).rejects.toThrow("undrained; mocks retained");
      expect(() => assertFixtureReleased()).toThrow("refusing to replace its isolation");
      expect(() => retryFixtureCleanup()).toThrow("recovery is unavailable");
      expect(finishFixture()).toBe(cleanupFlight);
      expect(globalThis.fetch).toBe(guardedFetch);
      release();
      await work;
      expect(observed).toEqual({ fetch: guardedFetch, home, codex: codexHome.path });
      const recovery = retryFixtureCleanup();
      cleanupFlight = recovery.catch(() => undefined);
      const failure = await recovery.catch(error => error as AggregateError);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0].message).toContain("held-fixture-observer");
      expect(globalThis.fetch).toBe(originalFetch);
      expect(process.env.OPENCODEX_HOME).toBe(previousHome);
      expect(process.env.CODEX_HOME).not.toBe(codexHome.path);
      expect(() => assertFixtureReleased()).not.toThrow();
      expect(() => retryFixtureCleanup()).toThrow("recovery is unavailable");
    } finally {
      release();
      await work;
      if (isolationActive && !cleanupRetryUsed) {
        cleanupFlight = retryFixtureCleanup().catch(() => undefined);
        await cleanupFlight;
      }
    }
  }, 60_000);

  test.each(["stop", "request"] as const)("fixture rejects a %s deadline without restoring or retrying live work", async phase => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const guardedFetch = globalThis.fetch;
    if (phase === "stop") stopServer = () => gate;
    else ownFixtureRequest(gate.then(() => ({ status: 200, body: "released" })));
    try {
      const attempt = finishFixture(15_000, 1);
      cleanupFlight = attempt.catch(() => undefined);
      await expect(attempt).rejects.toThrow("mocks retained");
      expect(globalThis.fetch).toBe(guardedFetch);
      expect(process.env.OPENCODEX_HOME).toBe(home);
      expect(() => retryFixtureCleanup()).toThrow("recovery is unavailable");
      release();
      await (requestFlight ?? gate);
      await fixtureDeadline(Promise.all([...ownedCleanup]), "released cleanup work");
      stopServer = () => undefined;
      const recovery = retryFixtureCleanup();
      cleanupFlight = recovery.catch(() => undefined);
      const failure = await recovery.catch(error => error as AggregateError);
      expect((failure as AggregateError).errors[0].message).toContain("Fixture timed out waiting for");
      expect(globalThis.fetch).toBe(originalFetch);
    } finally {
      release();
      await (requestFlight ?? gate);
      await fixtureDeadline(Promise.all([...ownedCleanup]), "released cleanup work");
      stopServer = () => undefined;
      if (isolationActive && !cleanupRetryUsed && !cleanupPending) {
        cleanupFlight = retryFixtureCleanup().catch(() => undefined);
        await cleanupFlight;
      }
    }
  }, 60_000);
});
