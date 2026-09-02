import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import * as modelRows from "../src/server/management/model-rows";
import type { OcxConfig } from "../src/types";
import { BASELINE_VISION_MODELS } from "../src/vision/eligibility";
import { ManagementRequest as Request } from "./helpers/management-auth";
import { removeTreeWithRetry } from "./helpers/remove-tree";

async function getSidecarSettings(config: OcxConfig): Promise<Response> {
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(new Request(url), url, config);
  if (!response) throw new Error("sidecar settings route did not handle GET");
  return response;
}

async function putSidecarSettings(config: OcxConfig, vision: Record<string, unknown>): Promise<Response> {
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vision }),
    }),
    url,
    config,
  );
  if (!response) throw new Error("sidecar settings route did not handle PUT");
  return response;
}

async function putClaudeCode(config: OcxConfig, body: Record<string, unknown>): Promise<Response> {
  const url = new URL("http://localhost/api/claude-code");
  const response = await handleManagementAPI(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    url,
    config,
  );
  if (!response) throw new Error("claude-code route did not handle PUT");
  return response;
}

function emptyConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "none",
    providers: {},
    ...overrides,
  } as OcxConfig;
}

describe("sidecar-settings vision model filter", () => {
  let previousHome: string | undefined;
  let isolatedHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedHome = mkdtempSync(join(tmpdir(), "ocx-sidecar-vision-filter-"));
    process.env.OPENCODEX_HOME = isolatedHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (isolatedHome) removeTreeWithRetry(isolatedHome);
    isolatedHome = undefined;
  });

  test("1. GET returns the allowed list containing gpt-5.6-luna", async () => {
    const config = emptyConfig();
    const response = await getSidecarSettings(config);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      visionModels?: Array<{ value: string; label: string; backend: string; baseline?: boolean }>;
    };
    expect(Array.isArray(body.visionModels)).toBe(true);
    expect(body.visionModels!.some(option => option.value === BASELINE_VISION_MODELS.openai)).toBe(true);
    expect(body.visionModels!.some(option => option.value === "gpt-5.6-luna")).toBe(true);
  });

  test("2. GET keeps a configured-but-ineligible model selectable", async () => {
    const config = emptyConfig({
      visionSidecar: { model: "o3-mini", backend: "openai" },
    });
    const response = await getSidecarSettings(config);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      vision: { model: string };
      visionModels: Array<{ value: string }>;
    };
    expect(body.vision.model).toBe("o3-mini");
    expect(body.visionModels.some(option => option.value === "o3-mini")).toBe(true);
  });

  test("3. PUT rejects an ineligible model with 400 and does not persist", async () => {
    const config = emptyConfig({
      visionSidecar: { model: "gpt-5.6-luna", reasoning: "low" },
    });
    const before = structuredClone(config.visionSidecar);
    const response = await putSidecarSettings(config, { model: "o3-mini" });
    expect(response.status).toBe(400);
    const body = await response.json() as { error?: string; allowed?: string[] };
    expect(typeof body.error).toBe("string");
    expect(Array.isArray(body.allowed)).toBe(true);
    expect(body.allowed!.length).toBeGreaterThan(0);
    expect(config.visionSidecar).toEqual(before);
  });

  test("4. PUT accepts an eligible model", async () => {
    const config = emptyConfig();
    const response = await putSidecarSettings(config, { model: "claude-haiku-4-5" });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      vision: { model: string };
      visionModels: Array<{ value: string }>;
    };
    expect(body.vision.model).toBe("claude-haiku-4-5");
    expect(config.visionSidecar?.model).toBe("claude-haiku-4-5");
    expect(Array.isArray(body.visionModels)).toBe(true);
  });

  test("5. PUT with model: \"\" still clears the override", async () => {
    const config = emptyConfig({
      visionSidecar: { model: "gpt-5.6-luna", reasoning: "low" },
    });
    const response = await putSidecarSettings(config, { model: "" });
    expect(response.status).toBe(200);
    const body = await response.json() as { vision: { model: string } };
    // Empty string clears the override; the effective reported model is the fallback.
    expect(config.visionSidecar?.model).toBeUndefined();
    expect(body.vision.model).toBe("gpt-5.4-mini");
  });

  test("6. catalog failure degrades to baselines", async () => {
    const rowsSpy = spyOn(modelRows, "listManagementModelRows").mockImplementation(async () => {
      throw new Error("catalog unavailable");
    });
    try {
      const config = emptyConfig();
      const response = await getSidecarSettings(config);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        visionModels: Array<{ value: string; baseline?: boolean }>;
      };
      const values = body.visionModels.map(option => option.value);
      expect(values).toContain(BASELINE_VISION_MODELS.openai);
      expect(values).toContain(BASELINE_VISION_MODELS.anthropic);
    } finally {
      rowsSpy.mockRestore();
    }
  });

  test("7. PUT keeps an id no source knows (regression guard)", async () => {
    const config = emptyConfig({ providers: {} });
    const response = await putSidecarSettings(config, { model: "custom-vision" });
    expect(response.status).toBe(200);
    expect(config.visionSidecar).toMatchObject({ model: "custom-vision" });
  });

  test("8. a custom image declaration cannot mask an authoritative blind OpenAI model", async () => {
    // Custom rows may declare modalities, but their claim cannot overrule the native
    // OpenAI table for a bare OpenAI model id. The write gate must inspect both.
    const rowsSpy = spyOn(modelRows, "listManagementModelRows").mockResolvedValue([{
      provider: "custom",
      id: "o3-mini",
      namespaced: "custom/o3-mini",
      disabled: false,
      inputModalities: ["text", "image"],
    }]);
    try {
      const config = emptyConfig();
      const response = await putSidecarSettings(config, { model: "o3-mini" });
      expect(response.status).toBe(400);
      expect(config.visionSidecar?.model).toBeUndefined();
    } finally {
      rowsSpy.mockRestore();
    }
  });

  test("9. GET reports the effective Anthropic default for an explicitly selected backend", async () => {
    // Reports what the runtime WOULD use for this backend. No OAuth account is set up
    // here, so no plan would run; the point is that the projection stops answering
    // gpt-5.4-mini for a configuration the OpenAI describer does not own.
    const config = emptyConfig({ visionSidecar: { backend: "anthropic" } });
    const response = await getSidecarSettings(config);
    expect(response.status).toBe(200);
    const body = await response.json() as { vision: { model: string; backend?: string } };
    expect(body.vision).toMatchObject({ model: "claude-sonnet-5", backend: "anthropic" });
  });

  test("10. GET exposes only catalog rows reachable by the executing Anthropic OAuth provider", async () => {
    writeFileSync(join(isolatedHome!, "auth.json"), JSON.stringify({
      "anthropic-oauth": {
        activeAccountId: "active",
        accounts: [{
          id: "active",
          credential: { access: "access", refresh: "refresh", expires: 9_999_999_999_999 },
        }],
      },
    }));
    const rowsSpy = spyOn(modelRows, "listManagementModelRows").mockResolvedValue([
      {
        provider: "anthropic-key",
        id: "key-only-vision",
        namespaced: "anthropic-key/key-only-vision",
        disabled: false,
        inputModalities: ["text", "image"],
      },
      {
        provider: "anthropic-oauth",
        id: "oauth-vision",
        namespaced: "anthropic-oauth/oauth-vision",
        disabled: false,
        inputModalities: ["text", "image"],
      },
    ]);
    try {
      const config = emptyConfig({
        providers: {
          "anthropic-key": { adapter: "anthropic", authMode: "key", baseUrl: "https://api.anthropic.com" },
          "anthropic-oauth": { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com" },
        },
      });
      const response = await getSidecarSettings(config);
      expect(response.status).toBe(200);
      const body = await response.json() as { visionModels: Array<{ value: string; backend: string }> };
      expect(body.visionModels).toContainEqual(expect.objectContaining({ value: "oauth-vision", backend: "anthropic" }));
      expect(body.visionModels.some(option => option.value === "key-only-vision")).toBe(false);
    } finally {
      rowsSpy.mockRestore();
    }
  });

  test("11. PUT /api/claude-code rejects a provably blind vision override and accepts unknown", async () => {
    const rejectConfig = emptyConfig({
      claudeCode: {
        visionSidecar: { model: "gpt-5.6-luna" },
      },
    });
    const before = structuredClone(rejectConfig.claudeCode);
    const rejected = await putClaudeCode(rejectConfig, {
      visionSidecar: { model: "o3-mini" },
    });
    expect(rejected.status).toBe(400);
    const rejectedBody = await rejected.json() as { error?: string; allowed?: string[] };
    expect(typeof rejectedBody.error).toBe("string");
    expect(Array.isArray(rejectedBody.allowed)).toBe(true);
    expect(rejectConfig.claudeCode).toEqual(before);

    const acceptConfig = emptyConfig();
    const accepted = await putClaudeCode(acceptConfig, {
      visionSidecar: { model: "custom-vision" },
    });
    expect(accepted.status).toBe(200);
    expect(acceptConfig.claudeCode?.visionSidecar?.model).toBe("custom-vision");
  });

  test("12. a blind model cannot be laundered by claiming the other backend", async () => {
    // Regression: the gate used to synthesize the candidate's provider from the
    // caller's `backend`, so `backend: "anthropic"` made a known text-only OpenAI
    // model look merely unknown (absent from the Anthropic table) and it saved.
    // The backend is a hint, never the authority.
    for (const backend of ["openai", "anthropic"] as const) {
      const config = emptyConfig();
      const response = await putSidecarSettings(config, { model: "o3-mini", backend });
      expect(response.status).toBe(400);
      expect(config.visionSidecar?.model).toBeUndefined();
    }

    const claudeConfig = emptyConfig();
    const claudeResponse = await putClaudeCode(claudeConfig, {
      visionSidecar: { model: "o3-mini", backend: "anthropic" },
    });
    expect(claudeResponse.status).toBe(400);
    expect(claudeConfig.claudeCode?.visionSidecar?.model).toBeUndefined();
  });

  test("13. the reject path does not persist to disk", async () => {
    // In-memory equality alone would not prove a disk write did not happen if the
    // gate were ever reordered after the mutation block.
    const configModule = await import("../src/config");
    const saveSpy = spyOn(configModule, "saveConfigPreservingClaudeCode");
    try {
      const config = emptyConfig();
      const response = await putSidecarSettings(config, { model: "o3-mini" });
      expect(response.status).toBe(400);
      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      saveSpy.mockRestore();
    }
  });

  test("14. the web-search sidecar now has its OWN membership gate (#2188)", async () => {
    // This test used to pin "deliberately NOT gated". #2188 replaced that
    // contract: web-search rejects on non-membership (closed executor set),
    // while vision keeps rejecting only on proven blindness. The two gates
    // remain different predicates; full web-search coverage lives in
    // tests/sidecar-settings-web-search-gate.test.ts.
    const config = emptyConfig();
    const url = new URL("http://localhost/api/sidecar-settings");
    const response = await handleManagementAPI(
      new Request(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ webSearch: { model: "o3-mini" } }),
      }),
      url,
      config,
    );
    expect(response?.status).toBe(400);
    expect(config.webSearchSidecar?.model).toBeUndefined();
  });
});
