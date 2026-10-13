import { describe, expect, test } from "bun:test";
import { handleAdvisorRoutes, parseAdvisorSettingsPatch } from "../../src/server/management/advisor-routes";
import { handleCompanionRoutes } from "../../src/server/management/companion-routes";
import type { ManagementApiDeps, ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";

/**
 * One complete `ManagementContext` for the route tests. Direct dispatch means the untrusted
 * admin-token case (`trustedLoopbackIngress: false`, no GUI session), and the two required
 * convergence seams are stubbed: the advisor routes never call them, but the fixture must still
 * satisfy the interface.
 */
function makeCtx(
  config: OcxConfig,
  method: string,
  body?: unknown,
  deps: ManagementApiDeps = {},
): { ctx: ManagementContext; saved: OcxConfig[] } {
  const saved: OcxConfig[] = [];
  const ctx: ManagementContext = {
    req: new Request("http://localhost/api/advisor/settings", {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    }),
    url: new URL("http://localhost/api/advisor/settings"),
    config,
    deps: {
      saveConfigPreservingClaudeCode: cfg => {
        saved.push(cfg);
      },
      ...deps,
    },
    version: "test",
    trustedLoopbackIngress: false,
    guiSessionIssuance: null,
    convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
    syncClaudeAgentDefsBestEffort: async () => {},
  };
  return { ctx, saved };
}

const baseConfig = (): OcxConfig => ({
  port: 10100,
  providers: {},
}) as OcxConfig;

describe("GET /api/advisor/settings", () => {
  test("returns resolved settings with defaults and availability", async () => {
    const { ctx } = makeCtx(baseConfig(), "GET");
    const response = await handleAdvisorRoutes(ctx);
    expect(response).not.toBeNull();
    const body = await response!.json() as { settings: { enabled: boolean; policy: string }; runnable: boolean };
    expect(body.settings.enabled).toBe(false);
    expect(body.settings.policy).toBe("manual");
    expect(body.runnable).toBe(false);
  });

  test("flags enabled-without-model as a warning the GUI can show", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: true };
    const { ctx } = makeCtx(config, "GET");
    const body = await (await handleAdvisorRoutes(ctx))!.json() as { warning?: string; runnable: boolean };
    expect(body.warning).toBe("advisor_enabled_without_model");
    expect(body.runnable).toBe(false);
  });

  test("other paths and methods return null for the dispatcher", async () => {
    const { ctx } = makeCtx(baseConfig(), "DELETE");
    expect(await handleAdvisorRoutes(ctx)).toBeNull();
  });

  test("companion dispatch reaches advisor settings", async () => {
    // The management composition root is a sponsored surface, so the live
    // chain calls advisor routes from the next already-wired handler.
    const { ctx } = makeCtx(baseConfig(), "GET");
    const response = await handleCompanionRoutes(ctx);
    expect(response).not.toBeNull();
    const body = await response!.json() as { settings: { policy: string } };
    expect(body.settings.policy).toBe("manual");
  });
});

describe("PUT /api/advisor/settings", () => {
  test("partial patch persists in memory and through the locked writer", async () => {
    const config = baseConfig();
    const { ctx, saved } = makeCtx(config, "PUT", { enabled: true, model: "expert/gpt-6-astra" });
    const response = await handleAdvisorRoutes(ctx);
    const body = await response!.json() as {
      settings: { enabled: boolean; model: string; contextSharingConsent: string | null };
      runnable: boolean;
      warning?: string;
    };
    expect(body.settings.enabled).toBe(true);
    expect(body.settings.model).toBe("expert/gpt-6-astra");
    expect(body.settings.contextSharingConsent).toBeNull();
    expect(body.runnable).toBe(false);
    expect(body.warning).toBe("advisor_context_sharing_consent_required");
    expect(saved).toHaveLength(1);
    // In-memory and persisted state agree.
    expect((config as { advisor?: { model?: string } }).advisor?.model).toBe("expert/gpt-6-astra");
  });

  test("patches merge into an existing advisor block instead of replacing it", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: true, model: "keep/me", effort: "high" };
    const { ctx } = makeCtx(config, "PUT", { policy: "preflight" });
    const body = await (await handleAdvisorRoutes(ctx))!.json() as { settings: { model: string; effort: string; policy: string } };
    expect(body.settings.model).toBe("keep/me");
    expect(body.settings.effort).toBe("high");
    expect(body.settings.policy).toBe("preflight");
  });

  test("invalid values are refused with a named field and nothing is saved", async () => {
    for (const bad of [
      { effort: "ultra-plus" },
      { policy: "adaptive" },
      { model: 42 },
      { enabled: "yes" },
      { unknown: true },
      { timeoutMs: 5 },
    ]) {
      const config = baseConfig();
      const { ctx, saved } = makeCtx(config, "PUT", bad);
      const response = await handleAdvisorRoutes(ctx);
      expect(response!.status).toBe(400);
      const body = await response!.json() as { error: { code: string; message: string } };
      expect(body.error.code).toMatch(/^invalid_|^unknown_field$/);
      expect(saved).toHaveLength(0);
    }
  });

  test("reset restores the disabled default and persists", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: true, model: "x/y" };
    const { ctx, saved } = makeCtx(config, "PUT", { reset: true });
    const body = await (await handleAdvisorRoutes(ctx))!.json() as { settings: { enabled: boolean } };
    expect(body.settings.enabled).toBe(false);
    expect(saved).toHaveLength(1);
    expect((config as { advisor?: unknown }).advisor).toBeUndefined();
  });

  test("a failed save restores the in-memory snapshot", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: false };
    const { ctx } = makeCtx(config, "PUT", { enabled: true }, {
      saveConfigPreservingClaudeCode: () => {
        throw new Error("disk full");
      },
    });
    const response = await handleAdvisorRoutes(ctx);
    expect(response!.status).toBe(500);
    expect((config as { advisor?: { enabled?: boolean } }).advisor?.enabled).toBe(false);
  });
});

describe("parseAdvisorSettingsPatch (strict validation)", () => {
  test("valid patches pass through", () => {
    expect(parseAdvisorSettingsPatch({ enabled: true, model: " m/n ", effort: "low", policy: "manual", timeoutMs: 5000 }))
      .toEqual({ ok: true, patch: { enabled: true, model: "m/n", effort: "low", policy: "manual", timeoutMs: 5000 } });
  });
  test("empty body and non-object bodies are refused", () => {
    expect(parseAdvisorSettingsPatch({}).ok).toBe(false);
    expect(parseAdvisorSettingsPatch("x").ok).toBe(false);
    expect(parseAdvisorSettingsPatch([]).ok).toBe(false);
  });

  test("reset combined with other fields is refused", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: true };
    const { ctx, saved } = makeCtx(config, "PUT", { reset: true, enabled: false });
    const response = await handleAdvisorRoutes(ctx);
    expect(response!.status).toBe(400);
    const body = await response!.json() as { error: { code: string } };
    expect(body.error.code).toBe("reset_with_fields");
    expect(saved).toHaveLength(0);
    expect((config as { advisor?: unknown }).advisor).toEqual({ enabled: true });
  });

  test("model clearing: an empty value clears the model and reports not-runnable", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: true, model: "expert/gpt-6-astra" };
    const { ctx, saved } = makeCtx(config, "PUT", { model: "" });
    const response = await handleAdvisorRoutes(ctx);
    expect(response!.status).toBe(200);
    const body = await response!.json() as {
      settings: { model: string; enabled: boolean };
      runnable: boolean;
      warning?: string;
    };
    // Clearing the model is a supported state, not a validation failure.
    expect(body.settings.model).toBe("");
    expect(body.settings.enabled).toBe(true);
    expect(body.runnable).toBe(false);
    // Enabled without a model is the state the GUI shows a warning for.
    expect(body.warning).toBe("advisor_enabled_without_model");
    expect(saved).toHaveLength(1);
    expect((config as { advisor?: { model?: string } }).advisor?.model).toBe("");
  });

  test("model clearing: a whitespace-only value trims to an empty model and saves", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: false, model: "expert/gpt-6-astra" };
    const { ctx, saved } = makeCtx(config, "PUT", { model: "   " });
    const response = await handleAdvisorRoutes(ctx);
    expect(response!.status).toBe(200);
    const body = await response!.json() as { settings: { model: string } };
    expect(body.settings.model).toBe("");
    expect(saved).toHaveLength(1);
    expect((config as { advisor?: { model?: string } }).advisor?.model).toBe("");
  });

  test("model validation still bounds the trimmed length at 200 characters", async () => {
    const config = baseConfig();
    const { ctx, saved } = makeCtx(config, "PUT", { model: `expert/${"m".repeat(200)}` });
    const response = await handleAdvisorRoutes(ctx);
    expect(response!.status).toBe(400);
    const body = await response!.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_model");
    // The message now describes the real contract (string + trimmed bound; empty clears).
    expect(body.error.message).toContain("empty value clears");
    expect(saved).toHaveLength(0);
    // Exactly 200 trimmed characters is still accepted.
    const okCtx = makeCtx(baseConfig(), "PUT", { model: "m".repeat(200) }).ctx;
    expect((await handleAdvisorRoutes(okCtx))!.status).toBe(200);
  });
});

describe("PUT /api/advisor/settings context-sharing consent", () => {
  test("current consent is stored, returned, and makes a configured advisor runnable", async () => {
    const config = baseConfig();
    const { ctx, saved } = makeCtx(config, "PUT", {
      enabled: true,
      model: "expert/gpt-6-astra",
      contextSharingConsent: "v1",
    });
    const body = await (await handleAdvisorRoutes(ctx))!.json() as {
      settings: { contextSharingConsent: string | null; enabled: boolean };
      runnable: boolean;
    };
    expect(body.settings.contextSharingConsent).toBe("v1");
    expect(body.settings.enabled).toBe(true);
    expect(body.runnable).toBe(true);
    expect((config as { advisor?: { contextSharingConsent?: string } }).advisor?.contextSharingConsent).toBe("v1");
    expect(saved).toHaveLength(1);
  });

  test("unknown versions and wrong types are refused and nothing is saved", async () => {
    for (const contextSharingConsent of ["v0", "V1", true, 1, ""]) {
      const config = baseConfig();
      const { ctx, saved } = makeCtx(config, "PUT", { contextSharingConsent });
      const response = await handleAdvisorRoutes(ctx);
      expect(response!.status).toBe(400);
      const body = await response!.json() as { error: { code: string } };
      expect(body.error.code).toBe("invalid_context_sharing_consent");
      expect(saved).toHaveLength(0);
    }
  });

  test("null removes consent and immediately blocks a previously runnable advisor", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = {
      enabled: true,
      model: "expert/gpt-6-astra",
      contextSharingConsent: "v1",
    };
    const { ctx } = makeCtx(config, "PUT", { contextSharingConsent: null });
    const body = await (await handleAdvisorRoutes(ctx))!.json() as {
      settings: { contextSharingConsent: string | null; enabled: boolean };
      runnable: boolean;
      warning?: string;
    };
    expect(body.settings.enabled).toBe(true);
    expect(body.settings.contextSharingConsent).toBeNull();
    expect(body.runnable).toBe(false);
    expect(body.warning).toBe("advisor_context_sharing_consent_required");
    expect((config as { advisor?: { contextSharingConsent?: string } }).advisor?.contextSharingConsent).toBeUndefined();
  });

  test("reset removes consent along with the rest of the advisor block", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = {
      enabled: true,
      model: "expert/gpt-6-astra",
      contextSharingConsent: "v1",
    };
    const { ctx } = makeCtx(config, "PUT", { reset: true });
    const body = await (await handleAdvisorRoutes(ctx))!.json() as {
      settings: { enabled: boolean; contextSharingConsent: string | null };
      runnable: boolean;
    };
    expect(body.settings.enabled).toBe(false);
    expect(body.settings.contextSharingConsent).toBeNull();
    expect(body.runnable).toBe(false);
    expect((config as { advisor?: unknown }).advisor).toBeUndefined();
  });

  test("enabling without consent is stored and left unrunnable", async () => {
    const config = baseConfig();
    const { ctx } = makeCtx(config, "PUT", { enabled: true, model: "expert/gpt-6-astra" });
    const body = await (await handleAdvisorRoutes(ctx))!.json() as { runnable: boolean; warning?: string };
    expect(body.runnable).toBe(false);
    expect(body.warning).toBe("advisor_context_sharing_consent_required");
  });
});
