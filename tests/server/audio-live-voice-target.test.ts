import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveLiveVoiceHeaders } from "../../src/config/live-voice";
import type { AdmissionLease } from "../../src/lib/admission";
import { LiveCallBindings } from "../../src/server/live-call-bindings";
import type { AudioClient } from "../../src/server/audio-client";
import { selectLiveVoiceBackend, resolveExternalLiveSocket, resolveLiveVoiceActiveModelId } from "../../src/server/audio-live";
import { addRequestLog, clearRequestLogsForTests, type RequestLogEntry } from "../../src/server/request-log";
import { normalizeLogConversationId } from "../../src/server/request-log-conversation";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const CUSTOM_PROVIDERS = {
  "my-voice": {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    liveUrl: "wss://voice.example.test/live",
    liveHeaders: { authorization: "${VOICE_TOKEN}", "x-static": "static" },
  },
} satisfies Record<string, OcxProviderConfig>;

function config(liveVoice?: OcxConfig["liveVoice"], providers: Record<string, OcxProviderConfig> = CUSTOM_PROVIDERS): OcxConfig {
  return {
    port: 0,
    defaultProvider: "dummy",
    providers: { dummy: { adapter: "openai-chat", baseUrl: "https://example.test/v1" }, ...providers },
    ...(liveVoice ? { liveVoice } : {}),
  } as OcxConfig;
}

function logEntry(conversationId: string | undefined, model: string, requestedModel?: string): RequestLogEntry {
  return {
    requestId: `req-${model}`,
    timestamp: Date.now(),
    model,
    provider: "zai",
    ...(requestedModel ? { requestedModel } : {}),
    ...(conversationId ? { conversationId } : {}),
    status: 200,
    durationMs: 1,
    usageStatus: "reported",
  };
}

function fakeClient(headers: Record<string, string> = {}): AudioClient {
  return { admission: {} as never, headers: new Headers(headers), owner: "test" } as unknown as AudioClient;
}

function standaloneTarget() {
  return { style: "frameless-standalone" as const, query: "model=gpt-live-1" };
}

function socketOptions() {
  return {
    lease: undefined as unknown as AdmissionLease,
    bindings: new LiveCallBindings(),
    signal: undefined,
  };
}

describe("live voice backend selection", () => {
  test("defaults to the reserved openai target when nothing is configured", () => {
    expect(selectLiveVoiceBackend(config(), "zai/glm-5.3-flash")).toEqual({ kind: "openai" });
    expect(selectLiveVoiceBackend(config({}), "zai/glm-5.3-flash")).toEqual({ kind: "openai" });
  });

  test("an exact byModel entry wins over liveVoice.provider", () => {
    const cfg = config({ provider: "openai", byModel: { "zai/glm-5.3-flash": "my-voice" } });
    expect(selectLiveVoiceBackend(cfg, "zai/glm-5.3-flash")).toEqual({
      kind: "custom",
      providerName: "my-voice",
      provider: CUSTOM_PROVIDERS["my-voice"],
    });
    expect(selectLiveVoiceBackend(cfg, "other/model")).toEqual({ kind: "openai" });
  });

  test("an explicit openai entry keeps the built-in relay even when a provider shares the name", () => {
    const cfg = config(
      { byModel: { m: "openai" } },
      { openai: { ...CUSTOM_PROVIDERS["my-voice"] } },
    );
    expect(selectLiveVoiceBackend(cfg, "m")).toEqual({ kind: "openai" });
  });

  test("liveVoice.provider is used when the active model has no override", () => {
    const cfg = config({ provider: "my-voice" });
    const expected = { kind: "custom", providerName: "my-voice", provider: CUSTOM_PROVIDERS["my-voice"] };
    expect(selectLiveVoiceBackend(cfg, "zai/glm-5.3-flash")).toEqual(expected);
    expect(selectLiveVoiceBackend(cfg, undefined)).toEqual(expected);
  });

  test("unknown and registry-managed targets resolve as invalid", () => {
    expect(selectLiveVoiceBackend(config({ provider: "ghost" }), "m")).toMatchObject({ kind: "invalid", target: "ghost" });
    expect(selectLiveVoiceBackend(config({ byModel: { m: "ghost" } }), "m")).toMatchObject({ kind: "invalid" });
    const registry = config({ provider: "anthropic" }, { anthropic: { ...CUSTOM_PROVIDERS["my-voice"] } });
    expect(selectLiveVoiceBackend(registry, "anthropic")).toMatchObject({ kind: "invalid", target: "anthropic" });
  });
});

describe("live voice conversation lookup", () => {
  beforeEach(() => { clearRequestLogsForTests(); });
  afterEach(() => { clearRequestLogsForTests(); });

  test("the request-backed lookup reads the thread's newest logged model", () => {
    expect(resolveLiveVoiceActiveModelId(new Headers({ "thread-id": "t1" }))).toBeUndefined();
    addRequestLog(logEntry(normalizeLogConversationId("t1"), "glm-5.3-flash", "zai/glm-5.3-flash"));
    expect(resolveLiveVoiceActiveModelId(new Headers({ "thread-id": "t1" }))).toBe("zai/glm-5.3-flash");
  });
});

describe("resolveExternalLiveSocket custom target", () => {
  beforeEach(() => { clearRequestLogsForTests(); });
  afterEach(() => { clearRequestLogsForTests(); });

  test("returns the provider endpoint without resolving a relay account", async () => {
    addRequestLog(logEntry(normalizeLogConversationId("t1"), "glm-5.3-flash", "zai/glm-5.3-flash"));
    process.env.VOICE_TOKEN = "secret-token";
    try {
      const cfg = config({ byModel: { "zai/glm-5.3-flash": "my-voice" } });
      const target = await resolveExternalLiveSocket(
        fakeClient({ "thread-id": "t1" }), cfg,
        { model: "gpt-live", provider: "unknown" }, standaloneTarget(), socketOptions(),
      );
      expect(target instanceof Response).toBe(false);
      if (target instanceof Response) throw new Error("expected a custom socket target");
      expect(target.upstreamWsUrl).toBe("wss://voice.example.test/live");
      expect(target.headers).toEqual({ authorization: "secret-token", "x-static": "static" });
      expect(typeof target.maxSessionMs).toBe("number");
      expect(target.maxSessionMs).toBeGreaterThan(0);
      expect(typeof target.finish).toBe("function");
      target.finish();
    } finally {
      delete process.env.VOICE_TOKEN;
    }
  });

  test("rejects unknown, registry-managed, and endpoint-less targets explicitly", async () => {
    for (const [cfg, expected] of [
      [config({ provider: "ghost" }), "is not configured"],
      [config({ provider: "anthropic" }, { anthropic: { ...CUSTOM_PROVIDERS["my-voice"] } }), "must name a custom provider"],
      [config({ provider: "bare" }, { bare: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } }), "has no live voice endpoint"],
    ] as const) {
      const target = await resolveExternalLiveSocket(
        fakeClient(), cfg, { model: "gpt-live", provider: "unknown" }, standaloneTarget(), socketOptions(),
      );
      expect(target).toBeInstanceOf(Response);
      if (!(target instanceof Response)) throw new Error("expected a rejection");
      expect(target.status).toBe(400);
      expect(await target.text()).toContain(expected);
    }
  });

  test("unmapped and openai-selected models keep the built-in relay path", async () => {
    // No relay accounts exist in this config, so the built-in path surfaces its own
    // account error — proof the selection fell through to the relay instead of a custom URL.
    for (const liveVoice of [undefined, {}, { provider: "openai" }, { byModel: { m: "openai" } }]) {
      const target = await resolveExternalLiveSocket(
        fakeClient(), config(liveVoice), { model: "gpt-live", provider: "unknown" }, standaloneTarget(), socketOptions(),
      );
      expect(target).toBeInstanceOf(Response);
      if (!(target instanceof Response)) throw new Error("expected the relay path to reject without accounts");
    }
  });
});
