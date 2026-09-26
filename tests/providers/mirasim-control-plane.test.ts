import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeMirasimCompactBody } from "../../src/adapters/mirasim/compact";
import {
  cachedMirasimThinkingShape,
  fetchMirasimLiveCatalog,
  fetchMirasimQuota,
  resetMirasimControlPlaneStateForTests,
  setCachedMirasimRosterForTests,
} from "../../src/adapters/mirasim/control-plane";
import { createMirasimDeviceIdentity } from "../../src/adapters/mirasim/crypto";
import {
  fetchMirasim,
  fetchMirasimControl,
  mirasimCredentialCacheScope,
  resetMirasimTransportStateForTests,
} from "../../src/adapters/mirasim/transport";
import { fetchProviderModelsWithAuth } from "../../src/codex/catalog/provider-models";
import type { CapturedProviderGather } from "../../src/codex/catalog/gather-capture";
import { clearModelCache } from "../../src/codex/model-cache";
import { getAccountSet, saveAccountCredential, saveCredential } from "../../src/oauth/store";
import type { OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "opencodex-mirasim-control-"));
  mkdirSync(home, { recursive: true });
  process.env.OPENCODEX_HOME = home;
  resetMirasimTransportStateForTests();
  resetMirasimControlPlaneStateForTests();
  clearModelCache("mirasim");
});

afterEach(() => {
  resetMirasimTransportStateForTests();
  resetMirasimControlPlaneStateForTests();
  clearModelCache("mirasim");
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function syntheticCredential() {
  const identity = createMirasimDeviceIdentity();
  return {
    access: "mirasim-access-test",
    refresh: "mirasim-refresh-test",
    expires: Date.now() + 3_600_000,
    source: "oauth" as const,
    accountId: "mirasim-test-account",
    mirasim: {
      devicePrivateKey: identity.privateKeyPem,
      relayUrl: "https://relay.mirasim.ai",
      adminUrl: "https://auth.mirasim.ai",
      clientVersion: "0.0.336",
    },
  };
}

type CapturedCall = { url: string; method: string; headers: Headers; body?: string };

function capture(calls: CapturedCall[], input: string | URL | Request, init?: RequestInit): CapturedCall {
  const url = input instanceof Request ? input.url : input.toString();
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === "string" ? init.body : undefined;
  const call = { url, method: init?.method ?? "GET", headers, ...(body ? { body } : {}) };
  calls.push(call);
  return call;
}

function providerWithFetch(fakeFetch: typeof fetch): OcxProviderConfig & { fetch: typeof fetch } {
  return {
    adapter: "mirasim",
    baseUrl: "https://relay.mirasim.ai",
    authMode: "oauth",
    fetch: fakeFetch,
  } as OcxProviderConfig & { fetch: typeof fetch };
}

function ticketResponse(): Response {
  return new Response(JSON.stringify({ ticket: "device-ticket-test", expiresIn: 600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Mirasim signed transport", () => {
  test("degrades model discovery when one bearer ambiguously matches multiple account slots", async () => {
    const first = syntheticCredential();
    const second = {
      ...syntheticCredential(),
      access: first.access,
      refresh: "mirasim-refresh-second",
      accountId: "mirasim-second-account",
    };
    await saveCredential("mirasim", first);
    await saveCredential("mirasim", second);

    let fetchCalls = 0;
    const provider = {
      ...providerWithFetch((async () => { fetchCalls += 1; return new Response("unexpected"); }) as typeof fetch),
      liveModels: true,
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
    } as OcxProviderConfig & { fetch: typeof fetch };
    const captured = {
      name: "mirasim",
      provider,
      discovery: { maxResponseBytes: 1024 * 1024, maxModels: 256 },
      request: {
        method: "GET",
        url: "https://relay.mirasim.ai/v1/models",
        headersWithoutCredential: {},
        headersWithCredential: {},
      },
      metadataModelIdCaseFold: false,
      effectiveAlias: null,
    } as unknown as CapturedProviderGather;

    const result = await fetchProviderModelsWithAuth(captured, 60_000, undefined, {
      kind: "observed",
      resolve: () => ({ apiKey: first.access, observed: true }),
    });
    expect(result.outcome.state).toBe("degraded");
    expect(result.models.map(model => model.id)).toContain("gpt-5.6-sol");
    expect(fetchCalls).toBe(0);
  });

  test("drops Mirasim scalar metadata containing control characters while keeping PEM multiline-safe", async () => {
    const valid = syntheticCredential();
    await saveCredential("mirasim", {
      ...valid,
      mirasim: { ...valid.mirasim, clientVersion: "0.0.336\r\nInjected: yes" },
    });
    const stored = getAccountSet("mirasim")?.accounts[0]?.credential;
    expect(stored?.mirasim).toBeUndefined();
    expect(stored?.access).toBe(valid.access);
  });

  test("keeps roster/model cache authority stable across access-token rotation", async () => {
    const initial = syntheticCredential();
    await saveCredential("mirasim", initial);
    const beforeScope = mirasimCredentialCacheScope(initial.access);
    setCachedMirasimRosterForTests(initial.access, {
      version: "rotation-v1",
      agents: {
        claude: [{
          id: "claude-haiku-4-5",
          contextWindow: 200_000,
          effort: ["high"],
          adaptive: false,
        }],
        codex: [],
      },
    });

    const set = getAccountSet("mirasim");
    expect(set).toBeDefined();
    const accountId = set!.activeAccountId;
    const rotated = {
      ...initial,
      access: "mirasim-access-rotated",
      refresh: "mirasim-refresh-rotated",
      expires: Date.now() + 7_200_000,
    };
    await saveAccountCredential("mirasim", accountId, rotated);

    expect(mirasimCredentialCacheScope(rotated.access)).toBe(beforeScope);
    expect(cachedMirasimThinkingShape(rotated.access, "claude-haiku-4-5")).toBe("budget");
  });

  test("mints a device ticket, then signs /v1/models without inference metadata sealing", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const calls: CapturedCall[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const call = capture(calls, input, init);
      if (new URL(call.url).pathname === "/v1/device/session") return ticketResponse();
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol", object: "model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const response = await fetchMirasimControl(
      "mirasim",
      providerWithFetch(fakeFetch),
      "mirasim-access-test",
      "/v1/models",
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);

    const mint = calls[0]!;
    expect(new URL(mint.url).pathname).toBe("/v1/device/session");
    expect(mint.method).toBe("POST");
    expect(mint.headers.get("authorization")).toBe("Bearer mirasim-access-test");
    expect(mint.headers.get("x-mirasim-sig")).toBeTruthy();
    expect(mint.headers.get("x-mirasim-client")).toBe("0.0.336");
    expect(mint.headers.get("x-mirasim-enc")).toBeNull();
    expect(mint.headers.get("x-mirasim-session")).toBeNull();

    const models = calls[1]!;
    expect(new URL(models.url).pathname).toBe("/v1/models");
    expect(models.method).toBe("GET");
    expect(models.headers.get("authorization")).toBe("Bearer device-ticket-test");
    expect(models.headers.get("x-mirasim-sig")).toBeTruthy();
    expect(models.headers.get("x-mirasim-device")).toBeTruthy();
    expect(models.headers.get("x-mirasim-client")).toBe("0.0.336");
    expect(models.headers.get("x-mirasim-enc")).toBeNull();
    expect(models.headers.get("x-mirasim-session")).toBeNull();
    expect(models.headers.get("x-mirasim-agent")).toBeNull();
    expect(models.headers.get("x-mirasim-call")).toBeNull();
  });

  test("combines ticket-auth /v1/models with access-auth /v1/model-roster", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const calls: CapturedCall[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const call = capture(calls, input, init);
      const path = new URL(call.url).pathname;
      if (path === "/v1/device/session") return ticketResponse();
      if (path === "/v1/models") {
        return new Response(JSON.stringify({
          data: [
            { id: "gpt-5.6-sol", object: "model", max_input_tokens: 300_000 },
            { id: "claude-sonnet-5", object: "model", max_input_tokens: 900_000 },
            { id: "kimi-k3", object: "model" },
            { id: "claude-sonnet-5-20270101", object: "model" },
            { id: "gpt-5.6-sol-paid", object: "model" },
            { id: "other/model", object: "model" },
            { id: "*", object: "model" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/v1/model-roster") {
        return new Response(JSON.stringify({
          version: "signed-v1",
          agents: {
            claude: [{
              id: "claude-sonnet-5",
              label: "Sonnet account",
              contextWindow: 1_000_000,
              maxOutput: 128_000,
              autoCompactRatio: 0.8,
              effort: ["low", "high", "max"],
              adaptive: false,
            }],
            codex: [{
              id: "gpt-5.6-sol",
              contextWindow: 372_000,
              maxOutput: 128_000,
              effort: ["low", "medium", "high"],
              adaptive: false,
            }],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await fetchMirasimLiveCatalog(
      "mirasim",
      providerWithFetch(fakeFetch),
      "mirasim-access-test",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected live Mirasim catalog");
    expect(result.models).toEqual([
      {
        id: "gpt-5.6-sol",
        object: "model",
        contextWindow: 372_000,
        maxOutputTokens: 128_000,
        reasoningEfforts: ["low", "medium", "high"],
        adaptiveThinking: false,
      },
      {
        id: "claude-sonnet-5",
        object: "model",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        displayName: "Sonnet account",
        reasoningEfforts: ["low", "high", "max"],
        adaptiveThinking: false,
        autoCompactRatio: 0.8,
      },
      {
        id: "kimi-k3",
        object: "model",
      },
      {
        id: "claude-sonnet-5[1m]",
        object: "model",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        displayName: "Sonnet account [1m]",
        reasoningEfforts: ["low", "high", "max"],
        adaptiveThinking: false,
        autoCompactRatio: 0.8,
      },
    ]);
    expect(calls.map(call => new URL(call.url).pathname)).toEqual([
      "/v1/device/session",
      "/v1/models",
      "/v1/model-roster",
    ]);
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer device-ticket-test");
    expect(calls[2]!.headers.get("authorization")).toBe("Bearer mirasim-access-test");
    expect(calls[2]!.headers.get("x-mirasim-sig")).toBeTruthy();
    expect(calls[2]!.headers.get("x-mirasim-device")).toBeTruthy();
    expect(calls[2]!.headers.get("x-mirasim-enc")).toBeNull();
  });

  test("keeps signed roster fields authoritative over static registry hints in the routed catalog", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const calls: CapturedCall[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const call = capture(calls, input, init);
      const path = new URL(call.url).pathname;
      if (path === "/v1/device/session") return ticketResponse();
      if (path === "/v1/models") {
        return new Response(JSON.stringify({
          data: [
            { id: "gpt-5.6-sol", object: "model", max_input_tokens: 300_000 },
            { id: "kimi-k3", object: "model" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/v1/model-roster") {
        return new Response(JSON.stringify({
          version: "signed-newer-than-registry",
          agents: {
            claude: [],
            codex: [{
              id: "gpt-5.6-sol",
              label: "Sol account live",
              contextWindow: 500_000,
              maxOutput: 150_000,
              autoCompactRatio: 0.8,
              effort: ["low", "max"],
              adaptive: false,
            }],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const provider = {
      ...providerWithFetch(fakeFetch),
      liveModels: true,
      models: ["gpt-5.6-sol", "kimi-k3"],
      defaultModel: "gpt-5.6-sol",
      modelContextWindows: { "gpt-5.6-sol": 372_000, "kimi-k3": 1_048_576 },
      modelMaxOutputTokens: { "gpt-5.6-sol": 128_000, "kimi-k3": 128_000 },
      modelDisplayNames: { "gpt-5.6-sol": "Static Sol", "kimi-k3": "Kimi K3" },
      modelReasoningEfforts: {
        "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "kimi-k3": ["low", "high", "max"],
      },
    } as OcxProviderConfig & { fetch: typeof fetch };
    const captured = {
      name: "mirasim",
      provider,
      discovery: { maxResponseBytes: 1024 * 1024, maxModels: 256 },
      request: {
        method: "GET",
        url: "https://relay.mirasim.ai/v1/models",
        headersWithoutCredential: {},
        headersWithCredential: {},
      },
      metadataModelIdCaseFold: false,
      effectiveAlias: null,
    } as unknown as CapturedProviderGather;

    const result = await fetchProviderModelsWithAuth(
      captured,
      60_000,
      400_000,
      {
        kind: "observed",
        resolve: () => ({ apiKey: "mirasim-access-test", observed: true }),
      },
    );
    const model = result.models.find(row => row.id === "gpt-5.6-sol");
    expect(model?.displayName).toBe("Static Sol");
    expect(model?.contextWindow).toBe(400_000);
    expect(model?.maxInputTokens).toBe(400_000);
    expect(model?.contextCapped).toBe(true);
    expect(model?.maxOutputTokens).toBe(150_000);
    expect(model?.reasoningEfforts).toEqual(["low", "max"]);
    expect(model?.autoCompactTokenLimit).toBe(360_000);
    expect(result.outcome.state).toBe("authoritative");
    const kimi = result.models.find(row => row.id === "kimi-k3");
    expect(kimi?.displayName).toBe("Kimi K3");
    expect(kimi?.contextWindow).toBe(400_000);
    expect(kimi?.contextCapped).toBe(true);
    expect(kimi?.maxOutputTokens).toBe(128_000);
    expect(kimi?.reasoningEfforts).toEqual(["low", "high", "max"]);

    const cached = await fetchProviderModelsWithAuth(
      captured,
      60_000,
      400_000,
      {
        kind: "observed",
        resolve: () => ({ apiKey: "mirasim-access-test", observed: true }),
      },
    );
    const cachedModel = cached.models.find(row => row.id === "gpt-5.6-sol");
    expect(cachedModel?.displayName).toBe("Static Sol");
    expect(cachedModel?.contextWindow).toBe(400_000);
    expect(cachedModel?.maxOutputTokens).toBe(150_000);
    expect(cachedModel?.reasoningEfforts).toEqual(["low", "max"]);
    expect(cachedModel?.autoCompactTokenLimit).toBe(360_000);
    expect(calls.filter(call => new URL(call.url).pathname === "/v1/models")).toHaveLength(1);
  });

  test("sends /v1/limits as a signed control probe with provider-owned probe metadata", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const calls: CapturedCall[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const call = capture(calls, input, init);
      const path = new URL(call.url).pathname;
      if (path === "/v1/device/session") return ticketResponse();
      if (path === "/v1/limits") {
        return new Response(JSON.stringify({
          windows: [{ name: "5h", budget: 100, used: 42, model_scoped: false }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const quota = await fetchMirasimQuota(
      "mirasim",
      providerWithFetch(fakeFetch),
      "mirasim-access-test",
    );
    expect(quota?.fiveHourPercent).toBe(42);
    const limits = calls.find(call => new URL(call.url).pathname === "/v1/limits");
    expect(limits?.headers.get("x-mirasim-probe")).toBe("usage");
    expect(limits?.headers.get("x-mirasim-sig")).toBeTruthy();
    expect(limits?.headers.get("x-mirasim-enc")).toBeNull();
  });

  test("signs and seals /v1/responses/compact as inference and normalizes ultra to max", async () => {
    await saveCredential("mirasim", syntheticCredential());
    const calls: CapturedCall[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const call = capture(calls, input, init);
      if (new URL(call.url).pathname === "/v1/device/session") return ticketResponse();
      return new Response(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "opaque" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const body = normalizeMirasimCompactBody({
      model: "ignored",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      reasoning: { effort: "ultra" },
    }, "gpt-5.6-sol");
    const response = await fetchMirasim({
      url: "https://relay.mirasim.ai/v1/responses/compact",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mirasim-session": "caller-must-not-control-this",
      },
      body: JSON.stringify(body),
    }, "mirasim-access-test", { executor: fakeFetch });
    expect(response.status).toBe(200);

    const compact = calls.find(call => new URL(call.url).pathname === "/v1/responses/compact");
    expect(compact).toBeDefined();
    expect(compact!.headers.get("authorization")).toBe("Bearer device-ticket-test");
    expect(compact!.headers.get("x-mirasim-client")).toBe("0.0.336");
    expect(compact!.headers.get("x-mirasim-enc")).toBeTruthy();
    expect(compact!.headers.get("x-mirasim-session")).toBeNull();
    expect(compact!.headers.get("x-mirasim-agent")).toBeNull();
    expect(compact!.headers.get("x-mirasim-call")).toBeNull();
    expect(compact!.headers.get("x-mirasim-sig")).toBeNull();
    expect(JSON.parse(compact!.body!)).toEqual({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "hello" }],
      reasoning: { effort: "max" },
    });
  });
});
