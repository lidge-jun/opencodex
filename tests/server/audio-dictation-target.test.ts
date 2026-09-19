import { describe, expect, test } from "bun:test";
import type { AdmissionLease } from "../../src/lib/admission";
import type { AudioClient } from "../../src/server/audio-client";
import {
  dictationConversationIds,
  latestDictationModelFromEntries,
  resolveDictationActiveModelId,
  resolveDictationProviderHeaders,
  resolveDictationSocket,
  selectDictationBackend,
} from "../../src/server/audio-dictation";
import type { RequestLogEntry } from "../../src/server/request-log";
import { normalizeLogConversationId } from "../../src/server/request-log-conversation";
import type { OcxConfig } from "../../src/types";

function config(dictation?: OcxConfig["dictation"]): OcxConfig {
  return {
    port: 0,
    defaultProvider: "dummy",
    providers: { dummy: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
    ...(dictation ? { dictation } : {}),
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

const CUSTOM = {
  url: "wss://dictation.example.test/stream",
  headers: { authorization: "${DICTATION_TOKEN}", "x-static": "static" },
  protocols: ["dictation-v1"],
};

describe("dictation backend selection", () => {
  test("defaults to the reserved openai target when nothing is configured", () => {
    expect(selectDictationBackend(config(), "zai/glm-5.3-flash")).toEqual({ target: "openai" });
  });

  test("an exact byModel entry wins over the default", () => {
    const cfg = config({
      default: "openai",
      byModel: { "zai/glm-5.3-flash": "custom" },
      providers: { custom: CUSTOM },
    });
    expect(selectDictationBackend(cfg, "zai/glm-5.3-flash")).toEqual({ target: "custom", provider: CUSTOM });
    expect(selectDictationBackend(cfg, "other/model")).toEqual({ target: "openai" });
  });

  test("the default is used when the active model has no override", () => {
    const cfg = config({ default: "custom", providers: { custom: CUSTOM } });
    expect(selectDictationBackend(cfg, "zai/glm-5.3-flash")).toEqual({ target: "custom", provider: CUSTOM });
    expect(selectDictationBackend(cfg, undefined)).toEqual({ target: "custom", provider: CUSTOM });
  });

  test("a target naming an absent provider is reported without a provider", () => {
    const cfg = config({ byModel: { "zai/glm-5.3-flash": "ghost" } });
    expect(selectDictationBackend(cfg, "zai/glm-5.3-flash")).toEqual({ target: "ghost" });
  });
});

describe("dictation conversation lookup", () => {
  test("normalizes thread, parent, and session headers to the logged digest", () => {
    const ids = dictationConversationIds(new Headers({
      "thread-id": "t1",
      "x-codex-parent-thread-id": "p1",
      "session_id": "s1",
    }));
    expect(ids).toEqual([normalizeLogConversationId("t1"), normalizeLogConversationId("p1"), normalizeLogConversationId("s1")]);
  });

  test("returns the newest matching entry and ignores missing or unrelated rows", () => {
    const entries = [
      logEntry(normalizeLogConversationId("t1"), "zai/old"),
      logEntry(undefined, "zai/unrelated"),
      logEntry(normalizeLogConversationId("t1"), "zai/glm-5.3-flash"),
      logEntry(normalizeLogConversationId("other"), "zai/other"),
    ];
    expect(latestDictationModelFromEntries(entries, [normalizeLogConversationId("t1")])).toBe("zai/glm-5.3-flash");
    expect(latestDictationModelFromEntries(entries, [])).toBeUndefined();
    expect(latestDictationModelFromEntries(entries, [normalizeLogConversationId("nope")])).toBeUndefined();
  });

  test("prefers the namespaced requested model over the physical destination", () => {
    const entries = [logEntry(normalizeLogConversationId("t1"), "glm-5.3-flash", "zai/glm-5.3-flash")];
    expect(latestDictationModelFromEntries(entries, [normalizeLogConversationId("t1")])).toBe("zai/glm-5.3-flash");
  });

  test("the request-backed lookup reads the same digests", () => {
    expect(resolveDictationActiveModelId(new Headers({ "thread-id": "t1" }))).toBeUndefined();
  });
});

describe("dictation custom provider headers", () => {
  test("resolves ${ENV} references and drops the ones with no value", () => {
    process.env.DICTATION_TOKEN = "secret-token";
    try {
      expect(resolveDictationProviderHeaders(CUSTOM)).toEqual({
        authorization: "secret-token",
        "x-static": "static",
      });
    } finally {
      delete process.env.DICTATION_TOKEN;
    }
    expect(resolveDictationProviderHeaders(CUSTOM)).toEqual({ "x-static": "static" });
  });
});

describe("resolveDictationSocket custom target", () => {
  test("returns the configured url, headers, and protocols without the ChatGPT relay", async () => {
    process.env.DICTATION_TOKEN = "secret-token";
    try {
      const target = await resolveDictationSocket(
        fakeClient(),
        config({ default: "custom", providers: { custom: CUSTOM } }),
        { model: "gpt-live", provider: "unknown" },
        undefined as unknown as AdmissionLease,
      );
      expect(target instanceof Response).toBe(false);
      if (target instanceof Response) throw new Error("expected a custom socket target");
      expect(target.upstreamWsUrl).toBe("wss://dictation.example.test/stream");
      expect(target.headers).toEqual({ authorization: "secret-token", "x-static": "static" });
      expect(target.protocols).toEqual(["dictation-v1"]);
      expect(typeof target.validateFrame).toBe("function");
      expect(typeof target.finish).toBe("function");
      target.finish();
    } finally {
      delete process.env.DICTATION_TOKEN;
    }
  });

  test("rejects a target that names no configured provider", async () => {
    const target = await resolveDictationSocket(
      fakeClient(),
      config({ default: "ghost" }),
      { model: "gpt-live", provider: "unknown" },
      undefined as unknown as AdmissionLease,
    );
    expect(target).toBeInstanceOf(Response);
    if (!(target instanceof Response)) throw new Error("expected a rejection");
    expect(target.status).toBe(400);
    expect(await target.text()).toContain("not configured");
  });
});
