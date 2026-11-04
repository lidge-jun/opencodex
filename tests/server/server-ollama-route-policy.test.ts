import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OcxConfig } from "../../src/types";
import { findOllamaRoute, listOllamaRoutes, preflightOllamaRoute, linkRequestSessionLane } from "../../src/server/ollama-route-policy";
import { getOrAllocateRequestSessionLane } from "../../src/server/request-log-conversation";

const originalFetch = globalThis.fetch;
let sends = 0;
beforeEach(() => { sends = 0; globalThis.fetch = (() => { sends++; throw new Error("unexpected send"); }) as typeof fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });
const req = (headers: Record<string, string> = {}) => new Request("http://localhost/api/chat", { headers });
function config(): OcxConfig {
  return { port: 0, defaultProvider: "keyed", providers: {
    keyed: { adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: "key", apiKey: "fixture", models: ["model"] },
    cursorless: { adapter: "cursor", baseUrl: "https://api2.cursor.sh/", authMode: "key", models: ["model"] },
    forward: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", models: ["model"] },
  }, routingProfiles: { daily: { alias: "daily", candidates: [{ provider: "keyed", model: "model" }] }, empty: { alias: "empty", candidates: [] } },
    combos: { group: { alias: "group", strategy: "round-robin", targets: [{ provider: "keyed", model: "model" }] } },
  } as OcxConfig;
}
function rejected(c: OcxConfig, selector: string, code: string, status: number, request = req()) {
  const result = preflightOllamaRoute(c, selector, request);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatchObject({ code, status });
  expect(sends).toBe(0);
}

describe("Ollama route preflight", () => {
  test("lists configured eligible routes only and rejects caller credential transports", () => {
    const c = config();
    c.customModels = [{ id: "custom", provider: "keyed", modelId: "custom" }];
    expect(listOllamaRoutes(c, req()).map(row => row.selector)).toEqual(["keyed/model", "keyed/custom"]);
    const result = preflightOllamaRoute(c, "keyed/model", req({ authorization: "Bearer caller" }));
    expect(result.ok).toBe(true);
    rejected(c, "cursorless/model", "unsupported_credential_domain", 403);
    rejected(c, "forward/model", "unsupported_credential_domain", 403);
    c.providers.keyed!.selectedModels = ["model", "retained"];
    expect(listOllamaRoutes(c, req()).map(row => row.selector)).toEqual(["keyed/model", "keyed/retained"]);
    expect(sends).toBe(0);
  });
  test("rejects policy selectors before policy evaluation, including aliases and unknown namespace", () => {
    const c = config();
    for (const selector of ["policy/daily", "daily", "policy/empty", "empty", "policy/missing", "policy/"]) {
      rejected(c, selector, "unsupported_credential_domain", 403);
    }
    expect(listOllamaRoutes(c, req()).every(row => !row.selector.startsWith("policy/"))).toBe(true);
  });
  test("rejects synthetic selectors before combo or policy handling", () => {
    const c = config(); c.cursorEffortRows = true;
    for (const selector of ["keyed/model--fast", "combo/group--fast", "policy/daily--fast", "daily--fast", "group--high", "daily--high"]) {
      rejected(c, selector, "unsupported_synthetic_selector", 400);
    }
    rejected(c, "combo/group", "unsupported_credential_domain", 403);
  });
  test("rejects configured shadow sources irrespective of provenance and target", () => {
    const c = config();
    for (const target of ["keyed/model", "combo/group"]) {
      c.shadowCallIntercept = { enabled: true, model: target, sourceModels: ["model"] };
      for (const headers of [{}, { "x-openai-subagent": "collab_spawn", "x-openai-parent-turn-id": "fixture" }]) {
        rejected(c, "model", "unsupported_shadow_rewrite", 400, req(headers));
      }
      expect(listOllamaRoutes(c, req()).map(row => row.selector)).toEqual(["keyed/model"]);
    }
  });
  test("rejects cross-provider blocked-model rewrites", () => {
    const c = config(); c.providers.other = { adapter: "openai-chat", baseUrl: "https://other.example/v1", authMode: "key", apiKey: "fixture", models: ["model"] }; c.blockedModelRedirects = { "keyed/model": "other/model" };
    rejected(c, "keyed/model", "unsupported_credential_domain", 403);
  });
  test("settles wire override and carries the sessionless Go lane to an internal request", () => {
    const c = config();
    c.providers["opencode-go"] = { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", authMode: "key", apiKey: "fixture", models: ["minimax-m3", "glm-5.2"], modelAdapters: { "glm-5.2": "openai-responses" } };
    const original = req(); const internal = req();
    const result = preflightOllamaRoute(c, "opencode-go/minimax-m3", original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.provider.adapter).toBe("anthropic");
    expect(result.route.provider.headers?.["x-opencode-session"]).toMatch(/^ocx_/);
    linkRequestSessionLane(original, internal);
    expect(getOrAllocateRequestSessionLane(internal)).toBe(getOrAllocateRequestSessionLane(original));
    const again = preflightOllamaRoute(c, "opencode-go/minimax-m3", internal);
    expect(again.ok && again.route.provider.headers?.["x-opencode-session"]).toBe(result.route.provider.headers?.["x-opencode-session"]);
    const other = preflightOllamaRoute(c, "opencode-go/glm-5.2", original);
    expect(other.ok && other.route.provider.adapter).toBe("openai-responses");
    expect(sends).toBe(0);
  });
  test("the point lookup matches the list for every selector and refuses everything else", () => {
    const c = config();
    c.customModels = [{ id: "custom", provider: "keyed", modelId: "vendor/custom" }];
    c.providers.off = { adapter: "openai-chat", baseUrl: "https://off.example/v1", authMode: "key", apiKey: "fixture", models: ["model"], disabled: true };
    const listed = listOllamaRoutes(c, req());
    expect(listed.map(row => row.selector)).toContain("keyed/vendor/custom");
    for (const row of listed) expect(findOllamaRoute(c, row.selector, req())?.selector).toBe(row.selector);
    for (const selector of ["keyed/absent", "off/model", "cursorless/model", "policy/daily", "daily", "combo/group", "model", "/model", "constructor/model", "__proto__/model"]) {
      expect({ selector, found: findOllamaRoute(c, selector, req()) }).toEqual({ selector, found: undefined });
    }
    c.providers.keyed!.selectedModels = ["model"];
    expect(findOllamaRoute(c, "keyed/vendor/custom", req())).toBeUndefined();
    expect(sends).toBe(0);
  });
});
