/**
 * GET /api/protocols?provider=<name> (src/server/management/protocol-routes.ts) and its
 * builder (src/protocols/provider-summary.ts): the resolved upstream wire, who decided it,
 * bounded per-model overrides, and a bounded, non-echoing query parameter.
 */
import { describe, expect, test } from "bun:test";
import { isProtocolProviderSummaryV1, PROTOCOL_PROVIDER_OVERRIDE_LIMIT, type ProtocolProviderSummaryV1 } from "../../src/protocols/dto";
import { buildProtocolProviderSummary, protocolAdapterSource } from "../../src/protocols/provider-summary";
import type { ManagementContext } from "../../src/server/management/context";
import { handleProtocolRoutes, PROTOCOL_PROVIDER_QUERY_LIMIT } from "../../src/server/management/protocol-routes";
import type { OcxConfig } from "../../src/types";

const manyModels = Array.from({ length: PROTOCOL_PROVIDER_OVERRIDE_LIMIT + 10 }, (_, index) => `m${String(index).padStart(3, "0")}`);

const config = {
  port: 10100,
  defaultProvider: "custom",
  providers: {
    custom: {
      adapter: "openai-chat",
      baseUrl: "https://custom.example/v1",
      apiKey: "secret-key-custom",
      models: ["plain", "wide"],
      modelAdapters: { wide: "openai-responses" },
    },
    "opencode-go": {
      adapter: "openai-chat",
      baseUrl: "https://opencode.ai/zen/go/v1",
      authMode: "key",
      apiKey: "secret-key-go",
      models: ["minimax-m2.5", "gpt-5.6-luna", "kimi-k2.7-code", "plain"],
      modelAdapters: { "kimi-k2.7-code": "openai-responses" },
    },
    crowded: {
      adapter: "openai-chat",
      baseUrl: "https://crowded.example/v1",
      apiKey: "secret-key-crowded",
      models: manyModels,
      modelAdapters: Object.fromEntries(manyModels.map(model => [model, "openai-responses"])),
    },
  },
} as unknown as OcxConfig;

function ctx(path: string): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  return { req: new Request(url), url, config, deps: {}, version: "test" } as unknown as ManagementContext;
}

async function get(path: string): Promise<Response> {
  const res = await handleProtocolRoutes(ctx(path));
  if (!res) throw new Error("route did not answer");
  return res;
}

describe("protocolAdapterSource", () => {
  test.each([
    ["hard-pin", "hard-pin"],
    ["operator", "operator"],
    ["operator-capability", "operator"],
    ["registry", "registry"],
    ["provider-default", "provider-default"],
    ["captured-auth", "provider-default"],
    ["unknown", "provider-default"],
    [undefined, "provider-default"],
  ] as const)("maps %s to %s", (source, expected) => {
    expect(protocolAdapterSource(source)).toBe(expected);
  });
});

describe("buildProtocolProviderSummary", () => {
  test("an operator provider lists only the model whose wire was decided apart from it", () => {
    const summary = buildProtocolProviderSummary(config, "custom");
    expect(isProtocolProviderSummaryV1(summary)).toBe(true);
    expect(summary).toEqual({
      name: "custom",
      adapter: "openai-chat",
      adapterSource: "operator",
      authMode: null,
      upstream: "chat",
      modelOverrides: [{ model: "wide", adapter: "openai-responses", source: "operator" }],
    });
  });

  test("a registry provider reports hard pins, registry wire defaults and operator overrides", () => {
    const summary = buildProtocolProviderSummary(config, "opencode-go")!;
    expect(summary).toMatchObject({ adapter: "openai-chat", adapterSource: "registry", authMode: "key", upstream: "chat" });
    const byModel = new Map(summary.modelOverrides.map(row => [row.model, row]));
    expect(byModel.get("minimax-m2.5")).toEqual({ model: "minimax-m2.5", adapter: "anthropic", source: "hard-pin" });
    expect(byModel.get("gpt-5.6-luna")).toEqual({ model: "gpt-5.6-luna", adapter: "openai-responses", source: "registry" });
    expect(byModel.get("kimi-k2.7-code")).toEqual({ model: "kimi-k2.7-code", adapter: "openai-responses", source: "operator" });
    expect(byModel.has("plain")).toBe(false);
    const models = summary.modelOverrides.map(row => row.model);
    expect(models).toEqual([...models].sort((left, right) => left.localeCompare(right)));
  });

  test("overrides are capped and the cap is reported", () => {
    const summary = buildProtocolProviderSummary(config, "crowded")!;
    expect(summary.modelOverrides).toHaveLength(PROTOCOL_PROVIDER_OVERRIDE_LIMIT);
    expect(summary.modelOverridesTruncated).toBe(true);
    expect(isProtocolProviderSummaryV1(summary)).toBe(true);
  });

  test("an unknown or inherited name has no summary", () => {
    expect(buildProtocolProviderSummary(config, "missing")).toBeUndefined();
    expect(buildProtocolProviderSummary(config, "constructor")).toBeUndefined();
    expect(buildProtocolProviderSummary(config, "__proto__")).toBeUndefined();
  });

  test("the summary carries no credential or endpoint", () => {
    const text = JSON.stringify(buildProtocolProviderSummary(config, "opencode-go"));
    expect(text).not.toContain("secret-key");
    expect(text).not.toContain("opencode.ai");
  });
});

describe("GET /api/protocols?provider=<name>", () => {
  test("adds the provider block to the usual body", async () => {
    const res = await get("/api/protocols?provider=custom");
    expect(res.status).toBe(200);
    const body = await res.json() as { schemaVersion: number; features: unknown[]; provider: ProtocolProviderSummaryV1 };
    expect(body.schemaVersion).toBe(1);
    expect(Array.isArray(body.features)).toBe(true);
    expect(isProtocolProviderSummaryV1(body.provider)).toBe(true);
    expect(body.provider.name).toBe("custom");
  });

  test("the plain GET keeps its shape without a provider block", async () => {
    const body = await (await get("/api/protocols")).json() as Record<string, unknown>;
    expect(body.provider).toBeUndefined();
  });

  test("an unknown provider answers 404 without echoing the name", async () => {
    const res = await get("/api/protocols?provider=no-such-provider");
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain("unknown_provider");
    expect(text).not.toContain("no-such-provider");
  });

  test.each([
    ["an empty name", "/api/protocols?provider="],
    ["a blank name", "/api/protocols?provider=%20%20"],
    ["an over-long name", `/api/protocols?provider=${"p".repeat(PROTOCOL_PROVIDER_QUERY_LIMIT + 1)}`],
    ["a control character", "/api/protocols?provider=custom%01"],
    ["a repeated parameter", "/api/protocols?provider=custom&provider=opencode-go"],
  ])("rejects %s with 400", async (_label, path) => {
    const res = await get(path);
    expect(res.status).toBe(400);
    const payload = await res.json() as { error: { code: string } };
    expect(payload.error.code).toBe("invalid_provider");
  });

  test("a name at the length bound is looked up, not rejected", async () => {
    const res = await get(`/api/protocols?provider=${"p".repeat(PROTOCOL_PROVIDER_QUERY_LIMIT)}`);
    expect(res.status).toBe(404);
  });
});

describe("isProtocolProviderSummaryV1", () => {
  const valid: ProtocolProviderSummaryV1 = {
    name: "p",
    adapter: "openai-chat",
    adapterSource: "operator",
    authMode: "key",
    upstream: "chat",
    modelOverrides: [],
  };

  test("accepts a minimal summary and rejects drift", () => {
    expect(isProtocolProviderSummaryV1(valid)).toBe(true);
    expect(isProtocolProviderSummaryV1({ ...valid, adapterSource: "captured-auth" })).toBe(false);
    expect(isProtocolProviderSummaryV1({ ...valid, upstream: "grpc" })).toBe(false);
    expect(isProtocolProviderSummaryV1({ ...valid, authMode: undefined })).toBe(false);
    expect(isProtocolProviderSummaryV1({ ...valid, modelOverridesTruncated: false })).toBe(false);
    const tooMany = Array.from({ length: PROTOCOL_PROVIDER_OVERRIDE_LIMIT + 1 }, (_, index) => ({
      model: `m${index}`,
      adapter: "openai-responses",
      source: "operator",
    }));
    expect(isProtocolProviderSummaryV1({ ...valid, modelOverrides: tooMany })).toBe(false);
  });
});
