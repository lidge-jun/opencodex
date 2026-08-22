import { afterEach, describe, expect, mock, test } from "bun:test";
import * as storeModule from "../src/oauth/store";
import * as usabilityModule from "../src/codex/account-usability";
import * as modelRowsModule from "../src/server/management/model-rows";

let accountSets: Record<string, { accounts: Array<{ id: string; needsReauth?: boolean; credential?: { projectId?: string } }>; activeAccountId?: string }> = {};
let usableCodexAccounts: Set<string> = new Set();
let managementRows: Array<Record<string, unknown>> = [];

mock.module("../src/oauth/store", () => ({
  ...storeModule,
  getAccountSet: (provider: string) => accountSets[provider] ?? null,
}));
mock.module("../src/codex/account-usability", () => ({
  ...usabilityModule,
  isCodexAccountUsable: (_config: unknown, accountId: string) => usableCodexAccounts.has(accountId),
}));
mock.module("../src/server/management/model-rows", () => ({
  ...modelRowsModule,
  listManagementModelRows: async () => managementRows,
}));

import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest as Request } from "./helpers/management-auth";
import {
  enabledVisionBackends,
  visionCandidateRows,
  visionDescriberIsProvablyBlind,
  visionModelOptionsFrom,
} from "../src/server/management/vision-sidecar-options";
import { activeVisionBackends } from "../src/vision/backends";
import { visionBackendForCandidate } from "../src/vision/eligibility";
import { resolveSidecarAuth } from "../src/sidecar/auth";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const forward: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" };
const xaiOAuth: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://api.x.ai/v1", authMode: "oauth" };
const antigravityOAuth: OcxProviderConfig = { adapter: "google-antigravity", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth" };
const volc: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://ark.volces.test/v1", apiKey: "k" };

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: { openai: forward, xai: xaiOAuth, "google-antigravity": antigravityOAuth, volcengine: volc },
    ...overrides,
  };
}

afterEach(() => {
  accountSets = {};
  usableCodexAccounts = new Set();
  managementRows = [];
});

describe("routed vision backend (#2188 roadmap 170 revised)", () => {
  test("any non-forward, non-OAuth-anthropic picker row maps to routed", () => {
    const cfg = config();
    expect(visionBackendForCandidate(cfg, { provider: "xai", id: "grok-4.3" })).toBe("routed");
    expect(visionBackendForCandidate(cfg, { provider: "google-antigravity", id: "gemini-3.7-flash" })).toBe("routed");
    expect(visionBackendForCandidate(cfg, { provider: "volcengine", id: "doubao-1.8-vision" })).toBe("routed");
    expect(visionBackendForCandidate(cfg, { provider: "openai", id: "gpt-5.6-luna" })).toBe("openai");
    expect(visionBackendForCandidate(cfg, { provider: "claude", id: "claude-haiku-4-5" }, "claude")).toBe("anthropic");
  });

  test("routed is always active; universal fallback still fires without any auth side", () => {
    const cfg = config();
    const active = activeVisionBackends(resolveSidecarAuth(cfg), cfg);
    expect(active).toContain("openai");
    expect(active).toContain("routed");
    expect(enabledVisionBackends(cfg, undefined)).toContain("routed");
  });

  test("options: routed rows are NAMESPACED and image-filtered (rule 2)", async () => {
    const cfg = config();
    managementRows = [
      { provider: "xai", id: "grok-4.3" },
      { provider: "xai", id: "grok-4" },
      { provider: "google-antigravity", id: "gemini-3.7-flash" },
      { provider: "volcengine", id: "doubao-1.8-vision", inputModalities: ["text", "image"] },
      { provider: "volcengine", id: "doubao-text-only", inputModalities: ["text"] },
    ];
    const candidates = await visionCandidateRows(cfg);
    const options = visionModelOptionsFrom(cfg, candidates, undefined);
    const values = options.map(option => option.value);
    expect(values).toContain("xai/grok-4.3");
    expect(values).toContain("google-antigravity/gemini-3.7-flash");
    expect(values).toContain("volcengine/doubao-1.8-vision");
    // rule 2: provably text-only rows drop — vendor table (grok-4) and row modalities.
    expect(values).not.toContain("xai/grok-4");
    expect(values).not.toContain("volcengine/doubao-text-only");
    const routedRows = options.filter(option => option.backend === "routed");
    expect(routedRows.every(option => option.value.includes("/"))).toBe(true);
  });

  test("provably-blind gate: namespaced probes its provider; bare probes all families", () => {
    const cfg = config();
    expect(visionDescriberIsProvablyBlind(cfg, "xai/grok-4", [], "routed")).toBe(true);
    expect(visionDescriberIsProvablyBlind(cfg, "xai/grok-4.3", [], "routed")).toBe(false);
    // bare text-only grok-4 still caught without any hint (blocker B).
    expect(visionDescriberIsProvablyBlind(cfg, "grok-4", [], undefined)).toBe(true);
    expect(visionDescriberIsProvablyBlind(cfg, "grok-4.3", [], undefined)).toBe(false);
  });
});

describe("management routes: routed union + coherence", () => {
  async function putVision(cfg: OcxConfig, vision: Record<string, unknown>): Promise<Response> {
    const url = new URL("http://localhost/api/sidecar-settings");
    const response = await handleManagementAPI(
      new Request(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ vision }) }),
      url, cfg,
    );
    if (!response) throw new Error("route did not handle PUT");
    return response;
  }

  test("backend routed accepted; xai/gemini/exa literals rejected 400", async () => {
    const cfg = config();
    expect((await putVision(cfg, { backend: "routed" })).status).toBe(200);
    expect(cfg.visionSidecar?.backend).toBe("routed");
    for (const bad of ["xai", "gemini", "exa", "zen"]) {
      expect((await putVision(cfg, { backend: bad })).status).toBe(400);
    }
    expect(cfg.visionSidecar?.backend).toBe("routed");
  });

  test("coherence: namespaced model requires routed; routed requires namespaced", async () => {
    const cfg = config();
    expect((await putVision(cfg, { backend: "openai", model: "xai/grok-4.3" })).status).toBe(400);
    expect((await putVision(cfg, { backend: "routed", model: "grok-4.3" })).status).toBe(400);
    const ok = await putVision(cfg, { backend: "routed", model: "xai/grok-4.3" });
    expect(ok.status).toBe(200);
    expect(cfg.visionSidecar?.model).toBe("xai/grok-4.3");
  });

  test("routed model provably blind via its namespaced provider → 400", async () => {
    const cfg = config();
    expect((await putVision(cfg, { backend: "routed", model: "xai/grok-4" })).status).toBe(400);
  });
  test("GET reports a routed backend's namespaced model verbatim (live-found regression)", async () => {
    const cfg = config({ visionSidecar: { backend: "routed", model: "xai/grok-4.6" } });
    const url = new URL("http://localhost/api/sidecar-settings");
    const response = await handleManagementAPI(new Request(url, { method: "GET" }), url, cfg);
    if (!response) throw new Error("route did not handle GET");
    const body = await response.json() as { vision: { model: string; backend?: string }; visionModels: Array<{ value: string; backend: string }> };
    expect(body.vision.backend).toBe("routed");
    expect(body.vision.model).toBe("xai/grok-4.6");
    // display grandfather: the persisted pair stays selectable even when no
    // matching option row exists in this fixture.
    expect(body.visionModels.some(option => option.value === "xai/grok-4.6" && option.backend === "routed")).toBe(true);
  });

  test("claude-code vision override admits routed with coherence", async () => {
    const cfg = config();
    const url = new URL("http://localhost/api/claude-code");
    async function putOverride(body: Record<string, unknown>): Promise<Response> {
      const response = await handleManagementAPI(
        new Request(url, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visionSidecar: body }),
        }),
        url, cfg,
      );
      if (!response) throw new Error("route did not handle PUT");
      return response;
    }
    expect((await putOverride({ backend: "routed", model: "volcengine/doubao-1.8-vision" })).status).toBe(200);
    expect((await putOverride({ backend: "xai" })).status).toBe(400);
    expect((await putOverride({ backend: "routed", model: "bare-id" })).status).toBe(400);
    expect((await putOverride({ backend: "openai", model: "volcengine/doubao-1.8-vision" })).status).toBe(400);
  });
});

