import { describe, expect, test } from "bun:test";
import { routeModel } from "../../src/router";
import { codexRouteCredentialDomainHeaders } from "../../src/server/responses/core-auth";
import type { HandleResponsesOptions } from "../../src/server/responses/core-options";
import type { OcxConfig } from "../../src/types";

function config(redirects: Record<string, string>): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    blockedModelRedirects: redirects,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        models: ["m1", "m2", "m3", "m4"],
        modelAliases: { m1: "fast" },
      },
      google: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        apiKey: "test-key",
        models: ["g1", "g2", "g3", "g4"],
        modelAliases: { g1: "quick" },
      },
    },
  };
}

function keyedSourceConfig(redirects: Record<string, string>): OcxConfig {
  const configured = config(redirects);
  configured.defaultProvider = "source";
  configured.providers.source = {
    adapter: "openai-chat", baseUrl: "https://source.example.test/v1", apiKey: "test-key", models: ["m1", "m2", "m3", "m4"],
  };
  return configured;
}

describe("blocked-model redirect compatibility and provider changes", () => {
  test.each(["openai/m1", "m1", "fast"])("legacy bare mapping remains post-resolution for %s", selector => {
    const routed = routeModel(config({ m1: "m2", m2: "m3" }), selector);
    expect(routed.providerName).toBe("openai");
    expect(routed.modelId).toBe("m2");
    expect(routed.routeReason).toBe("blocked-model-redirect");
    expect(routed.routeDecision?.selected.model).toBe("m2");
    expect(routed.credentialDomainRewrite).toBeUndefined();
  });

  test("legacy slash target remains a raw upstream model when its prefix is not a configured provider", () => {
    const routed = routeModel(config({ m1: "vendor/model" }), "openai/m1");
    expect(routed.providerName).toBe("openai");
    expect(routed.modelId).toBe("vendor/model");
  });

  test("a qualified key with a same-provider target does not alter legacy bare lookup", () => {
    const routed = routeModel(config({ "openai/m1": "openai/m3", m1: "m2" }), "openai/m1");
    expect(routed.providerName).toBe("openai");
    expect(routed.modelId).toBe("m2");
  });

  test("an explicit different-provider target resolves its own alias and records the destination", () => {
    const routed = routeModel(config({ m1: "google/quick" }), "openai/m1");
    expect(routed).toMatchObject({ providerName: "google", modelId: "g1", routeReason: "blocked-model-redirect" });
    expect(routed.routeDecision?.selected).toMatchObject({ provider: "google", model: "g1", reason: "blocked-model-redirect" });
    expect(routed.routeDecision?.requestedModel).toBe("openai/m1");
    expect(routed.credentialDomainRewrite).toBe(true);
  });

  test("a cross-provider redirect strips caller credentials meant for the source route", () => {
    const req = new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer source-route-token", "chatgpt-account-id": "acct-source", "x-extra": "kept" },
    });
    const options = { admission: { kind: "environment", source: "dedicated" } } as HandleResponsesOptions;
    const redirected = routeModel(config({ m1: "google/g1" }), "openai/m1");
    const scoped = codexRouteCredentialDomainHeaders(req, redirected, options, false);
    expect(scoped.get("authorization")).toBeNull();
    expect(scoped.get("chatgpt-account-id")).toBeNull();
    expect(scoped.get("x-extra")).toBe("kept");
    const legacy = routeModel(config({ m1: "m2" }), "openai/m1");
    expect(codexRouteCredentialDomainHeaders(req, legacy, options, false).get("authorization"))
      .toBe("Bearer source-route-token");
  });

  test("an explicit qualified cross-provider key takes precedence over a bare legacy mapping", () => {
    const routed = routeModel(config({ "openai/m1": "google/g2", m1: "m2" }), "fast");
    expect(routed).toMatchObject({ providerName: "google", modelId: "g2", routeReason: "blocked-model-redirect" });
  });

  test("missing destination key keeps the source provider; local auth can redirect", () => {
    const missing = config({ m1: "google/g1" });
    delete missing.providers.google!.apiKey;
    expect(routeModel(missing, "openai/m1")).toMatchObject({
      providerName: "openai", modelId: "google/g1", routeReason: "blocked-model-redirect",
    });
    missing.providers.google!.authMode = "local";
    missing.providers.google!.baseUrl = "http://localhost:11434/v1";
    expect(routeModel(missing, "openai/m1")).toMatchObject({ providerName: "google", modelId: "g1" });
  });

  test("forward destination cannot borrow the caller bearer from a cross-provider redirect", () => {
    const configured = config({ m1: "forward/g1" });
    configured.providers.forward = {
      adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: "forward", models: ["g1"],
    };
    expect(routeModel(configured, "openai/m1")).toMatchObject({
      providerName: "openai", modelId: "forward/g1", routeReason: "blocked-model-redirect",
    });
  });

  test("policy rejects a same-provider substitute outside its eligible candidate list", () => {
    const configured = config({ m1: "m2" });
    configured.routingProfiles = { fast: { candidates: [{ provider: "openai", model: "m1" }] } };
    expect(() => routeModel(configured, "policy/fast")).toThrow(/No eligible candidates/);
    configured.routingProfiles!.fast!.candidates.push({ provider: "openai", model: "m2" });
    expect(routeModel(configured, "policy/fast")).toMatchObject({
      providerName: "openai", modelId: "m2", routeKind: "policy", routeReason: "blocked-model-redirect",
    });
  });

  test("policy rejects a redirected destination outside its candidate list or hard requirements", () => {
    const configured: OcxConfig = {
      port: 10100,
      defaultProvider: "source",
      blockedModelRedirects: { m1: "remote/r1" },
      providers: {
        source: { adapter: "openai-chat", baseUrl: "http://localhost:11434/v1", authMode: "local", models: ["m1"] },
        remote: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "test-key", models: ["r1"] },
      },
      routingProfiles: { safe: { candidates: [{ provider: "source", model: "m1" }], require: { localOnly: true } } },
    };
    expect(() => routeModel(configured, "policy/safe")).toThrow(/No eligible candidates/);
    configured.routingProfiles!.safe!.candidates.push({ provider: "remote", model: "r1" });
    expect(() => routeModel(configured, "policy/safe")).toThrow(/No eligible candidates/);
  });

  test("detects cross-provider cycles", () => {
    const configured = keyedSourceConfig({ m1: "google/g1", g1: "source/m1" });
    expect(() => routeModel(configured, "source/m1")).toThrow(/cycle detected/i);
  });

  test("allows five redirect edges across an alias boundary and rejects six", () => {
    const redirects = {
      m1: "google/quick", // quick resolves to g1 before the next edge.
      g1: "source/m2",
      m2: "google/g2",
      g2: "source/m3",
      m3: "google/g3",
    };
    expect(routeModel(keyedSourceConfig(redirects), "source/m1")).toMatchObject({ providerName: "google", modelId: "g3" });
    expect(() => routeModel(keyedSourceConfig({ ...redirects, g3: "source/m4" }), "source/m1"))
      .toThrow(/maximum redirect depth \(5\)/i);
  });

  test("account-qualified selectors retain the account for legacy substitutions and reject provider escape", () => {
    const configured = { ...config({ "gpt-5.6-terra": "gpt-5.6-luna" }), codexAccountNamespaces: { side: "account-side" } };
    expect(routeModel(configured, "side/gpt-5.6-terra")).toMatchObject({
      providerName: "openai", modelId: "gpt-5.6-luna", codexAccountId: "account-side", routeKind: "explicit-account",
    });
    for (const redirects of [
      { "gpt-5.6-terra": "google/g1" },
      { "side/gpt-5.6-terra": "google/g1" },
    ]) {
      expect(() => routeModel({ ...configured, blockedModelRedirects: redirects }, "side/gpt-5.6-terra"))
        .toThrow(/pinned account route/i);
    }
  });

  test("inherited and prototype redirect-map keys cannot redirect", () => {
    const inherited = Object.assign(Object.create({ m1: "google/g1" }) as Record<string, string>, {});
    expect(routeModel(config(inherited), "openai/m1")).toMatchObject({ providerName: "openai", modelId: "m1" });
    const prototypeKey = JSON.parse('{"__proto__":"google/g1"}') as Record<string, string>;
    expect(routeModel(config(prototypeKey), "__proto__")).toMatchObject({ providerName: "openai", modelId: "__proto__" });
  });

  test("policy trace and combo reason describe a redirected physical destination", () => {
    const configured: OcxConfig = {
      ...config({ m1: "google/g1" }),
      routingProfiles: { fast: { candidates: [{ provider: "openai", model: "m1" }, { provider: "google", model: "g1" }] } },
      combos: { quick: { alias: "quick-combo", strategy: "failover", targets: [{ provider: "openai", model: "m1" }] } },
    };
    const policy = routeModel(configured, "policy/fast");
    expect(policy).toMatchObject({ providerName: "google", modelId: "g1", routeKind: "policy", routeReason: "blocked-model-redirect" });
    expect(policy.routeDecision?.selected).toMatchObject({ provider: "google", model: "g1", reason: "blocked-model-redirect" });
    expect(policy.routeDecision?.candidates[0]).toMatchObject({ provider: "openai", model: "m1" });
    const combo = routeModel(configured, "quick-combo");
    expect(combo).toMatchObject({ providerName: "google", modelId: "g1", routeKind: "combo", routeReason: "blocked-model-redirect" });
    expect(combo.routeDecision?.selected).toMatchObject({ provider: "google", model: "g1", reason: "blocked-model-redirect" });
  });
});
