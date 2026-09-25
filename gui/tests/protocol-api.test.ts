import { afterEach, beforeEach, expect, test } from "bun:test";
import { planProtocol } from "../../src/protocols/plan";
import {
  clearProtocolPlanCache,
  fetchProtocolPlan,
  parseProtocolInfo,
  protocolPlanCacheKey,
} from "../src/protocol-api";

const originalFetch = globalThis.fetch;
const INFO = {
  schemaVersion: 1,
  contractVersion: "x",
  policyRevision: "p1-00000001",
  surfaces: {
    responses: { enabled: true, source: "fixed" },
    chat: { enabled: true, source: "fixed" },
    messages: { enabled: true, source: "claude-code-legacy" },
  },
  settings: { unrepresentable: "legacy" },
  features: ["request.tools"],
};
const PLAN = planProtocol({
  inbound: "chat",
  requestedModel: "m1",
  routeKind: "direct",
  candidates: [{ provider: "a", model: "m1", adapter: "openai-chat", nativeEligible: true, declineReasons: [] }],
  features: [],
  surfaces: INFO.surfaces,
  settings: { unrepresentable: "legacy" },
  policyRevision: INFO.policyRevision,
  basis: "preview",
});

let calls: string[] = [];
function serve(routes: Record<string, () => Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const path = new URL(url).pathname;
    return routes[path]?.() ?? new Response("{}", { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  clearProtocolPlanCache();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("the cache key ignores feature order and duplicates but not the policy revision", () => {
  const a = protocolPlanCacheKey("http://x", { model: "m", inbound: "chat", features: ["request.tools", "request.seed"] }, "r1");
  const b = protocolPlanCacheKey("http://x", { model: "m", inbound: "chat", features: ["request.seed", "request.tools", "request.tools"] }, "r1");
  expect(a).toBe(b);
  expect(protocolPlanCacheKey("http://x", { model: "m", inbound: "chat", features: [] }, "r2"))
    .not.toBe(protocolPlanCacheKey("http://x", { model: "m", inbound: "chat", features: [] }, "r1"));
  expect(protocolPlanCacheKey("http://y", { model: "m", inbound: "chat", features: [] }, "r1"))
    .not.toBe(protocolPlanCacheKey("http://x", { model: "m", inbound: "chat", features: [] }, "r1"));
});

test("an older server without the routes turns the preview off", async () => {
  serve({});
  expect(await fetchProtocolPlan("http://x", { model: "m1", inbound: "chat", features: [] })).toEqual({ kind: "unavailable" });
});

test("a valid plan is returned and then served from cache for the same policy revision", async () => {
  serve({
    "/api/protocols": () => Response.json(INFO),
    "/api/protocols/plan": () => Response.json(PLAN),
  });
  const first = await fetchProtocolPlan("http://x", { model: "m1", inbound: "chat", features: [] });
  expect(first).toEqual({ kind: "plan", plan: PLAN });
  const second = await fetchProtocolPlan("http://x", { model: "m1", inbound: "chat", features: [] });
  expect(second).toEqual({ kind: "plan", plan: PLAN });
  expect(calls.filter(url => url.endsWith("/api/protocols/plan"))).toHaveLength(1);
});

test("a plan that fails validation is an error, not a half-rendered record", async () => {
  serve({
    "/api/protocols": () => Response.json(INFO),
    "/api/protocols/plan": () => Response.json({ ...PLAN, schemaVersion: 2 }),
  });
  expect(await fetchProtocolPlan("http://x", { model: "m1", inbound: "chat", features: [] })).toEqual({ kind: "error" });
});

test("protocol info requires every surface", () => {
  expect(parseProtocolInfo(INFO)?.policyRevision).toBe("p1-00000001");
  expect(parseProtocolInfo({ ...INFO, surfaces: { chat: { enabled: true } } })).toBeNull();
});
