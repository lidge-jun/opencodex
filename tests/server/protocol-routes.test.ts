/**
 * GET /api/protocols and POST /api/protocols/plan (src/server/management/protocol-routes.ts):
 * read-only, bounded input, and a validated ProtocolPlanV1 with basis "preview".
 */
import { describe, expect, test } from "bun:test";
import { PROTOCOL_CONTRACT_VERSION } from "../../src/protocols/contract";
import { isProtocolPlanV1 } from "../../src/protocols/dto";
import { PROTOCOL_FEATURES } from "../../src/protocols/features";
import type { ManagementContext } from "../../src/server/management/context";
import { handleProtocolRoutes, parseProtocolPlanBody } from "../../src/server/management/protocol-routes";
import type { OcxConfig } from "../../src/types";

const config = {
  port: 10100,
  defaultProvider: "a",
  providers: { a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] } },
} as unknown as OcxConfig;

function ctx(method: string, path: string, body?: string): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const req = new Request(url, {
    method,
    ...(body !== undefined ? { body, headers: { "content-type": "application/json" } } : {}),
  });
  return { req, url, config, deps: {}, version: "test" } as unknown as ManagementContext;
}

async function post(body: unknown): Promise<Response> {
  const res = await handleProtocolRoutes(ctx("POST", "/api/protocols/plan", typeof body === "string" ? body : JSON.stringify(body)));
  if (!res) throw new Error("route did not answer");
  return res;
}

describe("GET /api/protocols", () => {
  test("returns the vocabulary, the settings and the policy revision", async () => {
    const res = await handleProtocolRoutes(ctx("GET", "/api/protocols"));
    expect(res?.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.schemaVersion).toBe(1);
    expect(body.contractVersion).toBe(PROTOCOL_CONTRACT_VERSION);
    expect(typeof body.policyRevision).toBe("string");
    expect(body.features).toEqual([...PROTOCOL_FEATURES]);
    expect((body.surfaces as Record<string, { enabled: boolean }>).chat.enabled).toBe(true);
    expect((body.settings as { unrepresentable: string }).unrepresentable).toBe("legacy");
  });

  test("other methods and paths fall through", async () => {
    expect(await handleProtocolRoutes(ctx("POST", "/api/protocols", "{}"))).toBeNull();
    expect(await handleProtocolRoutes(ctx("GET", "/api/protocols/plan"))).toBeNull();
    expect(await handleProtocolRoutes(ctx("GET", "/api/protocolsx"))).toBeNull();
  });
});

describe("POST /api/protocols/plan", () => {
  test("answers a valid preview plan", async () => {
    const res = await post({ model: "m1", inbound: "chat", features: ["request.tools"] });
    expect(res.status).toBe(200);
    const plan = await res.json();
    expect(isProtocolPlanV1(plan)).toBe(true);
    expect(plan).toMatchObject({ basis: "preview", inbound: "chat", requestedModel: "m1", mode: "native" });
  });

  test.each([
    ["invalid JSON", "{", "invalid_json"],
    ["a non-object body", [], "invalid_body"],
    ["an unknown key", { model: "m1", inbound: "chat", prompt: "x" }, "unknown_field"],
    ["a missing model", { inbound: "chat" }, "invalid_model"],
    ["an over-long model", { model: "m".repeat(201), inbound: "chat" }, "invalid_model"],
    ["a control character in the model", { model: "m\u0001", inbound: "chat" }, "invalid_model"],
    ["an unknown inbound", { model: "m1", inbound: "anthropic" }, "invalid_inbound"],
    ["too many features", { model: "m1", inbound: "chat", features: Array(25).fill("request.tools") }, "invalid_features"],
    ["an unknown feature", { model: "m1", inbound: "chat", features: ["request.prompt"] }, "invalid_features"],
    ["non-array features", { model: "m1", inbound: "chat", features: "request.tools" }, "invalid_features"],
  ])("rejects %s with 400", async (_label, body, code) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    const payload = await res.json() as { error: { code: string; message: string } };
    expect(payload.error.code).toBe(code);
  });

  test("errors never echo the submitted model", () => {
    const parsed = parseProtocolPlanBody({ model: "secret-looking-value\u0001", inbound: "chat" });
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("secret-looking-value");
  });

  test("duplicate features collapse and the model is trimmed", () => {
    const parsed = parseProtocolPlanBody({ model: " m1 ", inbound: "chat", features: ["request.tools", "request.tools"] });
    expect(parsed).toEqual({ ok: true, request: { model: "m1", inbound: "chat", features: ["request.tools"] } });
  });
});
