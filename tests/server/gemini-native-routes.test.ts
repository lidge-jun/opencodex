import { expect, test } from "bun:test";
import type { OcxConfig } from "../../src/types";
import type { OllamaRouteDeps } from "../../src/server/index/ollama-routes";
import { dispatchGeminiNativeRoute } from "../../src/server/index/gemini-native-routes";

const key = "ocx_data_gemini_native_fixture";
function config(allowedProviders = ["google-antigravity"], allowedModels = ["gemini-test"]): OcxConfig {
  return { hostname: "0.0.0.0", providers: { "google-antigravity": { adapter: "google", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com", models: ["gemini-test", "gemini-secret"] } }, apiKeys: [{ id: "fixture", key, name: "fixture", createdAt: "2026-01-01", allowedProviders, allowedModels }] } as OcxConfig;
}
async function dispatch(path: string, cfg = config(), options: { auth?: string; origin?: string; method?: string } = {}) {
  const headers = new Headers();
  if (options.auth !== "none") headers.set("Authorization", `Bearer ${options.auth ?? key}`);
  if (options.origin) headers.set("Origin", options.origin);
  const req = new Request(`http://127.0.0.1${path}`, { method: options.method ?? "GET", headers });
  return dispatchGeminiNativeRoute(req, new URL(req.url), {
    config: cfg, policy: cfg,
    requestServer: { timeout() {} },
    drainingResponse: () => new Response(null, { status: 503 }),
    runAdmittedHttpTurn: async () => new Response("admitted", { status: 202 }),
  } as unknown as OllamaRouteDeps);
}
test("Gemini ingress rejects missing or invalid credentials and hostile origins", async () => {
  expect((await dispatch("/v1beta/models", config(), { auth: "none" })).status).toBe(401);
  expect((await dispatch("/v1beta/models", config(), { auth: "wrong" })).status).toBe(401);
  expect((await dispatch("/v1beta/models", config(), { origin: "https://evil.invalid" })).status).toBe(403);
});
test("native generation applies provider and model scopes before admission", async () => {
  const path = "/v1beta/models/gemini-test:generateContent";
  expect((await dispatch(path, config(["other"]), { method: "POST" })).status).toBe(403);
  expect((await dispatch(path, config(undefined, ["gemini-secret"]), { method: "POST" })).status).toBe(403);
  expect((await dispatch(path, config(), { method: "POST" })).status).toBe(202);
  expect((await dispatch(path)).status).toBe(405);
});
test("Gemini catalog filters keys and provides scoped model metadata", async () => {
  const listed = await dispatch("/v1beta/models");
  expect(listed.status).toBe(200);
  const payload = await listed.json() as { models: Array<{ name: string }> };
  expect(payload.models.map(model => model.name)).toEqual(["models/gemini-test"]);
  expect((await dispatch("/v1beta/models/gemini-test")).status).toBe(200);
  expect((await dispatch("/v1beta/models/gemini-secret")).status).toBe(404);
  expect((await dispatch("/v1beta/models?pageSize=0")).status).toBe(400);
  expect((await dispatch("/v1beta/interactions", config(), { method: "POST" })).status).toBe(404);
});

test("native catalog lists wire model ids instead of collapsed picker aliases", async () => {
  const listed = await dispatch("/v1beta/models?pageSize=1000", config([], []));
  const payload = await listed.json() as { models: Array<{ name: string }> };
  const names = payload.models.map(model => model.name);
  expect(names).not.toContain("models/gemini-3.8-flash");
  expect(names).toContain("models/gemini-3.8-flash-medium");
});
