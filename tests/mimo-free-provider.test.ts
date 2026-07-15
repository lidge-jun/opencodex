import { describe, expect, test, mock, beforeEach } from "bun:test";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { providerConfigSeed, deriveKeyLoginMap, deriveFeaturedProviderIds } from "../src/providers/derive";
import {
  getMimoClientId,
  resetMimoClientIdCache,
  getMimoJwt,
  injectMimoSystemMarker,
  resetMimoJwtCache,
  MIMO_SYSTEM_MARKER,
  MIMO_CHAT_URL,
  createMimoFreeAdapter,
} from "../src/adapters/mimo-free";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

function minimalRequest(model = "mimo-auto"): OcxParsedRequest {
  return {
    modelId: model,
    stream: false,
    context: { messages: [{ role: "user", content: "hello" }], tools: [] },
    options: {},
  };
}

describe("mimo-free provider registry", () => {
  const entry = PROVIDER_REGISTRY.find(e => e.id === "mimo-free");

  test("registry entry exists with correct shape", () => {
    expect(entry).toBeDefined();
    expect(entry?.adapter).toBe("mimo-free");
    expect(entry?.baseUrl).toBe("https://api.xiaomimimo.com/api/free-ai/openai/chat");
    expect(entry?.authKind).toBe("key");
    expect(entry?.keyOptional).toBe(true);
    expect(entry?.featured).toBe(true);
    expect(entry?.liveModels).toBe(true);
    expect(entry?.defaultModel).toBe("mimo-auto");
  });

  test("providerConfigSeed propagates keyOptional and liveModels", () => {
    const seed = providerConfigSeed(entry!);
    expect(seed.keyOptional).toBe(true);
    expect(seed.liveModels).toBe(true);
  });

  test("is included in the key-login map", () => {
    const keyMap = deriveKeyLoginMap();
    expect(keyMap["mimo-free"]).toBeDefined();
  });

  test("is in the featured provider list", () => {
    expect(deriveFeaturedProviderIds()).toContain("mimo-free");
  });

  test("provider note mentions no key needed", () => {
    expect(entry?.note?.toLowerCase()).toContain("no key needed");
  });
});

describe("mimo-free system marker injection", () => {
  test("prepends marker when no system message is present", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const result = injectMimoSystemMarker(body) as { messages: { role: string; content: string }[] };
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content).toBe(MIMO_SYSTEM_MARKER);
    expect(result.messages[1]?.role).toBe("user");
  });

  test("prepends marker when system message does not contain it", () => {
    const body = { messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "hi" }] };
    const result = injectMimoSystemMarker(body) as { messages: { role: string; content: string }[] };
    expect(result.messages[0]?.content).toBe(MIMO_SYSTEM_MARKER);
    expect(result.messages).toHaveLength(3);
  });

  test("is idempotent when marker is already present", () => {
    const body = { messages: [{ role: "system", content: `${MIMO_SYSTEM_MARKER} extra` }, { role: "user", content: "hi" }] };
    const result = injectMimoSystemMarker(body) as { messages: unknown[] };
    expect(result.messages).toHaveLength(2);
  });

  test("passes through non-object bodies unchanged", () => {
    expect(injectMimoSystemMarker(null)).toBeNull();
    expect(injectMimoSystemMarker("string")).toBe("string");
  });

  test("passes through body without messages unchanged", () => {
    const body = { model: "mimo-auto" };
    expect(injectMimoSystemMarker(body)).toEqual({ model: "mimo-auto" });
  });
});

describe("mimo-free client id", () => {
  const { mkdtempSync, rmSync, readFileSync: readFs, existsSync: existsFs } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join: joinPath } = require("node:path") as typeof import("node:path");

  test("random UUID persisted under OPENCODEX_HOME and stable across cache resets", () => {
    const home = mkdtempSync(joinPath(tmpdir(), "ocx-mimo-id-"));
    const prevHome = process.env["OPENCODEX_HOME"];
    process.env["OPENCODEX_HOME"] = home;
    resetMimoClientIdCache();
    try {
      const id1 = getMimoClientId();
      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      // Persisted to disk under the configured home.
      const file = joinPath(home, "mimo-client-id");
      expect(existsFs(file)).toBe(true);
      expect(readFs(file, "utf8").trim()).toBe(id1);
      // Stable across calls and across in-process cache resets (re-read from disk).
      expect(getMimoClientId()).toBe(id1);
      resetMimoClientIdCache();
      expect(getMimoClientId()).toBe(id1);
    } finally {
      if (prevHome === undefined) delete process.env["OPENCODEX_HOME"];
      else process.env["OPENCODEX_HOME"] = prevHome;
      resetMimoClientIdCache();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("client id is not derived from machine attributes (two homes differ)", () => {
    const homeA = mkdtempSync(joinPath(tmpdir(), "ocx-mimo-a-"));
    const homeB = mkdtempSync(joinPath(tmpdir(), "ocx-mimo-b-"));
    const prevHome = process.env["OPENCODEX_HOME"];
    try {
      process.env["OPENCODEX_HOME"] = homeA;
      resetMimoClientIdCache();
      const idA = getMimoClientId();
      process.env["OPENCODEX_HOME"] = homeB;
      resetMimoClientIdCache();
      const idB = getMimoClientId();
      expect(idA).not.toBe(idB);
    } finally {
      if (prevHome === undefined) delete process.env["OPENCODEX_HOME"];
      else process.env["OPENCODEX_HOME"] = prevHome;
      resetMimoClientIdCache();
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
    }
  });
});

describe("mimo-free JWT cache", () => {
  beforeEach(() => {
    resetMimoJwtCache();
  });

  test("getMimoJwt fetches from bootstrap and caches", async () => {
    const fakeJwt = "header." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64") + ".sig";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ jwt: fakeJwt }), { status: 200 }));
    try {
      const jwt1 = await getMimoJwt();
      expect(jwt1).toBe(fakeJwt);
      // Second call should use cache — fetch called only once
      const jwt2 = await getMimoJwt();
      expect(jwt2).toBe(fakeJwt);
      expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      resetMimoJwtCache();
    }
  });

  test("getMimoJwt throws when bootstrap returns error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response("", { status: 503 }));
    try {
      await expect(getMimoJwt()).rejects.toThrow("MiMo bootstrap failed: 503");
    } finally {
      globalThis.fetch = originalFetch;
      resetMimoJwtCache();
    }
  });

  test("resetMimoJwtCache forces re-fetch on next call", async () => {
    const fakeJwt = "h." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64") + ".s";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ jwt: fakeJwt }), { status: 200 }));
    try {
      await getMimoJwt();
      resetMimoJwtCache();
      await getMimoJwt();
      expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      resetMimoJwtCache();
    }
  });

  test("concurrent getMimoJwt callers share one bootstrap (single-flight)", async () => {
    const fakeJwt = "h." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64") + ".s";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      await new Promise(r => setTimeout(r, 20)); // force overlap
      return new Response(JSON.stringify({ jwt: fakeJwt }), { status: 200 });
    });
    try {
      const [a, b, c] = await Promise.all([getMimoJwt(), getMimoJwt(), getMimoJwt()]);
      expect(a).toBe(fakeJwt);
      expect(b).toBe(fakeJwt);
      expect(c).toBe(fakeJwt);
      expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      resetMimoJwtCache();
    }
  });

  test("bootstrap propagates the caller abort signal into fetch", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      return new Response(JSON.stringify({ jwt: "x.y.z" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const aborted = AbortSignal.abort();
      await expect(getMimoJwt(aborted)).rejects.toThrow(/aborted/i);
    } finally {
      globalThis.fetch = originalFetch;
      resetMimoJwtCache();
    }
  });
});

describe("mimo-free auth retry predicate", () => {
  beforeEach(() => {
    resetMimoJwtCache();
  });

  function adapterForRetry(): ReturnType<typeof createMimoFreeAdapter> {
    const provider: OcxProviderConfig = providerConfigSeed(PROVIDER_REGISTRY.find(e => e.id === "mimo-free")!);
    return createMimoFreeAdapter(provider);
  }

  test("401 retries exactly once with a fresh JWT after draining the first body", async () => {
    const fakeJwt = "h." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64") + ".s";
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/bootstrap")) {
        calls.push("bootstrap");
        return new Response(JSON.stringify({ jwt: fakeJwt }), { status: 200 });
      }
      calls.push(`chat:${(init?.headers as Record<string, string>)?.["Authorization"] ?? "none"}`);
      if (calls.filter(c => c.startsWith("chat:")).length === 1) {
        return new Response("expired", { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const adapter = adapterForRetry();
      const res = await adapter.fetchResponse!(
        { url: MIMO_CHAT_URL, method: "POST", headers: { "Authorization": "Bearer stale" }, body: "{}" },
        {} as never,
      );
      expect(res.status).toBe(200);
      // Sequence: first chat with stale token -> 401 -> bootstrap -> retry with fresh JWT.
      expect(calls[0]).toBe("chat:Bearer stale");
      expect(calls[1]).toBe("bootstrap");
      expect(calls[2]).toBe(`chat:Bearer ${fakeJwt}`);
      expect(calls.length).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
      resetMimoJwtCache();
    }
  });

  test("403 (anti-abuse) is returned as-is without retry", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response("Illegal access", { status: 403 })) as unknown as typeof fetch;
    try {
      const adapter = adapterForRetry();
      const res = await adapter.fetchResponse!(
        { url: MIMO_CHAT_URL, method: "POST", headers: { "Authorization": "Bearer t" }, body: "{}" },
        {} as never,
      );
      expect(res.status).toBe(403);
      expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      resetMimoJwtCache();
    }
  });
});

describe("mimo-free adapter request building", () => {
  beforeEach(() => {
    resetMimoJwtCache();
  });

  test("buildRequest sets correct URL, headers, and injects system marker", async () => {
    const fakeJwt = "h." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64") + ".s";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ jwt: fakeJwt }), { status: 200 }));
    try {
      const provider: OcxProviderConfig = providerConfigSeed(PROVIDER_REGISTRY.find(e => e.id === "mimo-free")!);
      const adapter = createMimoFreeAdapter(provider);
      const req = await adapter.buildRequest(minimalRequest());
      const headers = req.headers as Record<string, string>;

      expect(req.url).toBe(MIMO_CHAT_URL);
      expect(headers["Authorization"]).toBe(`Bearer ${fakeJwt}`);
      expect(headers["X-Mimo-Source"]).toBe("mimocode-cli-free");
      expect(headers["x-session-affinity"]).toMatch(/^ses_/);

      const body = JSON.parse(req.body as string) as { messages: { role: string; content: string }[] };
      expect(body.messages[0]?.role).toBe("system");
      expect(body.messages[0]?.content).toBe(MIMO_SYSTEM_MARKER);
    } finally {
      globalThis.fetch = originalFetch;
      resetMimoJwtCache();
    }
  });
});

describe("mimo-free GUI preset", () => {
  test("deriveProviderPresets exposes keyOptional for picker", () => {
    const { deriveProviderPresets } = require("../src/providers/derive");
    const presets = deriveProviderPresets();
    const preset = presets.find((p: { id: string }) => p.id === "mimo-free");
    expect(preset).toBeDefined();
    expect(preset.keyOptional).toBe(true);
    expect(preset.note).toMatch(/no key needed/i);
  });
});
