import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { planWebSearch, resolveSidecarBackend, shouldResolveOpenAiWebSearchSidecar } from "../src/web-search";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest as Request } from "./helpers/management-auth";
import { redactSecrets } from "../src/lib/redact";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const routed: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "routed-key" };
const forward: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://chatgpt.test/v1", authMode: "forward" };

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, defaultProvider: "routed", providers: { routed, openai: forward }, ...overrides };
}

function parsedWithWebSearch() {
  return parseRequest({ model: "routed/model", input: "search", stream: true, tools: [{ type: "web_search" }] });
}

describe("widened backend union remains fail-closed without backend authority", () => {
  test("resolveSidecarBackend: unset pin survives; new ids resolve to themselves", () => {
    expect(resolveSidecarBackend(undefined)).toBe("openai");
    expect(resolveSidecarBackend("xai")).toBe("xai");
    expect(resolveSidecarBackend("gemini")).toBe("gemini");
    expect(resolveSidecarBackend("exa")).toBe("exa");
  });

  test("planWebSearch xai -> no plan without a configured Grok OAuth provider", () => {
    const cfg = config({ webSearchSidecar: { backend: "xai" } });
    expect(planWebSearch(cfg, parsedWithWebSearch(), false, routed, "model", undefined)).toBeUndefined();
  });

  test.each(["gemini", "exa"] as const)("planWebSearch %s -> no plan while its executor is inert", backend => {
    const cfg = config({ webSearchSidecar: { backend } });
    expect(planWebSearch(cfg, parsedWithWebSearch(), false, routed, "model", undefined)).toBeUndefined();
  });

  test.each(["xai", "gemini", "exa"] as const)("shouldResolveOpenAiWebSearchSidecar false for %s", backend => {
    const cfg = config({ webSearchSidecar: { backend } });
    expect(shouldResolveOpenAiWebSearchSidecar(cfg, parsedWithWebSearch(), false)).toBe(false);
  });
});

async function putSidecar(cfg: OcxConfig, webSearch: Record<string, unknown>): Promise<Response> {
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(
    new Request(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ webSearch }) }),
    url, cfg,
  );
  if (!response) throw new Error("route did not handle PUT");
  return response;
}

describe("management routes admit the union, reject strangers, and guard the exa key", () => {
  test("backend xai accepted; zen rejected 400", async () => {
    const cfg = config();
    expect((await putSidecar(cfg, { backend: "xai" })).status).toBe(200);
    expect(cfg.webSearchSidecar?.backend).toBe("xai");
    const bad = await putSidecar(cfg, { backend: "zen" });
    expect(bad.status).toBe(400);
  });

  test("exaApiKey sets, clears with empty string, and never appears in GET or PUT bodies", async () => {
    const cfg = config();
    const put = await putSidecar(cfg, { exaApiKey: "exa-canary-1234567890" });
    expect(put.status).toBe(200);
    expect(cfg.webSearchSidecar?.exaApiKey).toBe("exa-canary-1234567890");
    expect(JSON.stringify(await put.json())).not.toContain("exa-canary");
    const url = new URL("http://localhost/api/sidecar-settings");
    const get = await handleManagementAPI(new Request(url), url, cfg);
    expect(JSON.stringify(await get!.json())).not.toContain("exa-canary");
    const clear = await putSidecar(cfg, { exaApiKey: "" });
    expect(clear.status).toBe(200);
    expect(cfg.webSearchSidecar?.exaApiKey).toBeUndefined();
  });

  test("redactSecrets strips exaApiKey from structures", () => {
    const redacted = redactSecrets({ webSearchSidecar: { exaApiKey: "exa-canary-1234567890", model: "m" } }) as Record<string, never>;
    expect(JSON.stringify(redacted)).not.toContain("exa-canary");
    expect(JSON.stringify(redacted)).toContain('"model":"m"');
  });
});

async function putClaudeCode(cfg: OcxConfig, body: Record<string, unknown>): Promise<Response> {
  const url = new URL("http://localhost/api/claude-code");
  const response = await handleManagementAPI(
    new Request(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    url, cfg,
  );
  if (!response) throw new Error("route did not handle PUT");
  return response;
}

describe("claude-code overrides: union widened for web-search ONLY (review F1)", () => {
  test("webSearchSidecar.backend xai accepted", async () => {
    const cfg = config();
    const response = await putClaudeCode(cfg, { webSearchSidecar: { backend: "xai" } });
    expect(response.status).toBe(200);
    expect(cfg.claudeCode?.webSearchSidecar?.backend).toBe("xai");
  });

  test("visionSidecar.backend xai rejected 400 (vision keeps the two-member contract)", async () => {
    const cfg = config();
    const response = await putClaudeCode(cfg, { visionSidecar: { backend: "xai" } });
    expect(response.status).toBe(400);
    expect(cfg.claudeCode?.visionSidecar).toBeUndefined();
  });
});
