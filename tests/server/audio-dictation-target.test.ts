import { describe, expect, test } from "bun:test";
import { resolveDictationHeaders } from "../../src/config/dictation";
import type { AdmissionLease } from "../../src/lib/admission";
import type { AudioClient } from "../../src/server/audio-client";
import {
  dictationConversationIds,
  latestDictationModelFromEntries,
  resolveDictationActiveModelId,
  resolveDictationSocket,
  selectDictationBackend,
} from "../../src/server/audio-dictation";
import type { RequestLogEntry } from "../../src/server/request-log";
import { normalizeLogConversationId } from "../../src/server/request-log-conversation";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const CUSTOM_PROVIDERS = {
  "my-dictation": {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    dictationUrl: "wss://dictation.example.test/stream",
    dictationHeaders: { authorization: "${DICTATION_TOKEN}", "x-static": "static" },
    dictationProtocols: ["dictation-v1"],
  },
} satisfies Record<string, OcxProviderConfig>;

function config(
  dictation?: OcxConfig["dictation"],
  providers: Record<string, OcxProviderConfig> = CUSTOM_PROVIDERS,
): OcxConfig {
  return {
    port: 0,
    defaultProvider: "dummy",
    providers: { dummy: { adapter: "openai-chat", baseUrl: "https://example.test/v1" }, ...providers },
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

describe("dictation backend selection", () => {
  test("defaults to the reserved openai target when nothing is configured", () => {
    expect(selectDictationBackend(config(), "zai/glm-5.3-flash")).toEqual({ kind: "openai" });
    expect(selectDictationBackend(config({}), "zai/glm-5.3-flash")).toEqual({ kind: "openai" });
  });

  test("an exact byModel entry wins over dictation.provider", () => {
    const cfg = config({ provider: "openai", byModel: { "zai/glm-5.3-flash": "my-dictation" } });
    expect(selectDictationBackend(cfg, "zai/glm-5.3-flash")).toEqual({
      kind: "custom",
      providerName: "my-dictation",
      provider: CUSTOM_PROVIDERS["my-dictation"],
    });
    expect(selectDictationBackend(cfg, "other/model")).toEqual({ kind: "openai" });
  });

  test("dictation.provider is used when the active model has no override", () => {
    const cfg = config({ provider: "my-dictation" });
    const expected = { kind: "custom", providerName: "my-dictation", provider: CUSTOM_PROVIDERS["my-dictation"] };
    expect(selectDictationBackend(cfg, "zai/glm-5.3-flash")).toEqual(expected);
    expect(selectDictationBackend(cfg, undefined)).toEqual(expected);
  });

  test("unknown and registry-managed targets resolve as invalid", () => {
    expect(selectDictationBackend(config({ provider: "ghost" }), "m")).toMatchObject({ kind: "invalid", target: "ghost" });
    expect(selectDictationBackend(config({ byModel: { m: "ghost" } }), "m")).toMatchObject({ kind: "invalid" });
    const registry = config({ provider: "anthropic" }, { anthropic: { ...CUSTOM_PROVIDERS["my-dictation"] } });
    expect(selectDictationBackend(registry, "anthropic")).toMatchObject({ kind: "invalid", target: "anthropic" });
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

describe("dictation provider headers", () => {
  test("resolves ${ENV} references and drops the ones with no value", () => {
    const headers = CUSTOM_PROVIDERS["my-dictation"].dictationHeaders;
    process.env.DICTATION_TOKEN = "secret-token";
    try {
      expect(resolveDictationHeaders(headers)).toEqual({ authorization: "secret-token", "x-static": "static" });
    } finally {
      delete process.env.DICTATION_TOKEN;
    }
    expect(resolveDictationHeaders(headers)).toEqual({ "x-static": "static" });
  });
});

describe("resolveDictationSocket custom target", () => {
  test("returns the provider endpoint without the ChatGPT relay", async () => {
    process.env.DICTATION_TOKEN = "secret-token";
    try {
      const target = await resolveDictationSocket(
        fakeClient(),
        config({ provider: "my-dictation" }),
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

  test("rejects unknown, registry-managed, and endpoint-less targets", async () => {
    for (const [cfg, expected] of [
      [config({ provider: "ghost" }), "is not configured"],
      [config({ provider: "anthropic" }, { anthropic: { ...CUSTOM_PROVIDERS["my-dictation"] } }), "must name a custom provider"],
      [config({ provider: "bare" }, { bare: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } }), "has no dictation endpoint"],
    ] as const) {
      const target = await resolveDictationSocket(
        fakeClient(), cfg, { model: "gpt-live", provider: "unknown" }, undefined as unknown as AdmissionLease,
      );
      expect(target).toBeInstanceOf(Response);
      if (!(target instanceof Response)) throw new Error("expected a rejection");
      expect(target.status).toBe(400);
      expect(await target.text()).toContain(expected);
    }
  });
});
