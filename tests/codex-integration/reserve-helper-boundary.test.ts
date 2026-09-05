import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { describeImage } from "../../src/vision/describe";
import { planVisionSidecar } from "../../src/vision";
import { runWebSearch } from "../../src/web-search/executor";
import { planWebSearch } from "../../src/web-search";
import * as sidecarAuth from "../../src/sidecar/auth";
import { parseRequest } from "../../src/responses/parser";
import { handleSearch } from "../../src/server/search";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";

const forward: OcxProviderConfig = {
  adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex",
};
const routed: OcxProviderConfig = {
  adapter: "openai-chat", baseUrl: "https://fixture.example.test/v1", noVisionModels: ["blind"],
};
const headers = new Headers({ authorization: "Bearer fixture-helper-token" });
const loopbackAdmission = { kind: "loopback", source: "loopback" } as const;
const sidecar = { providerName: "openai" as const, provider: forward, accountMode: "direct" as const,
  authContext: { kind: "main" as const, accountId: null }, headers };
function config(): OcxConfig {
  return { port: 0, defaultProvider: "openai", providers: { openai: forward }, codexDesktopAuthless: true,
    codexAccountPickerEnabled: true, codexAccountNamespaces: { personal: "@main" },
    visionSidecar: { backend: "openai", model: "gpt-reserve" },
    webSearchSidecar: { backend: "openai", model: "gpt-reserve" } };
}
afterEach(() => mock.restore());

describe("Reserve native helper boundary", () => {
  test.each(["vision", "search"] as const)("%s helper refuses before fetch or outcome recording", async kind => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const outcome = mock(() => {});
    const settings = { model: "gpt-reserve", reasoning: "medium" as const, timeoutMs: 1_000, reserveCompatibility: true };
    const result = kind === "vision"
      ? await describeImage("data:image/png;base64,AA==", undefined, "fixture", forward, headers, settings, undefined, outcome)
      : await runWebSearch("fixture", { type: "web_search" }, forward, headers, settings, undefined, outcome);
    expect(result.error).toContain("only available as a conversation model");
    expect(fetchSpy).not.toHaveBeenCalled(); expect(outcome).not.toHaveBeenCalled();
  });

  test.each(["vision", "search"] as const)("%s helper preserves opt-in-off dispatch", async kind => {
    spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    const settings = { model: "gpt-reserve", reasoning: "medium" as const, timeoutMs: 1_000 };
    const result = kind === "vision"
      ? await describeImage("data:image/png;base64,AA==", undefined, "fixture", forward, headers, settings)
      : await runWebSearch("fixture", { type: "web_search" }, forward, headers, settings);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.error).toContain("503");
  });

  test.each(["enabled", "disabled", "remote", "missing", "dedicated", "bearer", "x-api-key", "secondary-loopback"] as const)("%s native plan carries only ingress-bound compatibility", mode => {
    spyOn(sidecarAuth, "resolveSidecarAuth").mockReturnValue({ isCodexAuth: true, isAnthropicAuth: false });
    const cfg = config();
    if (mode === "disabled") cfg.codexDesktopAuthless = false;
    if (mode === "remote") cfg.runtimeRole = "client";
    cfg.hostname = "0.0.0.0";
    cfg.unauthenticatedLoopbackListener = { enabled: true, port: 15142 };
    const source: DataPlaneAdmission["source"] = mode === "dedicated" || mode === "bearer" || mode === "x-api-key"
      ? mode : "loopback";
    const options = { admission: mode === "missing" ? undefined : { source } };
    const parsed = parseRequest({ model: "external/blind", tools: [{ type: "web_search" }], input: [{
      role: "user", content: [{ type: "input_text", text: "fixture" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }],
    }] });
    const vision = planVisionSidecar(cfg, routed, "blind", parsed, sidecar, options);
    const search = planWebSearch(cfg, parsed, false, routed, "blind", sidecar, options);
    expect(vision?.settings.model).toBe("gpt-reserve");
    expect(search?.settings.model).toBe("gpt-reserve");
    const expected = mode === "enabled" || mode === "secondary-loopback" ? true : undefined;
    expect(vision?.settings.reserveCompatibility).toBe(expected);
    expect(search?.settings.reserveCompatibility).toBe(expected);
  });

  test.each(["gpt-reserve", "personal/gpt-reserve"])("standalone %s refuses before native credential resolution", async model => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const result = await handleSearch(new Request("http://localhost/v1/alpha/search", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, query: "fixture" }),
    }), config(), { model: "", provider: "" }, undefined, loopbackAdmission);
    expect(result.status).toBe(400);
    expect(await result.text()).toContain("not the standalone search relay");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("standalone opt-in-off retains its existing provider check", async () => {
    const cfg = config(); cfg.codexDesktopAuthless = false; cfg.providers = {};
    const result = await handleSearch(new Request("http://localhost/v1/alpha/search", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-reserve" }),
    }), cfg, { model: "", provider: "" });
    expect(await result.text()).toContain("none is configured");
  });
});
