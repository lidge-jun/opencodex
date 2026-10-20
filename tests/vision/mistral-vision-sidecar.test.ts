import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { buildCatalogEntries, gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { routeModel } from "../../src/router";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { resetVisionDescriptionCache } from "../../src/vision";
import { requiresVisionPreprocessing } from "../../src/vision/plan";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const GLM = "zai-glm-5-3";
const NATIVE = "mistral-large-4-0";
const IMAGE = "data:image/png;base64,aGVsbG8taW1hZ2UtYnl0ZXM=";
const CAPTION = "A red square with a white circle.";
const originalFetch = globalThis.fetch;
let previousHome: string | undefined;
let home = "";
let codexHome: IsolatedCodexHome;
let sidecarCalls: Array<Record<string, unknown>>;
let mainCalls: Array<Record<string, unknown>>;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  codexHome = installIsolatedCodexHome("ocx-mistral-vision-codex-");
  home = mkdtempSync(join(tmpdir(), "ocx-mistral-vision-"));
  process.env.OPENCODEX_HOME = home;
  clearModelCache();
  resetVisionDescriptionCache();
  sidecarCalls = [];
  mainCalls = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://api.mistral.ai") {
      if (url.pathname === "/v1/models") return Response.json({ data: [
        { id: GLM, capabilities: { vision: false }, max_context_length: 1_048_576 },
        { id: NATIVE, capabilities: { vision: true }, max_context_length: 1_048_576 },
      ] });
      if (url.pathname === "/v1/chat/completions") {
        mainCalls.push(JSON.parse(String(init?.body)));
        return Response.json({
          id: "chatcmpl-mistral-vision", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "A red square." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        });
      }
    }
    if (url.origin === "https://chatgpt.com" && url.pathname === "/backend-api/codex/responses") {
      sidecarCalls.push(JSON.parse(String(init?.body)));
      return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: CAPTION })}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.hostname === "127.0.0.1") return originalFetch(input, init);
    throw new Error("Unexpected network destination in Mistral vision fixture");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  resetVisionDescriptionCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  codexHome.restore();
  removeTreeWithRetry(home);
});

/** Build an isolated Mistral configuration with a caller-authenticated OpenAI vision helper. */
function configuration(): OcxConfig {
  return {
    port: 0, hostname: "127.0.0.1", defaultProvider: "mistral", openaiProviderTierVersion: 2,
    providers: {
      mistral: { adapter: "openai-chat", baseUrl: "https://api.mistral.ai/v1", apiKey: "fixture-mistral-key" },
      openai: {
        adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    },
  };
}

describe("Mistral GLM vision sidecar defaults", () => {
  test("live discovery publishes GLM attachments without a saved modality override", async () => {
    const config = configuration();
    const models = await gatherRoutedModels(withStubbedProviderFetch(config));
    expect(buildCatalogEntries(null, [], models).find(row => row.slug === `mistral/${GLM}`)?.input_modalities)
      .toEqual(["text", "image"]);
    const route = routeModel(config, `mistral/${GLM}`);
    expect(requiresVisionPreprocessing(config, route.provider, GLM, "mistral")).toBe(true);
    expect(config.providers.mistral!.modelInputModalities).toBeUndefined();
    expect(config.providers.mistral!.modelCapabilities).toBeUndefined();
  });

  test("disabled vision sidecar leaves the GLM catalog text-only", async () => {
    const config = { ...configuration(), visionSidecar: { enabled: false } };
    const models = await gatherRoutedModels(withStubbedProviderFetch(config));
    expect(models.find(row => row.provider === "mistral" && row.id === GLM)?.inputModalities).toEqual(["text"]);
  });

  test("native Mistral vision and explicit operator declarations keep their precedence", async () => {
    const config = configuration();
    config.providers.mistral!.modelInputModalities = { [GLM]: ["text", "image"] };
    const models = await gatherRoutedModels(withStubbedProviderFetch(config));
    expect(models.find(row => row.provider === "mistral" && row.id === GLM)?.inputModalities).toEqual(["text", "image"]);
    expect(models.find(row => row.provider === "mistral" && row.id === NATIVE)?.inputModalities).toEqual(["text", "image"]);
    for (const id of [GLM, NATIVE]) {
      const route = routeModel(config, `mistral/${id}`);
      expect(requiresVisionPreprocessing(config, route.provider, id, "mistral")).toBe(false);
    }
  });

  test("an exact capability override still wins over the GLM preset", () => {
    const config = configuration();
    config.providers.mistral!.modelCapabilities = { [GLM]: { inputModalities: ["text", "image"] } };
    const route = routeModel(config, `mistral/${GLM}`);
    expect(requiresVisionPreprocessing(config, route.provider, GLM, "mistral")).toBe(false);
  });

  test("the GLM enrollment does not apply to unknown Mistral models or another provider", () => {
    const config = configuration();
    config.providers.other = { adapter: "openai-chat", baseUrl: "https://other.example/v1", apiKey: "fixture-other-key" };
    for (const selector of ["mistral/unknown-text-model", `other/${GLM}`]) {
      const route = routeModel(config, selector);
      expect(requiresVisionPreprocessing(config, route.provider, route.modelId, route.providerName)).toBe(false);
    }
  });

  test.each(["sidecar", "disabled", "native"] as const)("image request uses the %s path", async mode => {
    const config = configuration();
    if (mode === "disabled") config.visionSidecar = { enabled: false };
    saveConfig(config);
    const server = startServer(0);
    try {
      const token = fakeChatGptJwt({ chatgpt_account_id: "acct-mistral-vision-fixture" });
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json", authorization: `Bearer ${token}`,
          "chatgpt-account-id": "acct-mistral-vision-fixture",
        },
        body: JSON.stringify({ model: `mistral/${mode === "native" ? NATIVE : GLM}`, stream: false,
          input: [{ role: "user", content: [
            { type: "input_text", text: "Describe this image." }, { type: "input_image", image_url: IMAGE },
          ] }],
        }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(mainCalls).toHaveLength(1);
      expect(sidecarCalls).toHaveLength(mode === "sidecar" ? 1 : 0);
      const forwarded = JSON.stringify(mainCalls[0]);
      if (mode === "sidecar") {
        expect(sidecarCalls[0]!.model).toBe("gpt-5.6-luna");
        expect(JSON.stringify(sidecarCalls[0])).toContain(IMAGE);
        expect(forwarded).toContain(CAPTION);
      }
      if (mode === "native") expect(forwarded).toContain(IMAGE);
      else {
        expect(forwarded).not.toContain(IMAGE);
        expect(forwarded).not.toContain("image_url");
      }
      if (mode === "disabled") expect(forwarded).toContain("[image omitted:");
    } finally {
      await server.stop(true);
    }
  });
});
