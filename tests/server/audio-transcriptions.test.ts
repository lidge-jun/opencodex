import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota } from "../../src/codex/auth-api";
import { clearMainAccountInfoCache } from "../../src/codex/main-account-cache";
import { resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { waitForNativeMainStartupGate } from "../../src/codex/native-profile-startup";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import * as routing from "../../src/codex/routing";
import * as authContext from "../../src/codex/auth-context";
import { startServer } from "../../src/server";
import { handleAudioTranscriptions, AUDIO_BODY_MAX_BYTES, AUDIO_FILE_MAX_BYTES } from "../../src/server/audio-transcriptions";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { acquireNativeMainProfileDrain, abortAndReleaseAllTurns, getActiveTurnCount, tryAdmitTurn } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";

const KEY = "ocx_data_audio_test_client";
const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
let home = "";
let codex: IsolatedCodexHome;
let captured: Request[];
let respond: (req: Request) => Response | Promise<Response>;
let server: ReturnType<typeof startServer> | undefined;

function config(): OcxConfig {
  return {
    port: 0, hostname: "127.0.0.1", defaultProvider: "openai-apikey", openaiProviderTierVersion: 2,
    providers: { "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-upstream-key", authMode: "key" } },
    apiKeys: [{ id: "audio-client", name: "audio", key: KEY, createdAt: "2026-09-12T00:00:00Z" }],
  } as OcxConfig;
}

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.append("file", new File([new Uint8Array([82, 73, 70, 70, 0, 0])], "sample.wav", { type: "audio/wav" }));
  data.append("model", "gpt-4o-transcribe");
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

function savePoolConfig(): OcxConfig {
  const cfg = config();
  cfg.defaultProvider = "openai";
  cfg.providers = { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" } };
  cfg.codexAccounts = [{ id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" }];
  cfg.activeCodexAccountId = "pool-a";
  saveCodexAccountCredential("pool-a", { accessToken: fakeChatGptJwt({ chatgpt_account_id: "acct-pool-a" }), refreshToken: "fixture-refresh", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "acct-pool-a" });
  saveConfig(cfg);
  return cfg;
}

async function request(body: BodyInit = form(), headers: Record<string, string> = {}): Promise<Response> {
  server ??= startServer(0, { inspectNativeCodexOwnership: ownedServiceHomeInspection("audio fixture") });
  await waitForNativeMainStartupGate();
  return originalFetch(new URL("/v1/audio/transcriptions", server.url), {
    method: "POST", body, headers: { authorization: `Bearer ${KEY}`, ...headers },
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-audio-"));
  process.env.OPENCODEX_HOME = home;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  codex = installIsolatedCodexHome("ocx-audio-codex-");
  clearAccountQuota();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  captured = [];
  respond = () => Response.json({ text: "synthetic transcript" });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (["api.openai.com", "chatgpt.com"].includes(new URL(req.url).hostname)) {
      if (!req.url.endsWith("/transcribe") && !req.url.endsWith("/audio/transcriptions")) return Response.json({});
      captured.push(req);
      return respond(req);
    }
    throw new Error("Unexpected non-fixture outbound request");
  }) as typeof fetch;
  saveConfig(config());
});

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  globalThis.fetch = originalFetch;
  clearAccountQuota();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  codex.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
  removeTreeWithRetry(home);
});

describe("standalone transcription API", () => {
  test("forwards multipart bytes with upstream credentials and returns only transcript", async () => {
    respond = () => Response.json({ text: "synthetic transcript", internal: "must not escape" });
    const response = await request(form({ prompt: "technical terms", language: "ko" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "synthetic transcript" });
    expect(captured).toHaveLength(1);
    const upstream = captured[0]!;
    expect(upstream.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(upstream.headers.get("authorization")).toBe("Bearer fixture-upstream-key");
    expect(upstream.headers.get("x-opencodex-api-key")).toBeNull();
    const data = await upstream.formData();
    expect(data.get("model")).toBe("gpt-4o-transcribe");
    expect(data.get("prompt")).toBe("technical terms");
    expect(data.get("language")).toBe("ko");
    expect(Array.from(new Uint8Array(await (data.get("file") as File).arrayBuffer()))).toEqual([82, 73, 70, 70, 0, 0]);
  });

  test("text format is a text response while upstream uses JSON", async () => {
    const response = await request(form({ response_format: "text" }));
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("synthetic transcript");
  });

  test("explicit bad dedicated key cannot fall through to a valid bearer on loopback", async () => {
    expect((await request(form(), { "x-opencodex-api-key": "wrong" })).status).toBe(401);
    expect((await request(form(), { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await request(form(), { authorization: "" })).status).toBe(401);
    expect(captured).toHaveLength(0);
  });

  test("hostile origin is rejected even with a valid key", async () => {
    expect((await request(form(), { origin: "https://untrusted.example" })).status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  test("duplicate, missing and unsupported fields fail before upstream", async () => {
    const duplicate = form(); duplicate.append("model", "whisper-1");
    const missing = form(); missing.delete("file");
    for (const body of [duplicate, missing, form({ model: "chat-model" }), form({ stream: "true" }), form({ response_format: "srt" })]) {
      expect((await request(body)).status).toBe(400);
    }
    expect(captured).toHaveLength(0);
  });

  test("malformed and compressed multipart are rejected", async () => {
    expect((await request("broken", { "content-type": "multipart/form-data; boundary=test" })).status).toBe(400);
    expect((await request(form(), { "content-encoding": "gzip" })).status).toBe(400);
    expect(captured).toHaveLength(0);
  });

  test("file and text limits are enforced", async () => {
    const oversized = form(); oversized.set("file", new File([new Uint8Array(AUDIO_FILE_MAX_BYTES + 1)], "large.wav"));
    expect((await request(oversized)).status).toBe(413);
    expect((await request(form({ prompt: "x".repeat(16 * 1024 + 1) }))).status).toBe(413);
    expect(captured).toHaveLength(0);
  });

  test("chunked body limit cancels the reader before account resolution", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(AUDIO_BODY_MAX_BYTES + 1)); },
      cancel() { canceled = true; },
    });
    const req = new Request("http://localhost/v1/audio/transcriptions", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body });
    const result = await handleAudioTranscriptions(req, config(), { model: "unknown", provider: "unknown" }, { kind: "configured", keyId: "audio-client", source: "bearer" });
    expect(result.status).toBe(413);
    expect(canceled).toBe(true);
    expect(captured).toHaveLength(0);
  });

  test("declared body limit rejects without pulling audio", async () => {
    let canceled = false;
    const req = new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(AUDIO_BODY_MAX_BYTES + 1) },
      body: new ReadableStream({ cancel() { canceled = true; } }),
    });
    const response = await handleAudioTranscriptions(req, config(), { model: "unknown", provider: "unknown" }, { kind: "configured", keyId: "audio-client", source: "bearer" });
    expect(response.status).toBe(413);
    expect(canceled).toBe(true);
    expect(captured).toHaveLength(0);
  });

  test("client cancellation aborts the upstream request", async () => {
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    let aborted = false;
    respond = req => new Promise<Response>((_resolve, reject) => {
      req.signal.addEventListener("abort", () => { aborted = true; reject(req.signal.reason); }, { once: true });
      ready.resolve();
    });
    const pending = handleAudioTranscriptions(new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST", body: form(), signal: controller.signal,
    }), config(), { model: "unknown", provider: "unknown" }, { kind: "configured", keyId: "audio-client", source: "bearer" });
    await ready.promise;
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(aborted).toBe(true);
  });

  test("upload deadline cancels a stalled reader and releases its turn", async () => {
    const schedule = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 30_000) expire = () => callback(...args);
      return schedule(callback, delay, ...args);
    }) as typeof setTimeout);
    let canceled = false;
    const lease = tryAdmitTurn()!;
    try {
      const pending = handleAudioTranscriptions(new Request("http://localhost/v1/audio/transcriptions", {
        method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" },
        body: new ReadableStream({ cancel() { canceled = true; } }),
      }), config(), { model: "unknown", provider: "unknown" }, { kind: "configured", keyId: "audio-client", source: "bearer" }, lease);
      expect(expire).toBeDefined();
      expire!();
      expect((await pending).status).toBe(408);
      expect(canceled).toBe(true);
      expect(getActiveTurnCount()).toBe(0);
      expect(captured).toHaveLength(0);
    } finally { timers.mockRestore(); lease.release(); }
  });

  test("shutdown aborts upstream through the registered turn controller", async () => {
    const ready = Promise.withResolvers<void>();
    let aborted = false;
    respond = req => new Promise<Response>((_resolve, reject) => {
      req.signal.addEventListener("abort", () => { aborted = true; reject(req.signal.reason); }, { once: true });
      ready.resolve();
    });
    const lease = tryAdmitTurn()!;
    const pending = handleAudioTranscriptions(new Request("http://localhost/v1/audio/transcriptions", {
      method: "POST", body: form(),
    }), config(), { model: "unknown", provider: "unknown" }, { kind: "configured", keyId: "audio-client", source: "bearer" }, lease);
    await ready.promise;
    abortAndReleaseAllTurns();
    expect((await pending).status).toBe(503);
    expect(aborted).toBe(true);
    expect(getActiveTurnCount()).toBe(0);
  });

  test("malformed responses, upstream errors and redirects remain content-free errors", async () => {
    for (const reply of [new Response("not-json"), Response.json({ missing: true }), new Response("private detail", { status: 429 }), new Response("", { status: 302, headers: { location: "https://untrusted.example" } })]) {
      respond = () => reply;
      const response = await request();
      expect(response.status).toBe(reply.status === 429 ? 429 : 502);
      expect(await response.text()).not.toContain("private detail");
    }
  });

  test("oversized upstream result is rejected and canceled", async () => {
    let canceled = false;
    respond = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel() { canceled = true; },
    }));
    expect((await request()).status).toBe(502);
    expect(canceled).toBe(true);
  });

  test("stored Direct credentials replace the proxy key", async () => {
    writeFileSync(join(codex.path, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-main-access", account_id: "fixture-main-account" } }));
    clearMainAccountInfoCache();
    const cfg = config();
    cfg.defaultProvider = "openai";
    cfg.providers = { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" } };
    saveConfig(cfg);
    expect((await request()).status).toBe(200);
    expect(captured[0]!.url).toBe("https://chatgpt.com/backend-api/transcribe");
    expect(captured[0]!.headers.get("authorization")).toBe("Bearer fixture-main-access");
    expect(captured[0]!.headers.get("user-agent")).toBe("codex_cli_rs");
    expect(captured[0]!.headers.get("originator")).toBe("codex_cli_rs");
    expect((await captured[0]!.formData()).get("model")).toBeNull();
  });

  test("a missing stored Direct credential fails without paid-provider fallback", async () => {
    const cfg = config();
    cfg.providers.openai = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" };
    saveConfig(cfg);
    expect((await request()).status).toBe(401);
    expect(captured).toHaveLength(0);
  });

  test("a validated explicit Direct caller remains distinct from stored main", async () => {
    const cfg = config();
    cfg.defaultProvider = "openai";
    cfg.providers = { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" } };
    saveConfig(cfg);
    const token = fakeChatGptJwt({ chatgpt_account_id: "explicit-native" });
    expect((await request(form(), { "x-opencodex-api-key": KEY, authorization: `Bearer ${token}`, "chatgpt-account-id": "explicit-native" })).status).toBe(200);
    expect(captured[0]!.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(captured[0]!.headers.get("chatgpt-account-id")).toBe("explicit-native");
  });

  test("draining stored Direct profile does not dispatch transcription", async () => {
    writeFileSync(join(codex.path, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-main-access", account_id: "fixture-main-account" } }));
    clearMainAccountInfoCache();
    const cfg = config();
    cfg.providers.openai = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" };
    saveConfig(cfg);
    server = startServer(0, { inspectNativeCodexOwnership: ownedServiceHomeInspection("audio fixture") });
    await waitForNativeMainStartupGate();
    const drain = acquireNativeMainProfileDrain("audio-test");
    expect(drain).not.toBeNull();
    try {
      expect((await request()).status).toBe(503);
      expect(captured).toHaveLength(0);
    } finally { drain?.release(); }
  });

  test("Pool substitutes the selected stored account and strips compatibility model", async () => {
    savePoolConfig();
    expect((await request()).status).toBe(200);
    expect(captured[0]!.headers.get("chatgpt-account-id")).toBe("acct-pool-a");
    expect(captured[0]!.headers.get("authorization")).not.toContain(KEY);
    expect((await captured[0]!.formData()).get("model")).toBeNull();
  });

  test("malformed Pool response records one failure and no provisional success", async () => {
    savePoolConfig();
    respond = () => Response.json({ missing: "text" });
    const outcomes = spyOn(routing, "recordCodexUpstreamOutcome");
    try {
      expect((await request()).status).toBe(502);
      expect(outcomes.mock.calls.filter(call => call[1] === "pool-a").map(call => call[2])).toEqual([502]);
    } finally { outcomes.mockRestore(); }
  });

  test("overall timeout records one Pool timeout after dispatch", async () => {
    const cfg = savePoolConfig();
    const schedule = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 120_000 && !expire) expire = () => callback(...args);
      return schedule(callback, delay, ...args);
    }) as typeof setTimeout);
    const ready = Promise.withResolvers<void>();
    respond = req => new Promise<Response>((_resolve, reject) => {
      req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true });
      ready.resolve();
    });
    const outcomes = spyOn(routing, "recordCodexUpstreamOutcome");
    const lease = tryAdmitTurn()!;
    try {
      const pending = handleAudioTranscriptions(new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form() }), cfg,
        { model: "unknown", provider: "unknown" }, { kind: "configured", keyId: "audio-client", source: "bearer" }, lease);
      await ready.promise;
      expect(expire).toBeDefined();
      expire!();
      expect((await pending).status).toBe(504);
      expect(outcomes.mock.calls.filter(call => call[1] === "pool-a").map(call => call[2])).toEqual(["timeout"]);
    } finally { outcomes.mockRestore(); timers.mockRestore(); lease.release(); }
  });

  test("Pool redirect is recorded once without penalizing the account", async () => {
    savePoolConfig();
    respond = () => new Response("", { status: 302, headers: { location: "https://untrusted.example" } });
    const before = routing.getCodexUpstreamHealth("pool-a");
    const outcomes = spyOn(routing, "recordCodexUpstreamOutcome");
    try {
      expect((await request()).status).toBe(502);
      expect(outcomes.mock.calls.filter(call => call[1] === "pool-a").map(call => call[2])).toEqual([302]);
      expect(routing.getCodexUpstreamHealth("pool-a")).toEqual(before);
    } finally { outcomes.mockRestore(); }
  });

  test.each(["materialization", "usability"] as const)("Pool %s failure releases the acquired context before returning", async failure => {
    savePoolConfig();
    const release = spyOn(authContext, "releaseCodexAuthContextProbeLease");
    const fault = failure === "materialization"
      ? spyOn(authContext, "headersForCodexAuthContext").mockImplementation(() => { throw new Error("fixture materialization failure"); })
      : spyOn(authContext, "isCodexAuthContextUsable").mockReturnValue(false);
    try {
      expect((await request()).status).toBe(401);
      expect(release.mock.calls.some(([ctx]) => ctx?.accountId === "pool-a")).toBe(true);
      expect(captured).toHaveLength(0);
    } finally { fault.mockRestore(); release.mockRestore(); }
  });
});
